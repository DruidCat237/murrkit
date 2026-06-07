"use client";

/**
 * DockArea — the center editor group. Hosts multiple tabs grouped into
 * panes ('p-left' is the default/main pane; split tabs go to 'p-right',
 * 'p-bottom', or the left-docked group 'p-far-left'). Renders the active
 * tab per pane.
 *
 * - Drag-to-reorder within a pane uses native HTML5 DnD.
 * - Drop a tab onto ANOTHER pane's body → the tab relocates into that pane.
 * - Drop on the left edge docks the tab into a new group to the LEFT of the
 *   main pane ('p-far-left'), rendered as the PRIMARY-left side of a
 *   horizontal split.
 * - Drop on the right edge spawns a vertical split (to 'p-right').
 * - Drop on the bottom edge spawns a horizontal split (to 'p-bottom').
 * - The "detach" toolbar button pops the active tab into its own side pane.
 * - Close a tab via the X icon or middle-click.
 *
 * ── Drag-and-drop robustness note (root cause of the old "can't drop" bug) ──
 * Native HTML5 DnD only treats an element as a valid drop target if it EXISTS
 * (and is hit-testable) at the moment the drag is over it. The previous version
 * mounted the edge drop-zones conditionally — `{dragActive && <EdgeDropZone/>}`
 * — i.e. only AFTER `dragstart` fired. Because the nodes were created mid-drag,
 * the in-flight drag session never reliably registered them, so `dragover`
 * (and therefore `drop`) frequently never fired and the tab would not move.
 *
 * The fix: the drop overlays are ALWAYS mounted. They are invisible and
 * `pointer-events:none` at rest, and we only flip them to visible +
 * `pointer-events:auto` while a drag is active (a pure style change, NOT a
 * remount). The targets thus exist before any `dragstart`, so the very first
 * drag works. Every drop target calls `preventDefault()` in `onDragOver`
 * (mandatory — without it `onDrop` never fires), reads the tab id from
 * `dataTransfer`, and calls the matching store action.
 */

import { useEffect, useState } from "react";
import { X, PanelRight } from "lucide-react";
import { useLayout } from "@/store/layout";
import { useSession } from "@/store/session";
import { openPopout } from "@/lib/popout";
import type { CenterTab } from "@/lib/types";
import SplitPane from "./SplitPane";
import CollapseRail from "./CollapseRail";

// Custom drag mime so we can recognise OUR tab drags specifically (and ignore
// unrelated drags). We still mirror the id into "text/plain" for maximum
// browser compatibility and read whichever is present.
const TAB_MIME = "application/x-phaser-tab";

interface DockAreaProps {
  renderTab: (tab: CenterTab) => React.ReactNode;
}

