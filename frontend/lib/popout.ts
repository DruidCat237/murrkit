"use client";

/**
 * openPopout — open one of the dock panels in its OWN floating browser window.
 *
 * Unlike a dock split (which just re-homes a tab into another pane inside the
 * same window), this is a REAL OS-level window: the user can move it anywhere,
 * including onto a second monitor, resize it, and keep it on top. It loads the
 * dedicated `/popout` route which renders a single panel full-window.
 *
 * Returns the Window handle (or null if the browser blocked the popup) so the
 * caller can watch `w.closed` and dock the panel back when it's closed.
 */
export function openPopout(
  opts: { kind: string; title?: string; file?: string },
  project?: string,
): Window | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams();
  params.set("tab", opts.kind);
  if (opts.title) params.set("title", opts.title);
  if (opts.file) params.set("file", opts.file);
  if (project) params.set("project", project);
  // A stable name per kind+file so re-detaching focuses the existing window
  // instead of stacking duplicates.
  const name = `phaser2d-popout-${opts.kind}-${opts.file ?? ""}`;
  // `popup=yes` + explicit size → minimal-chrome OS window (no tab bar).
  const features = "popup=yes,width=820,height=900,left=140,top=90";
  return window.open(`/popout?${params.toString()}`, name, features);
}
