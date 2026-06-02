"use client";

import { useEffect, useRef, useState } from "react";

/**
 * useWsStream — generic WebSocket subscription hook with automatic
 * reconnect (exponential backoff) and ping keepalive.
 *
 * @param opener  factory: open the WS, pass onMessage callback in.
 * @returns       {connected, retryCount}
 */
export function useWsStream<T>(
  opener: (onMessage: (m: T) => void) => WebSocket | null,
  onMessage: (m: T) => void,
  opts: { enabled?: boolean; maxBackoffMs?: number; reconnectKey?: string | number } = {}
): { connected: boolean; retryCount: number } {
  const { enabled = true, maxBackoffMs = 16_000, reconnectKey = "" } = opts;
  const [connected, setConnected] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onMsgRef = useRef(onMessage);
  onMsgRef.current = onMessage;
  const openerRef = useRef(opener);
  openerRef.current = opener;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let attempt = 0;

    function connect(): void {
      if (cancelled) return;
      const ws = openerRef.current((m) => onMsgRef.current(m));
      if (!ws) return;
      wsRef.current = ws;

      const origOnClose = ws.onclose;
      const origOnError = ws.onerror;
      ws.onopen = () => {
        if (cancelled) return;
        attempt = 0;
        setConnected(true);
        setRetryCount(0);
      };
      ws.onclose = (e) => {
        if (typeof origOnClose === "function") (origOnClose as EventListener).call(ws, e);
        if (cancelled) return;
        setConnected(false);
        attempt += 1;
        setRetryCount(attempt);
        const wait = Math.min(maxBackoffMs, 1000 * 2 ** Math.min(attempt, 4));
        timerRef.current = setTimeout(connect, wait);
      };
      ws.onerror = (e) => {
        if (typeof origOnError === "function") (origOnError as EventListener).call(ws, e);
        // close handler will fire too
      };
    }

    connect();

    return () => {
      cancelled = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      try { wsRef.current?.close(); } catch { /* ignore */ }
      wsRef.current = null;
    };
  }, [enabled, maxBackoffMs, reconnectKey]);

  return { connected, retryCount };
}
