/**
 * Auto-archive engine for dsh-auto-archive.
 *
 * Periodically scans persisted sessions and archives the ones that have been
 * idle for longer than the configured threshold:
 *
 *   - "Idle" = the session's on-disk artifact (session.jsonl.zstd) has not been
 *     written for `idleDays` days; its mtime is the last activity time.
 *   - Safety rails: sessions that are currently running a turn are never
 *     touched; sessions that still live in the in-memory store are skipped
 *     conservatively (a truly idle session is evicted anyway); ids on the
 *     user's exclude list are skipped; already-archived ids are skipped.
 *   - Archiving goes through the official `workspaceRegistry.archiveSession`
 *     when available, with a storage-domain fallback that also patches the
 *     registry's private state cache (same dance dsh-session-manager does).
 *
 * Config + last-run audit record persist as one JSON file in the harness home
 * directory. The home root is derived from a session artifact path (locate()
 * always returns something under <harness-root>/sessions/...), so no extra
 * path service dependency is needed.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// Minimal structural typings for the harness services used here.
// ---------------------------------------------------------------------------

interface SessionHeader {
  id: string;
  createdAt?: number | null;
  cwd?: string | null;
}

interface SessionListEntry {
  header?: SessionHeader;
  id?: string;
}

interface SessionPersistence {
  list(): Promise<SessionListEntry[]>;
  locate(header: SessionHeader): { path?: string } | null | undefined;
}

interface WorkspaceRegistry {
  state?: unknown;
  archivedSessionIds?: string[];
  setState?(state: unknown): Promise<unknown>;
  archiveSession?(id: string): Promise<unknown> | unknown;
}

interface StorageDomainService {
  get?(name: string): { global?: { get?(): unknown; set?(value: unknown): Promise<unknown> } } | undefined;
}

interface AgentsService {
  get(id: string): { status?: string } | undefined;
}

interface SessionQueryService {
  readTitleSnapshots?(
    ids: string[]
  ): Promise<Array<{
    sessionId: string;
    status?: string;
    value?: { title?: { title?: string } };
  }>>;
  readSession?(id: string): Promise<{
    session?: { createdAt?: number | null; cwd?: string | null; parentSession?: string | null };
    events?: unknown[];
  } | null | undefined>;
}

/** Host-side plugin context (the subset the engine needs). */
export interface AutoArchiveCtx {
  get<T = unknown>(key: string): T | undefined;
  logger?: { info?(...args: unknown[]): void; warn?(...args: unknown[]): void; debug?(...args: unknown[]): void };
}

// ---------------------------------------------------------------------------
// Title resolution: log-backed title first, first-user-message fallback second
// ---------------------------------------------------------------------------

/** Extract readable text from a content-block array (user/assistant messages). */
function blocksText(blocks: unknown): string {
  if (!Array.isArray(blocks)) {
    return typeof blocks === "string" ? blocks : "";
  }
  const parts: string[] = [];
  for (const b of blocks) {
    if (!b || typeof b !== "object") continue;
    const block = b as Record<string, unknown>;
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n");
}

/** Rough mirror of the harness `cleanTitleText`: trim markdown noise and squeeze whitespace. */
function cleanTitleText(input: string): string {
  return input
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^\s*[#>*\-\d.、)\]]+\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** UTF-8-byte truncation with an ellipsis, mirroring the harness title folding. */
function truncateTitleUtf8(input: string, maxBytes: number): string {
  const enc = new TextEncoder();
  if (enc.encode(input).length <= maxBytes) return input;
  let out = "";
  let bytes = 0;
  for (const ch of input) {
    const n = enc.encode(ch).length;
    if (bytes + n > maxBytes - 1) break;
    out += ch;
    bytes += n;
  }
  return out + "…";
}

/**
 * Fold a display title from the first user message when the session log has no
 * committed `session/title` event (older sessions predate the title service,
 * so the sidebar's live fallback projection never got persisted for them).
 */
function fallbackTitleFromEvents(events: unknown[]): string | null {
  for (const raw of events) {
    const ev = raw as { type?: string; data?: { content?: unknown } } | null | undefined;
    if (!ev || ev.type !== "user/message" || !ev.data) continue;
    const text = cleanTitleText(blocksText(ev.data.content));
    if (text.length > 0) return truncateTitleUtf8(text, 90);
  }
  return null;
}

/**
 * Resolve display titles for session ids.
 *
 * Pass 1 uses the official `readTitleSnapshots` (log-backed `session/title`
 * events). Pass 2 covers sessions without one by loading their log and folding
 * the first user message — the same idea as the harness's live fallback
 * projection, computed on demand for cold sessions.
 */
export async function resolveTitles(query: SessionQueryService | undefined, ids: string[]): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  if (!query || ids.length === 0) return titles;

  if (typeof query.readTitleSnapshots === "function") {
    try {
      const results = await query.readTitleSnapshots(ids);
      for (const r of results || []) {
        if (r && r.status === "fulfilled" && r.value && r.value.title && typeof r.value.title.title === "string") {
          titles.set(r.sessionId, r.value.title.title);
        }
      }
    } catch (e) {
      // fall through to the per-session fallback
    }
  }

  const missing = ids.filter((id) => !titles.has(id));
  const readSession = typeof query.readSession === "function" ? query.readSession.bind(query) : null;
  if (missing.length > 0 && readSession) {
    let cursor = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const i = cursor++;
        if (i >= missing.length) return;
        const id = missing[i];
        try {
          const snap = await readSession(id);
          const events = snap && Array.isArray(snap.events) ? snap.events : [];
          if (events.length > 0) {
            const title = fallbackTitleFromEvents(events);
            if (title) titles.set(id, title);
          }
        } catch (e) {
          // unreadable session: leave it untitled
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, missing.length) }, () => worker()));
  }
  return titles;
}

