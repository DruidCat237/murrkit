"use client";

/**
 * CreditsBadge — top-right Kitty App balance pill.
 *
 * Matches the production Kitty AI Studio header pattern:
 *  - Live $X.XX balance polled every 60s from /api/kitty/balance.
 *  - Pulses on each new local generation (driven by the usage_tracker WS).
 *  - Click → opens a dropdown with: account info, big Top-up button,
 *    recent-generation breakdown.
 *
 * The dropdown still includes the local usage history (recent calls,
 * spend-by-resolution) — but the headline number is now the user's actual
 * account balance, not the murrkit local spend counter.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLink, Gem, Loader2, RefreshCcw } from "lucide-react";
import {
  BACKEND,
  getGptImage2Usage,
  openGptImage2UsageStream,
  openQueueWs,
} from "@/lib/api";
import type { QueueWsEvent, UsageCall, UsageReport, UsageStreamEvent } from "@/lib/types";

/**
 * Public helper for any component to nudge a balance refresh after an action
 * the user cares about (submitting a plan, cancelling jobs, etc).
 */
export function refreshKittyBalance(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("kitty:refresh-balance"));
  }
}

const TOPUP_URL =
  process.env.NEXT_PUBLIC_KITTY_TOPUP_URL ??
  process.env.NEXT_PUBLIC_DRUIDCAT_TOPUP_URL ??
  "https://druidcat.com/my-account/";

interface BalanceInfo {
  ok: boolean;
  credits_usd: number;
  formatted: string;
  username: string | null;
  detail: string;
}

