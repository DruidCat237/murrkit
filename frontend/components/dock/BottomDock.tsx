"use client";

import { ChevronDown, ChevronUp } from "lucide-react";
import { useLayout } from "@/store/layout";
import type { BottomTab } from "@/lib/types";

interface BottomDockProps {
  renderTab: (tab: BottomTab) => React.ReactNode;
}

export default function BottomDock({ renderTab }: BottomDockProps) {
  const tabs = useLayout((s) => s.bottomTabs);
  const active = useLayout((s) => s.activeBottomTabId);
  const open = useLayout((s) => s.bottomDockOpen);
  const setActive = useLayout((s) => s.setActiveBottomTab);
  const toggle = useLayout((s) => s.toggleBottomDock);

  const activeTab = tabs.find((t) => t.id === active) ?? tabs[0] ?? null;

  // ── Collapsed: a thin handle bar carrying the SAME big, accent, always-visible
  // collapse affordance the resize dividers use (.divider-collapse-btn). A
  // visible chevron makes the fold obvious and one click expands it. The
  // open/closed state is persisted in the layout store (bottomDockOpen). ──────
  if (!open) {
    return (
      <button
        onClick={toggle}
        className="bottom-fold-bar"
        aria-label="Expand bottom panel"
        aria-expanded={false}
        title="Open Queue / Phaser Console / Logs / Problems / Output (Cmd+J)"
      >
        <span className="bottom-fold-handle" aria-hidden>
          <ChevronUp className="h-5 w-5" strokeWidth={2.5} />
        </span>
        <span className="bottom-fold-label">Bottom Panel</span>
        <span className="text-text-subtle text-[10px]">— click to expand</span>
      </button>
    );
  }

  return (
    <div className="h-full w-full flex flex-col bg-bg overflow-hidden">
      {/* tab bar */}
      <div className="flex items-center border-y border-line bg-bg-subtle shrink-0">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setActive(t.id)}
            className={`dock-tab ${t.id === activeTab?.id ? "active" : ""}`}
          >
            {t.title}
          </button>
        ))}
        {/* Big, accent, always-visible fold chevron — same vocabulary as the
            divider collapse handles, so collapsing the bottom dock feels
            identical to collapsing the Inspector. */}
        <button
          onClick={toggle}
          className="bottom-fold-collapse ml-auto mr-2"
          aria-label="Collapse bottom panel"
          aria-expanded={true}
          title="Collapse bottom panel (Cmd+J)"
        >
          <ChevronDown className="h-5 w-5" strokeWidth={2.5} />
        </button>
      </div>

      {/* content */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {activeTab ? renderTab(activeTab) : (
          <div className="h-full flex items-center justify-center text-text-subtle text-sm">
            No bottom tab selected
          </div>
        )}
      </div>
    </div>
  );
}
