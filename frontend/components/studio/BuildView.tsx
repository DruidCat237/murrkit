"use client";

/**
 * BuildView — the focused, prompt-first working surface for one project.
 *
 * Layout (desktop ≥ md): a horizontal split — the chat conversation on the
 * left (reuses <ChatPanel>) and the LIVE GAME on the right (<GamePreviewLite>,
 * the same Vite-iframe embed the IDE uses). A slim <ProgressStrip> spans the
 * bottom (live gen-queue). The model picker is a VISIBLE labeled control in the
 * top bar. The game panel collapses via a visible chevron handle.
 *
 * Layout (mobile < md): the two panels stack and a segmented Chat / Game toggle
 * swaps between them, so the whole flow works from ~360px up.
 *
 * On mount it consumes a pending prompt (set by StudioHome) and prefills it
 * into ChatPanel through the existing `chat:prefill` event.
 */

import { useEffect, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Code2,
  Gamepad2,
  Home,
  MessageSquare,
} from "lucide-react";
import SplitPane from "@/components/dock/SplitPane";
import ChatPanel from "@/components/ChatPanel";
import { useSession } from "@/store/session";
import { useView } from "@/store/view";
import GamePreviewLite from "./GamePreviewLite";
import ProgressStrip from "./ProgressStrip";
import ModelPicker from "./ModelPicker";
import { PENDING_PROMPT_KEY } from "./StudioHome";

/** Skeleton shown while session store hasn't hydrated from localStorage yet. */
function BuildSkeleton() {
  return (
    <div className="h-screen w-screen flex flex-col overflow-hidden bg-[var(--bg)]">
      {/* Top bar skeleton */}
      <div className="flex items-center gap-3 px-4 h-14 border-b border-line bg-bg-panel shrink-0">
        <div className="skeleton h-7 w-16 rounded" />
        <div className="w-px h-5 bg-line" />
        <div className="skeleton h-6 w-36 rounded" />
        <div className="flex-1" />
        <div className="skeleton h-7 w-20 rounded" />
      </div>
      {/* Body skeleton */}
      <div className="flex-1 flex gap-0 p-4 min-h-0">
        <div className="flex-1 flex flex-col gap-3 min-w-0">
          <div className="skeleton h-8 w-full rounded" />
          <div className="skeleton flex-1 w-full rounded" />
        </div>
      </div>
      {/* Progress strip skeleton */}
      <div className="h-9 border-t border-line bg-bg-panel shrink-0 flex items-center px-3 gap-3">
        <div className="skeleton h-2 w-2 rounded-full" />
        <div className="skeleton h-3 w-48 rounded" />
      </div>
    </div>
  );
}

type MobilePane = "chat" | "game";

