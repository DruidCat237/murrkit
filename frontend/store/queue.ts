"use client";

import { create } from "zustand";
import { BACKEND } from "@/lib/api";
import type { QueueTask, QueueWsEvent } from "@/lib/types";

interface QueueState {
  tasks: Record<string, QueueTask>;
  order: string[];
  maxParallel: number;
  connected: boolean;
  lastRefetchAt: number; // epoch ms — used to throttle redundant refetches

  ingest: (e: QueueWsEvent) => void;
  setConnected: (v: boolean) => void;
  clear: () => void;
  /**
   * Bug #167 fix — pull the authoritative task list from
   * `GET /api/gen-queue/list` and replace the local store, so the panel
   * stays live without the user needing to F5.
   *
   * Triggered automatically on every WS reconnect (transition false→true)
   * inside `setConnected`. The panel also calls this on a periodic poll
   * and on tab-focus/visibilitychange so events dropped during a network
   * blip never leave a zombie "planned" row behind.
   */
  refetch: (project?: string) => Promise<void>;
}

export const useQueue = create<QueueState>((set, get) => ({
  tasks: {},
  order: [],
  maxParallel: 3,
  connected: false,
  lastRefetchAt: 0,

  ingest(e) {
    if (e.event === "snapshot") {
      const tasks: Record<string, QueueTask> = {};
      const order: string[] = [];
      for (const t of e.tasks) {
        tasks[t.id] = t;
        order.push(t.id);
      }
      set({ tasks, order, maxParallel: e.max_parallel });
      return;
    }
    // planned / queued / started / progress / completed / failed / cancelled / removed
    const t = e.task;
    const prev = get().tasks;
    let order = get().order;
    if (e.event === "cancelled" && prev[t.id]?.status === "planned") {
      // Planned rows are removed entirely on cancel (discard_planned)
      const { [t.id]: _, ...rest } = prev;
      set({ tasks: rest, order: order.filter((id) => id !== t.id) });
      return;
    }
    if (e.event === "removed") {
      // Bulk-clear sweep removed this task from the backend store — drop it.
      const { [t.id]: _, ...rest } = prev;
      set({ tasks: rest, order: order.filter((id) => id !== t.id) });
      return;
    }
    const tasks = { ...prev, [t.id]: t };
    if (!order.includes(t.id)) order = [...order, t.id];
    set({ tasks, order });
  },
  setConnected(v) {
    const wasConnected = get().connected;
    set({ connected: v });
    // Bug #167: on every WS reconnect (false→true) the backend pushes a
    // fresh snapshot, but events can still be dropped during the gap.
    // Belt-and-suspenders: also pull the authoritative state via HTTP so
    // zombie "planned" rows never linger.
    if (v && !wasConnected) {
      void get().refetch();
    }
  },
  clear() { set({ tasks: {}, order: [] }); },

  async refetch(project) {
    // Throttle: at most one refetch per 1500ms regardless of caller.
    const now = Date.now();
    if (now - get().lastRefetchAt < 1500) return;
    set({ lastRefetchAt: now });
    try {
      const res = await fetch(`${BACKEND}/api/gen-queue/list`, {
        signal: AbortSignal.timeout(4000),
      });
      if (!res.ok) return;
      const data = await res.json() as { tasks: QueueTask[]; max_parallel: number; ts: number };
      const tasks: Record<string, QueueTask> = {};
      const order: string[] = [];
      // Backend returns ALL projects; the panel filters per active project
      // client-side, matching the WS broadcast behaviour.
      for (const t of data.tasks) {
        // Defensive: skip stale rows that don't match the requested project
        // when caller asked for one.
        if (project && t.project !== project) {
          tasks[t.id] = t;
          order.push(t.id);
          continue;
        }
        tasks[t.id] = t;
        order.push(t.id);
      }
      set({ tasks, order, maxParallel: data.max_parallel });
    } catch {
      // Network blip / abort — the periodic poll will retry. One missed
      // reconcile is fine; never throw out of a fire-and-forget call.
    }
  },
}));