export default function CreditsBadge({ projectName }: { projectName?: string }) {
  const [report, setReport] = useState<UsageReport | null>(null);
  const [balance, setBalance] = useState<BalanceInfo | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [open, setOpen] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const pulseRef = useRef<HTMLSpanElement | null>(null);

  const fetchBalance = useCallback(async () => {
    setRefreshing(true);
    try {
      const r = await fetch(`${BACKEND}/api/kitty/balance`, { cache: "no-store" });
      const data = (await r.json()) as BalanceInfo;
      setBalance(data);
    } catch {
      setBalance(null);
    } finally {
      setRefreshing(false);
    }
  }, []);

  async function fetchUsageReport() {
    try {
      const r = await getGptImage2Usage(projectName, undefined, 30);
      setReport(r);
    } catch {
      /* backend cold-start — ignore */
    }
  }

  // Initial load + 60s polling for balance
  useEffect(() => {
    void fetchBalance();
    void fetchUsageReport();
    const id = setInterval(fetchBalance, 60_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectName]);

  // Real-time refresh on any global "kitty:refresh-balance" event. Anyone
  // can call refreshKittyBalance() after an action that changes credits
  // (plan accept, cancel-all, queue submit success, etc).
  useEffect(() => {
    function onRefresh() { void fetchBalance(); }
    window.addEventListener("kitty:refresh-balance", onRefresh);
    return () => window.removeEventListener("kitty:refresh-balance", onRefresh);
  }, [fetchBalance]);

  // Real-time refresh on EVERY generation-queue event so the user sees
  // credits drop the moment a job is accepted by Kitty (not 60s later).
  // Kitty's WordPress plugin deducts credits at SUBMIT time, so we
  // refresh on `queued`, then again on `failed` (refund) and `completed`.
  useEffect(() => {
    let alive = true;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let ws: WebSocket | null = null;
    const connect = () => {
      if (!alive) return;
      ws = openQueueWs(
        (evt: QueueWsEvent) => {
          if (evt.event === "queued" || evt.event === "completed" || evt.event === "failed") {
            // Slight delay — Kitty plugin needs ~500ms to settle the debit.
            setTimeout(() => void fetchBalance(), 600);
          }
        },
        () => {
          if (!alive) return;
          retryTimer = setTimeout(connect, 4000);
        },
      );
    };
    connect();
    return () => {
      alive = false;
      if (retryTimer) clearTimeout(retryTimer);
      try { ws?.close(); } catch { /* ignore */ }
    };
  }, [fetchBalance]);

  // Local generation events — pulse + refresh balance shortly after
  useEffect(() => {
    let mounted = true;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const connect = () => {
      if (!mounted) return;
      const ws = openGptImage2UsageStream(
        (evt: UsageStreamEvent) => {
          if (evt.type === "usage_snapshot") {
            setReport((prev) => prev && {
              ...prev,
              total_calls: evt.totals.total_calls,
              total_cost_usd: evt.totals.total_cost_usd,
            });
          } else if (evt.type === "usage_event") {
            setReport((prev) => {
              if (!prev) return prev;
              const callsForProject =
                !projectName || evt.record.project === projectName || projectName === "default";
              if (!callsForProject) return prev;
              const newCalls = [evt.record, ...prev.calls].slice(0, 30);
              return {
                ...prev,
                total_calls: prev.total_calls + 1,
                total_cost_usd: +(prev.total_cost_usd + evt.record.cost_usd).toFixed(4),
                calls: newCalls,
              };
            });
            if (pulseRef.current) {
              pulseRef.current.classList.remove("animate-ping");
              void pulseRef.current.offsetWidth;
              pulseRef.current.classList.add("animate-ping");
            }
            // A generation completed — refresh balance after the backend has
            // had a moment to settle the upstream debit.
            setTimeout(() => { void fetchBalance(); }, 1500);
          }
        },
        () => {
          if (!mounted) return;
          retryTimer = setTimeout(connect, 4000);
        },
      );
      wsRef.current = ws;
    };
    connect();
    return () => {
      mounted = false;
      if (retryTimer) clearTimeout(retryTimer);
      try { wsRef.current?.close(); } catch { /* ignore */ }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectName]);

  const cost = report?.total_cost_usd ?? 0;
  const total = report?.total_calls ?? 0;

  const balanceLabel = balance?.ok ? balance.formatted : "—";
  const balanceColor = !balance?.ok
    ? "text-text-subtle border-line"
    : balance.credits_usd < 1
      ? "text-accent-warn border-accent-warn/40 bg-accent-warn/10"
      : "text-emerald-400 border-emerald-500/30 bg-emerald-500/10 hover:bg-emerald-500/20";

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className={[
          "flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full border transition-colors cursor-pointer",
          balanceColor,
        ].join(" ")}
        title={balance?.ok ? `Click for details — last refreshed just now` : balance?.detail ?? "Kitty App"}
      >
        <span
          ref={pulseRef}
          className={[
            "h-1.5 w-1.5 rounded-full inline-block",
            balance?.ok ? "bg-emerald-400" : "bg-text-subtle",
          ].join(" ")}
        />
        <Gem className="h-3 w-3" />
        <span className="font-mono tabular-nums">{balanceLabel}</span>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 w-96 max-h-[70vh] overflow-y-auto bg-bg-panel border border-line rounded-md shadow-xl">
          {/* Header */}
          <div className="px-3 py-2 border-b border-line flex items-center justify-between text-[11px]">
            <div className="flex items-center gap-2">
              <Gem className="h-3 w-3 text-emerald-400" />
              <span className="font-semibold uppercase tracking-wider">Kitty App</span>
            </div>
            <button
              onClick={fetchBalance}
              className="text-text-dim hover:text-text"
              title="Refresh balance"
            >
              {refreshing ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <RefreshCcw className="h-3 w-3" />
              )}
            </button>
          </div>

          {/* Balance + identity */}
          <div className="px-3 py-3 border-b border-line">
            {balance?.ok ? (
              <>
                <div className="text-[10px] uppercase tracking-wider text-text-dim mb-0.5">
                  Account balance
                </div>
                <div className="text-2xl font-bold text-emerald-400 tabular-nums">
                  {balance.formatted}
                </div>
                {balance.username && (
                  <div className="text-[10px] text-text-subtle mt-0.5 truncate">
                    {balance.username}
                  </div>
                )}
              </>
            ) : (
              <div className="text-xs text-accent-warn">
                {balance?.detail || "Kitty App not connected. Paste your code in Settings."}
              </div>
            )}
          </div>

          {/* Top up */}
          <a
            href={TOPUP_URL}
            target="_blank"
            rel="noreferrer noopener"
            className="block px-3 py-3 border-b border-line bg-gradient-to-r from-emerald-500/10 to-cyan-500/10 hover:from-emerald-500/20 hover:to-cyan-500/20 transition-colors"
          >
            <div className="flex items-center justify-between">
              <div>
                <div className="font-semibold flex items-center gap-1.5 text-sm">
                  <Gem className="h-3.5 w-3.5 text-emerald-400" />
                  Top up credits
                </div>
                <div className="text-[10px] text-text-subtle mt-0.5">
                  druidcat.com/my-account
                </div>
              </div>
              <ExternalLink className="h-3.5 w-3.5 text-text-dim" />
            </div>
          </a>

          {/* This-session spend */}
          <div className="px-3 py-2 border-b border-line text-[11px] flex items-center justify-between">
            <span className="text-text-dim">This session</span>
            <span className="font-mono tabular-nums">
              ${cost.toFixed(4)} · {total} {total === 1 ? "image" : "images"}
            </span>
          </div>

          {/* Breakdown by resolution */}
          {report && Object.keys(report.by_resolution).length > 0 && (
            <div className="grid grid-cols-3 gap-2 px-3 py-2 border-b border-line">
              {Object.entries(report.by_resolution).map(([res, stats]) => (
                <div key={res} className="text-[10px]">
                  <div className="text-text-dim uppercase tracking-wider">{res}</div>
                  <div className="font-mono">{stats.count} · ${stats.cost_usd.toFixed(3)}</div>
                </div>
              ))}
            </div>
          )}

          {/* Recent calls */}
          <div className="p-2 space-y-1">
            <div className="text-[9px] uppercase tracking-wider text-text-subtle px-1 pb-1">
              Recent generations
            </div>
            {report?.calls.slice(0, 30).map((c) => (
              <CallRow key={c.id} c={c} />
            ))}
            {(!report || report.calls.length === 0) && (
              <div className="text-text-subtle text-[10px] text-center py-4">
                No generations yet this session.
              </div>
            )}
          </div>

          <div className="px-3 py-1.5 border-t border-line text-[9px] text-text-subtle">
            Pricing scales with quality + resolution — Low-1K from $0.04, High-4K up to ~$0.16.
          </div>
        </div>
      )}
    </div>
  );
}

function CallRow({ c }: { c: UsageCall }) {
  const status =
    c.status === "completed" ? "✓"
    : c.status === "failed" ? "✗"
    : "•";
  const statusColor =
    c.status === "completed" ? "text-accent"
    : c.status === "failed" ? "text-err"
    : "text-text-dim";
  const date = new Date(c.ts);
  const timeStr = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return (
    <div className="text-[10px] grid grid-cols-[auto_auto_1fr_auto_auto] items-center gap-1.5 px-1 py-0.5 hover:bg-bg-subtle rounded">
      <span className={statusColor}>{status}</span>
      <span className="text-text-dim font-mono tabular-nums">{timeStr}</span>
      <span className="truncate text-text-subtle" title={c.prompt}>
        {c.prompt || "(no prompt)"}
      </span>
      <span className="text-emerald-400 font-mono">{c.resolution}</span>
      <span className="font-mono tabular-nums">${c.cost_usd.toFixed(3)}</span>
    </div>
  );
}
