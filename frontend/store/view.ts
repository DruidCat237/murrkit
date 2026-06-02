"use client";

/**
 * View store — the top-level prompt-first navigation switch.
 *
 *   home  → Studio Home (new-game prompt-box + project gallery)
 *   build → Build view  (focused chat + live game for the active project)
 *   ide   → the legacy VS-Code-style MainLayout (power users)
 *
 * This sits ABOVE the existing layout/session stores. It does not replace
 * them — the IDE still owns its own dock/panel arrangement via `store/layout`,
 * and the active project still lives in `store/session`. We only decide which
 * top-level surface is mounted.
 *
 * SSR-safe: the initial state never touches localStorage so the server render
 * and the first client render produce identical HTML. The persisted value is
 * read post-mount via `hydrateView()` (see <StudioShell />).
 */

import { create } from "zustand";

export type AppView = "home" | "build" | "ide";

interface ViewState {
  view: AppView;
  /** True once the persisted view has been read on the client. */
  hydrated: boolean;
  setView: (v: AppView) => void;
  /** Convenience: open the Build view (used right after creating/selecting a project). */
  openBuild: () => void;
  goHome: () => void;
  openIde: () => void;
  hydrateView: () => void;
}

const VIEW_KEY = "phaser2d.view";

function readPersisted(): AppView | null {
  if (typeof window === "undefined") return null;
  try {
    const v = window.localStorage.getItem(VIEW_KEY);
    return v === "home" || v === "build" || v === "ide" ? v : null;
  } catch {
    return null;
  }
}

function writePersisted(v: AppView): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(VIEW_KEY, v);
  } catch {
    /* ignore quota errors */
  }
}

export const useView = create<ViewState>((set, get) => ({
  view: "home",
  hydrated: false,

  setView(v) {
    set({ view: v });
    writePersisted(v);
  },
  openBuild() {
    set({ view: "build" });
    writePersisted("build");
  },
  goHome() {
    set({ view: "home" });
    writePersisted("home");
  },
  openIde() {
    set({ view: "ide" });
    writePersisted("ide");
  },
  hydrateView() {
    if (get().hydrated) return;
    const stored = readPersisted();
    set({ view: stored ?? "home", hydrated: true });
  },
}));
