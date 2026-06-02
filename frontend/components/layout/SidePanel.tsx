"use client";

import { useLayout } from "@/store/layout";
import { useSession } from "@/store/session";
import ProjectsSidebar from "../ProjectsSidebar";
import AssetBrowser from "../browser/AssetBrowser";
import SettingsPanel from "../SettingsPanel";
import HelpPanel from "../HelpPanel";
import AnalyticsPanel from "../AnalyticsPanel";

export default function SidePanel() {
  const section = useLayout((s) => s.activitySection);
  const activeProject = useSession((s) => s.activeProject);
  const setActiveProject = useSession((s) => s.setActiveProject);

  const titleMap: Record<string, string> = {
    projects:  "Projects",
    browser:   "Asset Browser",
    chat:      "Recent chats",
    animator:  "Animations",
    unity:     "Phaser game",
    analytics: "Analytics",
    settings:  "Settings",
    help:      "Help",
  };

  return (
    <aside className="h-full w-full flex flex-col bg-bg-panel overflow-hidden">
      <div className="px-3 py-2 border-b border-line shrink-0">
        <div className="text-[10px] uppercase tracking-wider text-text-dim font-semibold">
          {titleMap[section] ?? section}
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        {section === "projects"  && <ProjectsSidebar activeProject={activeProject} onSelect={setActiveProject} />}
        {section === "browser"   && <AssetBrowser projectName={activeProject} />}
        {section === "chat"      && <RecentChats projectName={activeProject} />}
        {section === "animator"  && <AnimatorList projectName={activeProject} />}
        {section === "unity"     && <PhaserHubPanel />}
        {section === "analytics" && <AnalyticsPanel />}
        {section === "settings"  && <SettingsPanel />}
        {section === "help"      && <HelpPanel />}
      </div>
    </aside>
  );
}

function RecentChats({ projectName }: { projectName: string }) {
  return (
    <div className="p-4 text-xs text-text-dim space-y-2">
      <p>Recent chat history for <span className="text-text">{projectName}</span></p>
      <p className="text-text-subtle">Open the Chat tab in the center to view conversations.</p>
    </div>
  );
}

function AnimatorList({ projectName }: { projectName: string }) {
  return (
    <div className="p-4 text-xs text-text-dim space-y-2">
      <p>Animation specs for <span className="text-text">{projectName}</span></p>
      <p className="text-text-subtle">Open the Animator tab in the center to edit a clip.</p>
    </div>
  );
}

function PhaserHubPanel() {
  return (
    <div className="p-4 text-xs text-text-dim space-y-2">
      <p>The Phaser game runtime lives in <code className="text-text">phaser_game/</code> and
        runs as a Vite dev server on <code className="text-text">localhost:5173</code>.</p>
      <p className="text-text-subtle">Open the <strong>Game</strong> tab in the center to start/stop the dev
        server, switch levels, take screenshots, or run a headless playtest.</p>
    </div>
  );
}
