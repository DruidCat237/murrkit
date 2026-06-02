"use client";

/**
 * WindowMenu — a "Window" dropdown in the title bar that lets the user:
 *   1. RE-OPEN any tab they previously closed (closing a tab via its × used to
 *      be irreversible — now every tab kind is one click away here).
 *   2. See at a glance which tabs are currently open (checkmark).
 *   3. Close an open (non-sticky) tab without hunting for it.
 *   4. Reset the whole workspace layout back to the default arrangement.
 *
 * This directly answers the user's ask: a single, always-available place to
 * recover tabs and reset to default.
 */

import { useEffect, useRef, useState } from "react";
import { LayoutPanelLeft, RotateCcw, Check, X, Minimize2 } from "lucide-react";
import { useLayout } from "@/store/layout";
import type { CenterTab, CenterTabKind } from "@/lib/types";

// Every tab kind the user can summon, in a sensible menu order. `wizard` is
// intentionally omitted (legacy/hidden). Titles mirror defaultTabTitle().
const ALL_TABS: { kind: CenterTabKind; title: string }[] = [
  { kind: "chat", title: "Chat" },
  { kind: "generate", title: "Generate" },
  { kind: "library", title: "Library" },
  { kind: "code", title: "Code" },
  { kind: "spritesheet", title: "Spritesheet Import" },
  { kind: "animator", title: "Animator" },
  { kind: "scene", title: "Phaser Game" },
  { kind: "queue", title: "Queue" },
  { kind: "references", title: "References" },
  { kind: "vision", title: "Vision Reviews" },
  { kind: "qwen", title: "AI Peer" },
  { kind: "settings", title: "Settings" },
];

export default function WindowMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const centerTabs = useLayout((s) => s.centerTabs);
  const openOrFocus = useLayout((s) => s.openOrFocusCenterTab);
  const removeTab = useLayout((s) => s.removeCenterTab);
  const mergePanes = useLayout((s) => s.mergePanes);
  const resetLayout = useLayout((s) => s.resetLayout);

  // Close on outside-click / Escape.
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // First open tab per kind (used to show the checkmark + drive the close ×).
  const openByKind = new Map<string, CenterTab>();
  for (const t of centerTabs) if (!openByKind.has(t.kind)) openByKind.set(t.kind, t);

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        onClick={() => setOpen((v) => !v)}
        className={[
          "flex items-center gap-1 h-7 px-2 rounded-md border text-xs transition-colors",
          open
            ? "border-accent/60 bg-accent/15 text-accent"
            : "border-line text-text-dim hover:text-text hover:border-line-strong",
        ].join(" ")}
        title="Open or recover tabs · reset layout"
        aria-label="Window menu"
        aria-expanded={open}
      >
        <LayoutPanelLeft className="h-3.5 w-3.5" />
        Window
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 w-64 rounded-lg border border-line bg-bg-panel shadow-xl z-50 py-1 text-xs">
          <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-text-subtle">
            Tabs — click to open / focus
          </div>
          <div className="max-h-[60vh] overflow-y-auto">
            {ALL_TABS.map(({ kind, title }) => {
              const tab = openByKind.get(kind);
              const isOpen = !!tab;
              return (
                <div key={kind} className="flex items-center group">
                  <button
                    onClick={() => { openOrFocus(kind); setOpen(false); }}
                    className="flex-1 flex items-center gap-2 px-3 py-1.5 text-left hover:bg-bg-subtle transition-colors"
                  >
                    <span className={`w-3.5 flex justify-center ${isOpen ? "text-accent" : "text-transparent"}`}>
                      <Check className="h-3.5 w-3.5" />
                    </span>
                    <span className={isOpen ? "text-text" : "text-text-dim"}>{title}</span>
                  </button>
                  {isOpen && tab && !tab.sticky && (
                    <button
                      onClick={() => removeTab(tab.id)}
                      className="px-2 py-1.5 text-text-subtle hover:text-err opacity-0 group-hover:opacity-100 transition-opacity"
                      title={`Close ${title}`}
                      aria-label={`Close ${title}`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          <div className="my-1 border-t border-line" />
          <button
            onClick={() => { mergePanes(); setOpen(false); }}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-text-dim hover:bg-bg-subtle hover:text-text transition-colors"
            title="Bring all split-out panels back into one group (keeps your open tabs)"
          >
            <Minimize2 className="h-3.5 w-3.5" />
            Merge all panes
          </button>
          <button
            onClick={() => {
              if (
                confirm(
                  "Reset the workspace layout to default?\n\nOnly window/tab positions reset — your chats and generated assets are untouched.",
                )
              ) {
                resetLayout();
                setOpen(false);
              }
            }}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-text-dim hover:bg-bg-subtle hover:text-text transition-colors"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Reset layout to default
          </button>
        </div>
      )}
    </div>
  );
}
