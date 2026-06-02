"use client";

/**
 * VisionReviewsPanel — universal timeline of every vision / triage consult
 * Claude has made on behalf of this project.
 *
 *   ┌──────────────────────────────────────────────────────────┐
 *   │  Routing summary: Gemini via Kitty (default)             │
 *   │  Peer-VL: fallback only · DeepSeek: log triage           │
 *   ├──────────────────────────────────────────────────────────┤
 *   │  [Gemini 3.1 Pro · kitty_proxy]  19:42 · $0.012 · 6 fr   │
 *   │   Q: "is the AI making moves?"                            │
 *   │   ❌ Cat-Tac-Toe: AI never moves after player turn.       │
 *   │   Frames: frame_001.png frame_002.png … frame_006.png    │
 *   ├──────────────────────────────────────────────────────────┤
 *   │  [DeepSeek V4 · direct]  19:38 · $0.001 · 42 KB log      │
 *   │   severity=error · 3 clusters                             │
 *   │   ▸ NullRef in CatTacToeBoard.cs:142                      │
 *   ├──────────────────────────────────────────────────────────┤
 *   │  [Peer-VL · kitty_proxy]  19:30 · $0.024 · fallback      │
 *   │   ⚠ explicit second-opinion request                       │
 *   └──────────────────────────────────────────────────────────┘
 *
 * Data sources:
 *   - GET /api/vision/history?project=<name>&limit=50 (initial paint)
 *   - WS /api/vision/ws (live updates broadcast on every /review or /triage)
 *   - GET /api/vision/providers (routing summary at top)
 *
 * Surface naming: never show the upstream provider or cloud-platform names.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  AlertTriangle,
  Brain,
  Camera,
  Eye,
  FileText,
  Info,
  Loader2,
  RefreshCw,
  Sparkles,
  Trash2,
  XCircle,
  Zap,
} from "lucide-react";
import { BACKEND } from "@/lib/api";
import type { VisionHistoryEntry, VisionProvidersInfo } from "@/lib/types";

type FilterKind = "all" | "review" | "triage";
type FilterProvider = "all" | "gemini" | "qwen" | "deepseek";

const PROVIDER_COLOR: Record<string, string> = {
  gemini: "text-emerald-400 border-emerald-500/40 bg-emerald-500/10",
  qwen: "text-amber-400 border-amber-500/40 bg-amber-500/10",
  deepseek: "text-sky-400 border-sky-500/40 bg-sky-500/10",
};

// Display-only relabeling — the underlying routing key stays as-is.
const PROVIDER_LABEL: Record<string, string> = {
  qwen: "peer",
};

const SEVERITY_COLOR: Record<string, string> = {
  info: "text-text-dim",
  warning: "text-warn",
  error: "text-err",
  fatal: "text-err font-bold",
};

export default function VisionReviewsPanel({
  projectName = "default",
}: {
  projectName?: string;
}) {
  const [entries, setEntries] = useState<VisionHistoryEntry[]>([]);
  const [providers, setProviders] = useState<VisionProvidersInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filterKind, setFilterKind] = useState<FilterKind>("all");
  const [filterProvider, setFilterProvider] = useState<FilterProvider>("all");
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [wsState, setWsState] = useState<"connecting" | "open" | "closed">("connecting");
  const wsRef = useRef<WebSocket | null>(null);

  // ---- Initial history fetch ----------------------------------------------
  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(
        `${BACKEND}/api/vision/history?project=${encodeURIComponent(
          projectName,
        )}&limit=50`,
      );
      if (!r.ok) {
        setError(`HTTP ${r.status}`);
        setLoading(false);
        return;
      }
      const data = await r.json();
      setEntries(data.entries ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "fetch failed");
    } finally {
      setLoading(false);
    }
  }, [projectName]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // ---- /providers (routing summary) ---------------------------------------
  useEffect(() => {
    fetch(`${BACKEND}/api/vision/providers`)
      .then((r) => (r.ok ? r.json() : null))
      .then(setProviders)
      .catch(() => setProviders(null));
  }, []);

  // ---- WebSocket live stream ----------------------------------------------
  useEffect(() => {
    const wsUrl = BACKEND.replace(/^http/, "ws") + "/api/vision/ws";
    let cancelled = false;

    function connect() {
      if (cancelled) return;
      setWsState("connecting");
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;
      ws.onopen = () => {
        if (cancelled) return;
        setWsState("open");
      };
      ws.onmessage = (e) => {
        if (cancelled) return;
        try {
          const entry = JSON.parse(e.data) as VisionHistoryEntry;
          // Drop entries for other projects so the panel stays scoped.
          if (entry.project && entry.project !== projectName) return;
          setEntries((prev) => [entry, ...prev].slice(0, 100));
        } catch {
          /* ignore malformed */
        }
      };
      ws.onclose = () => {
        if (cancelled) return;
        setWsState("closed");
        // Auto-reconnect after 3s so live updates resume when backend hops.
        setTimeout(connect, 3000);
      };
      ws.onerror = () => {
        /* onclose fires next */
      };
      // Keep-alive ping so intermediaries don't time us out.
      const ping = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(JSON.stringify({ type: "ping" }));
          } catch {
            /* ignore */
          }
        } else {
          clearInterval(ping);
        }
      }, 25_000);
    }

    connect();
    return () => {
      cancelled = true;
      wsRef.current?.close();
    };
  }, [projectName]);

  // ---- Filtered view ------------------------------------------------------
  const filtered = useMemo(() => {
    return entries.filter((e) => {
      if (filterKind !== "all" && e.type !== filterKind) return false;
      if (filterProvider !== "all" && e.provider !== filterProvider) return false;
      return true;
    });
  }, [entries, filterKind, filterProvider]);

  // ---- Aggregate stats ----------------------------------------------------
  const stats = useMemo(() => {
    let totalCost = 0;
    let geminiCount = 0;
    let qwenCount = 0;
    let deepseekCount = 0;
    for (const e of entries) {
      totalCost += e.cost_usd ?? 0;
      if (e.provider === "gemini") geminiCount++;
      else if (e.provider === "qwen") qwenCount++;
      else if (e.provider === "deepseek") deepseekCount++;
    }
    return { totalCost, geminiCount, qwenCount, deepseekCount };
  }, [entries]);

  // ---- Clear history ------------------------------------------------------
  async function clearHistory() {
    try {
      await fetch(
        `${BACKEND}/api/vision/history?project=${encodeURIComponent(projectName)}`,
        { method: "DELETE" },
      );
      setEntries([]);
    } catch {
      /* ignore */
    }
  }

  function toggleExpand(idx: number) {
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  }

  // ---- Provider routing summary -------------------------------------------
  const geminiTransport = providers?.providers?.gemini?.transport ?? "kitty_proxy";
  const geminiModel = providers?.providers?.gemini?.model ?? "gemini-3.1-pro-preview";

  return (
    <div className="h-full w-full flex flex-col bg-bg text-text text-sm">
      {/* ---- HEADER: routing summary + stats ---------------------------- */}
      <div className="border-b border-line p-3 space-y-2">
        <div className="flex items-center gap-2">
          <Eye className="h-4 w-4 text-accent" />
          <span className="text-xs font-semibold uppercase tracking-wider">
            Vision Reviews
          </span>
          <span className="ml-auto text-[10px] text-text-dim">
            project: {projectName}
          </span>
          <span
            className={[
              "text-[10px] font-mono px-1.5 py-0.5 rounded",
              wsState === "open"
                ? "text-emerald-400 bg-emerald-500/10"
                : wsState === "connecting"
                  ? "text-text-dim bg-bg-subtle"
                  : "text-err bg-err/10",
            ].join(" ")}
            title={`Live updates: WebSocket ${wsState}`}
          >
            ● {wsState === "open" ? "live" : wsState}
          </span>
        </div>

        {/* Routing pills */}
        <div className="flex flex-wrap gap-1.5 text-[10px]">
          <span
            className={[
              "px-2 py-0.5 rounded border font-mono",
              PROVIDER_COLOR.gemini,
            ].join(" ")}
            title={`Default. ${
              geminiTransport === "kitty_proxy"
                ? "Routed through Kitty App (no Google Cloud setup needed)."
                : "Direct Google AI Studio."
            }`}
          >
            <Sparkles className="h-2.5 w-2.5 inline mr-1" />
            Gemini · {geminiTransport === "kitty_proxy" ? "via Kitty" : "direct"}
          </span>
          <span
            className={[
              "px-2 py-0.5 rounded border font-mono",
              PROVIDER_COLOR.deepseek,
            ].join(" ")}
            title="Log/console/build triage. Returns structured JSON clusters."
          >
            <FileText className="h-2.5 w-2.5 inline mr-1" />
            DeepSeek · triage
          </span>
          <span
            className={[
              "px-2 py-0.5 rounded border font-mono opacity-70",
              PROVIDER_COLOR.qwen,
            ].join(" ")}
            title="Fallback only. Claude must explicitly request a second-opinion."
          >
            <Brain className="h-2.5 w-2.5 inline mr-1" />
            Peer-VL · fallback
          </span>
        </div>

        {/* Aggregate stats */}
        <div className="flex items-center gap-3 text-[10px] text-text-dim font-mono">
          <span>{entries.length} call{entries.length !== 1 ? "s" : ""}</span>
          <span>·</span>
          <span>${stats.totalCost.toFixed(4)} total</span>
          <span>·</span>
          <span className="text-emerald-400">{stats.geminiCount} gemini</span>
          <span className="text-sky-400">{stats.deepseekCount} triage</span>
          {stats.qwenCount > 0 && (
            <span className="text-amber-400">{stats.qwenCount} peer-fallback</span>
          )}
          <button
            onClick={refresh}
            className="ml-auto opacity-60 hover:opacity-100"
            title="Refresh history"
          >
            <RefreshCw className="h-3 w-3" />
          </button>
          {entries.length > 0 && (
            <button
              onClick={clearHistory}
              className="opacity-60 hover:opacity-100 text-err"
              title="Clear history for this project"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          )}
        </div>

        {/* Filters */}
        <div className="flex items-center gap-2 text-[10px]">
          <span className="text-text-dim">filter:</span>
          <FilterChip
            label="all"
            active={filterKind === "all"}
            onClick={() => setFilterKind("all")}
          />
          <FilterChip
            label="reviews"
            active={filterKind === "review"}
            onClick={() => setFilterKind("review")}
          />
          <FilterChip
            label="triage"
            active={filterKind === "triage"}
            onClick={() => setFilterKind("triage")}
          />
          <span className="text-text-dim ml-2">·</span>
          <FilterChip
            label="all"
            active={filterProvider === "all"}
            onClick={() => setFilterProvider("all")}
          />
          <FilterChip
            label="gemini"
            active={filterProvider === "gemini"}
            onClick={() => setFilterProvider("gemini")}
            colorClass="text-emerald-400"
          />
          <FilterChip
            label="peer"
            active={filterProvider === "qwen"}
            onClick={() => setFilterProvider("qwen")}
            colorClass="text-amber-400"
          />
          <FilterChip
            label="deepseek"
            active={filterProvider === "deepseek"}
            onClick={() => setFilterProvider("deepseek")}
            colorClass="text-sky-400"
          />
        </div>
      </div>

      {/* ---- TIMELINE ---------------------------------------------------- */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {loading ? (
          <div className="flex items-center justify-center py-8 text-text-dim">
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
            <span className="text-xs">Loading history…</span>
          </div>
        ) : error ? (
          <div className="text-xs text-err text-center py-4">
            ⚠ Failed to load: {error}
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            hasAny={entries.length > 0}
            geminiModel={geminiModel}
            geminiTransport={geminiTransport}
          />
        ) : (
          filtered.map((entry, i) => (
            <TimelineCard
              key={`${entry.ts}-${i}`}
              entry={entry}
              expanded={expanded.has(i)}
              onToggle={() => toggleExpand(i)}
            />
          ))
        )}
      </div>
    </div>
  );
}

