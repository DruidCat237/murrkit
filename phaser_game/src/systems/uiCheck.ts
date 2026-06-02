/**
 * Deterministic UI-QA — window.__uiCheck()
 *
 * Scans every VISIBLE scene for Text objects that (a) OVERLAP each other or
 * (b) run OFF-SCREEN / clipped at a canvas edge. Pure geometry from each
 * object's getBounds() — NO vision model, NO cost. Exposed on `window` so BOTH
 * the backend (`POST /api/phaser/ui-check`) AND the inner Claude (via the
 * Playwright-MCP `browser_evaluate`, in ANY menu/HUD/dialog state it has clicked
 * to) call the exact same check.
 *
 * Built because chat-history analysis showed the #1 recurring small failure was
 * UI text overlap / clipping that the USER had to catch by eye ("COURT nachodzi
 * na ramkę", "note collides with BACK", "tiles cover the ball"). Now the agent
 * catches it itself and self-iterates before showing the user.
 */

export interface UiCheckReport {
  ok: boolean;
  screen: { w: number; h: number };
  textCount: number;
  offscreen: { text: string; name: string; x: number; y: number; w: number; h: number }[];
  overlaps: { a: string; b: string; aName: string; bName: string; frac: number }[];
}

declare global {
  interface Window {
    __uiCheck?: (opts?: { overlapFrac?: number }) => UiCheckReport;
  }
}

export function installUiCheck(): void {
  window.__uiCheck = (opts?: { overlapFrac?: number }): UiCheckReport => {
    const overlapFrac = opts?.overlapFrac ?? 0.18;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const game: any = (window as any).game;
    const empty: UiCheckReport = {
      ok: true, screen: { w: 0, h: 0 }, textCount: 0, offscreen: [], overlaps: [],
    };
    if (!game || !game.scale) return empty;
    const W = game.scale.width, H = game.scale.height;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const texts: any[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const walk = (list: any[], sceneKey: string): void => {
      for (const o of list) {
        if (!o || o.visible === false || (typeof o.alpha === "number" && o.alpha <= 0.02)) continue;
        const isText =
          o.type === "Text" || o.type === "BitmapText" || o.type === "DynamicBitmapText" ||
          (typeof o.setText === "function" && o.text !== undefined);
        if (isText && typeof o.getBounds === "function") {
          const b = o.getBounds();
          const s = (o.text ?? "").toString().trim().slice(0, 50);
          if (b.width > 1 && b.height > 1 && s) {
            texts.push({ scene: sceneKey, text: s, name: o.name || "", x: b.x, y: b.y, w: b.width, h: b.height });
          }
        }
        if (o.list && o.list.length) walk(o.list, sceneKey);  // recurse into containers
      }
    };
    for (const sc of game.scene.scenes) {
      if (sc.scene.isVisible && sc.scene.isVisible() && sc.children && sc.children.list) {
        walk(sc.children.list, sc.scene.key);
      }
    }

    const m = 2;  // px tolerance at the edges
    const offscreen = texts
      .filter((t) => t.x < -m || t.y < -m || t.x + t.w > W + m || t.y + t.h > H + m)
      .map((t) => ({ text: t.text, name: t.name, x: Math.round(t.x), y: Math.round(t.y), w: Math.round(t.w), h: Math.round(t.h) }));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const overlaps: any[] = [];
    for (let i = 0; i < texts.length; i++) {
      for (let j = i + 1; j < texts.length; j++) {
        const a = texts[i], b = texts[j];
        const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
        const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
        const area = ix * iy;
        if (area <= 0) continue;
        const frac = area / Math.min(a.w * a.h, b.w * b.h);
        if (frac >= overlapFrac) {
          overlaps.push({ a: a.text, b: b.text, aName: a.name, bName: b.name, frac: +frac.toFixed(2) });
        }
      }
    }

    return {
      ok: offscreen.length === 0 && overlaps.length === 0,
      screen: { w: W, h: H },
      textCount: texts.length,
      offscreen,
      overlaps,
    };
  };
}
