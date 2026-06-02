"use client";

import { useEffect, useRef, useState } from "react";
import { ExternalLink, RefreshCw, Maximize2, Play, Square, Camera, Eye } from "lucide-react";
import { BACKEND } from "@/lib/api";
import { useSession } from "@/store/session";

/**
 * PhaserGamePreview — center-dock tab that embeds the live Phaser game.
 *
 * The Phaser game runs as its own Vite dev server (`phaser_game/`,
 * default port 5173). The backend can spawn / stop / health-check it
 * via `/api/phaser/dev-server/*`. We iframe the rendered canvas, plus a
 * toolbar for level switching, screenshot, playtest, composition-check.
 *
 * This replaces the old scene preview — same idea, different runtime.
 *
 * PROJECT-AWARE (mirrors `components/studio/GamePreviewLite`): levels live in
 * ONE shared `phaser_game/` runtime, but a project must NEVER auto-inherit
 * another project's game (e.g. AngryCats' level_01). We remember the level a
 * user last previewed PER PROJECT via the SAME localStorage key GamePreviewLite
 * uses; a project with none shows a "no game yet" state instead of defaulting to
 * someone else's level. On project switch we reload the iframe so the old game
 * unloads and the new project's level (or empty state) takes over.
 */

const PREVIEW_LEVEL_PREFIX = "phaser2d.previewLevel.";

function readStoredLevel(project: string): string {
  if (typeof window === "undefined" || !project) return "";
  try {
    return window.localStorage.getItem(PREVIEW_LEVEL_PREFIX + project) ?? "";
  } catch {
    return "";
  }
}

function writeStoredLevel(project: string, level: string): void {
  if (typeof window === "undefined" || !project) return;
  try {
    window.localStorage.setItem(PREVIEW_LEVEL_PREFIX + project, level);
  } catch {
    /* ignore quota */
  }
}

