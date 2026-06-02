"use client";

import { useEffect } from "react";
import SplitPane from "../dock/SplitPane";
import CollapseRail from "../dock/CollapseRail";
import ActivityBar from "./ActivityBar";
import TitleBar from "./TitleBar";
import SidePanel from "./SidePanel";
import RightPanel from "./RightPanel";
import BottomDock from "../dock/BottomDock";
import StatusBar from "../status/StatusBar";
import DockArea from "../dock/DockArea";
import CenterTabContent from "./CenterTabContent";
import BottomTabContent from "./BottomTabContent";
import KeyboardShortcuts from "./KeyboardShortcuts";
import CommandPalette from "../palette/CommandPalette";
import Toaster from "../Toaster";
import { useLayout } from "@/store/layout";
import { useSession } from "@/store/session";
import { useAutoFocusGenQueue } from "@/lib/useAutoFocusGenQueue";

// Hotkey hints surfaced in the rail / divider tooltips. Mirror the bindings
// installed in KeyboardShortcuts.tsx so the chrome teaches its own shortcuts.
const HK_SIDE = "Cmd+B";
const HK_RIGHT = "Cmd+Alt+B";

export default function MainLayout() {
  const sidePanelWidth = useLayout((s) => s.sidePanelWidth);
  const rightPanelWidth = useLayout((s) => s.rightPanelWidth);
  const bottomDockHeight = useLayout((s) => s.bottomDockHeight);
  const bottomOpen = useLayout((s) => s.bottomDockOpen);
  const sidePanelOpen = useLayout((s) => s.sidePanelOpen);
  const rightPanelOpen = useLayout((s) => s.rightPanelOpen);
  // Responsive soft-collapse — transient flags driven by the viewport width.
  const autoCollapseSide = useLayout((s) => s.autoCollapseSide);
  const autoCollapseRight = useLayout((s) => s.autoCollapseRight);
  const setSide = useLayout((s) => s.setSidePanelWidth);
  const setRight = useLayout((s) => s.setRightPanelWidth);
  const setBottomH = useLayout((s) => s.setBottomDockHeight);
  const toggleSide = useLayout((s) => s.toggleSidePanel);
  const toggleRight = useLayout((s) => s.toggleRightPanel);
  const applyViewportWidth = useLayout((s) => s.applyViewportWidth);
  const loadFromStorage = useLayout((s) => s.loadFromStorage);
  const hydrateSession = useSession((s) => s.hydrateFromStorage);

  // hydrate from localStorage once — both stores
  useEffect(() => {
    loadFromStorage();
    hydrateSession();
  }, [loadFromStorage, hydrateSession]);

  // Viewport-width awareness → responsive soft-collapse. The store only
  // reacts on real breakpoint crossings, so a user who re-expands a panel on
  // a narrow screen keeps it open until they cross a breakpoint again. Runs
  // once on mount to seed the correct bucket for the initial width.
  useEffect(() => {
    const onResize = () => applyViewportWidth(window.innerWidth);
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [applyViewportWidth]);

  // Auto-focus the Queue center tab whenever inner Claude stages planned
  // tasks. Without this the user had no visible signal that the pipeline
  // was paused waiting for ACCEPT. See exp-2 observation log bug #5.
  useAutoFocusGenQueue();

  // Effective visibility folds the persisted user intent together with the
  // transient responsive override. The rails handle the "collapsed but
  // reachable" state so a panel is never lost.
  const sideShowing = sidePanelOpen && !autoCollapseSide;
  const rightShowing = rightPanelOpen && !autoCollapseRight;

  return (
    <div className="h-screen w-screen flex flex-col overflow-hidden bg-bg text-text">
      <TitleBar />

      <div className="flex-1 flex overflow-hidden min-h-0">
        <ActivityBar />

        <div className="flex-1 min-w-0 flex flex-col">
          {/* Top section — side / center / right */}
          <div className="flex-1 min-h-0">
            <SplitPane
              direction="vertical"
              primary="second"
              primarySize={bottomOpen ? bottomDockHeight : 26}
              onPrimarySizeChange={setBottomH}
              minPrimary={26}
              maxPrimary={900}
            >
              <SidesAndCenter
                sideShowing={sideShowing}
                rightShowing={rightShowing}
                sidePanelWidth={sidePanelWidth}
                rightPanelWidth={rightPanelWidth}
                setSide={setSide}
                setRight={setRight}
                toggleSide={toggleSide}
                toggleRight={toggleRight}
              />
              <BottomDock renderTab={(t) => <BottomTabContent tab={t} />} />
            </SplitPane>
          </div>
        </div>
      </div>

      <StatusBar />

      {/* Global overlays */}
      <Toaster />
      <CommandPalette />
      <KeyboardShortcuts />
    </div>
  );
}

interface SidesProps {
  sideShowing: boolean;
  rightShowing: boolean;
  sidePanelWidth: number;
  rightPanelWidth: number;
  setSide: (w: number) => void;
  setRight: (w: number) => void;
  toggleSide: () => void;
  toggleRight: () => void;
}

/**
 * SidesAndCenter — composes the optional left panel, the center dock, and the
 * optional right panel. A panel that's showing lives inside a resizable
 * SplitPane whose divider carries a collapse chevron; a panel that's
 * collapsed is replaced by a thin {@link CollapseRail} with an expand
 * chevron, so it's always one click away. The center DockArea fills whatever
 * space is left and is the flex child that absorbs narrow viewports.
 *
 * Layout shape (left to right): [side panel | rail] · center · [rail | right
 * panel]. Rails are fixed-width, non-resizable. We nest SplitPanes only where
 * a resizable divider is actually needed, and keep the center as the single
 * `flex-1 min-w-0` element so there's never horizontal overflow.
 */
function SidesAndCenter({
  sideShowing, rightShowing, sidePanelWidth, rightPanelWidth,
  setSide, setRight, toggleSide, toggleRight,
}: SidesProps) {
  const center = <DockArea renderTab={(t) => <CenterTabContent tab={t} />} />;

  // The right edge is either the real panel (resizable, collapsible divider)
  // wrapped around the center, or the center followed by a collapsed rail.
  const centerWithRight = rightShowing ? (
    <SplitPane
      direction="horizontal"
      primary="second"
      primarySize={rightPanelWidth}
      onPrimarySizeChange={setRight}
      minPrimary={220} maxPrimary={720}
      onCollapse={toggleRight}
      collapseToward="right"
      collapseLabel={`Collapse Inspector (${HK_RIGHT})`}
    >
      {center}
      <RightPanel />
    </SplitPane>
  ) : (
    <div className="flex-1 min-w-0 flex h-full">
      <div className="flex-1 min-w-0 h-full">{center}</div>
      <CollapseRail edge="right" label="Inspector" hotkey={HK_RIGHT} onExpand={toggleRight} />
    </div>
  );

  // Wrap the (center+right) block with the left side: real panel inside a
  // resizable SplitPane, or a collapsed rail flanking it.
  if (sideShowing) {
    return (
      <SplitPane
        direction="horizontal"
        primarySize={sidePanelWidth}
        onPrimarySizeChange={setSide}
        minPrimary={180} maxPrimary={640}
        onCollapse={toggleSide}
        collapseToward="left"
        collapseLabel={`Collapse side panel (${HK_SIDE})`}
      >
        <SidePanel />
        {centerWithRight}
      </SplitPane>
    );
  }

  return (
    <div className="h-full w-full flex">
      <CollapseRail edge="left" label="Explorer" hotkey={HK_SIDE} onExpand={toggleSide} />
      <div className="flex-1 min-w-0 flex h-full">{centerWithRight}</div>
    </div>
  );
}
