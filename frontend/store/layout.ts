"use client";

/**
 * Layout store — single source of truth for the v2 dockable workspace.
 *
 * Persistence: writes the current snapshot to localStorage on every
 * mutation so reloads restore the previous arrangement.
 */

import { create } from "zustand";
import type {
  ActivitySection,
  BottomTab,
  BottomTabKind,
  CenterTab,
  CenterTabKind,
  LayoutSnapshot,
  ThemeName,
} from "@/lib/types";

// v6 bump — Vision Reviews tab added (Gemini default, peer fallback, DeepSeek
// triage). Replaces the peer tab as the right-pane default so the user sees what
// Claude is consulting across all three providers in one timeline.
// v7 (murrkit rebrand): bumped to invalidate cached legacy tab labels from the
// retired predecessor era. New key namespace + version forces a clean reset.
const STORAGE_KEY = "phaser2d.layout.v7";

const DEFAULT_CENTER_TABS: CenterTab[] = [
  { id: "tab-chat",      kind: "chat",     title: "Chat",            sticky: true, paneId: "p-left" },
  { id: "tab-vision",    kind: "vision",   title: "Vision Reviews",  paneId: "p-right" },
  { id: "tab-qwen",      kind: "qwen",     title: "AI Peer",         paneId: "p-right" },
  { id: "tab-generate",  kind: "generate", title: "Generate",        paneId: "p-left" },
  { id: "tab-library",   kind: "library",  title: "Library",         paneId: "p-left" },
  { id: "tab-code",      kind: "code",     title: "Code",            paneId: "p-left" },
  { id: "tab-spritesheet", kind: "spritesheet", title: "Spritesheet Import", paneId: "p-left" },
  { id: "tab-animator",  kind: "animator", title: "Animator",        paneId: "p-left" },
  { id: "tab-map",       kind: "map",      title: "Map Studio",      paneId: "p-left" },
  { id: "tab-scene",     kind: "scene",    title: "Phaser Game",     paneId: "p-left" },
];

const DEFAULT_BOTTOM_TABS: BottomTab[] = [
  { id: "bot-gen-queue",    kind: "gen-queue",    title: "Queue" },
  { id: "bot-unity-console", kind: "unity-console", title: "Phaser Console" },
  { id: "bot-logs",         kind: "logs",         title: "Logs" },
  { id: "bot-problems",     kind: "problems",     title: "Problems" },
  { id: "bot-output",       kind: "output",       title: "Output" },
];

const DEFAULTS: LayoutSnapshot = {
  version: 7,
  sidePanelWidth: 240,
  rightPanelWidth: 320,
  bottomDockHeight: 200,
  bottomDockOpen: false,     // user opens via StatusBar or Cmd+J
  rightPanelOpen: false,     // user opens via Cmd+B
  sidePanelOpen: true,
  activitySection: "projects",
  centerTabs: DEFAULT_CENTER_TABS,
  activeCenterTabId: "tab-chat",
  bottomTabs: DEFAULT_BOTTOM_TABS,
  activeBottomTabId: "bot-gen-queue",
  theme: "dark",
};

interface LayoutActions {
  setSidePanelWidth: (w: number) => void;
  setRightPanelWidth: (w: number) => void;
  setBottomDockHeight: (h: number) => void;
  toggleBottomDock: () => void;
  toggleRightPanel: () => void;
  toggleSidePanel: () => void;
  setBottomDockOpen: (open: boolean) => void;
  setRightPanelOpen: (open: boolean) => void;
  setSidePanelOpen: (open: boolean) => void;
  applyViewportWidth: (width: number) => void;
  setActivitySection: (s: ActivitySection) => void;
  setActiveCenterTab: (id: string) => void;
  setActiveBottomTab: (id: string) => void;
  addCenterTab: (tab: CenterTab) => void;
  removeCenterTab: (id: string) => void;
  openOrFocusCenterTab: (kind: CenterTabKind, opts?: { title?: string; file?: string }) => string;
  openOrFocusBottomTab: (kind: BottomTabKind, opts?: { title?: string }) => string;
  reorderCenterTabs: (newOrder: string[]) => void;
  splitCenterTab: (id: string, direction: "horizontal" | "vertical") => void;
  dockCenterTabLeft: (id: string) => void;
  /** Move a tab into an explicit pane ('p-left' | 'p-right' | 'p-bottom' |
   *  'p-far-left'). Backs the drag-and-drop relocation onto a pane/edge. */
  moveCenterTabToPane: (id: string, paneId: string) => void;
  /** Pop the active tab OUT into its own side pane in one click (no drag).
   *  Main-pane tab → 'p-right'; a tab already in a side pane → 'p-far-left'
   *  (so a second detach gives it yet another distinct panel). */
  detachCenterTab: (id: string) => void;
  mergePanes: () => void;
  setTheme: (t: ThemeName) => void;
  resetLayout: () => void;
  loadFromStorage: () => void;
}