// ============================================================================
// TimelineCard — single entry visualization
// ============================================================================

function TimelineCard({
  entry,
  expanded,
  onToggle,
}: {
  entry: VisionHistoryEntry;
  expanded: boolean;
  onToggle: () => void;
}) {
  const colorClass = PROVIDER_COLOR[entry.provider] ?? PROVIDER_COLOR.gemini;
  const date = new Date(entry.ts * 1000);
  const timeStr = date.toLocaleTimeString();

  const ProviderIcon =
    entry.provider === "gemini"
      ? Sparkles
      : entry.provider === "qwen"
        ? Brain
        : FileText;

  return (
    <div
      className={`border ${
        colorClass.split(" ")[1]
      } rounded bg-bg-panel overflow-hidden`}
    >
      {/* Header row — always visible */}
      <button
        onClick={onToggle}
        className="w-full text-left px-2 py-1.5 hover:bg-bg-subtle/50 transition-colors"
      >
        <div className="flex items-center gap-2 text-[10px] font-mono">
          <span
            className={`px-1.5 py-0.5 rounded ${colorClass} flex items-center gap-1`}
          >
            <ProviderIcon className="h-2.5 w-2.5" />
            {PROVIDER_LABEL[entry.provider] ?? entry.provider}
          </span>
          <span className="text-text-dim">{entry.model}</span>
          <span className="text-text-subtle">·</span>
          <span className="text-text-dim">
            {entry.transport === "kitty_proxy"
              ? "kitty"
              : entry.transport === "direct_google_ai"
                ? "direct AI"
                : "direct"}
          </span>
          <span className="text-text-subtle ml-auto">{timeStr}</span>
          <span className="text-text-dim">
            ${(entry.cost_usd ?? 0).toFixed(4)}
          </span>
        </div>

        {/* Summary line */}
        <div className="mt-1 text-xs">
          {entry.type === "review" ? (
            <ReviewSummary entry={entry} />
          ) : (
            <TriageSummary entry={entry} />
          )}
        </div>
      </button>

      {/* Expanded body */}
      {expanded && (
        <div className="border-t border-line/50 px-3 py-2 text-[11px] space-y-2">
          {entry.type === "review" ? (
            <ReviewExpanded entry={entry} />
          ) : (
            <TriageExpanded entry={entry} />
          )}
        </div>
      )}
    </div>
  );
}

