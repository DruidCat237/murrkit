"use client";

import { Search, Settings as SettingsIcon, Sparkles } from "lucide-react";
import { useEffect } from "react";
import { useSession } from "@/store/session";
import { useLayout } from "@/store/layout";
import { useView } from "@/store/view";
import { getContextSnapshot, getCostSnapshot } from "@/lib/api";
import CreditsBadge from "../CreditsBadge";
import ProjectContextBadge from "../ProjectContextBadge";
import QwenBudgetBadge from "../QwenBudgetBadge";
import VisionProviderBadge from "../VisionProviderBadge";
import ReferencesBadge from "../ReferencesBadge";
import ThemeSwitcher from "../status/ThemeSwitcher";
import WindowMenu from "./WindowMenu";

export default function TitleBar() {
  const activeProject = useSession((s) => s.activeProject);
  const togglePalette = useSession((s) => s.togglePalette);
  const setContext = useSession((s) => s.setContext);
  const setCost = useSession((s) => s.setCostSnapshot);
  const openOrFocusCenterTab = useLayout((s) => s.openOrFocusCenterTab);
  const activeCenterTabId = useLayout((s) => s.activeCenterTabId);
  const centerTabs = useLayout((s) => s.centerTabs);
  const setView = useView((s) => s.setView);
  // Returning to the simple UI lands on the project's Build view if one is
  // active, otherwise the Studio Home gallery.
  const simpleTarget = activeProject && activeProject !== "default" ? "build" : "home";

  const settingsActive = centerTabs.some(
    (t) => t.kind === "settings" && t.id === activeCenterTabId,
  );

  useEffect(() => {
    let cancelled = false;
    async function loop() {
      try {
        const [ctx, cost] = await Promise.all([
          getContextSnapshot().catch(() => null),
          getCostSnapshot().catch(() => null),
        ]);
        if (cancelled) return;
        if (ctx) setContext(ctx);
        if (cost) setCost(cost);
      } catch { /* ignore */ }
    }
    loop();
    const t = setInterval(loop, 30_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [setContext, setCost]);

  return (
    <header className="h-12 px-3 flex items-center gap-3 border-b border-line bg-bg-panel shrink-0">
      {/* logo */}
      <div className="flex items-center gap-2">
        <div className="h-7 w-7 rounded-md flex items-center justify-center"
             style={{ background: "color-mix(in oklab, var(--accent) 22%, transparent)" }}>
          <span className="text-accent font-bold text-xs">2D</span>
        </div>
        <div className="leading-none">
          <div className="text-xs font-semibold">murrkit</div>
          <div className="text-[10px] text-text-subtle">v1 · Phaser 3 + TS orchestrator</div>
        </div>
      </div>

      {/* Simple ⇄ Full IDE switch — exit the workspace back to the prompt-first Studio */}
      <div
        className="flex items-center rounded-md border border-line overflow-hidden text-xs shrink-0"
        title="Switch between the simple Studio UI and the full IDE"
      >
        <button
          onClick={() => setView(simpleTarget)}
          className="flex items-center gap-1 px-2.5 py-1 text-text-dim hover:text-text hover:bg-bg-subtle transition-colors"
        >
          <Sparkles className="h-3 w-3" />
          Simple
        </button>
        <span className="px-2.5 py-1 bg-accent/15 text-accent font-medium">Full IDE</span>
      </div>

      <ProjectContextBadge projectName={activeProject} />

      {/* center palette trigger */}
      <button
        onClick={togglePalette}
        className="flex-1 mx-4 max-w-2xl flex items-center gap-2 px-3 py-1.5 rounded-md bg-bg-subtle text-text-dim border border-line hover:border-line-strong transition-colors group"
        aria-label="Open command palette (Cmd+K)"
      >
        <Search className="h-3.5 w-3.5" />
        <span className="text-xs">Search actions, files, skills…</span>
        <span className="ml-auto flex items-center gap-1">
          <span className="kbd">Cmd</span>
          <span className="kbd">K</span>
        </span>
      </button>

      {/* right side */}
      <div className="flex items-center gap-2">
        <WindowMenu />
        <CreditsBadge projectName={activeProject} />
        <ReferencesBadge />
        <VisionProviderBadge />
        <QwenBudgetBadge />
        <ThemeSwitcher />
        <button
          onClick={() => openOrFocusCenterTab("settings")}
          className={[
            "h-7 w-7 rounded-md flex items-center justify-center border transition-colors",
            settingsActive
              ? "border-accent/60 bg-accent/15 text-accent"
              : "border-line text-text-dim hover:text-text hover:border-line-strong",
          ].join(" ")}
          title="Settings & API keys"
          aria-label="Settings"
        >
          <SettingsIcon className="h-3.5 w-3.5" />
        </button>
      </div>
    </header>
  );
}