// ---------------------------------------------------------------------------
// Config & audit types
// ---------------------------------------------------------------------------

export interface AutoArchiveConfig {
  /** Master switch. Defaults to false: nothing moves until the user opts in. */
  enabled: boolean;
  /** Idle threshold in days (fractional allowed). */
  idleDays: number;
  /** Scan cadence in minutes. */
  intervalMinutes: number;
  /** Session ids the user pinned out of auto-archiving. */
  excludeIds: string[];
}

/** One archived (or previewable) session in a scan result. */
export interface AutoArchiveHit {
  id: string;
  title: string | null;
  /** Idle duration in whole days, floored. */
  idleDays: number;
  lastActiveAt: number | null;
}

/** Result of one scan pass (live or preview). */
export interface ScanResult {
  startedAt: number;
  finishedAt: number;
  dryRun: boolean;
  scanned: number;
  /** Candidates that matched the idle threshold but were skipped for safety. */
  skippedLive: number;
  skippedRunning: number;
  skippedExcluded: number;
  archivedCount: number;
  archived: AutoArchiveHit[];
  preview: AutoArchiveHit[];
  errors: string[];
}

interface AutoArchiveState {
  config: AutoArchiveConfig;
  lastRun: ScanResult | null;
}

export const DEFAULT_CONFIG: AutoArchiveConfig = {
  enabled: false,
  idleDays: 14,
  // Once a day by default (user preference 2026-09-17); still stored in
  // minutes so existing state files keep loading unchanged.
  intervalMinutes: 1440,
  excludeIds: []
};

// ---------------------------------------------------------------------------
// Config file persistence
// ---------------------------------------------------------------------------

const STATE_FILE = "dsh-auto-archive.json";

/** Sanity-clamp a config value coming from disk or the settings API. */
function clampConfig(raw: Partial<AutoArchiveConfig> | null | undefined): AutoArchiveConfig {
  const c: AutoArchiveConfig = { ...DEFAULT_CONFIG };
  if (!raw || typeof raw !== "object") return c;
  if (typeof raw.enabled === "boolean") c.enabled = raw.enabled;
  const days = Number(raw.idleDays);
  if (Number.isFinite(days)) c.idleDays = Math.min(3650, Math.max(0.5, days));
  const minutes = Number(raw.intervalMinutes);
  // 6 hours .. 365 days.
  if (Number.isFinite(minutes)) c.intervalMinutes = Math.min(525600, Math.max(360, minutes));
  if (Array.isArray(raw.excludeIds)) {
    c.excludeIds = raw.excludeIds.filter((id): id is string => typeof id === "string" && id.length > 0);
  }
  return c;
}

/** Cached harness home root; derived from a session artifact path. */
let cachedHomeRoot: string | null = null;

/**
 * Seed the cached harness root by locating one real session artifact.
 *
 * Called once from the host half's apply() before any config read/write, and
 * opportunistically by lastActiveAtOf() on every scan. Until a root is known,
 * state reads fall back to defaults and writes are dropped (harmless: with no
 * sessions on disk there is nothing to auto-archive either).
 */
