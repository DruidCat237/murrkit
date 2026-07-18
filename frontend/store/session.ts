"use client";

/**
 * Session store — runtime context: active project, active model, cost,
 * engine connection. Hydrated on app boot, updated by hooks.
 */

import { create } from "zustand";
import type { ChatModel, ContextSnapshot, CostSnapshot } from "@/lib/types";

interface SessionState {
  activeProject: string;
  activeModel: ChatModel;
  costSnapshot: CostSnapshot | null;
  context: ContextSnapshot | null;
  unityConnection: "http" | "stdio" | "offline" | "unknown";
  paletteOpen: boolean;
  onboardingDone: boolean;
  /** True after first client mount finishes — UI can safely read persisted values. */
  hydrated: boolean;

  setActiveProject: (p: string) => void;
  setActiveModel: (m: ChatModel) => void;
  setCostSnapshot: (c: CostSnapshot | null) => void;
  setContext: (c: ContextSnapshot | null) => void;
  setUnityConnection: (s: "http" | "stdio" | "offline" | "unknown") => void;
  openPalette: () => void;
  closePalette: () => void;
  togglePalette: () => void;
  setOnboardingDone: (v: boolean) => void;
  hydrateFromStorage: () => void;
}

const ACTIVE_PROJECT_KEY = "sa2d.activeProject";
const ACTIVE_MODEL_KEY = "superagent2d.activeModel";
const ONBOARDING_KEY = "superagent2d.onboardingDone";

function readPersisted<T>(key: string, fallback: T, parse: (s: string) => T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const v = window.localStorage.getItem(key);
    return v != null ? parse(v) : fallback;
  } catch { return fallback; }
}

function writePersisted(key: string, value: string): void {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(key, value); } catch { /* ignore */ }
}

// SSR-safe defaults: initial state must NOT touch localStorage so the server
// render and the client's first render produce identical HTML. localStorage is
// read post-mount via `hydrateFromStorage` — see `<SessionHydrator />` in
// MainLayout.
export const useSession = create<SessionState>((set, get) => ({
  activeProject: "default",
  activeModel: "claude_sonnet",
  costSnapshot: null,
  context: null,
  unityConnection: "unknown",
  paletteOpen: false,
  onboardingDone: false,
  hydrated: false,

  setActiveProject(p) {
    set({ activeProject: p });
    writePersisted(ACTIVE_PROJECT_KEY, p);
  },
  setActiveModel(m) {
    set({ activeModel: m });
    writePersisted(ACTIVE_MODEL_KEY, m);
  },
  setCostSnapshot(c) { set({ costSnapshot: c }); },
  setContext(c) {
    set({ context: c });
    if (c) {
      const status = c.mcp_unity_status === "ready"
        ? c.mcp_unity_transport === "http" ? "http" : "stdio"
        : c.mcp_unity_status === "offline" ? "offline" : "unknown";
      set({ unityConnection: status });
    }
  },
  setUnityConnection(s) { set({ unityConnection: s }); },
  openPalette() { set({ paletteOpen: true }); },
  closePalette() { set({ paletteOpen: false }); },
  togglePalette() { set((s) => ({ paletteOpen: !s.paletteOpen })); },
  setOnboardingDone(v) {
    set({ onboardingDone: v });
    writePersisted(ONBOARDING_KEY, String(v));
  },
  hydrateFromStorage() {
    if (get().hydrated) return;
    const ap = readPersisted(ACTIVE_PROJECT_KEY, "default", (s) => s);
    const am = readPersisted<ChatModel>(ACTIVE_MODEL_KEY, "claude_sonnet", (s) =>
      (["claude_sonnet", "claude_opus", "claude_fable", "deepseek_v4"] as const).includes(s as ChatModel)
        ? (s as ChatModel)
        : "claude_sonnet",
    );
    const od = readPersisted(ONBOARDING_KEY, false, (s) => s === "true");
    set({ activeProject: ap, activeModel: am, onboardingDone: od, hydrated: true });
  },
}));
