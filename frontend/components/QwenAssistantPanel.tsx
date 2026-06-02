"use client";

/**
 * QwenAssistantPanel — collapsible card in the chat sidebar. User commits
 * a token budget; backend then enforces a hard cap on every peer call
 * Claude makes. Live display of used/remaining/cost.
 *
 * Surface naming: NEVER show the upstream provider — user sees
 * "Peer via Kitty App" only.
 */

import { useCallback, useEffect, useState } from "react";
import { Brain, Check, Loader2, Zap, X } from "lucide-react";
import { BACKEND } from "@/lib/api";

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

export default function QwenAssistantPanel() {
  const [pricing, setPricing] = useState<Pricing | null>(null);
  const [budget, setBudget] = useState<Budget | null>(null);
  const [tokensLimit, setTokensLimit] = useState(500_000);
  const [burn, setBurn] = useState(50_000);
  const [committing, setCommitting] = useState(false);
  const [testStatus, setTestStatus] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${BACKEND}/api/qwen/pricing`)
      .then((r) => r.ok ? r.json() : null)
      .then(setPricing)
      .catch(() => setPricing(null));
  }, []);

  const refreshBudget = useCallback(async () => {
    if (!budget?.session_id) return;
    try {
      const r = await fetch(`${BACKEND}/api/qwen/budget/${budget.session_id}`);
      if (r.ok) setBudget(await r.json());
    } catch { /* ignore */ }
  }, [budget?.session_id]);

  useEffect(() => {
    if (!budget) return;
    const t = setInterval(refreshBudget, 5000);
    return () => clearInterval(t);
  }, [budget, refreshBudget]);

  async function commit() {
    setCommitting(true);
    try {
      const r = await fetch(`${BACKEND}/api/qwen/budget/commit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          max_tokens: tokensLimit,
          max_tokens_per_minute: burn,
          purpose: "ad-hoc Claude session",
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
      }
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
    setBudget(null);
  }

  async function ping() {
    setTestStatus("…");
    try {
      const r = await fetch(`${BACKEND}/api/qwen/test`, { method: "POST" });
      const data = await r.json();
      setTestStatus(data.ok ? `✓ ${data.response} (${data.input_tokens}+${data.output_tokens} tok, $${data.cost_usd_billed})` : `✗ ${data.error?.slice(0, 60)}`);
    } catch (e) {
      setTestStatus(`✗ ${e instanceof Error ? e.message : "fail"}`);
    }
  }

  const estCost = pricing
    ? (tokensLimit / 1_000_000) * pricing.user_visible_rate_usd_per_million
    : 0;

  return (
    <div className="panel p-3 space-y-3">
      <div className="flex items-center gap-2">
        <Brain className="h-4 w-4 text-accent" />
        <span className="text-xs font-semibold uppercase tracking-wider">
          AI Peer
        </span>
        <span className="ml-auto text-[10px] text-text-dim">via Kitty App</span>
      </div>

      {budget === null ? (
        <>
          <div className="text-[11px] text-text-dim leading-relaxed">
            Optional multimodal peer for Claude — vision-verifies screenshots,
            generates playtest reports, second-opinion on plans. Pay-per-use
            from your Kitty balance.
          </div>
          <label className="block text-[10px] uppercase tracking-wider text-text-dim">
            Token limit
          </label>
          <input
            type="range"
            min={50_000}
            max={2_000_000}
            step={50_000}
            value={tokensLimit}
            onChange={(e) => setTokensLimit(Number(e.target.value))}
            className="w-full"
          />
          <div className="flex justify-between text-[10px] font-mono">
            <span>{(tokensLimit / 1_000).toLocaleString()}k tok</span>
            <span className="text-accent">~${estCost.toFixed(2)} from Kitty</span>
          </div>
          <label className="block text-[10px] uppercase tracking-wider text-text-dim">
            Burn-protection (tokens/min cap)
          </label>
          <select
            value={burn}
            onChange={(e) => setBurn(Number(e.target.value))}
            className="w-full bg-bg-subtle border border-line rounded px-2 py-1 text-xs"
          >
            <option value={10_000}>10 000 / min (slow safe)</option>
            <option value={50_000}>50 000 / min (default)</option>
            <option value={200_000}>200 000 / min (fast)</option>
          </select>
          <button
            onClick={commit}
            disabled={committing}
            className="w-full btn-primary text-xs flex items-center justify-center gap-1"
          >
            {committing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
            Commit {(tokensLimit / 1_000).toLocaleString()}k tokens
          </button>
          <button
            onClick={ping}
            className="w-full btn-ghost text-[10px] flex items-center justify-center gap-1"
            title="Single ~$0.01 call to verify Kitty plumbing"
          >
            <Zap className="h-3 w-3" /> Smoke test ($0.005)
          </button>
          {testStatus && (
            <div className="text-[10px] font-mono text-text-dim">{testStatus}</div>
          )}
        </>
      ) : (
        <>
          <div className="space-y-1">
            <div className="flex justify-between text-[10px]">
              <span className="text-text-dim">used / reserved</span>
              <span className="font-mono">
                {budget.used_tokens.toLocaleString()} / {budget.reserved_tokens.toLocaleString()}
              </span>
            </div>
            <div className="h-2 bg-bg-subtle rounded overflow-hidden">
              <div
                className="h-full bg-accent transition-all"
                style={{
                  width: `${Math.min(100, (budget.used_tokens / budget.reserved_tokens) * 100)}%`,
                }}
              />
            </div>
            <div className="flex justify-between text-[10px] text-text-dim">
              <span>{budget.call_count} call{budget.call_count !== 1 ? "s" : ""}</span>
              <span>${budget.cost_usd_billed.toFixed(4)} spent</span>
            </div>
          </div>
          <button
            onClick={cancel}
            className="w-full btn-ghost text-[10px] flex items-center justify-center gap-1 text-err"
          >
            <X className="h-3 w-3" />
            Cancel session (refund unused)
          </button>
        </>
      )}
    </div>
  );
}
