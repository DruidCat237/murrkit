"use client";

import { Suspense, lazy } from "react";
import ChatPanel from "../ChatPanel";
import GeneratePanel from "../GeneratePanel";
import AssetLibraryPanel from "../AssetLibraryPanel";
import SettingsPanel from "../SettingsPanel";
import type { CenterTab } from "@/lib/types";
import { useSession } from "@/store/session";

// Heavier components: lazy-load
const CodeEditor = lazy(() => import("../editor/CodeEditor"));
const AnimatorPanel = lazy(() => import("../AnimatorPanel"));
const SpritesheetImportPanel = lazy(() => import("../SpritesheetImportPanel"));
const PhaserGamePreview = lazy(() => import("../phaser/PhaserGamePreview"));
const GenQueuePanel = lazy(() => import("../queue/GenQueuePanel"));
const QwenChatPanel = lazy(() => import("../QwenChatPanel"));
const VisionReviewsPanel = lazy(() => import("../VisionReviewsPanel"));
const ReferencesPanel = lazy(() => import("../ReferencesPanel"));

export default function CenterTabContent({ tab }: { tab: CenterTab }) {
  const projectName = useSession((s) => s.activeProject);

  return (
    <Suspense fallback={<TabSkeleton />}>
      {(() => {
        switch (tab.kind) {
          case "chat":     return <ChatPanel projectName={projectName} compact={false} />;
          case "generate": return <GeneratePanel />;
          case "library":  return <AssetLibraryPanel projectName={projectName} />;
          case "code":     return <CodeEditor initialFile={tab.file} />;
          case "animator": return <AnimatorPanel />;
          case "spritesheet": return <SpritesheetImportPanel />;
          case "scene":    return <PhaserGamePreview />;
          case "wizard":   return <PhaserGamePreview />;
          case "queue":    return <GenQueuePanel />;
          case "settings": return <SettingsPanel />;
          case "qwen":     return <QwenChatPanel projectName={projectName} />;
          case "vision":   return <VisionReviewsPanel projectName={projectName} />;
          case "references": return <ReferencesPanel projectName={projectName} />;
        }
      })()}
    </Suspense>
  );
}

function TabSkeleton() {
  return (
    <div className="h-full w-full p-4 space-y-3">
      <div className="skeleton h-8 w-1/3" />
      <div className="skeleton h-32 w-full" />
      <div className="skeleton h-6 w-2/3" />
      <div className="skeleton h-6 w-1/2" />
    </div>
  );
}
