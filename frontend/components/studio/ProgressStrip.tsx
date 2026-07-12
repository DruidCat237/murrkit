"use client";

/**
 * ProgressStrip — a slim, always-visible build-activity bar for the Build view.
 *
 * Reuses the live gen-queue store (`store/queue`) and its WebSocket
 * (`openQueueWs`, scoped to the active project) — the same source the IDE's
 * GenQueuePanel consumes. It collapses the queue to a one-line summary: how
 * many assets are generating / queued, the current in-flight task with a
 * progress bar, and a quiet "idle" state otherwise. This is the prompt-first
 * read on "what is the agent doing right now" without opening the dock.
 */

import { useEffect, useMemo } from "react";
import { Loader2, CheckCircle2, AlertTriangle, Sparkles } from "lucide-react";
import { openQueueWs } from "@/lib/api";
import { useWsStream } from "@/hooks/useWsStream";
import { useQueue } from "@/store/queue";
import type { QueueTask, QueueWsEvent } from "@/lib/types";

export default function ProgressStrip({ projectName }: { projectName: string }) {
  const tasks = useQueue((s) => s.tasks);
  const order = useQueue((s) => s.order);
  const connected = useQueue((s) => s.connected);
  const ingest = useQueue((s) => s.ingest);
  const setConnected = useQueue((s) => s.setConnected);

  // Live wire to the gen-queue, scoped to this project. Mirrors GenQueuePanel
  // by going through useWsStream so the strip reconnects (exponential backoff)
  // after a backend restart instead of going permanently blind — the raw
  // useEffect socket here had no retry, so a single restart froze the Build
  // view's activity read until a full page reload.
  const { connected: wsConnected } = useWsStream<QueueWsEvent>(
    (onMsg) => openQueueWs(onMsg, undefined, projectName),
    (e) => ingest(e),
    { reconnectKey: projectName },
  );
  useEffect(() => {
    setConnected(wsConnected);
  }, [wsConnected, setConnected]);

  const mine = useMemo<QueueTask[]>(
    () =>
      order
        .map((id) => tasks[id])
        .filter((t): t is QueueTask => Boolean(t) && t.project === projectName),
    [order, tasks, projectName],
  );

  const active = mine.filter((t) => t.status === "started" || t.status === "progress");
  const queued = mine.filter((t) => t.status === "queued" || t.status === "planned");
  const failed = mine.filter((t) => t.status === "failed");
  const current = active[0] ?? null;

  const lastDone = useMemo(() => {
    const done = mine
      .filter((t) => t.status === "completed" && t.completed_at)
      .sort((a, b) => (b.completed_at ?? 0) - (a.completed_at ?? 0));
    return done[0] ?? null;
  }, [mine]);

  const busy = active.length > 0 || queued.length > 0;

  return (
    <div className="flex items-center gap-3 h-9 px-3 border-t border-line bg-bg-panel text-xs shrink-0">
      {/* Connection / activity dot */}
      <span
        className={[
          "inline-flex h-2 w-2 rounded-full shrink-0",
          busy ? "bg-accent pulse-live" : connected ? "bg-ok/70" : "bg-text-subtle",
        ].join(" ")}
        title={connected ? "Live" : "Reconnecting…"}
      />

      {/* TODO: surface /api/chat/autoplay iteration status (e.g. "agent working… iter N") once
           the autoplay WS exposes per-iteration events without new infra. */}

      {current ? (
        <>
          <Loader2 className="h-3.5 w-3.5 text-accent animate-spin shrink-0" />
          <span className="text-text-dim truncate max-w-[40%]">
            <span className="text-text font-medium">{labelFor(current)}</span>
            {current.progress_text ? ` · ${current.progress_text}` : ""}
          </span>
          <div className="flex-1 min-w-[60px] h-1.5 rounded-full bg-bg-subtle overflow-hidden">
            <div
              className="h-full rounded-full bg-accent transition-all duration-500"
              style={{ width: `${Math.max(4, Math.min(100, current.progress_pct || 8))}%` }}
            />
          </div>
          <span className="tabular-nums text-text-subtle shrink-0">
            {current.progress_pct ? `${Math.round(current.progress_pct)}%` : ""}
          </span>
        </>
      ) : busy ? (
        <>
          <Loader2 className="h-3.5 w-3.5 text-accent animate-spin shrink-0" />
          <span className="text-text-dim flex-1">Preparing build tasks…</span>
        </>
      ) : (
        <>
          <Sparkles className="h-3.5 w-3.5 text-text-subtle shrink-0" />
          <span className="text-text-subtle flex-1">
            {lastDone ? "Up to date — describe your next change" : "Ready — describe the game you want"}
          </span>
        </>
      )}

      {/* Right-side counters */}
      <div className="flex items-center gap-2.5 shrink-0">
        {active.length > 1 && (
          <span className="tabular-nums text-accent text-[10px] px-1.5 py-0.5 rounded bg-accent/10 border border-accent/25">
            {active.length} active
          </span>
        )}
        {queued.length > 0 && (
          <span className="text-text-subtle tabular-nums">{queued.length} queued</span>
        )}
        {lastDone && !busy && (
          <span className="inline-flex items-center gap-1 text-ok">
            <CheckCircle2 className="h-3.5 w-3.5" />
            done
          </span>
        )}
        {failed.length > 0 && (
          <span className="inline-flex items-center gap-1 text-err" title={failed[0].error ?? "task failed"}>
            <AlertTriangle className="h-3.5 w-3.5" />
            {failed.length} failed
          </span>
        )}
      </div>
    </div>
  );
}

function labelFor(t: QueueTask): string {
  const kind = (t.asset_type || "asset").replace(/_/g, " ");
  const prompt = (t.prompt || "").trim();
  if (prompt) return prompt.length > 40 ? `${prompt.slice(0, 40)}…` : prompt;
  return `Generating ${kind}`;
}
