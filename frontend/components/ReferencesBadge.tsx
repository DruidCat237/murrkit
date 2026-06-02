"use client";

/**
 * ReferencesBadge — TitleBar pill showing user reference materials count
 * for the active project. Click → opens References center tab.
 *
 * Inner Claude is auto-aware of these files via the chat router system
 * prompt (see backend/routers/chat.py — references snippet inject).
 *
 * Polls /api/references/list every 8s so newly-dropped files appear
 * without manual refresh.
 */

import { useCallback, useEffect, useState } from "react";
import { FolderOpen, Image as ImageIcon } from "lucide-react";
import { BACKEND } from "@/lib/api";
import { useLayout } from "@/store/layout";
import { useSession } from "@/store/session";

export default function ReferencesBadge() {
  const [count, setCount] = useState<number | null>(null);
  const [hasError, setHasError] = useState(false);
  const projectName = useSession((s) => s.activeProject);
  const openOrFocus = useLayout((s) => s.openOrFocusCenterTab);

  const poll = useCallback(async () => {
    try {
      const r = await fetch(
        `${BACKEND}/api/references/list?project=${encodeURIComponent(projectName)}`,
        { signal: AbortSignal.timeout(2000) },
      );
      if (!r.ok) {
        setHasError(true);
        return;
      }
      const data = await r.json();
      setCount(data.total ?? 0);
      setHasError(false);
    } catch {
      setHasError(true);
    }
  }, [projectName]);

  useEffect(() => {
    poll();
    const t = setInterval(poll, 8000);
    return () => clearInterval(t);
  }, [poll]);

  // Fail-soft: don't render if endpoint is broken (shouldn't pollute titlebar)
  if (hasError) return null;

  const isEmpty = count === null || count === 0;

  return (
    <button
      onClick={() => openOrFocus("references")}
      className={[
        "h-7 px-2 rounded-md flex items-center gap-1.5 border text-[10px] font-mono transition-colors",
        isEmpty
          ? "border-line text-text-dim hover:text-text hover:border-line-strong"
          : "border-amber-500/50 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20",
      ].join(" ")}
      title={
        isEmpty
          ? "Click to open References tab — drop gameplay clips, real-game screenshots, mood-board images here. Inner Claude auto-uses them as ground-truth."
          : `${count} reference material(s) for ${projectName} — Claude has full access. Click to manage.`
      }
    >
      <FolderOpen className="h-3 w-3" />
      <ImageIcon className="h-2.5 w-2.5 -ml-0.5" />
      <span>Refs</span>
      {!isEmpty && (
        <span className="px-1 rounded bg-amber-500/20 text-amber-200">
          {count}
        </span>
      )}
    </button>
  );
}
