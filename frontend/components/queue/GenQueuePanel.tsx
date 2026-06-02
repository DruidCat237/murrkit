"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, X, CheckCircle2, AlertCircle, Clock, DollarSign, Activity, Image as ImageIcon, ListChecks, Pencil, Check, FolderOpen, Upload } from "lucide-react";
import { useQueue } from "@/store/queue";
import { useSession } from "@/store/session";
import { useWsStream } from "@/hooks/useWsStream";
import { cancelQueueTask, clearQueueTasks, openQueueWs, BACKEND } from "@/lib/api";
import type { QueueTask, QueueWsEvent } from "@/lib/types";
import { refreshKittyBalance } from "@/components/CreditsBadge";

export default function GenQueuePanel() {
  const tasks = useQueue((s) => s.tasks);
  const order = useQueue((s) => s.order);
  const maxParallel = useQueue((s) => s.maxParallel);
  const ingest = useQueue((s) => s.ingest);
  const setConnected = useQueue((s) => s.setConnected);
  const clearQueue = useQueue((s) => s.clear);
  const refetchQueue = useQueue((s) => s.refetch);
  const activeProject = useSession((s) => s.activeProject);

  // Drop the in-memory rows the moment the user switches projects so we don't
  // briefly show the wrong project's history while the new snapshot is in
  // flight. The fresh snapshot lands within ~50 ms thanks to the persistent
  // SQLite-backed store on the backend.
  useEffect(() => {
    clearQueue();
  }, [activeProject, clearQueue]);

  useWsStream<QueueWsEvent>(
    (onMsg) => openQueueWs(onMsg, () => setConnected(false), activeProject),
    (m) => { ingest(m); if (!useQueue.getState().connected) setConnected(true); },
    { reconnectKey: activeProject },
  );

  // Bug #167 — safety net: even when the WS push channel works, events can
  // be dropped during a network blip or backend restart, leaving zombie
  // "planned" rows that pretend the user still owes a decision. Poll the
  // authoritative `GET /api/gen-queue/list` every 8s, plus on tab focus and
  // visibility changes, so the panel reacts live without ever needing F5.
  useEffect(() => {
    // Cold-start refetch — fires before the WS snapshot lands on slow links.
    void refetchQueue();
    const intervalMs = 8000;
    const id = setInterval(() => { void refetchQueue(); }, intervalMs);
    const onFocus = () => { void refetchQueue(); };
    const onVisible = () => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        void refetchQueue();
      }
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refetchQueue, activeProject]);

  // Server broadcasts every project's events on the shared WS; filter client-
  // side so the panel shows only the active project's rows.
  const list = order
    .map((id) => tasks[id])
    .filter((t): t is QueueTask => Boolean(t) && t.project === activeProject);
  const plannedTasks = list.filter((t) => t.status === "planned");
  const activeTasks = list.filter((t) => t.status === "started" || t.status === "progress" || t.status === "queued");
  const running = activeTasks.length;
  const done = list.filter((t) => t.status === "completed").length;
  const failed = list.filter((t) => t.status === "failed").length;
  const plannedCostUsd = plannedTasks.reduce((s, t) => s + (t.cost_usd || 0), 0);

  // Detect when ANY running task has been ticking for > 3 min — surface a
  // calm explanation so the user doesn't think things are stuck.
  const nowSec = Date.now() / 1000;
  const longestRunning = Math.max(
    0,
    ...activeTasks.map((t) => (t.started_at ? nowSec - t.started_at : 0)),
  );
  const showSlowBanner = longestRunning > 180;

  async function acceptAllPlanned() {
    if (plannedTasks.length === 0) return;
    if (!confirm(`Accept ${plannedTasks.length} planned generation${plannedTasks.length === 1 ? "" : "s"} — ≈ $${plannedCostUsd.toFixed(2)}? This starts spending Kitty credits.`)) return;
    // Group by project so /accept knows which to fire.
    const byProject: Record<string, string[]> = {};
    for (const t of plannedTasks) (byProject[t.project] ||= []).push(t.id);
    await Promise.all(
      Object.entries(byProject).map(([project, task_ids]) =>
        fetch(`${BACKEND}/api/gen-queue/accept`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ project, task_ids }),
        }).catch(() => undefined),
      ),
    );
    // Kitty deducts credits at submit-time — refresh the badge immediately
    // so the user sees the balance drop instead of waiting 60s.
    refreshKittyBalance();
    // Bug #167: pull the authoritative list right after dispatch so the
    // planned→queued status flip lands in the UI immediately, even if the
    // WS broadcast missed an event.
    void refetchQueue();
  }

  async function discardAllPlanned() {
    if (plannedTasks.length === 0) return;
    if (!confirm(`Discard all ${plannedTasks.length} planned assets?`)) return;
    await Promise.all(plannedTasks.map((t) => cancelQueueTask(t.id).catch(() => undefined)));
    // Planned rows never spent credits, but a refresh is cheap insurance.
    refreshKittyBalance();
    // Bug #167: immediate reconcile so the planned rows disappear without F5.
    void refetchQueue();
  }

  // Cost: actual sum of completed costs + estimated remaining.
  const spentSoFar = list
    .filter((t) => t.status === "completed")
    .reduce((s, t) => s + (t.cost_usd || 0), 0);
  // Estimate $0.10 per pending — middle of $0.04 (1K-low) ↔ $0.16 (4K-high)
  const estRemaining = running * 0.10;

  async function cancelAll() {
    if (activeTasks.length === 0) return;
    if (!confirm(`Cancel ${activeTasks.length} pending generation${activeTasks.length === 1 ? "" : "s"}? Already-paid credits cannot be refunded.`)) return;
    await Promise.all(activeTasks.map((t) => cancelQueueTask(t.id).catch(() => undefined)));
    refreshKittyBalance();
  }

  async function clearFailed() {
    if (failed === 0) return;
    if (!confirm(`Remove ${failed} failed/cancelled row${failed === 1 ? "" : "s"} from the queue? This only clears history — no credits move.`)) return;
    await clearQueueTasks({ project: activeProject, statuses: ["failed", "cancelled"] }).catch(() => undefined);
    void refetchQueue();
  }

  async function clearCompleted() {
    if (done === 0) return;
    if (!confirm(`Remove ${done} completed row${done === 1 ? "" : "s"} from the queue history? Already-generated assets stay on disk — this only clears the queue rows.`)) return;
    await clearQueueTasks({ project: activeProject, statuses: ["completed"] }).catch(() => undefined);
    void refetchQueue();
  }

  return (
    <div className="h-full flex flex-col bg-bg overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-line shrink-0 text-xs flex-wrap">
        <Activity className="h-3.5 w-3.5 text-accent" />
        <span className="font-semibold">Generation Queue</span>
        {plannedTasks.length > 0 && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-text-dim/15 border border-text-dim/30 text-text-dim">
            {plannedTasks.length} planned
          </span>
        )}
        <span className="badge badge-info">{running} active</span>
        <span className="badge badge-ok">{done} done</span>
        {failed > 0 && <span className="badge badge-err">{failed} failed</span>}
        {(spentSoFar > 0 || estRemaining > 0) && (
          <span
            className="ml-2 text-text-dim font-mono tabular-nums"
            title={`Completed cost: $${spentSoFar.toFixed(3)} · estimated remaining: $${estRemaining.toFixed(2)} (running × $0.10)`}
          >
            ${spentSoFar.toFixed(2)} spent
            {estRemaining > 0 && <span className="text-accent-warn"> · +${estRemaining.toFixed(2)} est</span>}
          </span>
        )}
        <span className="ml-auto text-text-subtle">parallelism: {maxParallel}</span>
        {running > 0 && (
          <button
            onClick={cancelAll}
            className="text-[10px] px-2 py-0.5 rounded border border-err/40 text-err hover:bg-err/10"
            title={`Cancel all ${running} pending generations`}
          >
            Cancel all
          </button>
        )}
        {failed > 0 && (
          <button
            onClick={clearFailed}
            className="text-[10px] px-2 py-0.5 rounded border border-err/40 text-err hover:bg-err/10"
            title={`Remove ${failed} failed/cancelled row${failed === 1 ? "" : "s"} from history`}
          >
            Clear failed
          </button>
        )}
        {done > 0 && (
          <button
            onClick={clearCompleted}
            className="text-[10px] px-2 py-0.5 rounded border border-line text-text-dim hover:text-text"
            title={`Remove ${done} completed row${done === 1 ? "" : "s"} from history (assets stay on disk)`}
          >
            Clear done
          </button>
        )}
      </div>

      {showSlowBanner && (
        <div className="border-b border-accent-warn/40 bg-accent-warn/10 px-3 py-2 shrink-0 flex items-center gap-2 text-xs">
          <AlertCircle className="h-3.5 w-3.5 text-accent-warn shrink-0" />
          <span className="text-accent-warn">
            <strong>This wait is normal.</strong> The upstream image-gen queue
            (via Kitty) can hold a job in&nbsp;<code>not_started</code>
            &nbsp;for <strong>15-25 min</strong> before a worker picks it up —
            same behaviour as druidcat.com. Heartbeat is live; the bar jumps
            to 100% the moment the result lands. Max wait is 30&nbsp;min
            (Kitty Studio's own default). Hit <strong>Cancel all</strong>
            if you'd rather try again later.
          </span>
        </div>
      )}

      {plannedTasks.length > 0 && (
        <div className="border-b-2 border-accent/40 bg-accent/5 px-3 py-2 shrink-0 flex items-center gap-2 flex-wrap">
          <ListChecks className="h-3.5 w-3.5 text-accent" />
          <span className="text-xs font-semibold text-accent">
            {plannedTasks.length} planned · ≈ ${plannedCostUsd.toFixed(2)}
          </span>
          <span className="text-[10px] text-text-dim">
            Review below, then accept to start spending credits.
          </span>
          <div className="ml-auto flex items-center gap-1">
            <button
              onClick={discardAllPlanned}
              className="text-[10px] px-2 py-1 rounded border border-line text-text-dim hover:text-text"
            >
              Discard all
            </button>
            <button
              onClick={acceptAllPlanned}
              className="text-[10px] font-semibold px-3 py-1 rounded bg-accent text-bg hover:bg-accent/90"
            >
              Accept all → start
            </button>
          </div>
        </div>
      )}

      {list.length === 0 ? (
        <EmptyState />
      ) : (
        <ul className="flex-1 overflow-y-auto divide-y divide-line">
          {list.map((t) => <QueueRow key={t.id} task={t} />)}
        </ul>
      )}
    </div>
  );
}

