"use client";

import { useEffect, useState } from "react";
import { Clock, Cpu, DollarSign, RefreshCcw, Activity, LayoutGrid, Bug, Gamepad2 } from "lucide-react";
import { useSession } from "@/store/session";
import { useQueue } from "@/store/queue";
import { useLayout } from "@/store/layout";
import { BACKEND, getConfig } from "@/lib/api";

export default function StatusBar() {
  const cost = useSession((s) => s.costSnapshot);
  const ctx = useSession((s) => s.context);
  const activeModel = useSession((s) => s.activeModel);
  const [agentCli, setAgentCli] = useState<"claude" | "codex">("claude");

  // Phaser dev-server (Vite :5173) health — replaces the old engine offline pill.
  const [phaserHealthy, setPhaserHealthy] = useState<boolean>(false);
  useEffect(() => {
    let cancelled = false;
    async function refreshAgentCli() {
      const cfg = await getConfig().catch(() => null);
      if (cancelled || !cfg) return;
      const field = cfg.fields.find((f) => f.key === "MURRKIT_AGENT_CLI");
      setAgentCli(field?.value === "codex" ? "codex" : "claude");
    }
    refreshAgentCli();
    function onAgentChanged(e: Event) {
      const detail = (e as CustomEvent).detail as { agent?: "claude" | "codex" };
      if (detail?.agent === "claude" || detail?.agent === "codex") setAgentCli(detail.agent);
      else refreshAgentCli();
    }
    window.addEventListener("murrkit:agent-cli-changed", onAgentChanged);
    return () => {
      cancelled = true;
      window.removeEventListener("murrkit:agent-cli-changed", onAgentChanged);
    };
  }, []);

  useEffect(() => {
    const probe = async () => {
      try {
        const r = await fetch(`${BACKEND}/api/phaser/health`, { signal: AbortSignal.timeout(2000) });
        const d = await r.json();
        setPhaserHealthy(Boolean(d.healthy));
      } catch { setPhaserHealthy(false); }
    };
    probe();
    const id = setInterval(probe, 8000);
    return () => clearInterval(id);
  }, []);
  const queueTasks = useQueue((s) => s.tasks);
  const queueOrder = useQueue((s) => s.order);
  const resetLayout = useLayout((s) => s.resetLayout);
  const toggleBottom = useLayout((s) => s.toggleBottomDock);
  const openOrFocusBottomTab = useLayout((s) => s.openOrFocusBottomTab);

  const [time, setTime] = useState<string>("--:--");
  // Locale-dependent date title is computed CLIENT-SIDE only to avoid the
  // SSR/CSR hydration mismatch (server renders en-US, client renders pl-PL).
  const [dateTitle, setDateTitle] = useState<string>("");

  useEffect(() => {
    function update() {
      const d = new Date();
      setTime(`${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`);
      setDateTitle(d.toLocaleString());
    }
    update();
    const t = setInterval(update, 30_000);
    return () => clearInterval(t);
  }, []);

  const running = queueOrder.filter((id) => {
    const s = queueTasks[id]?.status;
    return s === "started" || s === "progress" || s === "queued";
  }).length;

  const failed = queueOrder.filter((id) => queueTasks[id]?.status === "failed").length;

  const phaserDot = phaserHealthy ? "bg-ok" : "bg-err";

  return (
    <footer className="h-6 flex items-center bg-bg-subtle border-t border-line shrink-0 text-[11px] overflow-hidden">
      <div className="status-segment" title="Active project">
        <LayoutGrid className="h-3 w-3" />
        <span>{ctx?.superagent_project ?? "default"}</span>
      </div>

      <div className="status-segment" title="Active model">
        <Cpu className="h-3 w-3" />
        <span>{modelLabel(activeModel, agentCli)}</span>
      </div>

      <button
        className="status-segment"
        onClick={() => { openOrFocusBottomTab("gen-queue"); }}
        title="Open generation queue"
      >
        <Activity className="h-3 w-3" />
        <span>Queue: {running}{failed > 0 && <span className="text-err"> · {failed} failed</span>}</span>
      </button>

      <div className="status-segment" title="Budget">
        <DollarSign className="h-3 w-3" />
        <span>
          ${(cost?.spent_usd ?? 0).toFixed(2)} / ${(cost?.budget_usd ?? 0).toFixed(0)}
          {cost && (
            <span className="text-text-subtle ml-1">({Math.round(cost.pct_used)}%)</span>
          )}
        </span>
      </div>

      <button
        className="status-segment"
        onClick={() => openOrFocusBottomTab("unity-console")}
        title={phaserHealthy ? "Phaser dev server live on :5173" : "Phaser dev server offline — start Vite (cd phaser_game && npm run dev)"}
      >
        <span className={`inline-block h-1.5 w-1.5 rounded-full ${phaserDot}`} />
        <Gamepad2 className="h-3 w-3" />
        <span>Phaser {phaserHealthy ? "live" : "offline"}</span>
      </button>

      <button className="status-segment" onClick={toggleBottom} title="Toggle bottom panel">
        <Bug className="h-3 w-3" />
        <span>Bottom</span>
      </button>

      <div className="ml-auto" />

      <button
        className="status-segment hover:text-accent-warn"
        onClick={() => {
          if (confirm("Reset workspace layout to the default? Your projects, chats, and generated assets are NOT touched — only window/tab positions.")) {
            resetLayout();
          }
        }}
        title="Reset workspace tabs + panels to defaults — does NOT touch chats or generated assets"
      >
        <RefreshCcw className="h-3 w-3" />
        <span>Reset Layout</span>
      </button>

      <div className="status-segment" title={dateTitle} suppressHydrationWarning>
        <Clock className="h-3 w-3" />
        <span>{time}</span>
      </div>

      <div className="status-segment border-r-0" title="murrkit version">
        <span>v1.0</span>
      </div>
    </footer>
  );
}

function modelLabel(m: string, agentCli: "claude" | "codex"): string {
  if (m === "claude_opus") return agentCli === "codex" ? "Codex Heavy" : "Opus 4.8";
  if (m === "claude_sonnet") return agentCli === "codex" ? "Codex Balanced" : "Sonnet";
  if (m === "deepseek_v4") return "DeepSeek V4";
  return m;
}