export async function ensureHomeRoot(persistence: SessionPersistence): Promise<void> {
  if (cachedHomeRoot) return;
  try {
    const entries = await persistence.list();
    for (const entry of entries || []) {
      const header = headerOf(entry);
      if (!header) continue;
      let location: { path?: string } | null | undefined = null;
      try {
        location = persistence.locate(header);
      } catch (e) {
        location = null;
      }
      const p = location && typeof location.path === "string" ? location.path : null;
      if (p) {
        seedHomeRootFromArtifact(p);
        if (cachedHomeRoot) return;
      }
    }
  } catch (e) {
    // No sessions yet; defaults apply and the scheduler retries later.
  }
}

/**
 * Resolve the state file path, or null when the harness root cannot be derived
 * (e.g. no sessions on disk at all yet). In that case auto-archiving simply
 * has nothing to scan anyway.
 */
export function resolveStatePath(persistence: SessionPersistence): string | null {
  if (cachedHomeRoot) return join(cachedHomeRoot, STATE_FILE);
  return null;
}

/**
 * Seed the cached harness root from a real artifact path. Called by the host
 * half once it has listed sessions; until then reads fall back to defaults.
 */
export function seedHomeRootFromArtifact(artifactPath: string): void {
  if (cachedHomeRoot) return;
  if (typeof artifactPath !== "string" || artifactPath.length === 0) return;
  // <root>/sessions/<ws>/<session>/<file> -> three dirname() calls up = <root>
  let dir = dirname(artifactPath);
  for (let i = 0; i < 3; i++) {
    const parent = dirname(dir);
    if (parent === dir) return; // filesystem root reached; path shape unexpected
    dir = parent;
  }
  if (existsSync(join(dir, "sessions"))) cachedHomeRoot = dir;
}

/** Exposed for tests / diagnostics. */
export function homeRootForTest(): string | null {
  return cachedHomeRoot;
}

function readState(persistence: SessionPersistence): AutoArchiveState {
  const path = resolveStatePath(persistence);
  if (!path || !existsSync(path)) return { config: { ...DEFAULT_CONFIG }, lastRun: null };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<AutoArchiveState>;
    return {
      config: clampConfig(raw && raw.config),
      lastRun: raw && raw.lastRun && typeof raw.lastRun === "object" ? (raw.lastRun as ScanResult) : null
    };
  } catch (e) {
    return { config: { ...DEFAULT_CONFIG }, lastRun: null };
  }
}

function writeState(persistence: SessionPersistence, state: AutoArchiveState): void {
  const path = resolveStatePath(persistence);
  if (!path) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = path + ".tmp";
    writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
    renameSync(tmp, path);
  } catch (e) {
    // Persistence of the audit record is best-effort; never break a scan.
  }
}

export function getConfig(persistence: SessionPersistence): AutoArchiveConfig {
  return readState(persistence).config;
}

export function setConfig(persistence: SessionPersistence, patch: Partial<AutoArchiveConfig>): AutoArchiveConfig {
  const state = readState(persistence);
  const next = clampConfig({ ...state.config, ...patch });
  writeState(persistence, { ...state, config: next });
  return next;
}

export function getLastRun(persistence: SessionPersistence): ScanResult | null {
  return readState(persistence).lastRun;
}

/** Add or remove one id from the manual "never auto-archive" list. */
export function setExcluded(persistence: SessionPersistence, sessionId: string, add: boolean): AutoArchiveConfig {
  const state = readState(persistence);
  const set = new Set(state.config.excludeIds);
  if (add) set.add(sessionId);
  else set.delete(sessionId);
  const next = clampConfig({ ...state.config, excludeIds: [...set] });
  writeState(persistence, { ...state, config: next });
  return next;
}

function recordRun(persistence: SessionPersistence, run: ScanResult): void {
  const state = readState(persistence);
  writeState(persistence, { ...state, lastRun: run });
}

// ---------------------------------------------------------------------------
// Archiving primitives
// ---------------------------------------------------------------------------

/**
 * Keep the registry's private state cache in lockstep with a direct domain
 * write. Mirrors dsh-session-manager's `syncRegistryState`: without this, the
 * cached `archivedSessionIds` goes stale and later archive calls disagree with
 * what clients see.
 */