function QueueRow({ task }: { task: QueueTask }) {
  const elapsed = (task.completed_at ?? Date.now() / 1000) - (task.started_at ?? Date.now() / 1000);
  const isPlanned = task.status === "planned";
  const name = (task.extra as Record<string, unknown> | null)?.name as string | undefined;
  const activeProject = useSession((s) => s.activeProject);

  // Inline edit state for planned rows. Only planned tasks are editable
  // because once accepted the worker has started and the prompt is locked.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(task.prompt);
  // base_image_path is editable too — user may want to swap the edit
  // reference between v1 atlases (e.g. black cat → patched cat) or null
  // it out if they decide a row should be fresh-gen.
  const taskBase = (task as unknown as { base_image_path?: string | null }).base_image_path ?? "";
  const [baseDraft, setBaseDraft] = useState(taskBase);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // For Windows-explorer Browse upload of a new reference. Uploads to
  // .omc/references/<project>/ via /api/references/upload, then sets the
  // returned abs_path on baseDraft so the user can save like usual.
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploadingBase, setUploadingBase] = useState(false);

  async function browseAndUpload(file: File) {
    setUploadingBase(true);
    setSaveError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const r = await fetch(
        `${BACKEND}/api/references/upload?project=${encodeURIComponent(activeProject)}`,
        { method: "POST", body: fd },
      );
      if (!r.ok) {
        const t = await r.text();
        setSaveError(`Upload failed: ${t.slice(0, 160)}`);
        return;
      }
      const data = await r.json();
      const absPath = (data?.abs_path as string | undefined) ?? "";
      if (!absPath) {
        setSaveError("Upload returned no abs_path");
        return;
      }
      // Replace baseDraft — user still hits Save to persist on the task.
      setBaseDraft(absPath);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "upload failed");
    } finally {
      setUploadingBase(false);
    }
  }

  // Re-sync drafts when upstream prompt/base changes (Claude restages,
  // user cancels mid-edit and the task gets re-broadcast).
  useEffect(() => {
    if (!editing) {
      setDraft(task.prompt);
      setBaseDraft(taskBase);
    }
  }, [task.prompt, taskBase, editing]);

  async function saveEdit() {
    if (saving) return;
    const trimmedPrompt = draft.trim();
    const trimmedBase = baseDraft.trim();
    const promptChanged = trimmedPrompt && trimmedPrompt !== task.prompt;
    const baseChanged = trimmedBase !== taskBase;
    if (!promptChanged && !baseChanged) {
      setEditing(false);
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const body: Record<string, string> = {};
      if (promptChanged) body.prompt = trimmedPrompt;
      // Always send base_image_path when it differs — empty string clears it.
      if (baseChanged) body.base_image_path = trimmedBase;
      const res = await fetch(`${BACKEND}/api/gen-queue/edit/${task.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const detail = await res.text();
        setSaveError(detail.slice(0, 200) || `HTTP ${res.status}`);
        return;
      }
      // WS `planned` broadcast will re-flow new state — no manual setDraft.
      setEditing(false);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "save failed");
    } finally {
      setSaving(false);
    }
  }

  function cancelEdit() {
    setDraft(task.prompt);
    setBaseDraft(taskBase);
    setEditing(false);
    setSaveError(null);
  }

  return (
    <li className={["px-3 py-2 text-xs hover:bg-bg-subtle", isPlanned ? "bg-accent/5" : ""].join(" ")}>
      <div className="flex items-center gap-2">
        <StatusIcon status={task.status} />
        <span className="font-semibold capitalize">{task.asset_type}</span>
        {name && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg-subtle border border-line font-mono text-text-dim">
            {name}
          </span>
        )}
        {editing ? (
          <span className="flex-1 text-text-subtle italic text-[10px]">editing…</span>
        ) : (
          <span className="text-text-dim truncate flex-1" title={task.prompt}>{task.prompt}</span>
        )}
        {isPlanned && task.planned_resolution && (
          <span className="text-[10px] text-text-subtle font-mono">
            {task.planned_resolution} {task.planned_quality}
          </span>
        )}
        {isPlanned && task.cost_usd > 0 && (
          <span className="text-[10px] font-mono tabular-nums text-accent">
            ${task.cost_usd.toFixed(2)}
          </span>
        )}
        {isPlanned && !editing && (
          <button
            onClick={() => setEditing(true)}
            className="text-text-dim hover:text-accent p-1"
            aria-label="Edit prompt"
            title="Edit prompt before accept"
          >
            <Pencil className="h-3 w-3" />
          </button>
        )}
        {(task.status === "started" || task.status === "progress" || task.status === "queued" || isPlanned) && !editing && (
          <button
            onClick={() => cancelQueueTask(task.id)}
            className="text-text-dim hover:text-err p-1"
            aria-label={isPlanned ? "Discard planned asset" : "Cancel task"}
            title={isPlanned ? "Discard from plan" : "Cancel"}
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>

      {editing && (
        <div className="ml-5 mt-1.5 space-y-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // Cmd/Ctrl+Enter = save, Escape = cancel — keeps Shift+Enter
              // available for inserting newlines into the prompt itself.
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                saveEdit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                cancelEdit();
              }
            }}
            rows={4}
            disabled={saving}
            className="w-full bg-bg-subtle border border-accent/50 rounded px-2 py-1 text-xs font-mono text-text focus:outline-none focus:border-accent disabled:opacity-50"
            placeholder="Prompt sent to GPT-Image-2 via Kitty…"
            autoFocus
          />

          {/* Base-image reference editor — visible when workflow is edit-mode
              OR when a base_image_path is already set. Lets the user retarget
              the reference and see a thumbnail of the current pick. */}
          {(task.planned_workflow === "gpt-image-2-edit" || taskBase) && (
            <div className="flex gap-2 items-start bg-bg-panel/60 border border-line/50 rounded p-1.5">
              {/* Thumbnail of current base */}
              <div className="w-16 h-16 shrink-0 bg-bg-subtle rounded border border-line overflow-hidden flex items-center justify-center">
                {taskBase ? (
                  <img
                    src={`${BACKEND}/api/gen-queue/base-preview/${task.id}?t=${Math.floor(
                      (task.completed_at || task.started_at || Date.now() / 1000),
                    )}`}
                    alt="base reference"
                    className="w-full h-full object-contain"
                    onError={(e) => {
                      (e.currentTarget as HTMLImageElement).style.opacity = "0.2";
                    }}
                  />
                ) : (
                  <span className="text-[9px] text-text-subtle">no ref</span>
                )}
              </div>
              <div className="flex-1 min-w-0 space-y-0.5">
                <div className="text-[10px] text-text-dim font-semibold uppercase tracking-wide flex items-center gap-2">
                  <span>Reference image (gpt-image-2-edit base)</span>
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    disabled={saving || uploadingBase}
                    className="ml-auto px-1.5 py-0.5 rounded border border-line/70 text-[9px] text-text-dim hover:text-accent hover:border-accent flex items-center gap-1 disabled:opacity-40"
                    title="Browse Windows Explorer to upload a new reference image — file goes to .omc/references/<project>/ and abs_path is filled in below"
                  >
                    {uploadingBase ? (
                      <Loader2 className="h-2.5 w-2.5 animate-spin" />
                    ) : (
                      <Upload className="h-2.5 w-2.5" />
                    )}
                    {uploadingBase ? "uploading…" : "Browse…"}
                  </button>
                  {baseDraft && (
                    <button
                      onClick={() => setBaseDraft("")}
                      disabled={saving || uploadingBase}
                      className="px-1.5 py-0.5 rounded border border-line/70 text-[9px] text-text-dim hover:text-err hover:border-err flex items-center gap-1 disabled:opacity-40"
                      title="Clear the reference — row becomes a fresh text-to-image gen on next save"
                    >
                      <X className="h-2.5 w-2.5" />
                      Clear
                    </button>
                  )}
                </div>
                <input
                  type="text"
                  value={baseDraft}
                  onChange={(e) => setBaseDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                      e.preventDefault();
                      saveEdit();
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      cancelEdit();
                    }
                  }}
                  disabled={saving || uploadingBase}
                  placeholder="Absolute path to .png reference, or click Browse… to upload"
                  className="w-full bg-bg-subtle border border-line/70 rounded px-1.5 py-0.5 text-[10px] font-mono text-text focus:outline-none focus:border-accent disabled:opacity-50"
                />
                <div className="text-[9px] text-text-subtle font-mono truncate" title={baseDraft}>
                  {baseDraft || "(no reference — will be a fresh text-to-image gen)"}
                </div>
                {/* Hidden native file picker. Browse… button triggers it. */}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) browseAndUpload(file);
                    // reset so re-picking the same file works
                    if (e.target) e.target.value = "";
                  }}
                />
              </div>
            </div>
          )}

          <div className="flex items-center gap-2 text-[10px]">
            <button
              onClick={saveEdit}
              disabled={
                saving ||
                (
                  // No changes
                  (draft.trim() === task.prompt) &&
                  (baseDraft.trim() === taskBase)
                ) ||
                // Empty prompt isn't allowed
                !draft.trim()
              }
              className="btn-primary px-2 py-0.5 flex items-center gap-1 disabled:opacity-40"
            >
              {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
              Save
            </button>
            <button
              onClick={cancelEdit}
              disabled={saving}
              className="btn-ghost px-2 py-0.5 text-text-dim"
            >
              Cancel
            </button>
            <span className="text-text-subtle font-mono">
              prompt {draft.length}/400 · Ctrl+Enter save · Esc cancel
            </span>
            {saveError && <span className="text-err truncate">⚠ {saveError}</span>}
          </div>
        </div>
      )}

      <div className="ml-5 mt-1 flex items-center gap-3 text-text-subtle">
        {(task.status === "progress" || task.status === "started") && (
          <div className="flex-1 max-w-[280px]">
            <div className="h-1 bg-bg-subtle rounded-full overflow-hidden">
              <div
                className="h-full bg-accent transition-all duration-300"
                style={{ width: `${task.progress_pct || 5}%` }}
              />
            </div>
            {task.progress_text && (
              <div className="text-[10px] text-text-subtle mt-0.5">{task.progress_text}</div>
            )}
          </div>
        )}
        {task.status === "completed" && task.thumbnail_url && (
          <img
            // Cache-bust on completed_at so a re-stripped atlas (same URL,
            // new content) actually shows up — otherwise the browser
            // happily reuses the empty 4 KB rembg-destroyed PNG it cached.
            src={`${BACKEND}${task.thumbnail_url}${
              task.completed_at
                ? `${task.thumbnail_url.includes("?") ? "&" : "?"}t=${Math.floor(task.completed_at)}`
                : ""
            }`}
            alt={task.prompt}
            // object-contain (not object-cover) — atlases are wide horizontal
            // strips (1024×1024 with the visible band in the middle); cover
            // would crop most of the flower row out, leaving a near-black
            // square because the rest of the atlas is transparent.
            className="h-12 w-12 object-contain rounded border border-line bg-bg-subtle"
            loading="lazy"
            decoding="async"
          />
        )}
        {task.status === "failed" && task.error && (
          <span className="text-err">{task.error}</span>
        )}
        <span className="ml-auto flex items-center gap-2">
          <span className="flex items-center gap-0.5"><Clock className="h-3 w-3" /> {formatDuration(elapsed)}</span>
          {task.cost_usd > 0 && (
            <span className="flex items-center gap-0.5"><DollarSign className="h-3 w-3" /> {task.cost_usd.toFixed(3)}</span>
          )}
        </span>
      </div>
    </li>
  );
}

function StatusIcon({ status }: { status: QueueTask["status"] }) {
  if (status === "planned") return <ListChecks className="h-3.5 w-3.5 text-accent" />;
  if (status === "queued") return <Clock className="h-3.5 w-3.5 text-text-subtle" />;
  if (status === "started" || status === "progress") return <Loader2 className="h-3.5 w-3.5 text-accent animate-spin" />;
  if (status === "completed") return <CheckCircle2 className="h-3.5 w-3.5 text-ok" />;
  if (status === "failed") return <AlertCircle className="h-3.5 w-3.5 text-err" />;
  if (status === "cancelled") return <X className="h-3.5 w-3.5 text-text-subtle" />;
  return null;
}

function EmptyState() {
  return (
    <div className="flex-1 flex items-center justify-center text-text-subtle">
      <div className="text-center px-6 py-8">
        <ImageIcon className="h-10 w-10 mx-auto mb-3 opacity-30" />
        <div className="text-sm mb-1">Queue is empty</div>
        <div className="text-[11px]">Start a generation from the Generate or Wizard tabs.</div>
      </div>
    </div>
  );
}

function formatDuration(s: number): string {
  if (s < 60) return `${s.toFixed(0)}s`;
  return `${Math.floor(s / 60)}m ${Math.floor(s % 60)}s`;
}
