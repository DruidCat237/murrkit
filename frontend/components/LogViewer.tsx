"use client";

/**
 * LogViewer — WebSocket-streamed live tail of backend logs visible
 * in a collapsible drawer at the bottom of the page.
 *
 * Filters by component (sprite_pipeline / unity_mcp / chat / etc.)
 */

import { useEffect, useRef, useState } from "react";
import { ChevronUp, Filter, Terminal, X } from "lucide-react";
import { BACKEND } from "@/lib/api";
import type { LogLine } from "@/lib/types";

const LEVEL_COLORS: Record<string, string> = {
  TRACE: "text-text-subtle",
  DEBUG: "text-text-subtle",
  INFO: "text-text",
  SUCCESS: "text-accent",
  WARNING: "text-accent-warn",
  ERROR: "text-err",
  CRITICAL: "text-err font-bold",
};

export default function LogViewer() {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [open, setOpen] = useState(false);
  const [componentFilter, setComponentFilter] = useState<string | "all">("all");
  const [levelFilter, setLevelFilter] = useState<string | "all">("all");
  const [paused, setPaused] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    // Fetch initial 200 lines via /recent
    (async () => {
      try {
        const r = await fetch(`${BACKEND}/api/logs/recent?limit=200`);
        if (r.ok) {
          const data = await r.json();
          setLines(data.lines as LogLine[]);
        }
      } catch {
        // ignore
      }
    })();
    // Open WS for live tail
    const wsUrl = BACKEND.replace(/^http/, "ws") + "/api/logs/tail";
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;
    ws.onmessage = (e) => {
      if (paused) return;
      try {
        const parsed = JSON.parse(e.data) as LogLine;
        setLines((prev) => {
          const next = [...prev, parsed];
          if (next.length > 1000) next.shift();
          return next;
        });
      } catch {
        // ignore
      }
    };
    ws.onclose = () => {
      wsRef.current = null;
    };
    return () => {
      try {
        ws.close();
      } catch {
        // ignore
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Auto-scroll
  useEffect(() => {
    if (paused) return;
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [lines, paused]);

  const components = Array.from(new Set(lines.map((l) => l.component || ""))).filter(Boolean).sort();
  const filtered = lines.filter(
    (l) =>
      (componentFilter === "all" || l.component === componentFilter) &&
      (levelFilter === "all" || l.level === levelFilter)
  );

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-2 left-2 z-30 px-2 py-1 bg-bg-panel border border-line rounded-md text-[10px] text-text-dim hover:text-text flex items-center gap-1 shadow-lg"
        title="Open live log viewer"
      >
        <Terminal className="h-3 w-3" />
        Logs
      </button>
    );
  }

  return (
    <div className="fixed bottom-0 left-0 right-0 z-30 bg-bg-panel border-t border-line shadow-2xl">
      <div className="flex items-center gap-2 px-3 py-1 border-b border-line text-[10px]">
        <Terminal className="h-3 w-3 text-accent" />
        <span className="font-semibold uppercase tracking-wider">Live Logs</span>
        <span className="text-text-subtle">({filtered.length}/{lines.length})</span>

        <Filter className="h-3 w-3 ml-3 text-text-dim" />
        <select
          value={componentFilter}
          onChange={(e) => setComponentFilter(e.target.value)}
          className="bg-bg-subtle border border-line rounded px-1 py-0.5 text-[10px] focus:outline-none focus:border-accent"
        >
          <option value="all">All components</option>
          {components.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
        <select
          value={levelFilter}
          onChange={(e) => setLevelFilter(e.target.value)}
          className="bg-bg-subtle border border-line rounded px-1 py-0.5 text-[10px] focus:outline-none focus:border-accent"
        >
          <option value="all">All levels</option>
          <option>DEBUG</option>
          <option>INFO</option>
          <option>SUCCESS</option>
          <option>WARNING</option>
          <option>ERROR</option>
        </select>

        <button
          onClick={() => setPaused(!paused)}
          className={[
            "px-1.5 py-0.5 rounded border text-[10px]",
            paused
              ? "bg-accent-warn/10 border-accent-warn/40 text-accent-warn"
              : "border-line text-text-dim hover:text-text",
          ].join(" ")}
        >
          {paused ? "▶ Resume" : "⏸ Pause"}
        </button>
        <button
          onClick={() => setLines([])}
          className="text-text-dim hover:text-accent-hot ml-1"
          title="Clear visible"
        >
          clear
        </button>
        <button
          onClick={() => setOpen(false)}
          className="ml-auto text-text-dim hover:text-text p-0.5"
          title="Close"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
      <div
        ref={containerRef}
        className="h-48 overflow-y-auto p-1 font-mono text-[10px] leading-tight bg-bg"
      >
        {filtered.map((l, i) => (
          <div key={i} className="flex gap-2 px-1 py-0.5 hover:bg-bg-subtle">
            <span className="text-text-subtle shrink-0">{l.ts?.slice(11) ?? ""}</span>
            <span className={["shrink-0 w-12", LEVEL_COLORS[l.level || "INFO"] || ""].join(" ")}>
              {l.level}
            </span>
            <span className="text-text-dim shrink-0 w-24 truncate" title={l.module}>
              {l.component || l.module || ""}
            </span>
            <span className="text-text break-all flex-1 min-w-0">
              {l.msg || l.raw}
            </span>
          </div>
        ))}
        {filtered.length === 0 && (
          <div className="text-center text-text-subtle py-4">No log entries.</div>
        )}
      </div>
    </div>
  );
}