export default function PhaserGamePreview() {
  const activeProject = useSession((s) => s.activeProject);

  // This component renders in BOTH the dashboard dock AND the detached /popout
  // window. Only ONE may run the live game at a time — otherwise the SAME game
  // boots twice and e.g. plays its audio from both windows at once. The two
  // windows coordinate over a same-origin BroadcastChannel: while a /popout game
  // window is open, the in-dashboard instance UNMOUNTS its iframe (destroying
  // that game + its audio context) and shows a "playing in detached window"
  // card; closing/docking the popout resumes the in-tab game.
  const isPopout = typeof window !== "undefined"
    && window.location.pathname.startsWith("/popout");
  const [detachedOpen, setDetachedOpen] = useState(false);

  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  // The project we've already auto-picked a level for, so we only auto-pick
  // ONCE per project (and never fight a user who then clears the dropdown).
  const autoPickedRef = useRef<string>("");
  const [phaserPort, setPhaserPort] = useState<number>(5173);
  const [running, setRunning] = useState<boolean>(false);
  const [healthy, setHealthy] = useState<boolean>(false);
  // "" = no game chosen for this project yet → show the empty state (NOT a
  // default level, so a new project never inherits AngryCats' level_01).
  const [level, setLevel] = useState<string>("");
  const [levels, setLevels] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [shotUrl, setShotUrl] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<string | null>(null);
  // Last action error, shown inline in the toolbar. Without this, a failed
  // fetch in startDev/etc. threw an UNHANDLED rejection → Next.js crash
  // overlay ("TypeError: Failed to fetch"). Now failures degrade gracefully.
  const [err, setErr] = useState<string | null>(null);
  const [iframeKey, setIframeKey] = useState<number>(0);

  // When the active project changes, load the level this project last previewed
  // (if any) and force the iframe to reload so the OLD game unloads. New /
  // never-previewed projects start with no level → empty state.
  useEffect(() => {
    setLevel(readStoredLevel(activeProject));
    autoPickedRef.current = "";   // allow ONE auto-pick for the newly active project
    setShotUrl(null);
    setVerdict(null);
    setIframeKey((k) => k + 1);
  }, [activeProject]);

  // Auto-pick the project's OWN game once the level list is known, so a project
  // that has a matching level shows it immediately instead of "No game yet" +
  // making the user hunt the dropdown (the user's "gra zniknęła / wina apki").
  // Name-matched ONLY (project "Cat_Volleyball" ⇄ level "volleyball"), so a
  // project never silently inherits another project's level (e.g. AngryCats'
  // level_01). Runs at most once per project and never if a stored choice exists.
  useEffect(() => {
    if (autoPickedRef.current === activeProject) return;
    if (level !== "" || readStoredLevel(activeProject)) return;
    if (levels.length === 0 || !activeProject) return;
    const projNorm = activeProject.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!projNorm) return;
    const match = levels.find((l) => {
      const ln = l.toLowerCase().replace(/[^a-z0-9]/g, "");
      return ln.length >= 3 && (projNorm.includes(ln) || ln.includes(projNorm));
    });
    if (match) {
      autoPickedRef.current = activeProject;
      selectLevel(match);
    }
    // selectLevel is stable enough for this guarded one-shot; deps cover the inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [levels, activeProject, level]);

  // Poll dev-server status + Phaser health + the (shared) level list. Backs off
  // to 8 s and SKIPS entirely while the dashboard tab is hidden — no point
  // hammering the backend for a panel nobody is looking at. Re-probes instantly
  // when the tab becomes visible again so the UI is never stale on return.
  useEffect(() => {
    let cancelled = false;
    // `force` runs even when the tab is hidden — used for the FIRST probe (so a
    // panel opened while briefly backgrounded isn't stuck on "offline") and the
    // on-become-visible refresh. The recurring interval skips while hidden.
    const probe = async (force = false) => {
      if (!force && document.hidden) return;
      try {
        const [s, h, l] = await Promise.all([
          fetch(`${BACKEND}/api/phaser/dev-server/status`).then((r) => r.json()).catch(() => ({})),
          fetch(`${BACKEND}/api/phaser/health`).then((r) => r.json()).catch(() => ({})),
          fetch(`${BACKEND}/api/phaser/levels`).then((r) => r.json()).catch(() => ({})),
        ]);
        if (cancelled) return;
        setRunning(Boolean(s.running));
        if (s.port) setPhaserPort(s.port);
        setHealthy(Boolean(h.healthy));
        if (Array.isArray(l.levels)) {
          setLevels(l.levels.map((n: string) => n.replace(/\.yaml$/, "")));
        }
      } catch {
        // ignore — keep last known state
      }
    };
    probe(true);
    const id = setInterval(() => probe(), 8000);
    const onVis = () => { if (!document.hidden) probe(true); };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      cancelled = true;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  function selectLevel(next: string) {
    setLevel(next);
    writeStoredLevel(activeProject, next);
    setIframeKey((k) => k + 1);
  }

  // Only treat the level as "chosen" when it is non-empty AND known to the
  // shared runtime (or the list hasn't loaded yet) — otherwise show empty state.
  const hasLevel = level !== "" && (levels.length === 0 || levels.includes(level));
  const phaserUrl = `http://127.0.0.1:${phaserPort}/?level=${encodeURIComponent(level)}`;

  // Sleep the embedded game when this panel is off-screen (an inactive dock tab
  // is display:none → 0 intersection) and wake it when shown — so a backgrounded
  // scene tab stops burning 60fps of WebGL even while the dashboard tab itself
  // is visible. Re-attaches whenever the iframe (re)mounts.
  useEffect(() => {
    const el = iframeRef.current;
    if (!el) return;
    const post = (visible: boolean) =>
      el.contentWindow?.postMessage({ type: "phaser2d:visible", visible }, "*");
    const io = new IntersectionObserver(
      ([entry]) => post(entry.isIntersecting && entry.intersectionRatio > 0),
      { threshold: 0 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [iframeKey, hasLevel, healthy]);

  // Single-live-game coordination across the dashboard ⇄ detached /popout window
  // (see the isPopout comment at the top) over a same-origin BroadcastChannel.
  useEffect(() => {
    if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") return;
    const bc = new BroadcastChannel("phaser2d.scene-game");
    if (isPopout) {
      // The popout IS the live game: announce it so in-dashboard instances pause,
      // answer pings (in case the dashboard mounted after us), and on unload tell
      // them to resume. A "dock-back" request → close ourselves.
      const announce = () => bc.postMessage({ type: "popout-open" });
      announce();
      bc.onmessage = (e) => {
        if (e.data?.type === "ping") announce();
        else if (e.data?.type === "dock-back") window.close();
      };
      const onClose = () => bc.postMessage({ type: "popout-closed" });
      window.addEventListener("beforeunload", onClose);
      return () => {
        onClose();
        window.removeEventListener("beforeunload", onClose);
        bc.close();
      };
    }
    // In-dashboard instance: pause our iframe whenever a popout game is open.
    bc.onmessage = (e) => {
      if (e.data?.type === "popout-open") setDetachedOpen(true);
      else if (e.data?.type === "popout-closed") setDetachedOpen(false);
    };
    bc.postMessage({ type: "ping" });  // detect a popout already open at mount
    return () => bc.close();
  }, [isPopout]);

  // "Bring it back" — tell the detached popout to close (→ it broadcasts
  // popout-closed → we resume). Fallback timer covers a popout that already died
  // without sending popout-closed, so the in-tab game never stays stuck-paused.
  function dockBack() {
    try {
      const bc = new BroadcastChannel("phaser2d.scene-game");
      bc.postMessage({ type: "dock-back" });
      bc.close();
    } catch { /* ignore */ }
    window.setTimeout(() => setDetachedOpen(false), 1200);
  }

  // Pull a human-friendly message out of a non-OK FastAPI response. Detail can
  // be a string OR our {error, hint} object (e.g. npm-missing → 503).
  async function failMessage(res: Response, fallback: string): Promise<string> {
    const body = await res.json().catch(() => null);
    const d = body?.detail;
    if (typeof d === "string") return d;
    if (d?.hint) return d.hint;
    if (d?.error) return d.error;
    return `${fallback} (HTTP ${res.status})`;
  }

  async function startDev() {
    setBusy("starting Vite…"); setErr(null);
    try {
      const res = await fetch(`${BACKEND}/api/phaser/dev-server/start`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ port: 5173 }),
      });
      if (!res.ok) setErr(await failMessage(res, "couldn't start Vite"));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "couldn't reach backend");
    } finally { setBusy(null); }
  }

  async function stopDev() {
    setBusy("stopping Vite…"); setErr(null);
    try {
      // user_initiated:true — a human clicked Stop, so the watchdog must RESPECT
      // it (the game stays down and the choice persists). Internal callers omit
      // this, so their transient stops still auto-recover.
      const res = await fetch(`${BACKEND}/api/phaser/dev-server/stop`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_initiated: true }),
      });
      if (!res.ok) setErr(await failMessage(res, "couldn't stop Vite"));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "couldn't reach backend");
    } finally { setBusy(null); }
  }

  async function takeShot() {
    setBusy("screenshot…"); setErr(null);
    setShotUrl(null);
    try {
      const res = await fetch(`${BACKEND}/api/phaser/screenshot`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ level_id: level, width: 1280, height: 720 }),
      });
      if (!res.ok) { setErr(await failMessage(res, "screenshot failed")); return; }
      const data = await res.json();
      if (data.served_url) setShotUrl(`${BACKEND}${data.served_url}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "couldn't reach backend");
    } finally { setBusy(null); }
  }

  async function runPlaytest() {
    setBusy("playtest 5s…"); setErr(null);
    setVerdict(null);
    try {
      const res = await fetch(`${BACKEND}/api/phaser/playtest`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ level_id: level, duration_s: 5, screenshot_interval_s: 1 }),
      });
      if (!res.ok) { setErr(await failMessage(res, "playtest failed")); return; }
      const data = await res.json();
      setVerdict(
        `verdict_pass=${data.verdict_pass} · frames=${data.frame_count} · ` +
        `errors=${data.console_error_count} · score=${data.final_state?.score ?? "?"}`,
      );
    } catch (e) {
      setErr(e instanceof Error ? e.message : "couldn't reach backend");
    } finally { setBusy(null); }
  }

  return (
    <div className="flex h-full w-full flex-col">
      <div className="panel-header flex items-center gap-2 px-2 py-1 border-b border-zinc-800">
        <span className="text-xs font-medium opacity-70">Phaser game</span>
        <span className={`inline-block h-2 w-2 rounded-full ${healthy ? "bg-emerald-500" : "bg-zinc-600"}`} />
        <span className="text-xs opacity-50">:{phaserPort}</span>

        <div className="mx-2 h-4 w-px bg-zinc-700" />

        <label className="text-xs opacity-70">level</label>
        <select
          className="bg-zinc-900 border border-zinc-700 rounded text-xs px-1 py-0.5"
          value={level}
          onChange={(e) => selectLevel(e.target.value)}
        >
          <option value="">(no game yet)</option>
          {levels.map((l) => <option key={l} value={l}>{l}</option>)}
        </select>

        <div className="mx-2 h-4 w-px bg-zinc-700" />

        {running ? (
          <button className="btn btn-xs" onClick={stopDev} title="Stop Vite dev server">
            <Square className="h-3 w-3" /> stop
          </button>
        ) : (
          <button className="btn btn-xs btn-primary" onClick={startDev} title="Start Vite dev server">
            <Play className="h-3 w-3" /> start
          </button>
        )}
        <button className="btn btn-xs" onClick={() => setIframeKey((k) => k + 1)} title="Reload iframe">
          <RefreshCw className="h-3 w-3" /> reload
        </button>
        <button className="btn btn-xs" onClick={takeShot} disabled={!hasLevel} title="Headless screenshot via Playwright">
          <Camera className="h-3 w-3" /> shot
        </button>
        <button className="btn btn-xs" onClick={runPlaytest} disabled={!hasLevel} title="5-second headless playtest">
          <Eye className="h-3 w-3" /> playtest
        </button>
        {hasLevel && (
          <>
            <a className="btn btn-xs" href={phaserUrl} target="_blank" rel="noreferrer" title="Open in new tab">
              <ExternalLink className="h-3 w-3" />
            </a>
            <a className="btn btn-xs" href={phaserUrl} target="_blank" rel="noreferrer" title="Fullscreen new tab">
              <Maximize2 className="h-3 w-3" />
            </a>
          </>
        )}

        {busy ? (
          <span className="ml-2 text-xs text-amber-400 animate-pulse">{busy}</span>
        ) : err ? (
          <span className="ml-2 text-xs text-red-400 truncate max-w-[280px]" title={err}>⚠ {err}</span>
        ) : verdict ? (
          <span className="ml-2 text-xs text-emerald-400">{verdict}</span>
        ) : null}
      </div>

      <div className="flex-1 relative bg-zinc-950">
        {!isPopout && detachedOpen ? (
          <div className="absolute inset-0 flex items-center justify-center text-center p-6">
            <div className="max-w-md space-y-3">
              <h3 className="text-lg font-medium">🎮 Game is open in a detached window</h3>
              <p className="text-sm opacity-70">
                It&apos;s playing in its own window, so audio and input aren&apos;t doubled
                here. Close that window (its <strong>Dock back</strong> button), or:
              </p>
              <button className="btn btn-primary" onClick={dockBack}>
                Bring it back to this tab
              </button>
            </div>
          </div>
        ) : healthy && hasLevel ? (
          <iframe
            key={iframeKey}
            ref={iframeRef}
            src={phaserUrl}
            className="absolute inset-0 h-full w-full border-0"
            allow="fullscreen; clipboard-read; clipboard-write"
            title="Phaser game"
          />
        ) : !healthy ? (
          <div className="absolute inset-0 flex items-center justify-center text-center p-6">
            <div className="max-w-md space-y-3">
              <h3 className="text-lg font-medium">Phaser dev server offline</h3>
              <p className="text-sm opacity-70">
                The Vite dev server at <code>:{phaserPort}</code> isn&apos;t responding.
                Click <strong>start</strong> in the toolbar above to launch it, or run{" "}
                <code className="text-xs">cd phaser_game && npm run dev</code> manually.
              </p>
              {!running && (
                <button className="btn btn-primary" onClick={startDev}>
                  <Play className="h-4 w-4" /> Start Vite (npm run dev)
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-center p-6">
            <div className="max-w-md space-y-3">
              <h3 className="text-lg font-medium">
                No game for <span className="text-emerald-400">{activeProject}</span> yet
              </h3>
              <p className="text-sm opacity-70">
                Describe the game you want in the chat — the agent builds it and it appears here.
                {levels.length > 0 && " Or pick an existing level from the dropdown above to preview it."}
              </p>
            </div>
          </div>
        )}
      </div>

      {shotUrl ? (
        <div className="border-t border-zinc-800 p-2 max-h-64 overflow-auto">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs font-medium">last screenshot</span>
            <a href={shotUrl} target="_blank" rel="noreferrer" className="text-xs underline opacity-70">
              open
            </a>
          </div>
          <img src={shotUrl} alt="latest screenshot" className="max-w-full h-auto rounded border border-zinc-700" />
        </div>
      ) : null}
    </div>
  );
}