function syncRegistryState(registry: WorkspaceRegistry, next: unknown): void {
  if (registry !== undefined && registry !== null && typeof registry === "object" && "state" in registry) {
    (registry as { state?: unknown }).state = next;
  }
}

/**
 * Archive one session id through the official API, with a storage-domain
 * fallback (plus the stale-cache patch). Returns true when the id is present
 * in the durable archive set afterwards.
 */
export async function archiveOne(ctx: AutoArchiveCtx, sessionId: string): Promise<boolean> {
  const registry = ctx.get<WorkspaceRegistry>("workspaceRegistry");
  if (!registry) throw new Error("workspace registry unavailable");

  if (typeof registry.archiveSession === "function") {
    try {
      await registry.archiveSession(sessionId);
    } catch (e) {
      // Fall through to the domain path; some builds reject unknown/edge ids.
    }
  }

  const presentNow = (): boolean =>
    Array.isArray(registry.archivedSessionIds) && registry.archivedSessionIds.includes(sessionId);
  if (presentNow()) return true;

  const domain = ctx.get<StorageDomainService>("storageDomain");
  const workspace = domain && typeof domain.get === "function" ? domain.get("workspace") : undefined;
  if (!workspace || !workspace.global || typeof workspace.global.get !== "function" || typeof workspace.global.set !== "function") {
    throw new Error("workspace storage domain unavailable; cannot archive");
  }
  const state = workspace.global.get() as { archivedSessionIds?: string[] };
  const rawIds = state && state.archivedSessionIds;
  const current: string[] = Array.isArray(rawIds) ? rawIds : [];
  if (!current.includes(sessionId)) {
    const next = { ...state, archivedSessionIds: [...current, sessionId] };
    await workspace.global.set(next);
    syncRegistryState(registry as WorkspaceRegistry, next);
  }
  // Re-read through the registry cache; the patch above keeps it fresh.
  return presentNow();
}

// ---------------------------------------------------------------------------
// Scan engine
// ---------------------------------------------------------------------------

function headerOf(entry: SessionListEntry): SessionHeader | null {
  if (entry && entry.header && typeof entry.header.id === "string") return entry.header;
  if (entry && typeof entry.id === "string") return { id: entry.id };
  return null;
}

/**
 * Last-activity mtime of a session, or null when unresolvable.
 *
 * `persistence.locate()` only COMPUTES the current-generation path
 * (`session.v3.jsonl.zstd`) without touching the filesystem — most older
 * sessions on disk are still previous generations (`session.jsonl.zstd`,
 * `session.v2...`), so stat-ing the computed path alone misses them with
 * ENOENT and every idle rule silently never fires. Instead: take the session
 * DIRECTORY from the computed path and use the newest mtime across all
 * generation log files in it (lock files excluded — they get touched often).
 */
function lastActiveAtOf(persistence: SessionPersistence, header: SessionHeader): number | null {
  try {
    const location = persistence.locate(header);
    const p = location && typeof location.path === "string" ? location.path : null;
    if (!p) return null;
    seedHomeRootFromArtifact(p);
    const dir = dirname(p);
    const entries = existsSync(dir) ? readdirSync(dir) : [];
    let newest: number | null = null;
    for (const name of entries) {
      if (!/^session(\.v\d+)?\.jsonl(\.zstd)?$/.test(name)) continue; // generation logs only
      try {
        const mtime = statSync(join(dir, name)).mtimeMs;
        if (Number.isFinite(mtime) && (newest === null || mtime > newest)) newest = mtime;
      } catch (e) {
        // file vanished mid-scan; ignore this entry
      }
    }
    return newest;
  } catch (e) {
    return null;
  }
}

/**
 * One scan pass.
 *
 * `dryRun` collects what WOULD be archived without touching anything; the
 * scheduler always uses the live mode, the settings API exposes both.
 */
