"use client";

import {
  FolderTree, Sparkles, MessageSquare, Film, Boxes, BarChart3, HelpCircle,
  ImagePlus, Grid3X3,
} from "lucide-react";
import { useLayout } from "@/store/layout";
import type { ActivitySection } from "@/lib/types";

interface SectionDef {
  key: ActivitySection;
  label: string;
  icon: React.ReactNode;
}

const SECTIONS: SectionDef[] = [
  { key: "projects",  label: "Projects",       icon: <FolderTree className="h-5 w-5" /> },
  { key: "browser",   label: "Asset Browser",  icon: <Sparkles className="h-5 w-5" /> },
  { key: "chat",      label: "Chat",           icon: <MessageSquare className="h-5 w-5" /> },
  { key: "animator",  label: "Animator",       icon: <Film className="h-5 w-5" /> },
  { key: "unity",     label: "Game Scene",     icon: <Boxes className="h-5 w-5" /> },
  { key: "analytics", label: "Analytics",      icon: <BarChart3 className="h-5 w-5" /> },
];

// Settings moved to TitleBar top-right gear — no duplicate entry here.
const BOTTOM_SECTIONS: SectionDef[] = [
  { key: "help", label: "Help", icon: <HelpCircle className="h-5 w-5" /> },
];

export default function ActivityBar() {
  const activitySection = useLayout((s) => s.activitySection);
  const setActivitySection = useLayout((s) => s.setActivitySection);
  const sidePanelOpen = useLayout((s) => s.sidePanelOpen);
  const autoCollapseSide = useLayout((s) => s.autoCollapseSide);
  const toggleSidePanel = useLayout((s) => s.toggleSidePanel);
  // References is a CENTER tab, not a SidePanel section — clicking the
  // icon opens it in the center dock instead of swapping the side panel.
  const openCenterTab = useLayout((s) => s.openOrFocusCenterTab);
  const activeCenterTabId = useLayout((s) => s.activeCenterTabId);
  const centerTabs = useLayout((s) => s.centerTabs);
  const refsTabActive = centerTabs.some(
    (t) => t.kind === "references" && t.id === activeCenterTabId,
  );
  const sheetTabActive = centerTabs.some(
    (t) => t.kind === "spritesheet" && t.id === activeCenterTabId,
  );

  // Effective visibility folds in the responsive soft-collapse so the icon's
  // active state tracks what the user actually SEES, not the stored flag.
  const sideShowing = sidePanelOpen && !autoCollapseSide;

  function handleClick(s: ActivitySection) {
    // Clicking the already-active section toggles the panel shut; otherwise
    // open + switch. Uses effective visibility so a click reliably reveals
    // the section even when it was auto-collapsed by the viewport.
    if (activitySection === s && sideShowing) {
      toggleSidePanel();
    } else {
      setActivitySection(s); // also force-opens + clears the soft-collapse
    }
  }

  return (
    <aside className="w-12 shrink-0 bg-bg flex flex-col border-r border-line">
      <div className="flex-1 flex flex-col items-stretch">
        {SECTIONS.map((s) => {
          const selected = activitySection === s.key;
          return (
            <button
              key={s.key}
              onClick={() => handleClick(s.key)}
              className={`activity-icon ${selected && sideShowing ? "active" : ""} ${selected && !sideShowing ? "selected" : ""}`}
              title={selected && !sideShowing ? `${s.label} — click to reveal` : s.label}
              aria-label={s.label}
              aria-pressed={selected}
            >
              {s.icon}
            </button>
          );
        })}
        {/* References is a center tab, not a side-panel section.
            Render after the regular sections so it's the last main icon.
            Click opens/focuses the References center tab. */}
        <button
          onClick={() => openCenterTab("spritesheet")}
          className={`activity-icon ${sheetTabActive ? "active" : ""}`}
          title="Spritesheet Import — upload a PNG sheet, set the split grid with a live overlay, slice into frames."
          aria-label="Spritesheet Import"
          aria-pressed={sheetTabActive}
        >
          <Grid3X3 className="h-5 w-5" />
        </button>
        <button
          onClick={() => openCenterTab("references")}
          className={`activity-icon ${refsTabActive ? "active" : ""}`}
          title="References — gameplay clips, real-game screenshots, mood-board, sketches. Inner Claude auto-aware."
          aria-label="References"
          aria-pressed={refsTabActive}
        >
          <ImagePlus className="h-5 w-5" />
        </button>
      </div>
      <div className="flex flex-col">
        {BOTTOM_SECTIONS.map((s) => {
          const selected = activitySection === s.key;
          return (
            <button
              key={s.key}
              onClick={() => handleClick(s.key)}
              className={`activity-icon ${selected && sideShowing ? "active" : ""} ${selected && !sideShowing ? "selected" : ""}`}
              title={selected && !sideShowing ? `${s.label} — click to reveal` : s.label}
              aria-label={s.label}
              aria-pressed={selected}
            >
              {s.icon}
            </button>
          );
        })}
      </div>
    </aside>
  );
}
