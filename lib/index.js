import { DEFAULT_CONFIG, archiveOne, ensureHomeRoot, getConfig, getLastRun, listAllSessions, resolveTitles, scanAndArchive, setConfig, setExcluded, startScheduler } from "./auto-archive.js";
/**
 * Read the header out of one `list()` row.
 *
 * Tolerates both shapes so a single build spans the old bare-header contract
 * and the current snapshot contract.
 */
function headerOf(entry) {
    const wrapped = entry;
    return wrapped && wrapped.header ? wrapped.header : entry;
}
// ---------------------------------------------------------------------------
// Plugin manifest
// ---------------------------------------------------------------------------
/** Wait for the browser HTTP carrier before registering the route. */
export const inject = ["webServer"];
/** Plugin display name for the loader. */
export const name = "dsh-archived-sessions";
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function parentDir(p) {
    const a = p.lastIndexOf("/");
    const b = p.lastIndexOf("\\");
    const i = a > b ? a : b;
    return i <= 0 ? p : p.slice(0, i);
}
function sessionIdOf(args) {
    if (args === null || typeof args !== "object")
        throw new Error("sessionId is required");
    const id = args.sessionId;
    if (typeof id !== "string" || id.length === 0)
        throw new Error("sessionId is required");
    return id;
}
/** Extract readable text from a content-block array. */
function blocksText(blocks) {
    if (!Array.isArray(blocks))
        return "";
    const parts = [];
    for (const b of blocks) {
        if (!b || typeof b !== "object")
            continue;
        const block = b;
        if (block.type === "text" && typeof block.text === "string")
            parts.push(block.text);
        else if (block.type === "reasoning" && typeof block.text === "string")
            parts.push("[思考] " + block.text);
        else if (block.type === "tool-call")
            parts.push("[调用 " + (typeof block.name === "string" ? block.name : "?") + "]");
        else if (block.type === "tool-result")
            parts.push("[工具结果]");
        else if (block.type === "image")
            parts.push("[图片]");
    }
    return parts.join("\n");
}
/**
 * Recursive byte size of a session directory via the fs service.
 *
 * Receives a resolved target handle and threads it through recursion: the
 * handle is the only thing `stat`/`listDir` accept, and the entries that
 * `listDir` yields already carry a handle for each child.
 *
 * @param fsSvc - the harness fs service.
 * @param dirPath - absolute path of the directory to measure.
 * @param depth - recursion guard.
 * @returns the byte total, or null when the path cannot be resolved (missing).
 */
async function dirSizeBytes(fsSvc, dirPath, depth) {
    let target;
    try {
        target = await fsSvc.resolve(dirPath);
    }
    catch (e) {
        return null;
    }
    return dirSizeOfTarget(fsSvc, target, depth);
}
/** Byte size of one already-resolved target. */
async function dirSizeOfTarget(fsSvc, target, depth) {
    try {
        const info = await fsSvc.stat(target);
        if (!info)
            return 0;
        if (info.type !== "directory")
            return info.size || 0;
        if (depth > 10)
            return 0;
        let total = 0;
        let entries = [];
        try {
            entries = await fsSvc.listDir(target);
        }
        catch (e) {
            entries = [];
        }
        for (const entry of entries) {
            if (entry.type === "directory") {
                // listDir already hands back a resolved handle for each child.
                total += await dirSizeOfTarget(fsSvc, entry.target, depth + 1);
            }
            else {
                total += entry.size || 0;
            }
        }
        return total;
    }
    catch (e) {
        return 0;
    }
}
/**
 * Resolve an explicit danger-full-access policy so the shell executor runs the
 * deletion unconfined. On Windows deployments where the ACL sandbox backend
 * cannot start (its temp root must live outside the workspace), any confined
 * mode would fail before the command even runs.
 *
 * Verified against 0.1.5-rc.1: `sandboxPolicy.resolve({ mode })` still returns
 * the resolved policy natively, and the shell request still accepts it.
 */
