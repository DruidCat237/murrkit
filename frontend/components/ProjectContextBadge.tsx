"use client";

/**
 * ProjectContextBadge — header strip:  📁 <project>  ·  🎮 <game runtime>  ·  ⤢
 *
 * Repurposed for murrkit and GAME-focused (the gamepad icon already implied
 * it). Behaviour the user expects from the look:
 *   - Clicking the badge → opens / focuses the **Phaser Game** tab.
 *   - The ⤢ button → pops the game out into its OWN floating window.
 * It no longer opens Settings (that was misleading — Settings has its own gear
 * button in the title bar), and the old engine-MCP status dots (a stray red
 * "offline" indicator that meant nothing in murrkit) were removed.
 */

import { useEffect, useState } from "react";
import { Folder, Gamepad2, ExternalLink } from "lucide-react";
import { getContextSnapshot, setActiveProject } from "@/lib/api";
import { useLayout } from "@/store/layout";
import { openPopout } from "@/lib/popout";
import type { ContextSnapshot } from "@/lib/types";

export default function ProjectContextBadge({ projectName }: { projectName: string }) {
  const [ctx, setCtx] = useState<ContextSnapshot | null>(null);
  const openTab = useLayout((s) => s.openOrFocusCenterTab);

  // Tell backend which project is active so chat prompts are scoped correctly.
  useEffect(() => {
    setActiveProject(projectName).catch(() => undefined);
  }, [projectName]);

  useEffect(() => {
    let mounted = true;
    const tick = async () => {
      try {
        const s = await getContextSnapshot();
        if (mounted) setCtx(s);
      } catch {
        // backend cold-start — try later
      }
    };
    tick();
    const id = setInterval(tick, 30_000);
    return () => {
      mounted = false;
      clearInterval(id);
    };
  }, []);

  const gameName = ctx?.unity_project_name || "phaser_game";

  return (
    <div className="flex items-center gap-0.5 text-[10px] text-text-dim rounded border border-line bg-bg-subtle/60 group">
      {/* Click the badge → open / focus the Phaser Game tab. */}
      <button
        onClick={() => openTab("scene")}
        className="flex items-center gap-2 px-2 py-1 rounded-l hover:text-text hover:bg-bg-subtle transition-colors"
        title="Open the Phaser game"
      >
        <span className="flex items-center gap-1">
          <Folder className="h-2.5 w-2.5 text-accent" />
          <span className="font-mono" suppressHydrationWarning>{projectName}</span>
        </span>
        <span className="text-text-subtle">·</span>
        <span className="flex items-center gap-1">
          <Gamepad2 className="h-2.5 w-2.5 text-accent-warn" />
          <span className="font-mono truncate max-w-[140px]">{gameName}</span>
        </span>
      </button>

      {/* ⤢ → pop the game out into its OWN floating window (movable to any monitor). */}
      <button
        onClick={() => openPopout({ kind: "scene", title: "Phaser Game" }, projectName)}
        className="flex items-center justify-center h-6 w-6 rounded-r text-text-subtle hover:text-accent hover:bg-accent/10 transition-colors"
        title="Open the game in a separate floating window"
        aria-label="Open the game in a separate window"
      >
        <ExternalLink className="h-3 w-3" />
      </button>
    </div>
  );
}
