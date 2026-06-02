"use client";

/**
 * SplitPane — two children separated by a draggable divider.
 *
 * Pragmatic implementation: works for horizontal (side-by-side) and
 * vertical (stacked) splits. The size of the "primary" side is
 * controlled via `primarySize` + `onPrimarySizeChange`; the other side
 * fills remaining space.
 */

import { useRef } from "react";
import {
  ChevronLeft, ChevronRight, ChevronUp, ChevronDown,
} from "lucide-react";

interface SplitPaneProps {
  direction: "horizontal" | "vertical";
  primary?: "first" | "second";
  primarySize: number;
  onPrimarySizeChange: (px: number) => void;
  minPrimary?: number;
  maxPrimary?: number;
  children: [React.ReactNode, React.ReactNode];
  primaryClass?: string;
  secondaryClass?: string;
  className?: string;
  /**
   * Optional collapse control rendered ON the divider. Clicking it fires
   * `onCollapse`. `collapseToward` says which physical edge the panel folds
   * into, which picks the chevron direction (the chevron points the way the
   * panel will disappear). Used to give every resizable panel a visible,
   * tasteful collapse affordance right where the user already grabs to
   * resize — not just a hidden hotkey.
   */
  onCollapse?: () => void;
  collapseToward?: "left" | "right" | "up" | "down";
  collapseLabel?: string;
}

export default function SplitPane({
  direction,
  primary = "first",
  primarySize,
  onPrimarySizeChange,
  minPrimary = 100,
  maxPrimary = 2000,
  children,
  primaryClass = "",
  secondaryClass = "",
  className = "",
  onCollapse,
  collapseToward,
  collapseLabel,
}: SplitPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const startMouse = useRef(0);
  const startSize = useRef(0);

  const isHoriz = direction === "horizontal";
  const CollapseIcon =
    collapseToward === "left" ? ChevronLeft :
    collapseToward === "right" ? ChevronRight :
    collapseToward === "up" ? ChevronUp :
    ChevronDown;

  function onDown(e: React.MouseEvent) {
    e.preventDefault();
    startMouse.current = isHoriz ? e.clientX : e.clientY;
    startSize.current = primarySize;
    document.body.style.cursor = isHoriz ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";

    const move = (ev: MouseEvent) => {
      const cur = isHoriz ? ev.clientX : ev.clientY;
      const delta = (cur - startMouse.current) * (primary === "first" ? 1 : -1);
      const next = Math.max(minPrimary, Math.min(maxPrimary, startSize.current + delta));
      onPrimarySizeChange(next);
    };
    const up = () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  // Keyboard resize (left/right arrows when divider focused)
  function onKey(e: React.KeyboardEvent) {
    const step = e.shiftKey ? 40 : 8;
    if (isHoriz) {
      if (e.key === "ArrowLeft") onPrimarySizeChange(Math.max(minPrimary, primarySize - step));
      else if (e.key === "ArrowRight") onPrimarySizeChange(Math.min(maxPrimary, primarySize + step));
    } else {
      if (e.key === "ArrowUp") onPrimarySizeChange(Math.max(minPrimary, primarySize - step));
      else if (e.key === "ArrowDown") onPrimarySizeChange(Math.min(maxPrimary, primarySize + step));
    }
  }

  const containerCls = `flex ${isHoriz ? "flex-row" : "flex-col"} h-full w-full overflow-hidden ${className}`;

  const primaryStyle = isHoriz
    ? { width: `${primarySize}px`, flexShrink: 0 }
    : { height: `${primarySize}px`, flexShrink: 0 };

  // Children always render in their declared order (children[0] in position 1,
  // children[1] in position 2). `primary` only controls which child gets the
  // FIXED size (primaryStyle) — the other one fills remaining space via flex-1.
  // Note: a previous version of this component *also* swapped children when
  // `primary="second"`, which produced an inverted layout (e.g. BottomDock
  // ended up at the top while SidesAndCenter was squeezed to the bottom).
  // That was a real bug — keep children in declared order here.
  const firstIsPrimary = primary === "first";
  const firstClass = firstIsPrimary ? primaryClass : secondaryClass;
  const secondClass = firstIsPrimary ? secondaryClass : primaryClass;

  return (
    <div ref={containerRef} className={containerCls}>
      <div style={firstIsPrimary ? primaryStyle : undefined}
           className={`${firstClass} ${firstIsPrimary ? "" : "flex-1 min-w-0 min-h-0"} overflow-hidden`}>
        {children[0]}
      </div>
      <div
        className={`dock-divider ${isHoriz ? "vertical" : "horizontal"} ${onCollapse ? "has-collapse" : ""}`}
        onMouseDown={onDown}
        onKeyDown={onKey}
        tabIndex={0}
        role="separator"
        aria-orientation={isHoriz ? "vertical" : "horizontal"}
        aria-label={`Resize ${isHoriz ? "horizontal" : "vertical"} split`}
      >
        {onCollapse && (
          <button
            type="button"
            // Don't let the press start a drag on the parent divider.
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onCollapse(); }}
            className="divider-collapse-btn"
            aria-label={collapseLabel ?? "Collapse panel"}
            title={collapseLabel ?? "Collapse panel"}
          >
            <CollapseIcon className="h-5 w-5" strokeWidth={2.5} />
          </button>
        )}
      </div>
      <div style={!firstIsPrimary ? primaryStyle : undefined}
           className={`${secondClass} ${!firstIsPrimary ? "" : "flex-1 min-w-0 min-h-0"} overflow-hidden`}>
        {children[1]}
      </div>
    </div>
  );
}
