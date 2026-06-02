"use client";

/**
 * StudioShell — the top-level view switch: Home ↔ Build ↔ IDE.
 *
 * This is the new entry point (mounted by app/page.tsx). It owns the
 * prompt-first navigation while leaving the existing stores untouched:
 *   - `store/view`    decides which surface is mounted
 *   - `store/session` still holds the active project (shared by all surfaces)
 *   - `store/layout`  still owns the IDE's internal dock arrangement
 *
 * Default-view policy (applied once, post-hydration):
 *   - no active project              → Home
 *   - active project, no saved view  → Build
 *   - otherwise                      → the persisted view
 *
 * The IDE surface keeps a quiet floating "Home" pill so power users are never
 * trapped in the workspace.
 */

import { useEffect } from "react";
import MainLayout from "@/components/layout/MainLayout";
import { useView } from "@/store/view";
import { useSession } from "@/store/session";
import StudioHome from "./StudioHome";
import BuildView from "./BuildView";

export default function StudioShell() {
  const view = useView((s) => s.view);
  const viewHydrated = useView((s) => s.hydrated);
  const hydrateView = useView((s) => s.hydrateView);
  const setView = useView((s) => s.setView);

  const sessionHydrated = useSession((s) => s.hydrated);
  const hydrateSession = useSession((s) => s.hydrateFromStorage);
  const activeProject = useSession((s) => s.activeProject);

  // Hydrate both stores from localStorage on first client mount.
  useEffect(() => {
    hydrateView();
    hydrateSession();
  }, [hydrateView, hydrateSession]);

  // One-time default-view decision once persisted state is known. If the user
  // had no saved view but has a real active project, drop them into Build so a
  // returning user lands on their game rather than the marketing-ish Home.
  useEffect(() => {
    if (!viewHydrated || !sessionHydrated) return;
    let savedView: string | null = null;
    try {
      savedView = window.localStorage.getItem("phaser2d.view");
    } catch {
      /* ignore */
    }
    const hasProject = activeProject && activeProject !== "default";
    if (!savedView && hasProject) {
      setView("build");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewHydrated, sessionHydrated]);

  // Avoid a flash of the wrong surface before hydration settles.
  if (!viewHydrated || !sessionHydrated) {
    return <div className="h-screen w-screen bg-[var(--bg)]" />;
  }

  if (view === "ide") {
    // The Simple ⇄ Full IDE switch lives in the IDE's TitleBar (always visible).
    return <MainLayout />;
  }

  if (view === "build") {
    // Guard: if somehow we're in Build with no real project, fall back to Home.
    if (!activeProject || activeProject === "default") {
      return <StudioHome />;
    }
    return <BuildView />;
  }

  return <StudioHome />;
}