export default function BuildView() {
  const activeProject = useSession((s) => s.activeProject);
  const hydrated = useSession((s) => s.hydrated);
  const goHome = useView((s) => s.goHome);
  const openIde = useView((s) => s.openIde);

  const [gameOpen, setGameOpen] = useState(true);
  const [splitSize, setSplitSize] = useState(440);
  const [mobilePane, setMobilePane] = useState<MobilePane>("chat");

  // Consume the pending prompt set by StudioHome's "Create & build".
  // CRITICAL FIX: wait until the session has HYDRATED — only then is <ChatPanel>
  // mounted and listening for `chat:prefill`. The previous version ran during
  // the loading skeleton (ChatPanel not mounted yet), so it dispatched the
  // event into the void AND cleared localStorage — the prompt was lost forever.
  // Gating on `hydrated` guarantees ChatPanel is present (its listener registers
  // before this parent effect, since child effects fire first), and we only
  // clear storage AFTER dispatching so a re-render can't drop it mid-flight.
  useEffect(() => {
    if (!hydrated) return;
    let pending: string | null = null;
    try {
      pending = window.localStorage.getItem(PENDING_PROMPT_KEY);
    } catch {
      /* ignore */
    }
    if (!pending) return;
    const value = pending;
    const t = setTimeout(() => {
      setMobilePane("chat");
      window.dispatchEvent(new CustomEvent("chat:prefill", { detail: value }));
      try {
        window.localStorage.removeItem(PENDING_PROMPT_KEY);
      } catch {
        /* ignore */
      }
    }, 200);
    return () => clearTimeout(t);
  }, [hydrated, activeProject]);

  if (!hydrated) return <BuildSkeleton />;

  return (
    <div className="h-screen w-screen flex flex-col overflow-hidden bg-[var(--bg)] text-text">
      {/* ── Top bar ───────────────────────────────────────────────── */}
      <header className="flex items-center gap-2 sm:gap-3 px-3 sm:px-4 h-14 border-b border-line bg-bg-panel shrink-0">
        <button
          onClick={goHome}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs text-text-dim hover:text-text hover:bg-bg-subtle transition-colors"
          title="Back to studio home"
        >
          <Home className="h-4 w-4" />
          <span className="hidden sm:inline">Home</span>
        </button>

        <div className="mx-1 h-5 w-px bg-line" />

        <div className="flex items-center gap-2 min-w-0">
          <span
            className="h-6 w-6 rounded-md flex items-center justify-center shrink-0"
            style={{ background: "color-mix(in oklab, var(--accent) 18%, transparent)" }}
          >
            <Gamepad2 className="h-3.5 w-3.5 text-accent" />
          </span>
          <div className="min-w-0 leading-tight">
            <div className="truncate text-sm font-semibold text-text">{activeProject}</div>
            <div className="text-[10px] text-text-subtle hidden sm:block">Build studio</div>
          </div>
        </div>

        {/* Visible, labeled model picker — center on desktop */}
        <div className="hidden md:flex flex-1 justify-center">
          <ModelPicker />
        </div>

        <div className="ml-auto md:ml-0 flex items-center gap-2">
          <button
            onClick={openIde}
            className="inline-flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 rounded-md text-xs text-text-dim border border-line hover:text-text hover:border-line-strong transition-colors"
            title="Open the full VS-Code-style workspace"
          >
            <Code2 className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Full IDE</span>
          </button>
        </div>
      </header>

      {/* Model picker row on mobile (it doesn't fit in the top bar) */}
      <div className="md:hidden flex items-center justify-center px-3 py-2 border-b border-line bg-bg-panel/60">
        <ModelPicker />
      </div>

      {/* Mobile pane toggle */}
      <div className="md:hidden flex items-center gap-1 p-1.5 border-b border-line bg-bg-panel">
        <SegmentBtn
          active={mobilePane === "chat"}
          onClick={() => setMobilePane("chat")}
          icon={<MessageSquare className="h-3.5 w-3.5" />}
          label="Chat"
        />
        <SegmentBtn
          active={mobilePane === "game"}
          onClick={() => setMobilePane("game")}
          icon={<Gamepad2 className="h-3.5 w-3.5" />}
          label="Live game"
        />
      </div>

      {/* ── Body ──────────────────────────────────────────────────── */}
      <div className="flex-1 min-h-0">
        {/* Mobile: one pane at a time */}
        <div className="md:hidden h-full">
          {mobilePane === "chat" ? (
            <div className="h-full">
              <ChatPanel projectName={activeProject} compact />
            </div>
          ) : (
            <GamePreviewLite />
          )}
        </div>

        {/* Desktop: chat | (handle) | live game */}
        <div className="hidden md:block h-full">
          {gameOpen ? (
            <SplitPane
              direction="horizontal"
              primary="second"
              primarySize={splitSize}
              onPrimarySizeChange={setSplitSize}
              minPrimary={320}
              maxPrimary={900}
            >
              <div className="h-full min-w-0">
                <ChatPanel projectName={activeProject} compact={false} />
              </div>
              <div className="h-full min-w-0 relative">
                {/* Visible collapse handle on the game panel's left edge */}
                <button
                  onClick={() => setGameOpen(false)}
                  className="absolute left-0 top-1/2 -translate-y-1/2 -translate-x-1/2 z-20 h-12 w-5 flex items-center justify-center rounded-md border border-line bg-bg-panel text-text-dim hover:text-accent hover:border-accent/50 transition-colors shadow-elev"
                  title="Collapse game preview"
                  aria-label="Collapse game preview"
                >
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
                <GamePreviewLite />
              </div>
            </SplitPane>
          ) : (
            <div className="h-full flex">
              <div className="flex-1 min-w-0">
                <ChatPanel projectName={activeProject} compact={false} />
              </div>
              {/* Collapsed rail — visible affordance to bring the game back */}
              <button
                onClick={() => setGameOpen(true)}
                className="group w-9 shrink-0 flex flex-col items-center justify-center gap-2 border-l border-line bg-bg-panel hover:bg-bg-subtle transition-colors"
                title="Show game preview"
                aria-label="Show game preview"
              >
                <ChevronLeft className="h-4 w-4 text-text-dim group-hover:text-accent" />
                <span className="text-[10px] [writing-mode:vertical-rl] rotate-180 text-text-dim group-hover:text-text tracking-wide">
                  Live game
                </span>
                <Gamepad2 className="h-4 w-4 text-text-dim group-hover:text-accent" />
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ── Progress strip ────────────────────────────────────────── */}
      <ProgressStrip projectName={activeProject} />
    </div>
  );
}

function SegmentBtn({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={[
        "flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors",
        active ? "bg-accent/15 text-accent" : "text-text-dim hover:text-text hover:bg-bg-subtle",
      ].join(" ")}
    >
      {icon}
      {label}
    </button>
  );
}
