"use client";

/**
 * QwenChatPanel — second chat surface dedicated to the Claude ↔ peer
 * conversation. Layout:
 *
 *   ┌───────────────────────────────────────────┐
 *   │  Budget control (QwenAssistantPanel)      │  ← commit / live tokens / cancel
 *   ├───────────────────────────────────────────┤
 *   │  Peer transcript                          │
 *   │  ...user / assistant messages...          │
 *   │                                           │
 *   ├───────────────────────────────────────────┤
 *   │  Scratch pad files (peer→Claude reports)  │  ← list + read
 *   ├───────────────────────────────────────────┤
 *   │  [textarea]                       [Send]  │
 *   └───────────────────────────────────────────┘
 *
 * Both Claude (via /api/qwen/peer/send from chat router) and the human
 * (via this panel's textarea) write to the same per-project transcript.
 * The user can therefore watch the two models converse in real time.
 *
 * Surface naming: NEVER show the upstream provider — user sees
 * "Peer via Kitty App" only.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Bot,
  Brain,
  Check,
  FileText,
  Loader2,
  RefreshCw,
  Send,
  Trash2,
  User,
  X,
  Zap,
} from "lucide-react";
import { BACKEND } from "@/lib/api";

// LocalStorage key — single global session id (Qwen budget isn't
// project-scoped on the backend, one session serves any project).
const QWEN_SESSION_KEY = "superagent2d.qwen.session_id";

function readStoredSession(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(QWEN_SESSION_KEY);
  } catch {
    return null;
  }
}

function writeStoredSession(sid: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(QWEN_SESSION_KEY, sid);
  } catch {
    /* quota / private mode — non-fatal */
  }
}

function clearStoredSession() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(QWEN_SESSION_KEY);
  } catch {
    /* ignore */
  }
}

interface Pricing {
  user_visible_rate_usd_per_million: number;
  kitty_markup: number;
  example_reservations: Array<{
    tokens: number;
    kitty_cost_usd: number;
    good_for: string;
  }>;
  burn_protection_default_tokens_per_minute: number;
}

interface Budget {
  session_id: string;
  reserved_tokens: number;
  used_tokens: number;
  remaining_tokens: number;
  cost_usd_billed: number;
  call_count: number;
}

interface PeerMessage {
  role: "user" | "assistant" | "system";
  content: string;
  ts: string;
  image_path?: string | null;
  tokens?: { input: number; output: number };
  cost_usd?: number;
}

interface ScratchFile {
  name: string;
  size_bytes: number;
  modified_at: number;
}

