/**
 * Browser half of the archived-sessions page (@muwinds/dsh-archived-sessions).
 *
 * Runs inside the harness web profile's __ModuleLoader__ bundle: this module is
 * compiled to CommonJS by `tsc -p tsconfig.client.json` and then wrapped into
 * `window.__ModuleLoader__.load({ id, factory: (require) => {...} })` by
 * scripts/build-client.mjs. The compiled body may use `require` and `exports`
 * freely because both are in scope inside the factory.
 */
import * as React from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Browser-side plugin context (the subset this plugin needs). */
export interface ClientCtx {
  effect(fn: () => () => void, name?: string): void;
  slots: {
    inject(slot: string, fn: () => unknown): void;
    register(desc: Record<string, unknown>, render: () => unknown): unknown;
  };
}

export interface ArchivedItem {
  id: string;
  title: string | null;
  createdAt?: number | null;
  cwd?: string | null;
  parentSession?: string | null;
  sizeBytes: number;
  missing: boolean;
  live: boolean;
  running: boolean;
  path: string | null;
}

export interface ListResult {
  items: ArchivedItem[];
  totalBytes: number;
}

export interface DetailMessage {
  seq?: number;
  time?: number;
  role: "user" | "assistant" | "tool";
  text: string;
}

export interface DetailData {
  id: string;
  createdAt?: number | null;
  cwd?: string | null;
  parentSession?: string | null;
  totalEvents: number;
  messageCount: number;
  truncated: boolean;
  messages: DetailMessage[];
}