/**
 * Transient (NOT persisted) responsive state. These are *soft* overrides
 * driven by the viewport width — they hide a panel on narrow screens
 * without touching the user's persisted `sidePanelOpen` / `rightPanelOpen`
 * intent. The effective "is this panel showing" decision is:
 *
 *     sidePanelOpen && !autoCollapseSide
 *
 * A user re-expanding a panel (rail chevron / ActivityBar / hotkey) clears
 * the matching auto-collapse flag, so they can defeat the soft override and
 * keep it open even on a narrow viewport. The next genuine breakpoint
 * crossing (resize) re-applies it. We never write these to localStorage.
 */
interface ResponsiveState {
  autoCollapseSide: boolean;
  autoCollapseRight: boolean;
  /** Last viewport bucket we reacted to, so we only act on real crossings. */
  lastViewportBucket: "desktop" | "laptop" | "tablet" | "narrow";
}

const RESPONSIVE_DEFAULTS: ResponsiveState = {
  autoCollapseSide: false,
  autoCollapseRight: false,
  lastViewportBucket: "desktop",
};

// Breakpoints (px). The right Inspector soft-collapses below LAPTOP (≤1024);
// the left side panel additionally soft-collapses below TABLET (≤768). Above
// 1024 the full-IDE experience is untouched (desktop / laptop buckets).
const BP_LAPTOP = 1024;
const BP_TABLET = 768;

function bucketFor(width: number): ResponsiveState["lastViewportBucket"] {
  if (width > 1280) return "desktop";
  if (width > BP_LAPTOP) return "laptop";
  if (width > BP_TABLET) return "tablet";
  return "narrow";
}

type LayoutStore = LayoutSnapshot & ResponsiveState & LayoutActions;

function persist(state: LayoutSnapshot) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch { /* ignore quota errors */ }
}

function readStorage(): LayoutSnapshot | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LayoutSnapshot;
    if (parsed.version !== 7) return null;
    // In-place migration: older v7 snapshots predate the Map Studio tab —
    // inject it (before the Phaser Game tab) instead of nuking the layout.
    if (!parsed.centerTabs.some((t) => t.kind === "map")) {
      const mapTab = DEFAULT_CENTER_TABS.find((t) => t.kind === "map")!;
      const sceneIdx = parsed.centerTabs.findIndex((t) => t.kind === "scene");
      parsed.centerTabs = [...parsed.centerTabs];
      parsed.centerTabs.splice(sceneIdx === -1 ? parsed.centerTabs.length : sceneIdx, 0, mapTab);
    }
    return parsed;
  } catch { return null; }
}

function snapshotOf(s: LayoutStore): LayoutSnapshot {
  return {
    version: 7,
    sidePanelWidth: s.sidePanelWidth,
    rightPanelWidth: s.rightPanelWidth,
    bottomDockHeight: s.bottomDockHeight,
    bottomDockOpen: s.bottomDockOpen,
    rightPanelOpen: s.rightPanelOpen,
    sidePanelOpen: s.sidePanelOpen,
    activitySection: s.activitySection,
    centerTabs: s.centerTabs,
    activeCenterTabId: s.activeCenterTabId,
    bottomTabs: s.bottomTabs,
    activeBottomTabId: s.activeBottomTabId,
    theme: s.theme,
  };
}