export default function DockArea({ renderTab }: DockAreaProps) {
  const tabs = useLayout((s) => s.centerTabs);
  const active = useLayout((s) => s.activeCenterTabId);
  const setActive = useLayout((s) => s.setActiveCenterTab);
  const closeTab = useLayout((s) => s.removeCenterTab);
  const reorder = useLayout((s) => s.reorderCenterTabs);
  const split = useLayout((s) => s.splitCenterTab);
  const dockLeft = useLayout((s) => s.dockCenterTabLeft);
  const moveToPane = useLayout((s) => s.moveCenterTabToPane);
  const detach = useLayout((s) => s.detachCenterTab);
  const merge = useLayout((s) => s.mergePanes);

  // Re-home any orphaned tabs to the main pane on every render so a user who
  // split everything to p-right/p-bottom/p-far-left still sees something in
  // the main pane. 'p-left' is the DEFAULT/main pane (the catch-all for any
  // unknown/legacy paneId).
  const leftTabs = tabs.filter(
    (t) => (t.paneId ?? "p-left") !== "p-right" && t.paneId !== "p-bottom" && t.paneId !== "p-far-left",
  );
  const rightTabs = tabs.filter((t) => t.paneId === "p-right");
  const bottomTabs = tabs.filter((t) => t.paneId === "p-bottom");
  const farLeftTabs = tabs.filter((t) => t.paneId === "p-far-left");

  // If the user moved tabs to a side pane but the MAIN pane is now empty,
  // merge everything back — better to lose the split than leave the user with
  // a huge empty main area they can't recover from. Covers right / bottom /
  // far-left equally.
  const mergeOnNextRender =
    leftTabs.length === 0 &&
    (rightTabs.length > 0 || bottomTabs.length > 0 || farLeftTabs.length > 0);
  if (mergeOnNextRender) {
    // schedule merge — must not setState during render
    queueMicrotask(() => merge());
  }

  const hasRight = !mergeOnNextRender && rightTabs.length > 0;
  const hasBottom = !mergeOnNextRender && bottomTabs.length > 0;
  const hasFarLeft = !mergeOnNextRender && farLeftTabs.length > 0;

  const [splitSize, setSplitSize] = useState(300);
  const [farLeftSize, setFarLeftSize] = useState(300);
  const [rightCollapsed, setRightCollapsed] = useState(false);

  // While a tab is mid-drag, surface the edge drop zones + per-pane "drop here"
  // overlays so the user can relocate a tab by releasing on the matching
  // target. The overlays are ALWAYS mounted (see the drag-and-drop note in the
  // file header) — this flag only toggles their visibility / pointer-events,
  // which avoids the native-DnD "target mounted too late" bug.
  const [dragActive, setDragActive] = useState(false);

  // SAFETY NET: when a tab is dropped INTO another pane, the source tab
  // re-renders into the new pane and its element unmounts before its own
  // `dragend` fires — so the per-tab `setDragActive(false)` can be missed,
  // leaving the drop-edge highlights stuck on screen ("zielone paski wyskoczyły
  // i zostały"). A window-level dragend/drop/dragexit listener always clears the
  // flag at the true end of ANY drag, no matter where (or whether) it dropped.
  useEffect(() => {
    const clear = () => setDragActive(false);
    window.addEventListener("dragend", clear);
    window.addEventListener("drop", clear);
    window.addEventListener("mouseup", clear);
    return () => {
      window.removeEventListener("dragend", clear);
      window.removeEventListener("drop", clear);
      window.removeEventListener("mouseup", clear);
    };
  }, []);

  // Ids of every tab NOT in the main pane (right ∪ bottom ∪ far-left). Used to
  // preserve their relative order when only the main pane is reordered.
  const otherOrder = tabs.filter((t) => !leftTabs.includes(t)).map((t) => t.id);

  const leftPaneEl = (
    <DockPane
      paneId="p-left"
      tabs={leftTabs}
      active={leftTabs.some((t) => t.id === active) ? active : leftTabs[0]?.id ?? null}
      onActivate={setActive}
      onClose={closeTab}
      onReorder={(orderIds) => {
        // splice into the global tabs order, keeping non-main tabs in place
        reorder([...orderIds, ...otherOrder]);
      }}
      onSplit={split}
      onDetach={detach}
      onMerge={merge}
      onDragState={setDragActive}
      onMoveTabHere={(id) => moveToPane(id, "p-left")}
      dragActive={dragActive}
      renderTab={renderTab}
    />
  );

  // ── Center composition: the existing main + right/bottom arrangement ──────
  let centerComposition: React.ReactNode = leftPaneEl;

  if (hasRight) {
    const rightPaneEl = (
      <DockPane
        paneId="p-right"
        tabs={rightTabs}
        active={rightTabs.some((t) => t.id === active) ? active : rightTabs[0]?.id ?? null}
        onActivate={setActive}
        onClose={closeTab}
        onReorder={(orderIds) => {
          const rest = tabs.filter((t) => t.paneId !== "p-right").map((t) => t.id);
          reorder([...rest, ...orderIds]);
        }}
        onSplit={split}
        onDetach={detach}
        onMerge={merge}
        onDragState={setDragActive}
        onMoveTabHere={(id) => moveToPane(id, "p-right")}
        dragActive={dragActive}
        renderTab={renderTab}
      />
    );
    if (rightCollapsed) {
      centerComposition = (
        <div className="flex-1 min-w-0 flex h-full">
          <div className="flex-1 min-w-0 h-full">{leftPaneEl}</div>
          <CollapseRail edge="right" label="Vision Reviews" onExpand={() => setRightCollapsed(false)} />
        </div>
      );
    } else {
      centerComposition = (
        <SplitPane
          direction="horizontal"
          primary="second"
          primarySize={splitSize}
          onPrimarySizeChange={setSplitSize}
          minPrimary={120}
          maxPrimary={1400}
          onCollapse={() => setRightCollapsed(true)}
          collapseToward="right"
          collapseLabel="Collapse Vision Reviews"
        >
          {leftPaneEl}
          {rightPaneEl}
        </SplitPane>
      );
    }
  } else if (hasBottom) {
    centerComposition = (
      <SplitPane
        direction="vertical"
        primarySize={splitSize}
        onPrimarySizeChange={setSplitSize}
        minPrimary={200}
        maxPrimary={1000}
      >
        {leftPaneEl}
        <DockPane
          paneId="p-bottom"
          tabs={bottomTabs}
          active={bottomTabs.some((t) => t.id === active) ? active : bottomTabs[0]?.id ?? null}
          onActivate={setActive}
          onClose={closeTab}
          onReorder={(orderIds) => {
            const rest = tabs.filter((t) => t.paneId !== "p-bottom").map((t) => t.id);
            reorder([...rest, ...orderIds]);
          }}
          onSplit={split}
          onDetach={detach}
          onMerge={merge}
          onDragState={setDragActive}
          onMoveTabHere={(id) => moveToPane(id, "p-bottom")}
          dragActive={dragActive}
          renderTab={renderTab}
        />
      </SplitPane>
    );
  }

  // ── Left dock: a real tab group to the LEFT of the whole center ───────────
  // Rendered as the PRIMARY-first side of a horizontal split, with the center
  // composition (main + any right/bottom) filling the rest. Resizable; merges
  // back via the pane's merge control or by dragging its last tab out.
  const content = hasFarLeft ? (
    <SplitPane
      direction="horizontal"
      primary="first"
      primarySize={farLeftSize}
      onPrimarySizeChange={setFarLeftSize}
      minPrimary={120}
      maxPrimary={1400}
    >
      <DockPane
        paneId="p-far-left"
        tabs={farLeftTabs}
        active={farLeftTabs.some((t) => t.id === active) ? active : farLeftTabs[0]?.id ?? null}
        onActivate={setActive}
        onClose={closeTab}
        onReorder={(orderIds) => {
          // Reorder within the far-left pane; keep every other tab in place.
          const rest = tabs.filter((t) => t.paneId !== "p-far-left").map((t) => t.id);
          reorder([...rest, ...orderIds]);
        }}
        onSplit={split}
        onDetach={detach}
        onMerge={merge}
        onDragState={setDragActive}
        onMoveTabHere={(id) => moveToPane(id, "p-far-left")}
        dragActive={dragActive}
        renderTab={renderTab}
      />
      {centerComposition}
    </SplitPane>
  ) : (
    centerComposition
  );

  // Drop affordances on the edges. Always mounted (see file header) — the
  // `active` prop only toggles visibility / pointer-events. Dropping on a strip
  // re-homes the dragged tab: left → 'p-far-left', right → split vertical
  // ('p-right'), bottom → split horizontal ('p-bottom').
  return (
    <div className="relative h-full w-full overflow-hidden">
      {content}

      <EdgeDropZone
        edge="left"
        active={dragActive}
        onDropTab={(id) => { dockLeft(id); setDragActive(false); }}
      />
      <EdgeDropZone
        edge="right"
        active={dragActive}
        onDropTab={(id) => { split(id, "vertical"); setDragActive(false); }}
      />
      <EdgeDropZone
        edge="bottom"
        active={dragActive}
        onDropTab={(id) => { split(id, "horizontal"); setDragActive(false); }}
      />
    </div>
  );
}