export interface DetailState {
  id: string;
  loading: boolean;
  data: DetailData | null;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Auto-archive types
// ---------------------------------------------------------------------------

export interface AutoConfig {
  enabled: boolean;
  idleDays: number;
  intervalMinutes: number;
  excludeIds: string[];
}

export interface AutoHit {
  id: string;
  title: string | null;
  idleDays: number;
  lastActiveAt: number | null;
}

export interface AutoRun {
  startedAt: number;
  finishedAt: number;
  dryRun: boolean;
  scanned: number;
  archivedCount: number;
  archived: AutoHit[];
  /** Present on dry-run scans: every session that matched the idle rule. */
  preview?: AutoHit[];
  errors: string[];
}

export interface AutoPreview {
  total: number;
  items: AutoHit[];
  errors: string[];
}

export interface AutoStatus {
  config: AutoConfig;
  lastRun: AutoRun | null;
  nextRunAt: number | null;
  scanning: boolean;
  preview: AutoPreview;
}

export interface SessionOverview {
  id: string;
  title: string | null;
  idleDays: number | null;
  lastActiveAt: number | null;
  running: boolean;
  live: boolean;
  excluded: boolean;
  wouldAutoArchive: boolean;
}

interface ApiEnvelope {
  error?: string;
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const STYLE_ID = "dsw-arch-style";
const CSS = [
  ".dsw-arch-page{font-size:13px;padding:2px 2px 24px;}",
  ".dsw-arch-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px;}",
  ".dsw-arch-page-title{font-weight:600;color:var(--dsw-alias-label-primary);}",
  ".dsw-arch-meta{color:var(--dsw-alias-label-secondary);font-size:12px;}",
  ".dsw-arch-btn{background:transparent;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);border-radius:6px;padding:3px 7px;font-size:12px;cursor:pointer;margin-right:4px;white-space:nowrap;}",
  ".dsw-arch-btn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);}",
  ".dsw-arch-btn-danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary);}",
  ".dsw-arch-btn:disabled{opacity:0.45;cursor:default;}",
  ".dsw-arch-table{width:100%;border-collapse:collapse;table-layout:fixed;}",
  ".dsw-arch-table th{text-align:left;font-weight:600;color:var(--dsw-alias-label-secondary);font-size:12px;padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);}",
  ".dsw-arch-table td{padding:8px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);vertical-align:top;}",
  ".dsw-arch-table tr:last-child td{border-bottom:none;}",
  ".dsw-arch-table th:nth-child(1),.dsw-arch-table td:nth-child(1){width:32px;text-align:center;padding-left:2px;padding-right:2px;}",
  ".dsw-arch-table th:nth-child(2),.dsw-arch-table td:nth-child(2){width:auto;}",
  ".dsw-arch-table th:nth-child(3),.dsw-arch-table td:nth-child(3){width:104px;}",
  ".dsw-arch-table th:nth-child(4),.dsw-arch-table td:nth-child(4){width:92px;padding-left:2px;padding-right:2px;}",
  ".dsw-arch-size{white-space:nowrap;}",
  ".dsw-arch-actions{white-space:nowrap;}",
  ".dsw-arch-title-click{cursor:pointer;color:var(--dsw-alias-label-primary);}",
  ".dsw-arch-title-click:hover{text-decoration:underline;}",
  ".dsw-arch-id,.dsw-arch-path{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-secondary);word-break:break-all;margin-top:2px;}",
  ".dsw-arch-selectbar{display:flex;align-items:center;gap:8px;padding:6px 10px;margin-bottom:10px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;font-size:12px;flex-wrap:wrap;}",
  ".dsw-arch-selectbar .dsw-arch-meta{flex:1;}",
  ".dsw-arch-detail{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:10px 12px;font-size:12px;text-align:left;}",
  ".dsw-arch-detail-head{margin-bottom:8px;}",
  ".dsw-arch-detail-body{max-height:360px;overflow:auto;}",
  ".dsw-arch-msg{margin-bottom:8px;white-space:pre-wrap;word-break:break-word;}",
  ".dsw-arch-msg-role{display:inline-block;font-weight:600;margin-right:6px;}",
  ".dsw-arch-msg-user .dsw-arch-msg-role{color:var(--dsw-alias-label-primary);}",
  ".dsw-arch-msg-assistant .dsw-arch-msg-role{color:var(--dsw-alias-brand-primary);}",
  ".dsw-arch-msg-tool .dsw-arch-msg-role{color:var(--dsw-alias-state-warn-primary);}",
  ".dsw-arch-msg-time{color:var(--dsw-alias-label-secondary);font-size:11px;margin-left:6px;}",
  ".dsw-arch-detail-note{color:var(--dsw-alias-label-secondary);font-size:11px;margin-bottom:8px;}",
  ".dsw-arch-error{color:var(--dsw-alias-state-error-primary);font-size:12px;margin-bottom:8px;}",
  ".dsw-arch-empty{color:var(--dsw-alias-label-secondary);padding:28px 0;text-align:center;}",
  ".dsw-arch-badge{display:inline-block;border:1px solid var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary);border-radius:4px;padding:1px 6px;font-size:11px;}",
  ".dsw-auto-card{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:10px 12px;margin-bottom:12px;font-size:12px;}",
  ".dsw-auto-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:6px;}",
  ".dsw-auto-title{font-weight:600;color:var(--dsw-alias-label-primary);font-size:13px;}",
  ".dsw-auto-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:6px 0;}",
  ".dsw-auto-input{background:var(--dsw-alias-bg-input,transparent);border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);border-radius:6px;padding:3px 6px;font-size:12px;width:64px;}",
  ".dsw-auto-status{color:var(--dsw-alias-label-secondary);margin:4px 0;}",
  ".dsw-auto-preview{margin-top:6px;border-top:1px dashed var(--dsw-alias-border-l1);padding-top:6px;}",
  ".dsw-auto-preview-item{display:flex;gap:8px;align-items:baseline;padding:2px 0;}",
  ".dsw-auto-preview-title{color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;}",
  ".dsw-auto-preview-idle{color:var(--dsw-alias-label-secondary);white-space:nowrap;}",
  ".dsw-auto-sesslist{margin-top:8px;border-top:1px solid var(--dsw-alias-border-l1);padding-top:8px;max-height:320px;overflow:auto;}",
  ".dsw-auto-sess{display:flex;gap:8px;align-items:center;padding:3px 0;font-size:12px;}",
  ".dsw-auto-sess-title{color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;}",
  ".dsw-auto-sess-meta{color:var(--dsw-alias-label-secondary);white-space:nowrap;font-size:11px;}",
  ".dsw-auto-sess-btns{white-space:nowrap;}"
].join("");

function ensureStyle(): void {
  try {
    if (document.getElementById(STYLE_ID)) return;
    const el = document.createElement("style");
    el.id = STYLE_ID;
    el.textContent = CSS;
    document.head.appendChild(el);
  } catch (e) {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

function api<T>(action: string, args?: Record<string, unknown>): Promise<T> {
  return fetch("/dsh-archived/" + action, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args || {})
  })
    .then((res) => res.json().catch(() => null))
    .then((payload: T | ApiEnvelope | null) => {
      if (payload === null || typeof payload !== "object") {
        throw new Error("请求失败：服务返回了无效响应");
      }
      if ("error" in payload && typeof payload.error === "string") {
        throw new Error(payload.error);
      }
      return payload as T;
    });
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function fmtSize(bytes: number): string {
  const n = Number(bytes) || 0;
  if (n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v = v / 1024;
    i = i + 1;
  }
  return (i === 0 ? String(Math.round(v)) : v.toFixed(1)) + " " + units[i];
}

function fmtTime(ms?: number | null): string {
  if (!ms) return "—";
  try {
    return new Date(ms).toLocaleString();
  } catch (e) {
    return String(ms);
  }
}

// ---------------------------------------------------------------------------
// Auto-archive settings card
// ---------------------------------------------------------------------------

/**
 * Self-contained settings card for the background auto-archiver. Owns its
 * fetching state so the main archive list stays independent; `onChanged` lets
 * the parent reload after a live scan moved sessions into the archive.
 */
function AutoArchiveCard({ onChanged }: { onChanged: () => void }) {
  const [loaded, setLoaded] = React.useState(false);
  const [status, setStatus] = React.useState<AutoStatus | null>(null);
  const [enabled, setEnabled] = React.useState(false);
  const [idleDays, setIdleDays] = React.useState("14");
  // Display unit is DAYS; the stored config stays in minutes (1 day = 1440).
  const [intervalDays, setIntervalDays] = React.useState("1");
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [showPreview, setShowPreview] = React.useState(false);
  const [scanArmed, setScanArmed] = React.useState(false);
  const [showSessions, setShowSessions] = React.useState(false);
  const [sessions, setSessions] = React.useState<SessionOverview[] | null>(null);
  const [sessBusy, setSessBusy] = React.useState<string | null>(null);

  function minutesToDays(minutes: number): string {
    const days = Math.round((minutes / 1440) * 100) / 100;
    return String(days);
  }

  function describe(err: unknown): string {
    if (err && typeof err === "object" && typeof (err as { message?: unknown }).message === "string") {
      return (err as { message: string }).message;
    }
    return String(err);
  }

  function load(): void {
    api<AutoStatus>("auto-status", {})
      .then((res) => {
        setStatus(res);
        if (res && res.config) {
          setEnabled(!!res.config.enabled);
          setIdleDays(String(res.config.idleDays));
          setIntervalDays(minutesToDays(res.config.intervalMinutes));
        }
        setLoaded(true);
      })
      .catch((err) => {
        setError(describe(err));
        setLoaded(true);
      });
  }

  React.useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function save(nextEnabled: boolean): void {
    setBusy("save");
    setError(null);
    setNotice(null);
    const payload: Partial<AutoConfig> = {
      enabled: nextEnabled,
      idleDays: Math.max(0.5, Number(idleDays) || 14),
      intervalMinutes: Math.max(0.25, Number(intervalDays) || 1) * 1440
    };
    api<{ config: AutoConfig }>("auto-config-set", payload)
      .then((res) => {
        if (res && res.config) {
          setEnabled(!!res.config.enabled);
          setIdleDays(String(res.config.idleDays));
          setIntervalDays(minutesToDays(res.config.intervalMinutes));
        }
        setNotice(nextEnabled ? "自动归档已开启" : "自动归档已关闭");
        setBusy(null);
        load();
      })
      .catch((err) => {
        setError(describe(err));
        setBusy(null);
      });
  }

  // ---- manual per-session operations ----
  function loadSessions(): void {
    setSessBusy("load");
    api<{ items: SessionOverview[] }>("auto-sessions", {})
      .then((res) => {
        setSessions(Array.isArray(res.items) ? res.items : []);
        setSessBusy(null);
      })
      .catch((err) => {
        setError(describe(err));
        setSessBusy(null);
      });
  }

  function toggleSessions(): void {
    const next = !showSessions;
    setShowSessions(next);
    if (next && sessions === null) loadSessions();
  }

  function archiveOneNow(id: string): void {
    setSessBusy("archive:" + id);
    setError(null);
    api<unknown>("auto-archive-one", { sessionId: id })
      .then(() => {
        setNotice("已归档 1 个会话");
        loadSessions();
        onChanged();
      })
      .catch((err) => setError(describe(err)))
      .finally(() => setSessBusy(null));
  }

  function setExcludedNow(id: string, add: boolean): void {
    setSessBusy("exclude:" + id);
    setError(null);
    api<unknown>("auto-exclude", { sessionId: id, add })
      .then(() => loadSessions())
      .catch((err) => setError(describe(err)))
      .finally(() => setSessBusy(null));
  }

  function runScan(dryRun: boolean): void {
    setBusy(dryRun ? "preview" : "scan");
    setError(null);
    setNotice(null);
    api<AutoRun>("auto-scan", { dryRun })
      .then((res) => {
        const count = res && Array.isArray(res.archived) ? res.archived.length : 0;
        setNotice(
          dryRun
            ? "预览完成：当前有 " + (res && res.preview ? res.preview.length : 0) + " 个闲置会话待归档"
            : "扫描完成：已归档 " + count + " 个会话" + (res && res.errors && res.errors.length > 0 ? "，" + res.errors.length + " 个失败" : "")
        );
        setScanArmed(false);
        setShowPreview(dryRun);
        setBusy(null);
        load();
        if (!dryRun) onChanged();
      })
      .catch((err) => {
        setError(describe(err));
        setBusy(null);
      });
  }

  const cfg = status && status.config ? status.config : null;
  const preview = status && status.preview ? status.preview : { total: 0, items: [], errors: [] };
  const lastRun = status ? status.lastRun : null;
  const anyBusy = busy !== null;

  const statusLine = !loaded
    ? "加载中…"
    : [
        cfg && cfg.enabled ? "已启用" : "未启用",
        cfg ? "闲置 ≥ " + cfg.idleDays + " 天归档" : null,
        status && status.nextRunAt ? "下次扫描 " + fmtTime(status.nextRunAt) : null,
        lastRun ? "上次 " + fmtTime(lastRun.finishedAt) + " 归档 " + lastRun.archivedCount + " 个" : "尚未自动扫描过"
      ]
        .filter(Boolean)
        .join(" · ");

  const previewEl = showPreview ? (
    <div className="dsw-auto-preview">
      {preview.total === 0 ? (
        <div className="dsw-auto-status">当前没有满足闲置条件的会话。</div>
      ) : (
        <React.Fragment>
          <div className="dsw-auto-status">
            将被归档 {preview.total} 个会话
            {preview.items.length < preview.total ? "（仅显示前 " + preview.items.length + " 条）" : ""}：
          </div>
          {preview.items.slice(0, 10).map((hit) => (
            <div className="dsw-auto-preview-item" key={hit.id}>
              <span className="dsw-auto-preview-title">{hit.title || hit.id}</span>
              <span className="dsw-auto-preview-idle">闲置 {hit.idleDays} 天</span>
            </div>
          ))}
          {preview.items.length > 10 ? (
            <div className="dsw-auto-status">…及其他 {preview.items.length - 10} 个</div>
          ) : null}
        </React.Fragment>
      )}
    </div>
  ) : null;

  return (
    <div className="dsw-auto-card">
      <div className="dsw-auto-head">
        <span className="dsw-auto-title">自动归档</span>
        <label style={{ display: "flex", alignItems: "center", gap: "4px", cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={enabled}
            disabled={anyBusy}
            onChange={(e) => save(e.target.checked)}
          />
          启用
        </label>
        <span>闲置</span>
        <input
          className="dsw-auto-input"
          type="number"
          min="0.5"
          step="0.5"
          value={idleDays}
          disabled={anyBusy}
          onChange={(e) => setIdleDays(e.target.value)}
        />
        <span>天以上自动归档 · 每</span>
        <input
          className="dsw-auto-input"
          type="number"
          min="0.25"
          step="0.25"
          value={intervalDays}
          disabled={anyBusy}
          onChange={(e) => setIntervalDays(e.target.value)}
        />
        <span>天扫描一次</span>
        <button className="dsw-arch-btn" disabled={anyBusy} onClick={() => save(enabled)}>保存设置</button>
      </div>
      <div className="dsw-auto-status">{statusLine}</div>
      <div className="dsw-auto-row">
        <button className="dsw-arch-btn" disabled={anyBusy} onClick={() => runScan(true)}>
          {busy === "preview" ? "预览中…" : "立即扫描（仅预览）"}
        </button>
        {scanArmed ? (
          <React.Fragment>
            <span className="dsw-auto-status" style={{ color: "var(--dsw-alias-state-warn-primary)" }}>
              确认现在归档所有闲置会话？
            </span>
            <button className="dsw-arch-btn dsw-arch-btn-danger" disabled={anyBusy} onClick={() => runScan(false)}>
              确认归档
            </button>
            <button className="dsw-arch-btn" disabled={anyBusy} onClick={() => setScanArmed(false)}>取消</button>
          </React.Fragment>
        ) : (
          <button className="dsw-arch-btn" disabled={anyBusy} onClick={() => setScanArmed(true)}>
            {busy === "scan" ? "扫描中…" : "立即扫描并归档"}
          </button>
        )}
      </div>
      {notice ? <div className="dsw-auto-status" style={{ color: "var(--dsw-alias-state-success-primary, var(--dsw-alias-brand-primary))" }}>{notice}</div> : null}
      {error ? <div className="dsw-arch-error">{error}</div> : null}
      {previewEl}
      <div className="dsw-auto-row" style={{ marginTop: "8px", borderTop: "1px solid var(--dsw-alias-border-l1)", paddingTop: "8px" }}>
        <button className="dsw-arch-btn" disabled={sessBusy === "load"} onClick={() => toggleSessions()}>
          {showSessions ? "收起会话列表" : "手动归档 / 排除会话…"}
        </button>
        {showSessions && sessions !== null ? (
          <span className="dsw-auto-status">共 {sessions.length} 个未归档会话</span>
        ) : null}
      </div>
      {showSessions ? (
        <div className="dsw-auto-sesslist">
          {sessions === null ? (
            <div className="dsw-auto-status">{sessBusy === "load" ? "加载中…" : ""}</div>
          ) : sessions.length === 0 ? (
            <div className="dsw-auto-status">没有未归档的会话。</div>
          ) : (
            sessions
              .slice()
              .sort((a, b) => {
                if (a.wouldAutoArchive !== b.wouldAutoArchive) return a.wouldAutoArchive ? -1 : 1;
                return (b.idleDays ?? -1) - (a.idleDays ?? -1);
              })
              .slice(0, 200)
              .map((s) => (
                <div className="dsw-auto-sess" key={s.id}>
                  <span className="dsw-auto-sess-title" title={s.id}>
                    {s.title || s.id}
                    {s.excluded ? "（已排除）" : ""}
                    {s.running ? "（运行中）" : ""}
                  </span>
                  <span className="dsw-auto-sess-meta">
                    {s.idleDays === null ? "未知" : "闲置 " + s.idleDays + " 天"}
                    {s.wouldAutoArchive ? " · 将被自动归档" : ""}
                  </span>
                  <span className="dsw-auto-sess-btns">
                    <button
                      className="dsw-arch-btn"
                      disabled={s.running || sessBusy !== null}
                      onClick={() => archiveOneNow(s.id)}
                    >
                      {sessBusy === "archive:" + s.id ? "归档中…" : "归档"}
                    </button>
                    {s.excluded ? (
                      <button className="dsw-arch-btn" disabled={sessBusy !== null} onClick={() => setExcludedNow(s.id, false)}>
                        取消排除
                      </button>
                    ) : (
                      <button className="dsw-arch-btn" disabled={sessBusy !== null} onClick={() => setExcludedNow(s.id, true)}>
                        永不自动归档
                      </button>
                    )}
                  </span>
                </div>
              ))
          )}
          {sessions !== null && sessions.length > 200 ? (
            <div className="dsw-auto-status">仅显示前 200 个，共 {sessions.length} 个。</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

function ArchivedSessionsPage() {
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [items, setItems] = React.useState<ArchivedItem[]>([]);
  const [total, setTotal] = React.useState(0);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [confirmId, setConfirmId] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<string[]>([]);
  const [batchBusy, setBatchBusy] = React.useState<string | null>(null);
  const [batchConfirm, setBatchConfirm] = React.useState<"clear" | "delete" | null>(null);
  const [expandedId, setExpandedId] = React.useState<string | null>(null);
  const [detail, setDetail] = React.useState<DetailState | null>(null);

  function describe(err: unknown): string {
    if (err === null || err === undefined) return String(err);
    if (typeof err === "object" && typeof (err as { message?: unknown }).message === "string") {
      return (err as { message: string }).message;
    }
    return String(err);
  }

  function applyList(res: ListResult): void {
    const next = res && Array.isArray(res.items) ? res.items : [];
    setItems(next);
    setTotal(res && typeof res.totalBytes === "number" ? res.totalBytes : 0);
    const ids: Record<string, boolean> = {};
    for (let i = 0; i < next.length; i++) ids[next[i].id] = true;
    setSelected((sel) => sel.filter((id) => ids[id]));
    if (expandedId && !ids[expandedId]) {
      setExpandedId(null);
      setDetail(null);
    }
  }

  function load(): void {
    setLoading(true);
    setError(null);
    api<ListResult>("list", {})
      .then((res) => {
        applyList(res);
        setLoading(false);
      })
      .catch((err) => {
        setError(describe(err));
        setLoading(false);
      });
  }

  React.useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
 * Refresh the sidebar/workbench views.
 *
 * Nothing to do: the Workspace registry's `setState` lands in the storage
 * domain, which emits `domain/changed`; the host-side workspace feed turns that
 * into an `archived` frame on the browser's follow stream, so the sidebar
 * projection updates itself. (The client `workspaces` service is a subscribe +
 * snapshot model with no `refresh()` to call.)
 */
function refreshViews(): void {}

  function reloadAfterAction(): Promise<void> {
    refreshViews();
    return api<ListResult>("list", {}).then(applyList);
  }

  // ---- row operations ----
  function unarchive(id: string): void {
    setBusy("unarchive:" + id);
    setError(null);
    api<unknown>("unarchive", { sessionId: id })
      .then(() => reloadAfterAction())
      .catch((err) => setError(describe(err)))
      .finally(() => setBusy(null));
  }

  // Single-button two-step delete: 删除 -> 确认 (auto-reverts after 5s).
  //
  // The browser timer globals are available to a plugin bundle (only dynamic
  // packages are guarded), and the host-side timer plugin is not on the browser
  // context, so a native timeout is the right tool here.
  function armDelete(id: string): void {
    setConfirmId(id);
    try {
      window.setTimeout(() => {
        setConfirmId((cur) => (cur === id ? null : cur));
      }, 5000);
    } catch (e) {
      // timer unavailable; stay armed until the user acts
    }
  }

  function doDelete(id: string): void {
    setBusy("delete:" + id);
    setError(null);
    api<unknown>("delete", { sessionId: id })
      .then(() => reloadAfterAction())
      .catch((err) => setError(describe(err)))
      .finally(() => {
        setBusy(null);
        setConfirmId(null);
      });
  }

  // ---- selection ----
  function toggleSelect(id: string): void {
    setSelected((sel) => (sel.includes(id) ? sel.filter((x) => x !== id) : sel.concat([id])));
  }

  function toggleSelectAll(): void {
    setSelected((sel) => (sel.length === items.length ? [] : items.map((item) => item.id)));
  }

  // ---- batch operations ----
  async function runBatch(ids: string[], kind: "delete" | "unarchive"): Promise<void> {
    setBatchBusy(kind);
    setError(null);
    const results: Array<{ id: string; ok: boolean }> = [];
    const method = kind === "delete" ? "delete" : "unarchive";
    for (const id of ids) {
      try {
        await api<unknown>(method, { sessionId: id });
        results.push({ id, ok: true });
      } catch (err) {
        results.push({ id, ok: false });
      }
    }
    const failed = results.filter((r) => !r.ok);
    if (failed.length > 0) {
      setError(
        (kind === "delete" ? "删除" : "释放") +
          "失败 " + failed.length + " 个会话：" + failed.map((f) => f.id).join(", ")
      );
    }
    refreshViews();
    try {
      applyList(await api<ListResult>("list", {}));
    } catch (err) {
      setError(describe(err));
    } finally {
      setBatchBusy(null);
      setBatchConfirm(null);
      setSelected([]);
      setConfirmId(null);
    }
  }

  function releaseAll(): void {
    runBatch(items.map((item) => item.id), "unarchive");
  }
  function clearAll(): void {
    runBatch(items.map((item) => item.id), "delete");
  }
  function releaseSelected(): void {
    runBatch(selected, "unarchive");
  }
  function deleteSelected(): void {
    runBatch(selected, "delete");
  }

  // ---- detail ----
  function toggleDetail(id: string): void {
    if (expandedId === id) {
      setExpandedId(null);
      setDetail(null);
      return;
    }
    setExpandedId(id);
    setDetail({ id, loading: true, data: null, error: null });
    api<DetailData>("detail", { sessionId: id })
      .then((data) => {
        setDetail({ id, loading: false, data, error: null });
      })
      .catch((err) => {
        setDetail({ id, loading: false, data: null, error: describe(err) });
      });
  }

  function detailCell(): React.ReactNode {
    if (!detail) return null;
    if (detail.loading) {
      return <div className="dsw-arch-detail">加载会话内容中…</div>;
    }
    if (detail.error) {
      return <div className="dsw-arch-detail">{detail.error}</div>;
    }
    const d = detail.data;
    if (!d || !Array.isArray(d.messages)) {
      return <div className="dsw-arch-detail">没有可显示的内容</div>;
    }
    const headParts: string[] = [];
    if (d.createdAt) headParts.push("创建于 " + fmtTime(d.createdAt));
    if (d.cwd) headParts.push(d.cwd);
    const msgs = d.messages.map((m, i) => {
      const roleLabel = m.role === "user" ? "用户" : m.role === "assistant" ? "助手" : "工具";
      return (
        <div key={i} className={"dsw-arch-msg dsw-arch-msg-" + m.role}>
          <span className="dsw-arch-msg-role">{roleLabel}</span>
          <span className="dsw-arch-msg-time">{fmtTime(m.time)}</span>
          <div>{m.text}</div>
        </div>
      );
    });
    return (
      <div className="dsw-arch-detail">
        <div className="dsw-arch-detail-head">
          <span className="dsw-arch-page-title">会话内容</span>
          <span className="dsw-arch-meta"> · {headParts.join(" · ")}</span>
        </div>
        <div className="dsw-arch-detail-note">
          共 {d.totalEvents} 条事件，提取 {d.messageCount} 条消息
          {d.truncated ? "（仅显示前 100 条）" : ""}
        </div>
        <div className="dsw-arch-detail-body">{msgs}</div>
      </div>
    );
  }

  // ---- render ----
  const anyBusy = busy !== null || batchBusy !== null;

  const header = (
    <div className="dsw-arch-toolbar">
      <span className="dsw-arch-page-title">归档会话</span>
      <span className="dsw-arch-meta">
        {items.length} 个会话 · 共 {fmtSize(total)}
        {loading ? " · 加载中…" : ""}
        {batchBusy ? " · 批量操作中…" : ""}
      </span>
      <button className="dsw-arch-btn" disabled={anyBusy} onClick={() => load()}>刷新</button>
      <button className="dsw-arch-btn" disabled={anyBusy || items.length === 0} onClick={() => releaseAll()}>一键释放</button>
      <button
        className="dsw-arch-btn dsw-arch-btn-danger"
        disabled={anyBusy || items.length === 0}
        onClick={() => setBatchConfirm("clear")}
      >一键清空</button>
    </div>
  );

  let confirmBar: React.ReactNode = null;
  if (batchConfirm === "clear") {
    confirmBar = (
      <div className="dsw-arch-selectbar">
        <span className="dsw-arch-meta" style={{ color: "var(--dsw-alias-state-warn-primary)" }}>
          确认清空全部 {items.length} 个归档会话？此操作会从硬盘删除且不可恢复。
        </span>
        <button className="dsw-arch-btn dsw-arch-btn-danger" disabled={anyBusy} onClick={() => clearAll()}>确认清空</button>
        <button className="dsw-arch-btn" disabled={anyBusy} onClick={() => setBatchConfirm(null)}>取消</button>
      </div>
    );
  } else if (batchConfirm === "delete") {
    confirmBar = (
      <div className="dsw-arch-selectbar">
        <span className="dsw-arch-meta" style={{ color: "var(--dsw-alias-state-warn-primary)" }}>
          确认删除选中的 {selected.length} 个会话？此操作不可恢复。
        </span>
        <button className="dsw-arch-btn dsw-arch-btn-danger" disabled={anyBusy} onClick={() => deleteSelected()}>确认删除</button>
        <button className="dsw-arch-btn" disabled={anyBusy} onClick={() => setBatchConfirm(null)}>取消</button>
      </div>
    );
  } else if (selected.length > 0) {
    confirmBar = (
      <div className="dsw-arch-selectbar">
        <span className="dsw-arch-meta">已选择 {selected.length} 个会话</span>
        <button className="dsw-arch-btn" disabled={anyBusy} onClick={() => releaseSelected()}>释放选中</button>
        <button className="dsw-arch-btn dsw-arch-btn-danger" disabled={anyBusy} onClick={() => setBatchConfirm("delete")}>删除选中</button>
        <button className="dsw-arch-btn" disabled={anyBusy} onClick={() => setSelected([])}>取消选择</button>
      </div>
    );
  }

  let body: React.ReactNode;
  if (loading && items.length === 0) {
    body = <div className="dsw-arch-empty">加载中…</div>;
  } else if (items.length === 0) {
    body = <div className="dsw-arch-empty">没有已归档的会话</div>;
  } else {
    const allSelected = selected.length === items.length;
    const rows = items.map((item) => {
      const confirming = confirmId === item.id;
      const metaParts: string[] = [];
      if (item.createdAt) metaParts.push("创建于 " + fmtTime(item.createdAt));
      if (item.cwd) metaParts.push(item.cwd);
      const chevron = expandedId === item.id ? "▾ " : "▸ ";
      return (
        <React.Fragment key={item.id}>
          <tr>
            <td>
              <input
                type="checkbox"
                checked={selected.includes(item.id)}
                disabled={anyBusy}
                onChange={() => toggleSelect(item.id)}
              />
            </td>
            <td>
              <div
                className="dsw-arch-title-click"
                title="点击查看会话内容"
                onClick={() => toggleDetail(item.id)}
              >
                {chevron}{item.title || "(无标题)"}
              </div>
              <div className="dsw-arch-id">{item.id}</div>
              <div className="dsw-arch-meta">{metaParts.join(" · ")}</div>
              {item.path ? <div className="dsw-arch-path">{item.path}</div> : null}
            </td>
            <td>
              {item.missing ? (
                <span className="dsw-arch-badge">文件缺失</span>
              ) : (
                <span className="dsw-arch-size">{fmtSize(item.sizeBytes)}</span>
              )}
            </td>
            <td className="dsw-arch-actions">
              <button
                className="dsw-arch-btn"
                disabled={anyBusy || item.missing}
                onClick={() => unarchive(item.id)}
              >释放</button>
              <button
                className="dsw-arch-btn dsw-arch-btn-danger"
                disabled={anyBusy}
                title={confirming ? "再次点击确认删除（5 秒后自动取消）" : "删除（需再次点击确认）"}
                onClick={() => (confirming ? doDelete(item.id) : armDelete(item.id))}
              >{confirming ? "确认" : "删除"}</button>
            </td>
          </tr>
          {expandedId === item.id ? (
            <tr key={item.id + "-detail"}>
              <td colSpan={4} style={{ padding: "4px 10px 10px" }}>{detailCell()}</td>
            </tr>
          ) : null}
        </React.Fragment>
      );
    });
    body = (
      <table className="dsw-arch-table">
        <thead>
          <tr>
            <th>
              <input
                type="checkbox"
                checked={allSelected}
                disabled={anyBusy}
                onChange={() => toggleSelectAll()}
              />
            </th>
            <th>会话</th>
            <th>磁盘占用</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>{rows}</tbody>
      </table>
    );
  }

  const errorEl = error ? <div className="dsw-arch-error">{error}</div> : null;

  return (
    <div className="dsw-arch-page">
      {errorEl}
      <AutoArchiveCard onChanged={load} />
      {header}
      {confirmBar}
      {body}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Plugin body
// ---------------------------------------------------------------------------

/**
 * Client-side service dependencies.
 *
 * `slots` (ui-renderer) is the registration seat. `workspaces`
 * (api-workspace-controller) is the live Workspace/archive projection the page
 * is about — it is injectable on 0.1.5-rc.1 and worth waiting for.
 *
 * Dropped from the original list: `sessions` (provided via
 * `ctx.reflect.provide`, not a Cordis service, so it is not injectable) and
 * `timer` (the page now uses a native `setTimeout`; the host-side timer plugin
 * is not on the browser context).
 */
export const inject = ["slots", "workspaces"];

export function apply(ctx: ClientCtx): void {
  ensureStyle();
  ctx.effect(() => {
    return () => {
      try {
        const el = document.getElementById(STYLE_ID);
        if (el) el.remove();
      } catch (e) {
        // ignore
      }
    };
  }, "ui-archived-sessions: style cleanup");

  ctx.slots.inject("settings.section", () =>
    ctx.slots.register(
      { name: "settings.section", id: "archived-sessions", order: 30, label: () => "归档会话" },
      () => React.createElement(ArchivedSessionsPage)
    )
  );
}