// ---- Review summary / expanded ---------------------------------------------

function ReviewSummary({ entry }: { entry: VisionHistoryEntry }) {
  const frameCount = entry.frame_count ?? entry.frames?.length ?? 0;
  const first = (entry.analysis ?? "").trim().split("\n")[0]?.slice(0, 160) ?? "";
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-text-dim font-mono text-[10px] shrink-0">
        <Camera className="h-3 w-3 inline mr-0.5" />
        {frameCount} fr
      </span>
      <span className="text-text break-words line-clamp-2">{first || "(no analysis)"}</span>
    </div>
  );
}

function ReviewExpanded({ entry }: { entry: VisionHistoryEntry }) {
  return (
    <>
      {entry.question && (
        <div className="text-text-dim italic">
          <span className="text-text-subtle">Q:</span> {entry.question}
        </div>
      )}
      <div className="prose-invert text-xs max-w-none whitespace-pre-wrap break-words">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>
          {entry.analysis ?? "(no analysis)"}
        </ReactMarkdown>
      </div>
      {entry.frames && entry.frames.length > 0 && (
        <div className="pt-1 border-t border-line/30">
          <div className="text-[10px] uppercase tracking-wider text-text-dim mb-1">
            frames ({entry.frames.length})
          </div>
          <div className="flex flex-wrap gap-1">
            {entry.frames.map((f, i) => (
              <span
                key={i}
                className="text-[10px] font-mono bg-bg-subtle border border-line rounded px-1.5 py-0.5"
                title={f}
              >
                {f.split(/[\\/]/).pop() ?? f}
              </span>
            ))}
          </div>
        </div>
      )}
      <div className="flex gap-3 text-[10px] text-text-subtle font-mono pt-1 border-t border-line/30">
        <span>tokens: {entry.tokens?.input ?? 0}+{entry.tokens?.output ?? 0}</span>
        <span>·</span>
        <span>cost: ${(entry.cost_usd ?? 0).toFixed(6)}</span>
      </div>
    </>
  );
}