export default function QwenChatPanel({
  projectName = "default",
}: {
  projectName?: string;
}) {
  const [pricing, setPricing] = useState<Pricing | null>(null);
  const [budget, setBudget] = useState<Budget | null>(null);
  const [tokensLimit, setTokensLimit] = useState(500_000);
  const [burn, setBurn] = useState(50_000);
  const [committing, setCommitting] = useState(false);
  const [testStatus, setTestStatus] = useState<string | null>(null);

  const [transcript, setTranscript] = useState<PeerMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [scratchFiles, setScratchFiles] = useState<ScratchFile[]>([]);
  const [scratchPreview, setScratchPreview] = useState<{
    name: string;
    content: string;
  } | null>(null);

  // Agent mode — when on, /peer/send routes to /agent/run which gives
  // the peer game-engine MCP tool calling (screenshot, console read, execute_code).
  // allowWrites gates the dangerous tools (execute_code, gameobject_create,
  // set_property) — read-only by default.
  const [agentMode, setAgentMode] = useState(false);
  const [allowWrites, setAllowWrites] = useState(false);

  const scrollRef = useRef<HTMLDivElement | null>(null);

  // ---- pricing + budget refresh -------------------------------------------
  useEffect(() => {
    fetch(`${BACKEND}/api/qwen/pricing`)
      .then((r) => (r.ok ? r.json() : null))
      .then(setPricing)
      .catch(() => setPricing(null));
  }, []);

  // Refresh + drop the budget if the session disappeared server-side
  // (backend restart, manual cancel, etc). Without this guard the panel
  // would keep polling a dead session forever and the user could never
  // click Commit again.
  const refreshBudget = useCallback(async () => {
    if (!budget?.session_id) return;
    try {
      const r = await fetch(`${BACKEND}/api/qwen/budget/${budget.session_id}`);
      if (r.ok) {
        setBudget(await r.json());
      } else if (r.status === 404 || r.status === 410) {
        // Session expired on the backend — wipe local cache so the user
        // can commit a fresh one.
        clearStoredSession();
        setBudget(null);
        setTestStatus("✗ previous session expired server-side — commit a new one");
      }
    } catch {
      /* network blip; will retry next interval */
    }
  }, [budget?.session_id]);

  useEffect(() => {
    if (!budget) return;
    const t = setInterval(refreshBudget, 5000);
    return () => clearInterval(t);
  }, [budget, refreshBudget]);

  // ---- restore session on mount ------------------------------------------
  // Resolution order (first hit wins):
  //   1. /api/qwen/budget/active — single source of truth, matches the badge
  //      in the title bar so the two always agree
  //   2. localStorage fallback — only used if /active returned nothing (e.g.
  //      backend cold-started, no sessions yet) but localStorage has a sid
  //      that's still alive
  //
  // Previously this was the reverse order, but that caused split-brain when
  // the user committed multiple sessions: panel pinned to a 0-call stored sid
  // while the badge correctly showed an /active session with real usage.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const adopt = (data: Budget) => {
        if (cancelled) return;
        setBudget({
          session_id: data.session_id,
          reserved_tokens: data.reserved_tokens,
          used_tokens: data.used_tokens,
          remaining_tokens:
            data.remaining_tokens ?? (data.reserved_tokens - data.used_tokens),
          cost_usd_billed: data.cost_usd_billed ?? 0,
          call_count: data.call_count ?? 0,
        });
        writeStoredSession(data.session_id);
      };

      // 1. Prefer /active — same source the title-bar badge uses
      try {
        const r = await fetch(`${BACKEND}/api/qwen/budget/active`);
        if (cancelled) return;
        if (r.ok) {
          const data = await r.json();
          if (data && data.session_id) {
            adopt(data);
            return;
          }
        }
      } catch {
        /* network — try localStorage below */
      }

      // 2. Fallback to stored sid only if /active had nothing
      const stored = readStoredSession();
      if (stored) {
        try {
          const r = await fetch(`${BACKEND}/api/qwen/budget/${stored}`);
          if (cancelled) return;
          if (r.ok) {
            adopt(await r.json());
            return;
          }
          clearStoredSession();
        } catch {
          /* no backend yet — user can commit manually */
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // ---- transcript polling -------------------------------------------------
  const refreshTranscript = useCallback(async () => {
    try {
      const r = await fetch(
        `${BACKEND}/api/qwen/peer/transcript?project=${encodeURIComponent(
          projectName,
        )}`,
      );
      if (r.ok) {
        const data = await r.json();
        setTranscript(data.messages ?? []);
      }
    } catch {
      /* ignore */
    }
  }, [projectName]);

  const refreshScratch = useCallback(async () => {
    try {
      const r = await fetch(
        `${BACKEND}/api/qwen/scratch/list?project=${encodeURIComponent(
          projectName,
        )}`,
      );
      if (r.ok) {
        const data = await r.json();
        setScratchFiles(data.files ?? []);
      }
    } catch {
      /* ignore */
    }
  }, [projectName]);

  useEffect(() => {
    refreshTranscript();
    refreshScratch();
    const t = setInterval(() => {
      refreshTranscript();
      refreshScratch();
    }, 4000);
    return () => clearInterval(t);
  }, [refreshTranscript, refreshScratch]);

  // ---- auto-scroll on new message ----------------------------------------
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [transcript.length]);

  // ---- budget commit ------------------------------------------------------
  async function commit() {
    setCommitting(true);
    setTestStatus(null);
    try {
      const r = await fetch(`${BACKEND}/api/qwen/budget/commit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          max_tokens: tokensLimit,
          max_tokens_per_minute: burn,
          purpose: `qwen peer chat (${projectName})`,
        }),
      });
      if (r.ok) {
        const data = await r.json();
        setBudget({
          session_id: data.session_id,
          reserved_tokens: data.reserved_tokens,
          used_tokens: 0,
          remaining_tokens: data.reserved_tokens,
          cost_usd_billed: 0,
          call_count: 0,
        });
        // Persist so refresh / tab switch / window close keeps the session.
        writeStoredSession(data.session_id);
      } else {
        // Show the real error to the user so they're not left wondering why
        // Send stays disabled. The hard-token-limit / kitty / 402 paths all
        // come through here.
        const txt = await r.text().catch(() => "");
        let detail = txt;
        try { detail = JSON.parse(txt).detail ?? txt; } catch { /* keep raw */ }
        setTestStatus(`✗ commit failed (HTTP ${r.status}): ${String(detail).slice(0, 140)}`);
      }
    } catch (e) {
      setTestStatus(`✗ commit network error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setCommitting(false);
    }
  }

  async function cancel() {
    if (!budget?.session_id) return;
    await fetch(
      `${BACKEND}/api/qwen/budget/cancel?session_id=${budget.session_id}`,
      { method: "POST" },
    );
    clearStoredSession();
    setBudget(null);
  }

  async function ping() {
    setTestStatus("…");
    try {
      const r = await fetch(`${BACKEND}/api/qwen/test`, { method: "POST" });
      const data = await r.json();
      setTestStatus(
        data.ok
          ? `✓ ${data.response} (${data.input_tokens}+${data.output_tokens} tok, $${data.cost_usd_billed})`
          : `✗ ${data.error?.slice(0, 60)}`,
      );
    } catch (e) {
      setTestStatus(`✗ ${e instanceof Error ? e.message : "fail"}`);
    }
  }

  // ---- send peer message --------------------------------------------------
  async function sendPeer() {
    if (!budget?.session_id) return;
    const msg = draft.trim();
    if (!msg) return;
    setSending(true);
    try {
      // Agent mode → /agent/run (peer can call game-engine MCP tools); plain chat → /peer/send
      const endpoint = agentMode ? "/api/qwen/agent/run" : "/api/qwen/peer/send";
      const body = agentMode
        ? {
            session_id: budget.session_id,
            project: projectName,
            message: msg,
            allow_writes: allowWrites,
            max_iterations: 8,
          }
        : {
            session_id: budget.session_id,
            project: projectName,
            role: "user",
            message: msg,
          };
      const r = await fetch(`${BACKEND}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (r.ok) {
        setDraft("");
        await refreshTranscript();
        await refreshScratch();
        await refreshBudget();
      } else {
        const err = await r.json().catch(() => ({}));
        setTranscript((t) => [
          ...t,
          {
            role: "system",
            content: `⚠ ${err.detail ?? `HTTP ${r.status}`}`,
            ts: new Date().toISOString(),
          },
        ]);
      }
    } finally {
      setSending(false);
    }
  }

  async function clearTranscript() {
    await fetch(
      `${BACKEND}/api/qwen/peer/clear?project=${encodeURIComponent(projectName)}`,
      { method: "POST" },
    );
    setTranscript([]);
  }

  async function openScratch(name: string) {
    try {
      const r = await fetch(
        `${BACKEND}/api/qwen/scratch/read?project=${encodeURIComponent(
          projectName,
        )}&filename=${encodeURIComponent(name)}`,
      );
      if (r.ok) {
        const data = await r.json();
        setScratchPreview({ name: data.filename, content: data.content });
      }
    } catch {
      /* ignore */
    }
  }

  const estCost = pricing
    ? (tokensLimit / 1_000_000) * pricing.user_visible_rate_usd_per_million
    : 0;

  const usagePct = budget
    ? Math.min(100, (budget.used_tokens / budget.reserved_tokens) * 100)
    : 0;

  return (
    <div className="h-full w-full flex flex-col bg-bg text-text text-sm">
      {/* ---- HEADER: budget control ---------------------------------- */}
      <div className="border-b border-line p-3 space-y-2">
        <div className="flex items-center gap-2">
          <Brain className="h-4 w-4 text-accent" />
          <span className="text-xs font-semibold uppercase tracking-wider">
            AI Peer · Second Opinion
          </span>
          <span className="ml-auto text-[10px] text-text-dim">
            project: {projectName}
          </span>
          <span className="text-[10px] text-text-dim">· via Kitty App</span>
        </div>

        {budget === null ? (
          <div className="space-y-2">
            <div className="text-[11px] text-text-dim leading-relaxed">
              Commit a token budget to start the peer session. Hard cap +
              burn-protection are enforced server-side — Claude cannot exceed
              this even in a runaway loop.
            </div>
            <div className="grid grid-cols-[1fr_auto] gap-2 items-center">
              <input
                type="range"
                min={50_000}
                max={2_000_000}
                step={50_000}
                value={tokensLimit}
                onChange={(e) => setTokensLimit(Number(e.target.value))}
                className="w-full"
              />
              <span className="text-[10px] font-mono whitespace-nowrap">
                {(tokensLimit / 1_000).toLocaleString()}k · ~$
                {estCost.toFixed(2)}
              </span>
            </div>
            <div className="flex gap-2 items-center">
              <select
                value={burn}
                onChange={(e) => setBurn(Number(e.target.value))}
                className="flex-1 bg-bg-subtle border border-line rounded px-2 py-1 text-xs"
                title="Burn protection (rolling 60s cap)"
              >
                <option value={10_000}>burn 10k/min (slow safe)</option>
                <option value={50_000}>burn 50k/min (default)</option>
                <option value={200_000}>burn 200k/min (fast)</option>
              </select>
              <button
                onClick={commit}
                disabled={committing}
                className="btn-primary text-xs px-3 py-1 flex items-center gap-1"
              >
                {committing ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Check className="h-3 w-3" />
                )}
                Commit
              </button>
              <button
                onClick={ping}
                className="btn-ghost text-[10px] px-2 py-1 flex items-center gap-1"
                title="Single ~$0.005 call to verify Kitty plumbing"
              >
                <Zap className="h-3 w-3" />
                Ping
              </button>
            </div>
            {testStatus && (
              <div className="text-[10px] font-mono text-text-dim">
                {testStatus}
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-1">
            <div className="flex items-center justify-between text-[10px]">
              <span className="text-text-dim">
                {budget.used_tokens.toLocaleString()} /{" "}
                {budget.reserved_tokens.toLocaleString()} tok
              </span>
              <span className="font-mono">
                ${budget.cost_usd_billed.toFixed(4)} spent · {budget.call_count}{" "}
                call{budget.call_count !== 1 ? "s" : ""}
              </span>
            </div>
            <div className="h-1.5 bg-bg-subtle rounded overflow-hidden">
              <div
                className={`h-full transition-all ${
                  usagePct > 90
                    ? "bg-err"
                    : usagePct > 70
                      ? "bg-warn"
                      : "bg-accent"
                }`}
                style={{ width: `${usagePct}%` }}
              />
            </div>
            <div className="flex justify-end">
              <button
                onClick={cancel}
                className="text-[10px] text-err hover:underline flex items-center gap-1"
              >
                <X className="h-3 w-3" />
                cancel session (refund unused)
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ---- TRANSCRIPT --------------------------------------------- */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto p-3 space-y-3"
      >
        {transcript.length === 0 ? (
          <div className="text-[11px] text-text-dim italic text-center py-6">
            No peer messages yet. Once Claude consults the peer (or you send a
            message below), the conversation appears here.
          </div>
        ) : (
          transcript.map((m, i) => <MessageBubble key={i} msg={m} />)
        )}
      </div>

      {/* ---- SCRATCH FILES ------------------------------------------ */}
      {scratchFiles.length > 0 && (
        <div className="border-t border-line p-2 max-h-32 overflow-y-auto">
          <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-text-dim mb-1">
            <FileText className="h-3 w-3" />
            Scratch reports ({scratchFiles.length})
            <button
              onClick={refreshScratch}
              className="ml-auto opacity-60 hover:opacity-100"
              title="Refresh"
            >
              <RefreshCw className="h-3 w-3" />
            </button>
          </div>
          <div className="flex flex-wrap gap-1">
            {scratchFiles.map((f) => (
              <button
                key={f.name}
                onClick={() => openScratch(f.name)}
                className="text-[10px] font-mono bg-bg-subtle border border-line rounded px-2 py-0.5 hover:border-accent"
                title={`${f.size_bytes} bytes · modified ${new Date(
                  f.modified_at * 1000,
                ).toLocaleString()}`}
              >
                {f.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ---- AGENT-MODE TOGGLE ------------------------------------- */}
      {budget && (
        <div className="border-t border-line px-2 py-1 flex items-center gap-3 text-[10px] text-text-dim">
          <label className="flex items-center gap-1 cursor-pointer">
            <input
              type="checkbox"
              checked={agentMode}
              onChange={(e) => setAgentMode(e.target.checked)}
              className="h-3 w-3"
            />
            <span className={agentMode ? "text-accent font-semibold" : ""}>
              Agent mode
            </span>
            <span className="text-text-subtle">
              (peer calls game tools directly — screenshot/console/inspect)
            </span>
          </label>
          {agentMode && (
            <label className="flex items-center gap-1 cursor-pointer ml-auto">
              <input
                type="checkbox"
                checked={allowWrites}
                onChange={(e) => setAllowWrites(e.target.checked)}
                className="h-3 w-3"
              />
              <span className={allowWrites ? "text-err font-semibold" : ""}>
                allow writes
              </span>
              <span className="text-text-subtle">
                (execute_code, create/modify GO)
              </span>
            </label>
          )}
        </div>
      )}

      {/* ---- INPUT -------------------------------------------------- */}
      <div className="border-t border-line p-2 flex gap-2 items-end">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              sendPeer();
            }
          }}
          placeholder={
            budget
              ? agentMode
                ? "Tell the peer what to do in the game… it'll call tools and report back"
                : "Ask the peer directly… (Claude also writes here when it consults)"
              : "Commit a token budget above to start."
          }
          disabled={!budget || sending}
          rows={2}
          className="flex-1 bg-bg-subtle border border-line rounded px-2 py-1 text-xs resize-none disabled:opacity-40"
        />
        <div className="flex flex-col gap-1">
          <button
            onClick={sendPeer}
            disabled={!budget || sending || !draft.trim()}
            className="btn-primary text-xs px-3 py-1 flex items-center gap-1 disabled:opacity-40"
          >
            {sending ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Send className="h-3 w-3" />
            )}
            Send
          </button>
          {transcript.length > 0 && (
            <button
              onClick={clearTranscript}
              className="btn-ghost text-[10px] px-2 py-0.5 flex items-center gap-1 text-err"
              title="Wipe peer transcript"
            >
              <Trash2 className="h-3 w-3" />
              Clear
            </button>
          )}
        </div>
      </div>

      {/* ---- SCRATCH PREVIEW MODAL --------------------------------- */}
      {scratchPreview && (
        <div
          className="absolute inset-0 bg-black/60 flex items-center justify-center p-6 z-50"
          onClick={() => setScratchPreview(null)}
        >
          <div
            className="bg-bg border border-line rounded-lg shadow-xl max-w-2xl w-full max-h-[80vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="border-b border-line p-2 flex items-center gap-2">
              <FileText className="h-4 w-4 text-accent" />
              <span className="text-xs font-mono">{scratchPreview.name}</span>
              <button
                onClick={() => setScratchPreview(null)}
                className="ml-auto opacity-60 hover:opacity-100"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-3 text-xs prose-invert">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {scratchPreview.content}
              </ReactMarkdown>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function MessageBubble({ msg }: { msg: PeerMessage }) {
  const isAssistant = msg.role === "assistant";
  const isSystem = msg.role === "system";

  return (
    <div
      className={`flex gap-2 ${
        isAssistant ? "items-start" : isSystem ? "items-center" : "items-start"
      }`}
    >
      <div
        className={`shrink-0 w-6 h-6 rounded flex items-center justify-center ${
          isAssistant
            ? "bg-accent/20 text-accent"
            : isSystem
              ? "bg-warn/20 text-warn"
              : "bg-bg-subtle text-text-dim"
        }`}
      >
        {isAssistant ? (
          <Bot className="h-3 w-3" />
        ) : isSystem ? (
          <Zap className="h-3 w-3" />
        ) : (
          <User className="h-3 w-3" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 text-[10px] text-text-dim mb-0.5">
          <span className="font-mono">
            {isAssistant ? "Peer" : isSystem ? "system" : "claude/user"}
          </span>
          <span>·</span>
          <span>{new Date(msg.ts).toLocaleTimeString()}</span>
          {msg.tokens && (
            <span className="ml-auto">
              {msg.tokens.input}+{msg.tokens.output} tok
              {msg.cost_usd !== undefined && (
                <> · ${msg.cost_usd.toFixed(4)}</>
              )}
            </span>
          )}
        </div>
        <div
          className={`text-xs leading-relaxed prose-invert whitespace-pre-wrap break-words ${
            isAssistant ? "" : isSystem ? "italic text-warn" : "text-text"
          }`}
        >
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {msg.content}
          </ReactMarkdown>
        </div>
        {msg.image_path && (
          <div className="text-[10px] font-mono text-text-dim mt-0.5">
            📎 {msg.image_path}
          </div>
        )}
      </div>
    </div>
  );
}
