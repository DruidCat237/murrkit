"use client";

/**
 * QwenBudgetBadge — title-bar pill showing the peer-chat budget
 * status. Click → focuses the peer tab so the user can commit / cancel
 * without hunting for the panel.
 *
 * Polls /api/qwen/budget/{session_id} every 6s when a session is live,
 * otherwise shows an idle state and pulls the latest session id from
 * /api/qwen/budget/active (the most-recent committed session).
 *
 * Surface naming: NEVER show the upstream provider name.
 */

import { useCallback, useEffect, useState } from "react";
import { Brain } from "lucide-react";
import { BACKEND } from "@/lib/api";
import { useLayout } from "@/store/layout";

interface BudgetSummary {
  session_id: string;
  reserved_tokens: number;
  used_tokens: number;
  remaining_tokens: number;
  cost_usd_billed: number;
  call_count: number;
}

export default function QwenBudgetBadge() {
  const [budget, setBudget] = useState<BudgetSummary | null>(null);
  const openOrFocusCenterTab = useLayout((s) => s.openOrFocusCenterTab);

  const poll = useCallback(async () => {
    // We don't track session_id in title bar persistence; instead query
    // the lightweight /api/qwen/budget/active endpoint that returns the
    // newest live session, or null if none.
    try {
      const r = await fetch(`${BACKEND}/api/qwen/budget/active`, {
        signal: AbortSignal.timeout(2000),
      });
      if (!r.ok) {
        setBudget(null);
        return;
      }
      const data = await r.json();
      if (data && data.session_id) {
        setBudget(data);
      } else {
        setBudget(null);
      }
    } catch {
      setBudget(null);
    }
  }, []);

  useEffect(() => {
    poll();
    const t = setInterval(poll, 6000);
    return () => clearInterval(t);
  }, [poll]);

  const pct = budget
    ? Math.min(100, (budget.used_tokens / budget.reserved_tokens) * 100)
    : 0;

  return (
    <button
      onClick={() => openOrFocusCenterTab("qwen")}
      className={[
        "h-7 px-2 rounded-md flex items-center gap-1.5 border text-[10px] font-mono transition-colors",
        budget
          ? "border-accent/60 bg-accent/10 text-accent hover:bg-accent/20"
          : "border-line text-text-dim hover:text-text hover:border-line-strong",
      ].join(" ")}
      title={
        budget
          ? `Peer chat: ${budget.used_tokens.toLocaleString()}/${budget.reserved_tokens.toLocaleString()} tokens used · $${budget.cost_usd_billed.toFixed(4)} · ${budget.call_count} calls — click to open panel`
          : "No peer session — click to open the peer chat panel"
      }
    >
      <Brain className="h-3 w-3" />
      {budget ? (
        <>
          <span>{Math.round(pct)}%</span>
          <div className="h-1 w-8 bg-bg-subtle rounded overflow-hidden">
            <div
              className={`h-full ${
                pct > 90 ? "bg-err" : pct > 70 ? "bg-warn" : "bg-accent"
              }`}
              style={{ width: `${pct}%` }}
            />
          </div>
        </>
      ) : (
        <span>Peer idle</span>
      )}
    </button>
  );
}
