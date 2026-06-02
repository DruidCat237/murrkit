/**
 * events.ts — a tiny typed event emitter shared by the RPG systems.
 *
 * The systems (inventory, combat, …) stay framework-free, so they emit through
 * this minimal emitter instead of Phaser.Events.EventEmitter. A scene that wants
 * Phaser semantics can still forward these into `scene.events`. Typed by an event
 * map so `on("equip", cb)` gives `cb` the right payload.
 */

export type Listener<P> = (payload: P) => void;

/** A typed emitter over an event-name → payload map. */
export class TypedEmitter<Events extends Record<string, unknown>> {
  private listeners: { [K in keyof Events]?: Set<Listener<Events[K]>> } = {};

  on<K extends keyof Events>(event: K, fn: Listener<Events[K]>): () => void {
    (this.listeners[event] ??= new Set()).add(fn);
    return () => this.off(event, fn);
  }

  off<K extends keyof Events>(event: K, fn: Listener<Events[K]>): void {
    this.listeners[event]?.delete(fn);
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.listeners[event];
    if (!set) return;
    // Iterate a copy so a listener that unsubscribes mid-emit can't skip peers.
    for (const fn of [...set]) fn(payload);
  }

  /** Drop every listener (system teardown). */
  clear(): void {
    this.listeners = {};
  }
}