/** Read the dragged tab id from a drop/dragover event, accepting our custom
 *  mime first and falling back to text/plain. */
function readTabId(e: React.DragEvent): string | null {
  const id = e.dataTransfer.getData(TAB_MIME) || e.dataTransfer.getData("text/plain");
  return id || null;
}

/**
 * EdgeDropZone — an INVISIBLE drop target on one edge of the dock. ALWAYS
 * mounted so native DnD recognises it from the first drag; it captures pointer
 * events only while a drag is active. Releasing a tab over it docks/splits the
 * tab to that edge.
 *
 * Visual language: NONE. We deliberately render nothing — no wash, no accent
 * line, no caption. The old green "edge strips" were distracting and, because
 * their visibility was tied to a flag that native HTML5 DnD doesn't reliably
 * reset (the source tab can unmount on relocate before `dragend` fires), they
 * frequently lingered on screen after a drop. Drawing nothing makes a stuck-on
 * green strip impossible by construction, while keeping the drop functional.
 */
function EdgeDropZone({
  edge,
  active,
  onDropTab,
}: {
  edge: "left" | "right" | "bottom";
  active: boolean;
  onDropTab: (id: string) => void;
}) {
  // Keep a generous hit area so edge-docking stays easy to land.
  const pos =
    edge === "left" ? "left-0 top-0 bottom-0 w-16"
    : edge === "right" ? "right-0 top-0 bottom-0 w-16"
    : "left-0 right-0 bottom-0 h-16";
  return (
    <div
      className={`absolute z-30 ${pos} ${
        active ? "pointer-events-auto" : "pointer-events-none"
      }`}
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }}
      onDragEnter={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const id = readTabId(e);
        if (id) onDropTab(id);
      }}
      aria-hidden
    />
  );
}

