"use client";

import {
  ChevronLeft, ChevronRight, ChevronUp,
} from "lucide-react";

/**
 * CollapseRail — the thin strip shown IN PLACE of a collapsed panel so the
 * panel is never "lost". It carries a single expand chevron plus a vertical
 * label, echoing the VS Code idiom where a collapsed side bar still leaves a
 * sliver you can click to bring it back.
 *
 * `edge` is the screen edge the rail hugs, which decides the chevron
 * direction (it points the way the panel will re-appear) and, for side rails,
 * the order of the rotated label vs. the chevron so the glyph sits nearest
 * the content it reveals.
 */
interface CollapseRailProps {
  edge: "left" | "right" | "bottom";
  label: string;
  onExpand: () => void;
  /** Hotkey hint appended to the tooltip, e.g. "Cmd+Alt+B". */
  hotkey?: string;
}

export default function CollapseRail({ edge, label, onExpand, hotkey }: CollapseRailProps) {
  const isSide = edge === "left" || edge === "right";
  const ChevIcon =
    edge === "left" ? ChevronRight :   // left rail → expands rightward
    edge === "right" ? ChevronLeft :   // right rail → expands leftward
    ChevronUp;                          // bottom rail → expands upward
  const tip = hotkey ? `Expand ${label} (${hotkey})` : `Expand ${label}`;

  if (!isSide) {
    // Horizontal rail (collapsed bottom dock). Kept compact; the existing
    // BottomDock already renders its own "click to expand" bar, so this rail
    // is reserved for the side panels — but we support the orientation for
    // completeness / future use.
    return (
      <button
        type="button"
        onClick={onExpand}
        className="collapse-rail-h"
        aria-label={tip}
        title={tip}
      >
        <ChevIcon className="h-3.5 w-3.5" />
        <span>{label}</span>
      </button>
    );
  }

  return (
    <div
      className={`collapse-rail-v ${edge === "right" ? "border-l" : "border-r"} border-line`}
      role="toolbar"
      aria-label={`${label} (collapsed)`}
    >
      <button
        type="button"
        onClick={onExpand}
        className="collapse-rail-btn"
        aria-label={tip}
        title={tip}
      >
        <ChevIcon className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={onExpand}
        className="collapse-rail-label"
        aria-label={tip}
        title={tip}
        tabIndex={-1}
      >
        {label}
      </button>
    </div>
  );
}
