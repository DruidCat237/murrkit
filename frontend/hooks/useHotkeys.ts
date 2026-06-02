"use client";

import { useEffect, useRef } from "react";

/**
 * Minimal `useHotkeys` hook — fires `handler` when the matching combo
 * is pressed at the window level. Combos use a vscode-ish syntax:
 *   "mod+k"        -> Cmd on mac, Ctrl elsewhere
 *   "mod+shift+p"  -> Cmd/Ctrl + Shift + P
 *   "esc"
 *   "mod+\\"
 *   "mod+1"
 *
 * Designed for low-allocation: registers one global listener per hook
 * call and skips the handler when typing in inputs unless `inInputs` is
 * true. Handler is stored in a ref so re-renders don't re-register.
 */
export function useHotkeys(
  combo: string,
  handler: (e: KeyboardEvent) => void,
  opts: { inInputs?: boolean; enabled?: boolean } = {}
): void {
  const { inInputs = false, enabled = true } = opts;
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!enabled) return;
    function listener(e: KeyboardEvent): void {
      const target = e.target as HTMLElement | null;
      if (!inInputs && target) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable) {
          // Allow esc + Cmd+K even in inputs (palette)
          if (combo !== "esc" && combo !== "mod+k") return;
        }
      }
      if (matchCombo(combo, e)) {
        e.preventDefault();
        handlerRef.current(e);
      }
    }
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [combo, inInputs, enabled]);
}

function matchCombo(combo: string, e: KeyboardEvent): boolean {
  const parts = combo.toLowerCase().split("+").map((s) => s.trim());
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform);

  const wantMod = parts.includes("mod");
  const wantShift = parts.includes("shift");
  const wantAlt = parts.includes("alt") || parts.includes("opt");
  const wantCtrl = parts.includes("ctrl");

  const modOk = wantMod ? (isMac ? e.metaKey : e.ctrlKey) : true;
  const shiftOk = e.shiftKey === wantShift;
  const altOk = e.altKey === wantAlt;
  const ctrlOk = wantCtrl ? e.ctrlKey : true;

  const key = parts.filter((p) => !["mod", "shift", "alt", "opt", "ctrl"].includes(p)).pop() || "";
  let keyOk = false;
  if (key === "esc") keyOk = e.key === "Escape";
  else if (key === "enter") keyOk = e.key === "Enter";
  else if (key === "\\") keyOk = e.key === "\\";
  else if (key.length === 1) keyOk = e.key.toLowerCase() === key;
  else keyOk = e.key.toLowerCase() === key;

  return modOk && shiftOk && altOk && ctrlOk && keyOk;
}