export async function scanAndArchive(ctx: AutoArchiveCtx, opts: { dryRun: boolean }): Promise<ScanResult> {
  const persistence = ctx.get<SessionPersistence>("sessionPersistence");
  const registry = ctx.get<WorkspaceRegistry>("workspaceRegistry");
  const agents = ctx.get<AgentsService>("agents");
  const query = ctx.get<SessionQueryService>("sessionQuery");
  if (!persistence || typeof persistence.list !== "function") {
    throw new Error("session persistence unavailable");
  }
  if (registry && !Array.isArray(registry.archivedSessionIds)) {
    // Registry exists but never started; treat as empty archive set.
  }

  const config = getConfig(persistence);
  const now = Date.now();
  const idleMs = config.idleDays * 24 * 60 * 60 * 1000;
  const rawArchived = registry && registry.archivedSessionIds;
  const archivedSet = new Set<string>(Array.isArray(rawArchived) ? rawArchived : []);

  const entries = await persistence.list();
  const result: ScanResult = {
    startedAt: now,
    finishedAt: 0,
    dryRun: !!opts.dryRun,
    scanned: 0,
    skippedLive: 0,
    skippedRunning: 0,
    skippedExcluded: 0,
    archivedCount: 0,
    archived: [],
    preview: [],
    errors: []
  };

  const excluded = new Set(config.excludeIds);
  const candidates: Array<{ header: SessionHeader; lastActiveAt: number; idleDays: number }> = [];

  for (const entry of entries) {
    const header = headerOf(entry);
    if (!header) continue;
    if (archivedSet.has(header.id)) continue; // already archived
    result.scanned++;

    if (excluded.has(header.id)) {
      result.skippedExcluded++;
      continue;
    }

    // Never touch a session whose agent holds a live in-memory entry: a
    // running turn would corrupt, and an idle-but-open session may still be
    // in active use even if its file went quiet (e.g. a long goal round).
    const agent = agents && typeof agents.get === "function" ? agents.get(header.id) : undefined;
    if (agent !== undefined && agent !== null) {
      if (agent.status === "running") {
        result.skippedRunning++;
      } else {
        result.skippedLive++;
      }
      continue;
    }

    const lastActiveAt = lastActiveAtOf(persistence, header);
    if (lastActiveAt === null) continue; // unreadable artifact; leave alone
    const idle = now - lastActiveAt;
    if (idle < idleMs) continue;

    candidates.push({
      header,
      lastActiveAt,
      idleDays: Math.floor(idle / (24 * 60 * 60 * 1000))
    });
  }

  // Titles for the report, best-effort.
  const titles = new Map<string, string>();
  if (query && typeof query.readTitleSnapshots === "function" && candidates.length > 0) {
    try {
      const snapshots = await query.readTitleSnapshots(candidates.map((c) => c.header.id));
      for (const s of snapshots || []) {
        if (s && s.status === "fulfilled" && s.value && s.value.title && typeof s.value.title.title === "string") {
          titles.set(s.sessionId, s.value.title.title);
        }
      }
    } catch (e) {
      // titles are cosmetic
    }
  }

  const hits: AutoArchiveHit[] = candidates.map((c) => ({
    id: c.header.id,
    title: titles.get(c.header.id) || null,
    idleDays: c.idleDays,
    lastActiveAt: c.lastActiveAt
  }));
  result.preview = hits;

  if (!opts.dryRun) {
    for (const hit of hits) {
      try {
        const ok = await archiveOne(ctx, hit.id);
        if (ok) {
          result.archived.push(hit);
          result.archivedCount++;
          archivedSet.add(hit.id);
        } else {
          result.errors.push("归档后未在归档集合中找到会话 " + hit.id);
        }
      } catch (e) {
        result.errors.push(hit.id + ": " + String((e && (e as Error).message) || e));
      }
    }
  }

  result.finishedAt = Date.now();
  if (!opts.dryRun) recordRun(persistence, result);
  return result;
}

// ---------------------------------------------------------------------------
// Manual archive support: full session inventory
// ---------------------------------------------------------------------------

/** One not-yet-archived session as shown in the manual archive list. */
export interface SessionOverview {
  id: string;
  title: string | null;
  /** Whole days since last write; null when the artifact is unreadable. */
  idleDays: number | null;
  lastActiveAt: number | null;
  running: boolean;
  /** Present in the in-memory store (kept out of auto-archive). */
  live: boolean;
  excluded: boolean;
  /** Would the NEXT scan archive it? (idle threshold met, not excluded). */
  wouldAutoArchive: boolean;
}