export const useLayout = create<LayoutStore>((set, get) => ({
  ...DEFAULTS,
  ...RESPONSIVE_DEFAULTS,

  setSidePanelWidth(w) {
    const clamped = Math.max(180, Math.min(640, w));
    set({ sidePanelWidth: clamped });
    persist(snapshotOf({ ...get(), sidePanelWidth: clamped }));
  },
  setRightPanelWidth(w) {
    const clamped = Math.max(220, Math.min(720, w));
    set({ rightPanelWidth: clamped });
    persist(snapshotOf({ ...get(), rightPanelWidth: clamped }));
  },
  setBottomDockHeight(h) {
    const clamped = Math.max(80, Math.min(800, h));
    set({ bottomDockHeight: clamped });
    persist(snapshotOf({ ...get(), bottomDockHeight: clamped }));
  },
  toggleBottomDock() {
    const v = !get().bottomDockOpen;
    set({ bottomDockOpen: v });
    persist(snapshotOf({ ...get(), bottomDockOpen: v }));
  },
  toggleRightPanel() {
    // Effective visibility folds in the responsive soft-collapse, so the
    // toggle always flips what the user actually SEES (not the stale stored
    // flag). Opening clears the auto-collapse override.
    const showing = get().rightPanelOpen && !get().autoCollapseRight;
    const v = !showing;
    set({ rightPanelOpen: v, autoCollapseRight: false });
    persist(snapshotOf({ ...get(), rightPanelOpen: v }));
  },
  toggleSidePanel() {
    const showing = get().sidePanelOpen && !get().autoCollapseSide;
    const v = !showing;
    set({ sidePanelOpen: v, autoCollapseSide: false });
    persist(snapshotOf({ ...get(), sidePanelOpen: v }));
  },
  setBottomDockOpen(open) {
    set({ bottomDockOpen: open });
    persist(snapshotOf({ ...get(), bottomDockOpen: open }));
  },
  setRightPanelOpen(open) {
    // Explicit open/close also clears the responsive soft-override so the
    // user's choice wins until the next breakpoint crossing.
    set({ rightPanelOpen: open, autoCollapseRight: false });
    persist(snapshotOf({ ...get(), rightPanelOpen: open }));
  },
  setSidePanelOpen(open) {
    set({ sidePanelOpen: open, autoCollapseSide: false });
    persist(snapshotOf({ ...get(), sidePanelOpen: open }));
  },
  applyViewportWidth(width) {
    const bucket = bucketFor(width);
    if (bucket === get().lastViewportBucket) return; // only act on crossings
    // Map the bucket → soft-collapse:
    //   desktop (>1280) / laptop (1024–1280]  → nothing collapsed (full IDE)
    //   tablet  (768–1024]                    → RIGHT panel collapses
    //   narrow  (≤768)                        → RIGHT + SIDE collapse
    // Widening back past a breakpoint clears the matching override so the
    // panels return to the user's persisted intent.
    const autoCollapseRight = bucket === "tablet" || bucket === "narrow";
    const autoCollapseSide = bucket === "narrow";
    set({ lastViewportBucket: bucket, autoCollapseRight, autoCollapseSide });
    // NOTE: intentionally NOT persisted — responsive collapse is transient.
  },
  setActivitySection(s) {
    // Picking a section always reveals the side panel — and beats the
    // responsive soft-collapse so the chosen section is actually visible.
    set({ activitySection: s, sidePanelOpen: true, autoCollapseSide: false });
    persist(snapshotOf({ ...get(), activitySection: s, sidePanelOpen: true }));
  },
  setActiveCenterTab(id) {
    set({ activeCenterTabId: id });
    persist(snapshotOf({ ...get(), activeCenterTabId: id }));
  },
  setActiveBottomTab(id) {
    set({ activeBottomTabId: id, bottomDockOpen: true });
    persist(snapshotOf({ ...get(), activeBottomTabId: id, bottomDockOpen: true }));
  },
  addCenterTab(tab) {
    const list = [...get().centerTabs, tab];
    set({ centerTabs: list, activeCenterTabId: tab.id });
    persist(snapshotOf({ ...get(), centerTabs: list, activeCenterTabId: tab.id }));
  },
  removeCenterTab(id) {
    const existing = get().centerTabs.find((t) => t.id === id);
    // Sticky tabs (Chat) are non-closable — protect against accidental
    // middle-click / programmatic close. Without this guard the user can
    // end up with an unusable empty workspace.
    if (existing?.sticky) return;
    let tabs = get().centerTabs.filter((t) => t.id !== id);
    // Self-heal: if every tab is gone, put Chat back so the workspace stays
    // usable (chat is the canonical home view).
    if (tabs.length === 0) {
      tabs = [{ id: "tab-chat", kind: "chat", title: "Chat", sticky: true, paneId: "p-left" }];
    }
    let active = get().activeCenterTabId;
    if (active === id) {
      active = tabs[tabs.length - 1].id;
    }
    set({ centerTabs: tabs, activeCenterTabId: active });
    persist(snapshotOf({ ...get(), centerTabs: tabs, activeCenterTabId: active }));
  },
  openOrFocusCenterTab(kind, opts) {
    // For 'code' we want one tab per file; for others single instance per kind.
    const tabs = get().centerTabs;
    const existing = tabs.find((t) => {
      if (kind === "code") return t.kind === "code" && t.file === opts?.file;
      return t.kind === kind;
    });
    if (existing) {
      set({ activeCenterTabId: existing.id });
      persist(snapshotOf({ ...get(), activeCenterTabId: existing.id }));
      return existing.id;
    }
    const id = `tab-${kind}-${Math.random().toString(36).slice(2, 8)}`;
    const title = opts?.title ?? defaultTabTitle(kind, opts?.file);
    const tab: CenterTab = { id, kind, title, file: opts?.file, paneId: "p-left" };
    const list = [...tabs, tab];
    set({ centerTabs: list, activeCenterTabId: id });
    persist(snapshotOf({ ...get(), centerTabs: list, activeCenterTabId: id }));
    return id;
  },
  openOrFocusBottomTab(kind, opts) {
    const tabs = get().bottomTabs;
    const existing = tabs.find((t) => t.kind === kind);
    if (existing) {
      set({ activeBottomTabId: existing.id, bottomDockOpen: true });
      persist(snapshotOf({ ...get(), activeBottomTabId: existing.id, bottomDockOpen: true }));
      return existing.id;
    }
    const id = `bot-${kind}-${Math.random().toString(36).slice(2, 8)}`;
    const title = opts?.title ?? kind;
    const tab: BottomTab = { id, kind, title };
    const list = [...tabs, tab];
    set({ bottomTabs: list, activeBottomTabId: id, bottomDockOpen: true });
    persist(snapshotOf({ ...get(), bottomTabs: list, activeBottomTabId: id, bottomDockOpen: true }));
    return id;
  },
  reorderCenterTabs(newOrder) {
    const map = new Map(get().centerTabs.map((t) => [t.id, t] as const));
    const reordered = newOrder.map((id) => map.get(id)).filter(Boolean) as CenterTab[];
    if (reordered.length !== get().centerTabs.length) return;
    set({ centerTabs: reordered });
    persist(snapshotOf({ ...get(), centerTabs: reordered }));
  },
  splitCenterTab(id, direction) {
    // For our pragmatic implementation, "split" means assign the tab to a
    // secondary paneId so the DockArea renders two panes side by side or
    // stacked. We use 'p-left' and 'p-right' (or 'p-top'/'p-bottom').
    const targetPane = direction === "horizontal" ? "p-bottom" : "p-right";
    const tabs = get().centerTabs.map((t) =>
      t.id === id ? { ...t, paneId: targetPane } : t
    );
    set({ centerTabs: tabs });
    persist(snapshotOf({ ...get(), centerTabs: tabs }));
  },
  dockCenterTabLeft(id) {
    // Dock a tab into a NEW group to the LEFT of the main pane. 'p-left' is
    // already the id of the DEFAULT/main pane, so the left-docked group needs
    // a distinct id ('p-far-left') — otherwise the tab would just merge back
    // into the main pane and nothing would visibly move. mergePanes() resets
    // every paneId (including 'p-far-left') to 'p-left', so merge-back works
    // without any extra handling here.
    const tabs = get().centerTabs.map((t) =>
      t.id === id ? { ...t, paneId: "p-far-left" } : t
    );
    set({ centerTabs: tabs });
    persist(snapshotOf({ ...get(), centerTabs: tabs }));
  },
  moveCenterTabToPane(id, paneId) {
    const cur = get().centerTabs.find((t) => t.id === id);
    if (!cur || (cur.paneId ?? "p-left") === paneId) return; // no-op
    const tabs = get().centerTabs.map((t) =>
      t.id === id ? { ...t, paneId } : t
    );
    // Activate the moved tab so the user immediately sees it land in the
    // target pane (otherwise the destination might keep showing another tab).
    set({ centerTabs: tabs, activeCenterTabId: id });
    persist(snapshotOf({ ...get(), centerTabs: tabs, activeCenterTabId: id }));
  },
  detachCenterTab(id) {
    // One-click "give this tab its own panel". Choose a DISTINCT target pane
    // based on where the tab currently lives so detach always visibly moves
    // it out: main pane → 'p-right'; anything already in a side pane →
    // 'p-far-left'. mergePanes() resets every paneId back to 'p-left'.
    const cur = get().centerTabs.find((t) => t.id === id);
    if (!cur) return;
    const here = cur.paneId ?? "p-left";
    const target =
      here === "p-left" ? "p-right"
      : here === "p-right" ? "p-far-left"
      : here === "p-bottom" ? "p-right"
      : "p-right"; // p-far-left → bring it to the right side instead
    if (here === target) return;
    const tabs = get().centerTabs.map((t) =>
      t.id === id ? { ...t, paneId: target } : t
    );
    set({ centerTabs: tabs, activeCenterTabId: id });
    persist(snapshotOf({ ...get(), centerTabs: tabs, activeCenterTabId: id }));
  },
  mergePanes() {
    const tabs = get().centerTabs.map((t) => ({ ...t, paneId: "p-left" }));
    set({ centerTabs: tabs });
    persist(snapshotOf({ ...get(), centerTabs: tabs }));
  },
  setTheme(t) {
    set({ theme: t });
    if (typeof document !== "undefined") {
      document.documentElement.classList.remove("theme-dark", "theme-light", "theme-rpg", "theme-synthwave");
      document.documentElement.classList.add(`theme-${t}`);
    }
    persist(snapshotOf({ ...get(), theme: t }));
  },
  resetLayout() {
    set({ ...DEFAULTS });
    persist(DEFAULTS);
  },
  loadFromStorage() {
    const stored = readStorage();
    if (!stored) return;
    set({ ...stored });
    if (typeof document !== "undefined") {
      document.documentElement.classList.remove("theme-dark", "theme-light", "theme-rpg", "theme-synthwave");
      document.documentElement.classList.add(`theme-${stored.theme}`);
    }
  },
}));

function defaultTabTitle(kind: CenterTabKind, file?: string): string {
  if (kind === "code" && file) {
    return file.split("/").pop() ?? file;
  }
  switch (kind) {
    case "chat":     return "Chat";
    case "code":     return "Code";
    case "animator": return "Animator";
    case "spritesheet": return "Spritesheet Import";
    case "scene":    return "Phaser Game";
    case "library":  return "Library";
    case "generate": return "Generate";
    case "wizard":   return "Phaser Game";
    case "queue":    return "Queue";
    case "settings": return "Settings";
    case "qwen":     return "AI Peer";
    case "vision":   return "Vision Reviews";
    case "references": return "References";
    case "map":      return "Map Studio";
  }
}
