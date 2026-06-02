"use client";

import { useEffect, useState } from "react";
import GenQueuePanel from "../queue/GenQueuePanel";
import type { BottomTab } from "@/lib/types";
import { BACKEND } from "@/lib/api";

interface BottomTabContentProps { tab: BottomTab; }

export default function BottomTabContent({ tab }: BottomTabContentProps) {
  switch (tab.kind) {
    case "gen-queue":     return <GenQueuePanel />;
    case "unity-console": return <UnityConsoleTab />;
    case "logs":          return <LogsTab />;
    case "problems":      return <ProblemsTab />;
    case "output":        return <OutputTab />;
    case "terminal":      return <TerminalPlaceholder />;
  }
}

function LogsTab() {
  // Render the existing LogViewer — it manages its own open state, but the
  // `Cmd+J → focus Logs tab` path already opens the bottom dock and the
  // user can click the LogViewer drawer button if needed. Render a docked
  // alternative below the legacy drawer for a complete in-dock experience.
  return (
    <div className="h-full w-full flex flex-col bg-bg">
      <DockedLogTail />
    </div>
  );
}

function DockedLogTail() {
  const [lines, setLines] = useState<Array<{ level?: string; msg?: string; component?: string; ts?: string; raw?: string }>>([]);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    // initial fetch
    fetch(`${BACKEND}/api/logs/recent?limit=200`)
      .then((r) => r.ok ? r.json() : Promise.reject(r.statusText))
      .then((d) => setLines(d.lines ?? []))
      .catch(() => { /* ignore */ });

    // WS tail
    const ws = new WebSocket(BACKEND.replace(/^http/, "ws") + "/api/logs/tail");
    ws.onmessage = (e) => {
      if (paused) return;
      try {
        const parsed = JSON.parse(e.data);
        setLines((prev) => [...prev.slice(-499), parsed]);
      } catch { /* ignore */ }
    };
    return () => { try { ws.close(); } catch { /* ignore */ } };
  }, [paused]);

  const LEVEL_COLORS: Record<string, string> = {
    TRACE: "text-text-subtle",
    DEBUG: "text-text-subtle",
    INFO: "text-text-dim",
    SUCCESS: "text-ok",
    WARNING: "text-accent-warn",
    ERROR: "text-err",
    CRITICAL: "text-err font-bold",
  };

  return (
    <div className="h-full w-full flex flex-col bg-bg overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-line shrink-0 text-xs">
        <span className="font-semibold">Backend Logs</span>
        <span className="text-text-subtle">{lines.length} lines</span>
        <button onClick={() => setPaused((p) => !p)} className="ml-auto btn btn-ghost text-xs">
          {paused ? "Resume" : "Pause"}
        </button>
        <button onClick={() => setLines([])} className="btn btn-ghost text-xs">Clear</button>
      </div>
      <div className="flex-1 overflow-auto p-1.5 font-mono text-[10.5px]">
        {lines.length === 0 ? (
          <div className="text-center text-text-subtle py-6">Waiting for log lines…</div>
        ) : lines.map((l, i) => (
          <div key={i} className={`px-1 py-0.5 ${LEVEL_COLORS[l.level ?? "INFO"] ?? "text-text-dim"} hover:bg-bg-subtle`}>
            <span className="text-text-subtle">{(l.ts ?? "").slice(11, 19)} </span>
            <span className="text-text-dim">[{l.component ?? "—"}]</span>{" "}
            <span>{l.msg ?? l.raw ?? ""}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function UnityConsoleTab() {
  const [lines, setLines] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    setBusy(true);
    try {
      const r = await fetch(`${BACKEND}/api/unity/editor/console`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ count: 100, types: ["error", "exception", "warning", "log"] }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      const arr: string[] = [];
      const entries = data.result?.entries ?? data.entries ?? [];
      for (const e of entries) {
        const ts = e.timestamp ?? "";
        const lvl = e.type ?? e.level ?? "log";
        const msg = e.message ?? e.text ?? "";
        arr.push(`[${ts}] [${lvl}] ${msg}`);
      }
      setLines(arr.reverse());
    } catch (e) {
      setLines([`error: ${(e as Error).message}`]);
    } finally { setBusy(false); }
  }

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="h-full w-full flex flex-col bg-bg">
      <div className="px-3 py-2 border-b border-line shrink-0 text-xs flex items-center gap-2">
        <span className="font-semibold">Phaser Console</span>
        <span className="text-text-subtle">{lines.length} lines</span>
        <button onClick={refresh} className="ml-auto btn btn-ghost text-xs" disabled={busy}>
          {busy ? "…" : "Refresh"}
        </button>
      </div>
      <div className="flex-1 overflow-auto p-2 font-mono text-[11px] text-text-dim">
        {lines.length === 0 ? (
          <div className="text-center py-6 text-text-subtle">No console output yet</div>
        ) : lines.map((l, i) => (
          <div key={i} className={l.includes("[error]") || l.includes("[exception]") ? "text-err" : ""}>
            {l}
          </div>
        ))}
      </div>
    </div>
  );
}

function ProblemsTab() {
  return (
    <div className="h-full flex items-center justify-center text-text-subtle text-sm">
      <div className="text-center px-6">
        <div className="text-2xl mb-2">✓</div>
        No problems detected.
      </div>
    </div>
  );
}

function OutputTab() {
  return (
    <div className="h-full p-4 font-mono text-xs text-text-dim overflow-auto">
      <p># Output</p>
      <p>Backend logs and tool output will appear here.</p>
      <p className="text-text-subtle mt-2">For live backend tail use the Logs tab.</p>
    </div>
  );
}

function TerminalPlaceholder() {
  return (
    <div className="h-full p-4 font-mono text-xs text-text-dim">
      <p>$ # Terminal not yet wired in v2</p>
      <p>$ # Use the Logs tab for backend tail.</p>
    </div>
  );
}