// ---- Triage summary / expanded ---------------------------------------------

function TriageSummary({ entry }: { entry: VisionHistoryEntry }) {
  const sev = entry.severity ?? "info";
  const SevIcon =
    sev === "fatal" || sev === "error"
      ? XCircle
      : sev === "warning"
        ? AlertTriangle
        : Info;
  return (
    <div className="flex items-baseline gap-2">
      <span
        className={`text-[10px] font-mono shrink-0 ${SEVERITY_COLOR[sev]}`}
        title={`severity ${sev}`}
      >
        <SevIcon className="h-3 w-3 inline mr-0.5" />
        {sev}
      </span>
      <span className="text-text-dim font-mono text-[10px] shrink-0">
        {entry.cluster_count ?? 0} clusters · {formatBytes(entry.log_chars ?? 0)}
      </span>
      <span className="text-text break-words line-clamp-2">
        {entry.summary ?? "(no summary)"}
      </span>
    </div>
  );
}

function TriageExpanded({ entry }: { entry: VisionHistoryEntry }) {
  return (
    <>
      {entry.context_hint && (
        <div className="text-text-dim italic">
          <span className="text-text-subtle">context:</span> {entry.context_hint}
        </div>
      )}
      <div className="text-xs">
        <span className="text-text-subtle uppercase tracking-wider text-[10px] mr-2">
          summary
        </span>
        <span className="text-text">{entry.summary ?? "(empty)"}</span>
      </div>
      {entry.top_actions && entry.top_actions.length > 0 && (
        <div className="space-y-0.5">
          <div className="text-[10px] uppercase tracking-wider text-text-dim">
            top actions
          </div>
          <ol className="list-decimal list-inside text-[11px] space-y-0.5 text-text">
            {entry.top_actions.map((a, i) => (
              <li key={i} className="break-words">
                {a}
              </li>
            ))}
          </ol>
        </div>
      )}
      <div className="flex gap-3 text-[10px] text-text-subtle font-mono pt-1 border-t border-line/30">
        <span>log: {formatBytes(entry.log_chars ?? 0)}</span>
        <span>·</span>
        <span>tokens: {entry.tokens?.input ?? 0}+{entry.tokens?.output ?? 0}</span>
        <span>·</span>
        <span>cost: ${(entry.cost_usd ?? 0).toFixed(6)}</span>
      </div>
    </>
  );
}

