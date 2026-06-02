/**
 * gameState — the GENERIC, GENRE-AGNOSTIC playtest contract surface.
 *
 * Exposes `window.__gameState()` returning a JSON snapshot that the backend
 * `/api/phaser/drive` harness samples once per frame. Any scene (platformer,
 * RPG, slingshot, …) registers ONE state-provider closure via
 * `registerGameState(scene, provider)`; the closure is invoked each time the
 * backend calls `window.__gameState()`.
 *
 * This is the genre-neutral analogue of the frozen slingshot StateRecorder
 * contract (window.__phaserTrace / __phaserCollisions / __phaserScene). The
 * slingshot StateRecorder becomes ONE adapter that ALSO feeds this snapshot —
 * see StateRecorder.ts. Both contracts coexist:
 *   - window.__gameState()      → generic per-frame snapshot (this file)
 *   - window.__phaserTrace etc. → frozen slingshot trace (StateRecorder)
 *
 * Field semantics (every field optional except `t` so any genre can fill only
 * what it has — the backend asserts read missing fields as undefined):
 *   t        → scene.time.now (ms since scene start), monotonic
 *   player   → primary controllable entity: { x, y, vx, vy, onGround? }
 *   hp       → primary player/entity health (number)
 *   mp       → primary player/entity magic/skill points (number; RPG)
 *   score    → current score (number)
 *   scene    → { key, win, lose } — active scene key + win/lose flags
 *   entities → arbitrary tracked objects [{ name, x, y, ... }]
 *   menu     → menu/UI state { open?, selected?, ... } (RPG inventory/combat)
 *   custom   → genre-specific escape hatch (anything JSON-serialisable)
 */

export interface PlayerState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  onGround?: boolean;
}

export interface GameStateSnapshot {
  /** scene.time.now in ms — monotonic per scene. Always present. */
  t: number;
  player?: PlayerState;
  hp?: number;
  /** Primary entity magic/skill points (RPG). Optional like every genre field. */
  mp?: number;
  score?: number;
  scene?: { key: string; win: boolean; lose: boolean };
  entities?: Array<Record<string, unknown>>;
  menu?: Record<string, unknown>;
  custom?: Record<string, unknown>;
}

/** A closure the scene supplies; called once per backend frame-sample. */
export type StateProvider = () => GameStateSnapshot;

interface GameStateWindow {
  __gameState?: StateProvider;
  __gameStateScene?: unknown;
}

/**
 * Register a per-frame state provider for the current scene. The provider is
 * invoked synchronously every time the backend calls `window.__gameState()`.
 * Wrapped so a throwing provider surfaces `{ t, custom: { error } }` instead of
 * a raw page-evaluate exception (the backend treats that as a sampling failure
 * but the timeline keeps a frame — fail loudly, do not silently drop).
 */
export function registerGameState(scene: Phaser.Scene, provider: StateProvider): void {
  const w = window as unknown as GameStateWindow;
  w.__gameStateScene = scene;
  w.__gameState = (): GameStateSnapshot => {
    const snap = provider();
    // Guarantee `t` is present even if a provider forgot it.
    if (snap.t === undefined) snap.t = scene.time.now;
    return snap;
  };
}

/** Tear down the global contract (scene shutdown) so a stale closure that
 *  references a destroyed scene can't be sampled. */
export function clearGameState(): void {
  const w = window as unknown as GameStateWindow;
  delete w.__gameState;
  delete w.__gameStateScene;
}
