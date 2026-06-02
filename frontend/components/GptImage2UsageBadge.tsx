"use client";

/**
 * GptImage2UsageBadge — header pill showing total GPT-Image-2 call count
 * and estimated cost. Click to expand a tooltip listing recent calls. Updates
 * live via WebSocket whenever a new submit is recorded by the backend.
 */

import { useEffect, useRef, useState } from "react";
import { Sparkles } from "lucide-react";
import { getGptImage2Usage, openGptImage2UsageStream, BACKEND } from "@/lib/api";
import type { UsageCall, UsageReport, UsageStreamEvent } from "@/lib/types";

export default function GptImage2UsageBadge({ projectName }: { projectName?: string }) {
  const [report, setReport] = useState<UsageReport | null>(null);
  const [open, setOpen] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const pulseRef = useRef<HTMLSpanElement | null>(null);

  async function refresh() {
    try {
      const r = await getGptImage2Usage(projectName, undefined, 30);
      setReport(r);
    } catch {
      // backend may be cold-starting
    }
  }

  useEffect(() => {
    refresh();
    // Live WebSocket — auto-reconnect on close
    let mounted = true;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const connect = () => {
      if (!mounted) return;
      const ws = openGptImage2UsageStream(
        (evt: UsageStreamEvent) => {
          if (evt.type === "usage_snapshot") {
            // overwrite totals only (keep existing calls until next refresh)
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
            // Visual pulse on new event
            if (pulseRef.current) {
              pulseRef.current.classList.remove("animate-ping");
              // Force reflow to restart the animation
              void pulseRef.current.offsetWidth;
              pulseRef.current.classList.add("animate-ping");
            }
          }
        },
        () => {
          if (!mounted) return;
          retryTimer = setTimeout(connect, 4000);
        }
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

  const total = report?.total_calls ?? 0;
  const cost = report?.total_cost_usd ?? 0;
  const last24h = report?.calls.filter(
    (c) => new Date(c.ts).getTime() > Date.now() - 24 * 3600 * 1000
  ).length ?? 0;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 text-[10px] text-text-dim hover:text-accent transition-colors px-1.5 py-0.5 rounded border border-line bg-bg-subtle"
        title={`GPT-Image-2: ${total} calls · $${cost.toFixed(4)} · ${last24h} last 24h`}
      >
        <span ref={pulseRef} className="h-1.5 w-1.5 rounded-full bg-purple-400 inline-block" />
        <Sparkles className="h-2.5 w-2.5 text-purple-400" />
        <span className="font-mono tabular-nums">{total}</span>
        <span className="text-text-subtle">·</span>
        <span className="font-mono tabular-nums">${cost.toFixed(2)}</span>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 w-96 max-h-[60vh] overflow-y-auto bg-bg-panel border border-line rounded-md shadow-xl">
          <div className="px-3 py-2 border-b border-line flex items-center justify-between text-[11px]">
            <div className="flex items-center gap-2">
              <Sparkles className="h-3 w-3 text-purple-400" />
              <span className="font-semibold uppercase tracking-wider">GPT-Image-2 usage</span>
            </div>
            <span className="text-text-subtle">
              {total} calls · ${cost.toFixed(4)}
            </span>
          </div>

          {report && (
            <div className="grid grid-cols-3 gap-2 px-3 py-2 border-b border-line">
              {Object.entries(report.by_resolution).map(([res, stats]) => (
                <div key={res} className="text-[10px]">
                  <div className="text-text-dim uppercase tracking-wider">{res}</div>
                  <div className="font-mono">{stats.count} · ${stats.cost_usd.toFixed(3)}</div>
                </div>
              ))}
            </div>
          )}

          <div className="p-2 space-y-1">
            {report?.calls.slice(0, 30).map((c) => (
              <CallRow key={c.id} c={c} />
            ))}
            {(!report || report.calls.length === 0) && (
              <div className="text-text-subtle text-[10px] text-center py-4">
                No GPT-Image-2 calls yet. Generate a sprite or asset to start tracking.
              </div>
            )}
          </div>

          <div className="px-3 py-1.5 border-t border-line text-[9px] text-text-subtle">
            Pricing matches Kitty App / DruidCat — $0.04 (1K) / $0.08 (2K) / $0.16 (4K).
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
      <span className="text-purple-400 font-mono">{c.resolution}</span>
      <span className="font-mono tabular-nums">${c.cost_usd.toFixed(3)}</span>
    </div>
  );
}