function dangerPolicy(ctx) {
    const sp = ctx.get("sandboxPolicy");
    if (!sp || typeof sp.resolve !== "function")
        return undefined;
    try {
        return sp.resolve({ mode: "danger-full-access" });
    }
    catch (e) {
        return undefined;
    }
}
/** Delete a directory recursively through the shell executor (pwsh / rm). */
async function removeDir(ctx, dirPath) {
    const shell = ctx.get("shell");
    if (!shell || typeof shell.resolve !== "function" || typeof shell.run !== "function") {
        throw new Error("shell executor unavailable; cannot delete from disk");
    }
    const isWindows = /^[A-Za-z]:[\\/]/.test(dirPath);
    const command = isWindows
        ? "Remove-Item -LiteralPath '" + dirPath.replace(/'/g, "''") + "' -Recurse -Force -ErrorAction Stop"
        : "rm -rf -- '" + dirPath.replace(/'/g, "'\\''") + "'";
    const request = {
        command,
        timeoutMs: 60000
    };
    const policy = dangerPolicy(ctx);
    if (policy)
        request.sandboxPolicy = policy;
    let spec;
    try {
        spec = shell.resolve(request);
    }
    catch (e) {
        throw new Error("shell resolve failed: " + String((e && e.message) || e));
    }
    const result = await shell.run(spec);
    if (result && result.exitCode === 0)
        return;
    let detail = "";
    try {
        const out = result && (result.stderr || result.stdout);
        if (out && typeof out.text === "string")
            detail = out.text.slice(0, 400);
    }
    catch (e) {
        detail = "";
    }
    throw new Error("删除失败 (exit " + String(result && result.exitCode) + "): " + (detail || dirPath));
}
/**
 * Remove one id from the durable archive set and keep the registry's in-memory
 * state consistent so its own later writes cannot clobber it.
 *
 * `WorkspaceRegistry.setState` is a bare `global.set` + `this.state = state`:
 * it is NOT serialized against the registry's own operations, which all run
 * through an internal promise chain. A concurrent archive/delete landing
 * between our read and our write would therefore be lost. We hold our own
 * tail so at least our own calls never interleave; a truly atomic
 * remove-from-set would need an API on the registry itself.
 */
let archiveWriteTail = Promise.resolve();
async function removeFromArchiveSet(ctx, sessionId) {
    const run = archiveWriteTail.then(() => removeFromArchiveSetNow(ctx, sessionId), () => removeFromArchiveSetNow(ctx, sessionId));
    archiveWriteTail = run.then(() => undefined, () => undefined);
    return run;
}
async function removeFromArchiveSetNow(ctx, sessionId) {
    const registry = ctx.get("workspaceRegistry");
    if (!registry)
        throw new Error("workspace registry unavailable");
    if (!registry.state || typeof registry.state !== "object")
        throw new Error("workspace registry is not started");
    const current = registry.archivedSessionIds;
    if (!Array.isArray(current) || !current.includes(sessionId))
        return false;
    const next = current.filter((id) => id !== sessionId);
    const state = Object.assign({}, registry.state, { archivedSessionIds: next });
    if (typeof registry.setState === "function") {
        await registry.setState(state);
        return true;
    }
    const domain = ctx.get("storageDomain");
    if (!domain || typeof domain.get !== "function")
        throw new Error("storage domain unavailable");
    const unit = domain.get("workspace");
    if (!unit || !unit.global || typeof unit.global.set !== "function")
        throw new Error("workspace domain is not open");
    await unit.global.set(state);
    registry.state = state;
    return true;
}
/** A session is deletable unless its agent is actively running a turn. */
function sessionRunning(ctx, sessionId) {
    const agents = ctx.get("agents");
    if (!agents || typeof agents.get !== "function")
        return false;
    const agent = agents.get(sessionId);
    return !!(agent && agent.status === "running");
}
/**
 * Evict a live session from the in-memory store (the store's own detach path),
 * so a deleted session cannot resurface in the workspace afterward.
 */
function evictSessionFromMemory(ctx, sessionId) {
    const sessions = ctx.get("sessions");
    if (!sessions)
        return false;
    try {
        const store = sessions.store;
        if (!store || typeof store.get !== "function")
            return false;
        const entry = store.get(sessionId);
        if (!entry || typeof entry.detach !== "function")
            return false;
        entry.detach();
        return true;
    }
    catch (e) {
        return false;
    }
}
// ---------------------------------------------------------------------------
// API handlers
// ---------------------------------------------------------------------------
async function handleList(ctx) {
    const registry = ctx.get("workspaceRegistry");
    const persistence = ctx.get("sessionPersistence");
    if (!registry || !persistence)
        return { items: [], totalBytes: 0 };
    const archived = Array.isArray(registry.archivedSessionIds) ? [...registry.archivedSessionIds] : [];
    if (archived.length === 0)
        return { items: [], totalBytes: 0 };
    const headers = await persistence.list();
    const byId = new Map();
    for (const entry of headers) {
        const header = headerOf(entry);
        if (header && typeof header.id === "string")
            byId.set(header.id, header);
    }
    const query = ctx.get("sessionQuery");
    // Log-backed title when present, first-user-message fallback otherwise
    // (older sessions have no committed `session/title` event at all).
    const titles = await resolveTitles(query, archived);
    const liveSvc = ctx.get("sessions");
    const fsSvc = ctx.get("fs");
    const items = [];
    let totalBytes = 0;
    for (const id of archived) {
        const header = byId.get(id);
        let sizeBytes = 0;
        let missing = false;
        let path = null;
        if (header) {
            let location = null;
            try {
                location = persistence.locate(header);
            }
            catch (e) {
                location = null;
            }
            if (location && typeof location.path === "string" && location.path.length > 0) {
                path = location.path;
                if (fsSvc) {
                    const size = await dirSizeBytes(fsSvc, parentDir(location.path), 0);
                    if (size === null)
                        missing = true;
                    else
                        sizeBytes = size;
                }
            }
            else {
                missing = true;
            }
        }
        else {
            missing = true;
        }
        totalBytes += sizeBytes;
        items.push({
            id,
            title: titles.get(id) || null,
            createdAt: header ? header.createdAt || null : null,
            cwd: header ? header.cwd || null : null,
            parentSession: header ? header.parentSession || null : null,
            sizeBytes,
            missing,
            live: !!(liveSvc && liveSvc.get(id) !== undefined),
            running: sessionRunning(ctx, id),
            path
        });
    }
    items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return { items, totalBytes };
}
async function handleUnarchive(ctx, args) {
    const sessionId = sessionIdOf(args);
    const registry = ctx.get("workspaceRegistry");
    if (!registry)
        throw new Error("workspace registry unavailable");
    if (!Array.isArray(registry.archivedSessionIds) || !registry.archivedSessionIds.includes(sessionId)) {
        throw new Error("会话 '" + sessionId + "' 不在归档集合中");
    }
    const changed = await removeFromArchiveSet(ctx, sessionId);
    return { ok: true, changed, archivedSessionIds: [...registry.archivedSessionIds] };
}
async function handleDelete(ctx, args) {
    const sessionId = sessionIdOf(args);
    const registry = ctx.get("workspaceRegistry");
    const persistence = ctx.get("sessionPersistence");
    if (!registry || !persistence)
        throw new Error("workspace registry or session persistence unavailable");
    if (!Array.isArray(registry.archivedSessionIds) || !registry.archivedSessionIds.includes(sessionId)) {
        throw new Error("会话 '" + sessionId + "' 不在归档集合中");
    }
    if (sessionRunning(ctx, sessionId)) {
        throw new Error("会话 '" + sessionId + "' 正在运行中，无法删除");
    }
    // A live (in-memory) session would otherwise resurface in the workspace once
    // the archive entry is pruned; evict it so the deletion is complete.
    const liveSvc = ctx.get("sessions");
    const isLive = !!(liveSvc && typeof liveSvc.get === "function" && liveSvc.get(sessionId) !== undefined);
    if (isLive && !evictSessionFromMemory(ctx, sessionId)) {
        throw new Error("会话 '" + sessionId + "' 仍驻留内存且无法移除，删除未完成；请重启 Harness 后重试");
    }
    const headers = await persistence.list();
    let header = null;
    for (const entry of headers) {
        const candidate = headerOf(entry);
        if (candidate && candidate.id === sessionId) {
            header = candidate;
            break;
        }
    }
    if (!header) {
        // Already gone from persistence: just prune the archive id.
        await removeFromArchiveSet(ctx, sessionId);
        return { ok: true, deleted: false, reason: "no-artifact", sessionId };
    }
    let location = null;
    try {
        location = persistence.locate(header);
    }
    catch (e) {
        location = null;
    }
    if (!location || typeof location.path !== "string" || location.path.length === 0) {
        await removeFromArchiveSet(ctx, sessionId);
        return { ok: true, deleted: false, reason: "no-artifact", sessionId };
    }
    const dirPath = parentDir(location.path);
    const fsSvc = ctx.get("fs");
    let sizeBytes = 0;
    if (fsSvc) {
        const size = await dirSizeBytes(fsSvc, dirPath, 0);
        sizeBytes = size === null ? 0 : size;
    }
    await removeDir(ctx, dirPath);
    await removeFromArchiveSet(ctx, sessionId);
    return { ok: true, deleted: true, sessionId, path: dirPath, sizeBytes };
}
async function handleDetail(ctx, args) {
    const sessionId = sessionIdOf(args);
    const query = ctx.get("sessionQuery");
    if (!query || typeof query.readSession !== "function") {
        throw new Error("session query unavailable");
    }
    let snapshot;
    try {
        snapshot = await query.readSession(sessionId);
    }
    catch (e) {
        throw new Error("无法读取会话内容（可能已从磁盘删除）: " + String((e && e.message) || e));
    }
    if (!snapshot || !Array.isArray(snapshot.events)) {
        throw new Error("会话内容为空或不可读");
    }
    const events = snapshot.events;
    const messages = [];
    const MAX_MESSAGES = 100;
    const MAX_TEXT = 8000;
    for (const raw of events) {
        if (messages.length >= MAX_MESSAGES)
            break;
        const ev = raw;
        if (!ev || !ev.data)
            continue;
        const data = ev.data;
        if (ev.type === "user/message") {
            const text = blocksText(data.content);
            if (text)
                messages.push({ seq: ev.seq, time: ev.time, role: "user", text: text.slice(0, MAX_TEXT) });
        }
        else if (ev.type === "assistant/message" && data.message && typeof data.message === "object") {
            const text = blocksText(data.message.content);
            if (text)
                messages.push({ seq: ev.seq, time: ev.time, role: "assistant", text: text.slice(0, MAX_TEXT) });
        }
        else if (ev.type === "tool/call") {
            const name = typeof data.name === "string" ? data.name : "?";
            const argsText = typeof data.arguments === "string" ? data.arguments.slice(0, 300) : "";
            messages.push({ seq: ev.seq, time: ev.time, role: "tool", text: "[" + name + "] " + argsText });
        }
    }
    const header = snapshot.session || null;
    return {
        id: sessionId,
        createdAt: header ? header.createdAt || null : null,
        cwd: header ? header.cwd || null : null,
        parentSession: header ? header.parentSession || null : null,
        totalEvents: events.length,
        messageCount: messages.length,
        truncated: messages.length >= MAX_MESSAGES,
        messages
    };
}
// ---------------------------------------------------------------------------
// Auto-archive API handlers
// ---------------------------------------------------------------------------
/** Preview list cap: the client shows a summary anyway. */
const AUTO_PREVIEW_CAP = 50;
/** Compact dry-run scan for the settings panel. */
async function autoPreview(ctx) {
    const result = await scanAndArchive(ctx, { dryRun: true });
    return {
        total: result.preview.length,
        items: result.preview.slice(0, AUTO_PREVIEW_CAP),
        errors: result.errors
    };
}
async function handleAutoStatus(ctx, scheduler) {
    const persistence = ctx.get("sessionPersistence");
    const config = persistence ? getConfig(persistence) : { ...DEFAULT_CONFIG };
    const lastRun = persistence ? getLastRun(persistence) : null;
    let preview = { total: 0, items: [], errors: [] };
    try {
        preview = await autoPreview(ctx);
    }
    catch (e) {
        preview = { total: 0, items: [], errors: [String((e && e.message) || e)] };
    }
    return {
        config,
        lastRun,
        nextRunAt: scheduler.nextRunAt(),
        scanning: scheduler.isScanning(),
        preview
    };
}
async function handleAutoConfigSet(ctx, args) {
    const persistence = ctx.get("sessionPersistence");
    if (!persistence)
        throw new Error("session persistence unavailable");
    await ensureHomeRoot(persistence);
    const patch = (args && typeof args === "object" ? args : {});
    const config = setConfig(persistence, patch);
    return { config };
}
async function handleAutoScan(ctx, args, scheduler) {
    const dryRun = !!(args && typeof args === "object" && args.dryRun === true);
    if (dryRun)
        return scanAndArchive(ctx, { dryRun: true });
    return scheduler.runNow();
}
/** Full not-yet-archived session inventory for the manual archive list. */
async function handleAutoSessions(ctx) {
    return { items: await listAllSessions(ctx) };
}
/** Manually archive ONE session (guarded like the scanner: never a running turn). */
async function handleAutoArchiveOne(ctx, args) {
    const sessionId = sessionIdOf(args);
    const agents = ctx.get("agents");
    const agent = agents && typeof agents.get === "function" ? agents.get(sessionId) : undefined;
    if (agent && agent.status === "running") {
        throw new Error("会话 '" + sessionId + "' 正在运行中，无法归档");
    }
    const ok = await archiveOne(ctx, sessionId);
    if (!ok)
        throw new Error("归档后未在归档集合中找到会话 " + sessionId);
    return { ok: true, sessionId };
}
/** Add/remove one id from the manual "never auto-archive" exclude list. */
async function handleAutoExclude(ctx, args) {
    const persistence = ctx.get("sessionPersistence");
    if (!persistence)
        throw new Error("session persistence unavailable");
    const sessionId = sessionIdOf(args);
    const add = !!(args && typeof args === "object" && args.add !== false);
    await ensureHomeRoot(persistence);
    const config = setExcluded(persistence, sessionId, add);
    return { ok: true, sessionId, excluded: add, config };
}
// ---------------------------------------------------------------------------
// HTTP route
// ---------------------------------------------------------------------------
/** Delay before the first scheduled pass; lets the harness finish booting. */
const AUTO_WARMUP_MS = 3 * 60 * 1000;
export function apply(ctx) {
    // Seed the harness-root cache before anything reads/writes plugin state;
    // failures are non-fatal (defaults apply, the scheduler retries later).
    const persistenceSvc = ctx.get("sessionPersistence");
    const ready = persistenceSvc
        ? ensureHomeRoot(persistenceSvc).catch(() => undefined)
        : Promise.resolve();
    const scheduler = startScheduler(ctx, AUTO_WARMUP_MS);
    const handlers = {
        list: () => handleList(ctx),
        unarchive: (args) => handleUnarchive(ctx, args),
        delete: (args) => handleDelete(ctx, args),
        detail: (args) => handleDetail(ctx, args),
        "auto-status": () => handleAutoStatus(ctx, scheduler),
        "auto-config-set": (args) => handleAutoConfigSet(ctx, args),
        "auto-scan": (args) => handleAutoScan(ctx, args, scheduler),
        "auto-sessions": () => handleAutoSessions(ctx),
        "auto-archive-one": (args) => handleAutoArchiveOne(ctx, args),
        "auto-exclude": (args) => handleAutoExclude(ctx, args)
    };
    async function handler(req, res) {
        if ((req.method || "") !== "POST") {
            sendJson(res, 405, { error: "method not allowed" });
            return;
        }
        const pathname = (req.url || "").split("?")[0].replace(/\/+$/, "");
        let action = null;
        for (const key of Object.keys(handlers)) {
            if (pathname === "/dsh-archived/" + key) {
                action = key;
                break;
            }
        }
        if (action === null) {
            sendJson(res, 404, { error: "not found" });
            return;
        }
        let body = {};
        try {
            const raw = await readBody(req);
            if (raw.trim().length > 0)
                body = JSON.parse(raw);
        }
        catch (e) {
            sendJson(res, 400, { error: "invalid JSON body" });
            return;
        }
        try {
            sendJson(res, 200, await handlers[action](body));
        }
        catch (e) {
            sendJson(res, 500, { error: (e && e.message) || String(e) });
        }
    }
    ctx.webServer.register({
        kind: "prefix",
        path: "/dsh-archived",
        handler
    });
    // Dispose: stop the scheduler so no scan fires after plugin unload.
    return ready.then(() => {
        return async () => {
            scheduler.stop();
        };
    });
}
function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => {
            try {
                resolve(Buffer.concat(chunks).toString("utf8"));
            }
            catch (e) {
                reject(e);
            }
        });
        req.on("error", reject);
    });
}
function sendJson(res, status, payload) {
    res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store"
    });
    res.end(JSON.stringify(payload));
}