interface DockPaneProps {
  paneId: string;
  tabs: CenterTab[];
  active: string | null;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onReorder?: (orderIds: string[]) => void;
  onSplit?: (id: string, dir: "horizontal" | "vertical") => void;
  /** Detach the active tab into its own side pane (one click, no drag). */
  onDetach?: (id: string) => void;
  onMerge?: () => void;
  /** Notifies the parent DockArea when a tab drag starts (true) / ends (false)
   *  so it can show/hide the drop targets. */
  onDragState?: (active: boolean) => void;
  /** Relocate a tab (by id) INTO this pane — fired when a tab from another
   *  pane is dropped onto this pane's body. */
  onMoveTabHere?: (id: string) => void;
  /** True while any tab in the dock is mid-drag (drives the body drop hint). */
  dragActive?: boolean;
  renderTab: (tab: CenterTab) => React.ReactNode;
}

function DockPane({
  paneId,
  tabs,
  active,
  onActivate,
  onClose,
  onReorder,
  onSplit,
  onDetach,
  onMerge,
  onDragState,
  onMoveTabHere,
  dragActive,
  renderTab,
}: DockPaneProps) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  // True when a tab from a DIFFERENT pane is hovering this pane's body, so we
  // can show a prominent "drop here" overlay inviting the relocation.
  const [bodyOver, setBodyOver] = useState(false);
  const activeTab = tabs.find((t) => t.id === active) ?? tabs[0] ?? null;

  // ── Detach → real floating OS window (movable to a second monitor) ─────────
  // This is what users expect "Detach" to do: pop the panel OUT into its own
  // window, not shuffle it between dock panes. The tab leaves the dock; closing
  // the floating window docks it back automatically. Sticky tabs (Chat) stay
  // docked and just open an extra floating view.
  const reopenTab = useLayout((s) => s.openOrFocusCenterTab);
  const removeForPopout = useLayout((s) => s.removeCenterTab);
  const activeProject = useSession((s) => s.activeProject);
  function popOut(tab: CenterTab) {
    const w = openPopout({ kind: tab.kind, title: tab.title, file: tab.file }, activeProject);
    if (!w) { onDetach?.(tab.id); return; } // popup blocked → fall back to in-app detach
    if (tab.sticky) return;                  // keep Chat docked; the popout is an extra view
    removeForPopout(tab.id);
    const timer = window.setInterval(() => {
      if (w.closed) {
        window.clearInterval(timer);
        reopenTab(tab.kind, { title: tab.title, file: tab.file });
      }
    }, 700);
  }

  function onDragStart(id: string, e: React.DragEvent) {
    setDraggingId(id);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", id);
    e.dataTransfer.setData(TAB_MIME, id);
    onDragState?.(true);
  }
  function endDrag() {
    setDraggingId(null);
    setOverId(null);
    setBodyOver(false);
    onDragState?.(false);
  }
  function onTabDragOver(id: string, e: React.DragEvent) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setOverId(id);
  }
  function onTabDrop(targetId: string, e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    const src = readTabId(e) || draggingId;
    setOverId(null);
    if (!src || src === targetId) { setDraggingId(null); return; }
    const ids = tabs.map((t) => t.id);
    const fromIdx = ids.indexOf(src);
    const toIdx = ids.indexOf(targetId);
    // src may live in a DIFFERENT pane. If it's NOT in this pane, treat the
    // drop on a tab as a relocation INTO this pane (drop it next to the tab the
    // user aimed at). Otherwise reorder within this pane.
    if (fromIdx < 0) {
      onMoveTabHere?.(src);
      setDraggingId(null);
      return;
    }
    if (toIdx < 0) { setDraggingId(null); return; }
    ids.splice(toIdx, 0, ids.splice(fromIdx, 1)[0]);
    onReorder?.(ids);
    setDraggingId(null);
  }

  // Body-level drop target: relocate a tab from another pane into THIS pane.
  // Only reacts to drags that did NOT originate in this pane (draggingId null
  // means the drag started elsewhere; a same-pane drag sets draggingId).
  const isForeignDrag = dragActive && draggingId === null;
  function onBodyDragOver(e: React.DragEvent) {
    if (!isForeignDrag) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setBodyOver(true);
  }
  function onBodyDrop(e: React.DragEvent) {
    e.preventDefault();
    const src = readTabId(e);
    setBodyOver(false);
    // Clear the dock-wide drag flag here too: on a cross-pane relocate the
    // source tab unmounts on the next render, so its own `dragend` can be lost
    // and the parent flag would otherwise stay set.
    onDragState?.(false);
    if (src) onMoveTabHere?.(src);
  }

  return (
    <div className="h-full w-full flex flex-col bg-bg overflow-hidden">
      {/* Tab bar */}
      <div className="flex items-center border-b border-line bg-bg-subtle shrink-0">
        {/* Scrollable tabs region — kept SEPARATE from the toolbar so the
            detach / split / merge controls stay visible no matter how many tabs
            are open (previously they lived inside the scroll area and slid off
            the right edge, which is why the detach icon "disappeared"). */}
        <div className="flex items-center overflow-x-auto flex-1 min-w-0 no-scrollbar">
        {tabs.map((t) => (
          <div
            key={t.id}
            className={`dock-tab flex-1 min-w-[90px] max-w-[220px] ${t.id === activeTab?.id ? "active" : ""} ${overId === t.id ? "ring-1 ring-accent" : ""}`}
            draggable
            onDragStart={(e) => onDragStart(t.id, e)}
            onDragOver={(e) => onTabDragOver(t.id, e)}
            onDrop={(e) => onTabDrop(t.id, e)}
            onDragEnd={endDrag}
            onClick={() => onActivate(t.id)}
            onMouseDown={(e) => {
              if (e.button === 1 && !t.sticky) {
                e.preventDefault();
                onClose(t.id);
              }
            }}
            role="tab"
            aria-selected={t.id === activeTab?.id}
            tabIndex={0}
          >
            <TabIcon kind={t.kind} />
            <span className="flex-1 min-w-0 truncate">{t.title}</span>
            {!t.sticky && (
              <button
                className="close ml-1 hover:text-err"
                onClick={(e) => { e.stopPropagation(); onClose(t.id); }}
                aria-label={`Close ${t.title}`}
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        ))}

        </div>

        {/* Pane control — a single, clearly-labelled "Detach" button. The old
            abstract split/merge glyphs (Columns2 / Rows2 / SplitSquareHorizontal)
            read as random "white squares and bars" against the dark UI, so they
            were removed. Splitting is done by dragging a tab to a pane edge;
            "Merge all panes" now lives in the Window menu as clean text. */}
        {onDetach && activeTab && (
          <div className="flex items-center px-2 shrink-0 border-l border-line/60">
            <button
              onClick={() => popOut(activeTab)}
              className="flex items-center gap-1 h-6 rounded px-1.5 text-[11px] font-medium text-text-dim border border-line hover:text-accent hover:border-accent/60 hover:bg-accent/10 transition-colors"
              title="Detach into a floating window — drag it to any monitor"
              aria-label="Detach into a floating window"
            >
              <PanelRight className="h-3.5 w-3.5" />
              <span>Detach</span>
            </button>
          </div>
        )}
      </div>

      {/* Active content — render ALL tabs and toggle visibility via CSS so
          long-running tabs (Chat WebSocket stream, Animator playback) keep
          their state when the user clicks between tabs.

          A body-level drop target (always present, transparent at rest) sits
          ON TOP while a FOREIGN tab is being dragged, so releasing a tab from
          another pane here relocates it into this pane. */}
      <div className="flex-1 min-h-0 overflow-hidden bg-bg relative">
        {tabs.length === 0 ? (
          <DockEmptyState />
        ) : (
          tabs.map((t) => (
            <div
              key={t.id}
              className="absolute inset-0 overflow-hidden"
              style={{
                display: t.id === activeTab?.id ? "block" : "none",
              }}
              aria-hidden={t.id !== activeTab?.id}
            >
              {renderTab(t)}
            </div>
          ))
        )}

        {/* Cross-pane drop hint — a NEUTRAL (grey, NOT green) faint tint + thin
            ring, shown ONLY while a foreign tab is actively hovering THIS pane's
            body (bodyOver), and cleared the instant the cursor leaves or drops.
            It is deliberately neutral so it never reads as the old "green
            strips", and because it is gated on bodyOver (a local enter/leave
            flag, not the dock-wide drag flag) it cannot linger after a drop. */}
        <div
          className={`absolute inset-0 z-20 transition-opacity duration-100 ${
            isForeignDrag ? "pointer-events-auto" : "pointer-events-none"
          } ${bodyOver ? "opacity-100" : "opacity-0"}`}
          style={{
            backgroundColor: "color-mix(in oklab, var(--text) 6%, transparent)",
            boxShadow: "inset 0 0 0 2px color-mix(in oklab, var(--text) 20%, transparent)",
          }}
          onDragOver={onBodyDragOver}
          onDragEnter={onBodyDragOver}
          onDragLeave={() => setBodyOver(false)}
          onDrop={onBodyDrop}
          aria-hidden
        />
      </div>
    </div>
  );
}

function TabIcon({ kind }: { kind: CenterTab["kind"] }) {
  // small inline svgs to avoid pulling more icons
  const cls = "h-3.5 w-3.5 opacity-70";
  switch (kind) {
    case "chat":
      return <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>;
    case "code":
      return <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>;
    case "animator":
      return <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>;
    case "scene":
      return <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>;
    case "library":
      return <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/></svg>;
    case "generate":
      return <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="12 2 15 9 22 9 17 14 19 21 12 17 5 21 7 14 2 9 9 9 12 2"/></svg>;
    case "wizard":
      return <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2l3 7h7l-5.5 4.5L18 21l-6-4-6 4 1.5-7.5L2 9h7z"/></svg>;
    case "queue":
      return <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>;
    case "settings":
      return <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>;
    case "qwen":
      // Brain-ish glyph — peer reviewer model
      return <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z"/><path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z"/></svg>;
  }
}

function DockEmptyState() {
  const openOrFocusCenterTab = useLayout((s) => s.openOrFocusCenterTab);
  const resetLayout = useLayout((s) => s.resetLayout);
  return (
    <div className="h-full w-full flex items-center justify-center bg-bg">
      <div className="text-center max-w-md px-6">
        <div className="text-5xl mb-3">💬</div>
        <h3 className="text-base font-semibold mb-2">Workspace is empty</h3>
        <p className="text-xs text-text-dim mb-5">
          Looks like you closed every tab. Re-open Chat to get back to work,
          or reset the layout to the friendly default.
        </p>
        <div className="flex items-center justify-center gap-2">
          <button
            onClick={() => openOrFocusCenterTab("chat")}
            className="btn btn-primary text-xs flex items-center gap-1.5 px-3 py-2"
          >
            Open Chat
          </button>
          <button
            onClick={() => {
              if (confirm("Reset the workspace layout to the default? Your generated assets and chats are NOT touched — only window positions.")) {
                resetLayout();
              }
            }}
            className="btn border border-line text-xs flex items-center gap-1.5 px-3 py-2 text-text-dim hover:text-text"
          >
            Reset layout
          </button>
        </div>
        <div className="text-[10px] text-text-subtle mt-4">
          Tip: <kbd className="kbd">Cmd+K</kbd> opens the command palette for any tab.
        </div>
      </div>
    </div>
  );
}
