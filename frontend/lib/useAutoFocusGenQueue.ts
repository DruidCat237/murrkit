"use client";

/**
 * useAutoFocusGenQueue — global subscriber to /ws/gen-queue that
 * automatically opens the Queue tab in the center dock whenever inner
 * Claude (or any caller) stages tasks with `status="planned"` and the
 * pipeline blocks waiting for the user's ACCEPT.
 *
 * Without this hook, planned tasks lived only in the collapsed bottom
 * dock — the user had no visible signal that the experiment was paused.
 * See observation log experiment-2-angry-cats-observations.md, bug #5.
 *
 * Triggers:
 *   - On initial snapshot: if ANY task has status="planned" → focus Queue.
 *   - On live `planned` events: focus Queue immediately.
 *
 * Mounted once in MainLayout so it stays connected across tab switches.
 */
import { useEffect, useRef } from "react";
import { BACKEND, backendReady } from "@/lib/api";
import { useLayout } from "@/store/layout";

export function useAutoFocusGenQueue() {
  const openOrFocus = useLayout((s) => s.openOrFocusCenterTab);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;

    function connect() {
      if (cancelled) return;
      // Wait for backend probe so we connect to the correct port.
      backendReady.then(() => {
        if (cancelled) return;
        const url = BACKEND.replace(/^http/, "ws") + "/ws/gen-queue";
        const ws = new WebSocket(url);
        wsRef.current = ws;

        ws.onmessage = (e) => {
          try {
            const msg = JSON.parse(e.data);
            if (msg.event === "snapshot") {
              const hasPlanned = (msg.tasks || []).some(
                (t: { status?: string }) => t.status === "planned",
              );
              if (hasPlanned) openOrFocus("queue");
            } else if (msg.event === "planned") {
              openOrFocus("queue");
            }
          } catch {
            /* ignore malformed */
          }
        };

        ws.onclose = () => {
          wsRef.current = null;
          if (cancelled) return;
          // Reconnect after 3s — survives backend port hops.
          reconnectTimer.current = setTimeout(connect, 3000);
        };

        ws.onerror = () => {
          /* onclose fires next */
        };
      });
    }

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [openOrFocus]);
}
