"use client";

import StudioShell from "@/components/studio/StudioShell";
import FirstRunSetup from "@/components/FirstRunSetup";

/**
 * murrkit — entry point.
 *
 * PROMPT-FIRST shell. The app now opens on a Studio Home ("type a prompt →
 * get a playable 2D game") with a focused Build view per project. The full
 * VS-Code-style workspace (the previous default) is still one click away and
 * remains the power-user surface.
 *
 * View switching (Home ↔ Build ↔ IDE) lives in `store/view`; the legacy
 * dockable workspace is `components/layout/MainLayout` and is reused as-is.
 *
 * See:
 *   components/studio/   — the prompt-first surfaces (Home, Build, shell)
 *   components/layout/   — the v2 IDE layout primitives (unchanged)
 */
export default function Home() {
  return (
    <>
      <StudioShell />
      {/* One-time guided setup gate (Claude Code + Kitty). Self-dismisses when
          already configured; renders nothing otherwise. */}
      <FirstRunSetup />
    </>
  );
}