// ---- Empty state ------------------------------------------------------------

function EmptyState({
  hasAny,
  geminiModel,
  geminiTransport,
}: {
  hasAny: boolean;
  geminiModel: string;
  geminiTransport: string;
}) {
  if (hasAny) {
    return (
      <div className="text-[11px] text-text-dim italic text-center py-6">
        No entries match the active filter.
      </div>
    );
  }
  return (
    <div className="text-[11px] text-text-dim text-center py-8 space-y-2">
      <div>
        <Eye className="h-5 w-5 inline-block mb-1 opacity-60" />
      </div>
      <div>
        No vision consults yet for this project. As Claude reviews screenshots
        or triages logs, each call appears here in real time.
      </div>
      <div className="text-text-subtle pt-2 text-[10px]">
        <code>{geminiModel}</code>{" "}
        {geminiTransport === "kitty_proxy"
          ? "(via Kitty App — no Google Cloud setup needed)"
          : "(direct Google AI)"}
      </div>
    </div>
  );
}

// ---- Tiny helpers -----------------------------------------------------------

function FilterChip({
  label,
  active,
  onClick,
  colorClass,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  colorClass?: string;
}) {
  return (
    <button
      onClick={onClick}
      className={[
        "px-1.5 py-0.5 rounded border text-[10px] font-mono transition-colors",
        active
          ? "border-accent bg-accent/10 text-accent"
          : `border-line/50 hover:border-line ${colorClass ?? "text-text-dim hover:text-text"}`,
      ].join(" ")}
    >
      {label}
    </button>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

// Unused import suppression — Zap is part of barrel re-exports if extended.
void Zap;
