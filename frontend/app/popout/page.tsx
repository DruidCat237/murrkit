"use client";

/**
 * /popout — a single dock panel rendered full-window in its OWN floating
 * browser window (see lib/popout.ts). This is what "Detach" opens: a real OS
 * window the user can drag to a second monitor.
 *
 * It reuses the exact same panel components the in-app dock uses
 * (`CenterTabContent`), so the detached Library / Chat / Vision / etc. behaves
 * identically. The active project is passed via the URL (and also persists in
 * localStorage), and the theme is applied by the no-FOUC script in the root
 * layout, so the popout matches the main window out of the box.
 */

import { Suspense, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { Minimize2 } from "lucide-react";
import CenterTabContent from "@/components/layout/CenterTabContent";
import { useSession } from "@/store/session";
import { useLayout } from "@/store/layout";
import type { CenterTab, CenterTabKind } from "@/lib/types";

function PopoutInner() {
  const params = useSearchParams();
  const kind = (params.get("tab") || "chat") as CenterTabKind;
  const file = params.get("file") || undefined;
  const title = params.get("title") || kind;
  const project = params.get("project") || undefined;

  const setActiveProject = useSession((s) => s.setActiveProject);
  const loadLayout = useLayout((s) => s.loadFromStorage);

  useEffect(() => {
    // Sync persisted layout (theme, etc.) into this window's store, and scope
    // the panel to the same project the main window was on.
    loadLayout();
    if (project) setActiveProject(project);
    document.title = `${title} — murrkit`;
  }, [project, title, setActiveProject, loadLayout]);

  const tab: CenterTab = { id: `popout-${kind}`, kind, title, file };

  return (
    <div className="h-screen w-screen flex flex-col bg-bg text-text overflow-hidden">
      <div className="h-9 shrink-0 flex items-center justify-between px-3 border-b border-line bg-bg-panel">
        <div className="flex items-center gap-2 text-xs font-medium min-w-0">
          <span className="h-5 w-5 rounded flex items-center justify-center shrink-0"
                style={{ background: "color-mix(in oklab, var(--accent) 20%, transparent)" }}>
            <span className="text-accent text-[10px] font-bold">2D</span>
          </span>
          <span className="truncate">{title}</span>
          <span className="text-text-subtle shrink-0">— detached window</span>
        </div>
        <button
          onClick={() => window.close()}
          className="flex items-center gap-1 h-6 px-2 rounded text-[11px] text-text-dim border border-line hover:text-accent hover:border-accent/60 hover:bg-accent/10 transition-colors shrink-0"
          title="Close this window and dock the panel back into the main window"
        >
          <Minimize2 className="h-3.5 w-3.5" />
          Dock back
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-hidden">
        <CenterTabContent tab={tab} />
      </div>
    </div>
  );
}

export default function PopoutPage() {
  return (
    <Suspense fallback={<div className="h-screen w-screen bg-bg" />}>
      <PopoutInner />
    </Suspense>
  );
}
