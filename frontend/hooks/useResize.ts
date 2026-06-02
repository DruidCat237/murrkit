"use client";

import { useEffect, useRef } from "react";

/**
 * useDragResize — generic mouse-drag resize hook.
 *
 * Returns a ref + `onMouseDown` you can spread onto your resize handle.
 * Calls `onResize(delta)` continuously while dragging.
 *
 * @param direction  'horizontal' (drag changes width) | 'vertical' (height)
 * @param onResize   callback receiving the cumulative delta in pixels
 * @param onEnd      optional callback when drag ends
 */
export function useDragResize(
  direction: "horizontal" | "vertical",
  onResize: (delta: number) => void,
  onEnd?: () => void
): {
  ref: React.RefObject<HTMLDivElement | null>;
  onMouseDown: (e: React.MouseEvent) => void;
  isDragging: boolean;
} {
  const ref = useRef<HTMLDivElement | null>(null);
  const startPos = useRef<number>(0);
  const isDragging = useRef<boolean>(false);

  function onMouseDown(e: React.MouseEvent) {
    e.preventDefault();
    isDragging.current = true;
    startPos.current = direction === "horizontal" ? e.clientX : e.clientY;
    document.body.style.cursor = direction === "horizontal" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
  }

  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (!isDragging.current) return;
      const cur = direction === "horizontal" ? e.clientX : e.clientY;
      const delta = cur - startPos.current;
      onResize(delta);
    }
    function onUp() {
      if (!isDragging.current) return;
      isDragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      onEnd?.();
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [direction, onResize, onEnd]);

  return { ref, onMouseDown, isDragging: isDragging.current };
}