/** Every not-yet-archived session with idle info, for the manual list. */
export async function listAllSessions(ctx: AutoArchiveCtx): Promise<SessionOverview[]> {
  const persistence = ctx.get<SessionPersistence>("sessionPersistence");
  const registry = ctx.get<WorkspaceRegistry>("workspaceRegistry");
  const agents = ctx.get<AgentsService>("agents");
  const query = ctx.get<SessionQueryService>("sessionQuery");
  if (!persistence || typeof persistence.list !== "function") {
    throw new Error("session persistence unavailable");
  }
  const config = getConfig(persistence);
  const excluded = new Set(config.excludeIds);
  const rawArchived = registry && registry.archivedSessionIds;
  const archivedSet = new Set<string>(Array.isArray(rawArchived) ? rawArchived : []);
  const idleMs = config.idleDays * 24 * 60 * 60 * 1000;
  const now = Date.now();

  const entries = await persistence.list();
  const rows: Array<{ id: string; lastActiveAt: number | null; running: boolean; live: boolean }> = [];
  for (const entry of entries) {
    const header = headerOf(entry);
    if (!header || archivedSet.has(header.id)) continue;
    const agent = agents && typeof agents.get === "function" ? agents.get(header.id) : undefined;
    const live = agent !== undefined && agent !== null;
    rows.push({
      id: header.id,
      lastActiveAt: lastActiveAtOf(persistence, header),
      running: !!(live && agent && agent.status === "running"),
      live
    });
  }

  const titles = await resolveTitles(query, rows.map((r) => r.id));

  return rows.map((r) => {
    const idleDays =
      r.lastActiveAt === null ? null : Math.max(0, Math.floor((now - r.lastActiveAt) / (24 * 60 * 60 * 1000)));
    const meetsIdle = r.lastActiveAt !== null && now - r.lastActiveAt >= idleMs;
    return {
      id: r.id,
      title: titles.get(r.id) || null,
      idleDays,
      lastActiveAt: r.lastActiveAt,
      running: r.running,
      live: r.live,
      excluded: excluded.has(r.id),
      wouldAutoArchive: meetsIdle && !excluded.has(r.id) && !r.live && !r.running
    };
  });
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

export interface SchedulerHandle {
  stop(): void;
  /** Run one pass immediately (bypassing enabled=false is NOT allowed). */
  runNow(): Promise<ScanResult>;
  isScanning(): boolean;
  nextRunAt(): number | null;
}

/**
 * Start the periodic auto-archive loop.
 *
 * First pass after a short warm-up (lets the harness finish booting), then
 * every `config.intervalMinutes`. Passes never overlap; a pass is skipped
 * while `config.enabled` is false. The config is re-read from disk before
 * every pass so settings changes apply without a restart.
 */
export function startScheduler(ctx: AutoArchiveCtx, warmupMs: number): SchedulerHandle {
  let stopped = false;
  let scanning = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let nextAt: number | null = null;

  const persistence = () => ctx.get<SessionPersistence>("sessionPersistence");

  function scheduleNext(delayMs: number): void {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    nextAt = Date.now() + delayMs;
    timer = setTimeout(tick, delayMs);
    // Keep the process alive only through the harness's own lifetime; unref
    // would risk never firing if the harness uses a short-lived loop, but the
    // harness host is a long-running Electron main, so a plain handle is fine.
  }

  async function tick(): Promise<void> {
    if (stopped) return;
    const persistenceSvc = persistence();
    const config = persistenceSvc ? getConfig(persistenceSvc) : { ...DEFAULT_CONFIG };
    if (config.enabled && !scanning) {
      scanning = true;
      try {
        const result = await scanAndArchive(ctx, { dryRun: false });
        if (result.archivedCount > 0 || result.errors.length > 0) {
          const log = ctx.logger;
          if (log && typeof log.info === "function") {
            log.info(
              "[dsh-auto-archive] 归档 " + result.archivedCount + " 个闲置会话 (>" + config.idleDays + " 天)",
              result.archived.map((h) => h.id)
            );
          }
        }
        for (const err of result.errors) {
          const log = ctx.logger;
          if (log && typeof log.warn === "function") log.warn("[dsh-auto-archive] " + err);
        }
      } catch (e) {
        const log = ctx.logger;
        if (log && typeof log.warn === "function") {
          log.warn("[dsh-auto-archive] 扫描失败: " + String((e && (e as Error).message) || e));
        }
      } finally {
        scanning = false;
      }
    }
    scheduleNext(Math.max(360, config.intervalMinutes) * 60 * 1000);
  }

  scheduleNext(warmupMs);

  return {
    stop(): void {
      stopped = true;
      nextAt = null;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
    async runNow(): Promise<ScanResult> {
      if (scanning) throw new Error("一次扫描正在进行中，请稍候");
      return scanAndArchive(ctx, { dryRun: false });
    },
    isScanning(): boolean {
      return scanning;
    },
    nextRunAt(): number | null {
      return nextAt;
    }
  };
}
