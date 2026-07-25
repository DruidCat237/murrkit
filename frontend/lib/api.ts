/**
 * Typed API helpers for murrkit frontend.
 * All calls go through the FastAPI backend (:8001).
 */

import type {
  SpriteGenRequest,
  SpriteGenResponse,
  SpritesheetImportResponse,
  AssetGenResponse,
  Project,
  WsEvent,
  ChatAttachment,
  ChatHistoryItem,
  ChatModel,
  ChatStreamEvent,
  LoopStreamEvent,
  ConfigSnapshot,
  ContextSnapshot,
  CostSnapshot,
  LibraryAsset,
  ProjectLibrary,
  SkillInfo,
  SmokeTestReport,
  TestResult,
  UsageReport,
  UsageStreamEvent,
  HubProjectList,
  ActiveProjectInfo,
  AnimFrame,
  AnimationSpec,
  LoopMode,
  QueueTask,
  QueueWsEvent,
  GameBuild,
  GameBuildWsEvent,
  AiPaintResult,
  MapDetail,
  MapListEntry,
  MapParseResult,
} from "./types";

// Backend URL — env var wins; otherwise probe a port range so we survive
// Windows TCP zombie sockets that forced backend to hop 8001→8005 last
// session. resolveBackend() is called at module init; result is cached
// for the lifetime of the page.
const ENV_BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL;
// murrkit (the fresh post-migration project) starts cleanly on :8001 — the
// desktop launcher hardcodes `--port 8001` and there is no Unity-era zombie
// socket here. Probe :8001 FIRST so the first call lands on the real backend
// in milliseconds; the higher ports stay only as a fallback for the rare case
// where 8001 was occupied and the backend hopped upward. (Dead local ports do
// NOT refuse fast on Windows — each can hang ~2s — so a wrong-first order
// stalls startup for seconds.)
const BACKEND_CANDIDATES = [
  "http://localhost:8001",  // primary — the desktop launcher always uses this
  "http://localhost:8002",
  "http://localhost:8003",
  "http://localhost:8004",
  "http://localhost:8005",
];

/** Probe `<host>/health` synchronously-ish at startup. Returns first OK URL. */
async function probeBackend(): Promise<string> {
  if (ENV_BACKEND) {
    try {
      const r = await fetch(`${ENV_BACKEND}/health`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return ENV_BACKEND;
    } catch { /* env URL dead — fall through to probe */ }
  }
  for (const candidate of BACKEND_CANDIDATES) {
    try {
      const r = await fetch(`${candidate}/health`, { signal: AbortSignal.timeout(800) });
      if (r.ok) return candidate;
    } catch { /* try next */ }
  }
  // Fallback to default; will fail visibly when the first real call goes out
  return "http://localhost:8001";
}

// Mutable so the resolved value can replace the placeholder once we've
// probed. Code that reads BACKEND at import time gets the placeholder;
// code that reads it after the first awaited call sees the resolved one.
//
// Seed: prefer NEXT_PUBLIC_BACKEND_URL so SSR and the first client paint
// agree on the same URL (otherwise React hydration mismatches when the
// probe finishes and BACKEND mutates to a different port). If the env
// URL is dead the probe still falls through to the candidate loop —
// transient "Failed to fetch" on first paint is preferable to a
// hydration error that wipes the whole tree.
export let BACKEND = ENV_BACKEND || "http://localhost:8001";
const _backendReady: Promise<string> = (typeof window !== "undefined" ? probeBackend() : Promise.resolve(BACKEND))
  .then((url) => { BACKEND = url; return url; });
/** Awaitable that resolves to the first responsive backend URL. */
export const backendReady = _backendReady;

async function post<T>(path: string, body: unknown): Promise<T> {
  // Gate every call behind the probe so we never use a stale URL on the
  // first paint. Once resolved the promise is microtask-fast.
  await _backendReady;
  const res = await fetch(`${BACKEND}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(detail || `POST ${path} failed: ${res.status}`);
  }
  return res.json();
}

async function get<T>(path: string): Promise<T> {
  await _backendReady;
  const res = await fetch(`${BACKEND}${path}`);
  if (!res.ok) {
    throw new Error(`GET ${path} failed: ${res.status}`);
  }
  return res.json();
}

// ---- Sprite generation --------------------------------------------------------

export async function generateCharacterSpritesheet(
  req: SpriteGenRequest
): Promise<SpriteGenResponse> {
  return post<SpriteGenResponse>("/api/sprite-gen/character", req);
}

// ---- Spritesheet import (upload PNG + grid slice) ----------------------------

/**
 * Upload a PNG spritesheet and have the backend slice it into a rows×cols grid.
 * Contract: POST /api/spritesheet/import (multipart) with fields
 *   file (PNG), rows (int), cols (int)  →  SpritesheetImportResponse.
 */
export async function importSpritesheet(opts: {
  file: File;
  rows: number;
  cols: number;
  project?: string;
}): Promise<SpritesheetImportResponse> {
  await _backendReady;
  const fd = new FormData();
  fd.append("file", opts.file);
  fd.append("rows", String(opts.rows));
  fd.append("cols", String(opts.cols));
  if (opts.project) fd.append("project", opts.project);
  const res = await fetch(`${BACKEND}/api/spritesheet/import`, { method: "POST", body: fd });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(detail || `Spritesheet import failed: ${res.status}`);
  }
  return res.json();
}

// ---- Asset generation --------------------------------------------------------

export async function generateBackground(
  description: string,
  layers?: string[]
): Promise<AssetGenResponse> {
  return post<AssetGenResponse>("/api/asset-gen/background", { description, layers });
}

export async function generateTileset(
  description: string,
  tileType = "ground"
): Promise<AssetGenResponse> {
  return post<AssetGenResponse>("/api/asset-gen/tileset", {
    description,
    tile_type: tileType,
  });
}

export async function generateUIElement(
  description: string,
  elementType = "button"
): Promise<AssetGenResponse> {
  return post<AssetGenResponse>("/api/asset-gen/ui-element", {
    description,
    element_type: elementType,
  });
}

export async function generateParticleFX(
  description: string,
  fxType = "dust"
): Promise<AssetGenResponse> {
  return post<AssetGenResponse>("/api/asset-gen/particle-fx", {
    description,
    fx_type: fxType,
  });
}

// ---- Projects ----------------------------------------------------------------

export async function listProjects(): Promise<Project[]> {
  return get<Project[]>("/api/projects");
}

export async function createProject(name: string): Promise<{ status: string; path: string }> {
  return post<{ status: string; path: string }>(`/api/projects/${name}`, {});
}

/**
 * Rename a project directory via `PUT /api/projects/{old}/{new}`.
 * Throws (with the backend `detail`, when present) on any non-2xx so callers
 * can revert an optimistic update and surface the reason. Returns the backend
 * rename contract `{status, old, new, path}`.
 */
export async function renameProject(
  oldName: string,
  newName: string,
): Promise<{ status: string; old: string; new: string; path: string }> {
  await _backendReady;
  const res = await fetch(
    `${BACKEND}/api/projects/${encodeURIComponent(oldName)}/${encodeURIComponent(newName)}`,
    { method: "PUT" },
  );
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(detail || `Rename failed: ${res.status}`);
  }
  return res.json();
}

export async function deleteProject(name: string): Promise<{ status: string; name: string }> {
  const res = await fetch(`${BACKEND}/api/projects/${name}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`DELETE failed: ${res.status}`);
  return res.json();
}

// ---- WebSocket ---------------------------------------------------------------

export function connectProgressWs(
  onEvent: (evt: WsEvent) => void,
  onClose?: () => void
): WebSocket {
  const wsUrl = BACKEND.replace(/^http/, "ws") + "/ws/progress";
  const ws = new WebSocket(wsUrl);

  ws.onmessage = (e) => {
    try {
      const parsed = JSON.parse(e.data) as WsEvent;
      onEvent(parsed);
    } catch {
      // ignore malformed messages
    }
  };

  if (onClose) ws.onclose = onClose;

  // Keep-alive ping
  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "ping" }));
    } else {
      clearInterval(pingInterval);
    }
  }, 25000);

  ws.onclose = () => {
    clearInterval(pingInterval);
    onClose?.();
  };

  return ws;
}

// ---- Chat --------------------------------------------------------------------

export async function listSkills(): Promise<SkillInfo[]> {
  return get<SkillInfo[]>("/api/chat/skills");
}

export async function getCostSnapshot(): Promise<CostSnapshot> {
  return get<CostSnapshot>("/api/chat/cost-snapshot");
}

export async function loadChatHistory(
  projectName = "default",
  limit = 100
): Promise<ChatHistoryItem[]> {
  return get<ChatHistoryItem[]>(`/api/chat/history?project_name=${encodeURIComponent(projectName)}&limit=${limit}`);
}

export async function clearChatHistory(projectName = "default"): Promise<{ deleted: number }> {
  return post<{ deleted: number }>(`/api/chat/clear?project_name=${encodeURIComponent(projectName)}`, {});
}

export async function uploadChatAttachment(file: File): Promise<ChatAttachment> {
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch(`${BACKEND}/api/chat/upload`, { method: "POST", body: fd });
  if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
  return res.json();
}

export async function abortChatTask(taskId: string): Promise<{ aborted: boolean }> {
  const res = await fetch(`${BACKEND}/api/chat/abort/${encodeURIComponent(taskId)}`, { method: "POST" });
  if (!res.ok) throw new Error(`Abort failed: ${res.status}`);
  return res.json();
}

/**
 * Open a project file in the OS editor (Notepad for text files on Windows).
 * `reveal: true` highlights the file in the OS file manager instead.
 * The backend rejects any path outside the project root.
 */
export async function openFileInEditor(
  path: string,
  reveal = false,
): Promise<{ ok: boolean; path: string; action: string; system: string }> {
  return post<{ ok: boolean; path: string; action: string; system: string }>(
    `/api/fs/open`,
    { path, reveal },
  );
}

// ---- In-app code editor (real Phaser game source) ----------------------------
//
// Backed by backend/routers/fs.py (GET /api/fs/tree, /api/fs/read,
// POST /api/fs/write). These power the Cursor-like "Code" tab over the live
// `phaser_game/` source tree. Every path is repo-relative and the backend
// path-guards it inside PROJECT_ROOT.

export interface FsTreeNode {
  name: string;
  /** repo-relative POSIX path, e.g. "phaser_game/src/main.ts" */
  path: string;
  type: "dir" | "file";
  children?: FsTreeNode[];
}

/** Recursive source-file tree under `root` (default: phaser_game). */
export async function getFsTree(root = "phaser_game"): Promise<FsTreeNode> {
  return get<FsTreeNode>(`/api/fs/tree?root=${encodeURIComponent(root)}`);
}

/** Read a source file's UTF-8 text. Backend rejects binary / oversized / outside-repo. */
export async function readFsFile(path: string): Promise<{ path: string; content: string }> {
  return get<{ path: string; content: string }>(`/api/fs/read?path=${encodeURIComponent(path)}`);
}

/** Write a source file (path-guarded; creates parent dirs). */
export async function writeFsFile(
  path: string,
  content: string,
): Promise<{ ok: boolean; path: string; bytes: number }> {
  return post<{ ok: boolean; path: string; bytes: number }>(`/api/fs/write`, { path, content });
}

// ---- Map Studio (phaser_game/maps/*.map.yaml) ---------------------------------

export async function listMaps(): Promise<{ maps: MapListEntry[]; dir: string }> {
  return get<{ maps: MapListEntry[]; dir: string }>(`/api/maps`);
}

export async function getMap(mapId: string, project?: string): Promise<MapDetail> {
  const q = project ? `?project=${encodeURIComponent(project)}` : "";
  return get<MapDetail>(`/api/maps/${encodeURIComponent(mapId)}${q}`);
}

/** Validate + persist a map yaml. Backend REJECTS specs the game can't build. */
export async function saveMap(
  mapId: string,
  yamlText: string,
): Promise<{ ok: boolean; id: string; created: boolean }> {
  await backendReady;
  const res = await fetch(`${BACKEND}/api/maps/${encodeURIComponent(mapId)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ yaml_text: yamlText }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(detail || `PUT /api/maps/${mapId} failed: ${res.status}`);
  }
  return res.json();
}

/** Validate a yaml string without writing (live editor feedback). */
export async function parseMap(yamlText: string): Promise<MapParseResult> {
  return post<MapParseResult>(`/api/maps/parse`, { yaml_text: yamlText });
}

/** Ask the AI painter (DeepSeek) for a paint-layer proposal. Reads the SAVED
 *  map file server-side; the result is applied in the panel, not on disk. */
export async function aiPaintMap(
  mapId: string,
  instruction: string,
  rowsHint?: string[],
): Promise<AiPaintResult> {
  return post<AiPaintResult>(`/api/maps/${encodeURIComponent(mapId)}/ai-paint`, {
    instruction,
    rows_hint: rowsHint ?? null,
  });
}

/**
 * Stage `biome_tileset` PLANNED rows in the gen-queue (accept-gate applies —
 * nothing is billed until the user accepts them in the Queue panel).
 */
export async function planBiomeTilesets(
  project: string,
  rows: Array<{
    biome: string;
    prompt: string;
    baseImagePath?: string;
    /** Map's `projection:` — "isometric" makes the sheet 2:1 diamond cells. */
    projection?: "orthogonal" | "isometric";
  }>,
): Promise<{ task_ids: string[]; count: number; total_cost_usd: number }> {
  return post(`/api/gen-queue/plan`, {
    project,
    rows: rows.map((r) => ({
      name: r.biome,
      asset_type: "biome_tileset",
      prompt: r.prompt,
      workflow_id: r.baseImagePath ? "gpt-image-2-edit" : "gpt-image-2",
      quality: "high",
      resolution: "2K",
      aspect_ratio: "1:1",
      base_image_path: r.baseImagePath ?? null,
      extra: { projection: r.projection ?? "orthogonal" },
    })),
  });
}

/**
 * Open a chat-stream WebSocket.
 * Caller is responsible for closing the socket when done.
 */
export function openChatStream(
  payload: {
    task_id: string;
    project_name: string;
    message: string;
    model: ChatModel;
    attachments?: ChatAttachment[];
    skill_prefix?: string;
  },
  onEvent: (e: ChatStreamEvent) => void,
  onClose?: () => void
): WebSocket {
  const wsUrl = BACKEND.replace(/^http/, "ws") + "/api/chat/stream";
  const ws = new WebSocket(wsUrl);
  ws.onopen = () => ws.send(JSON.stringify(payload));
  ws.onmessage = (e) => {
    try {
      onEvent(JSON.parse(e.data) as ChatStreamEvent);
    } catch {
      // ignore
    }
  };
  ws.onclose = () => onClose?.();
  // A failed/dropped socket fires `error` and THEN `close`. Routing both to
  // onClose double-fires it, and any consumer that reconnects per call then
  // doubles its attempts each round (exponential storm). `close` always
  // follows, so a no-op here keeps onClose firing exactly once per socket.
  ws.onerror = () => {};
  return ws;
}

/**
 * Open a WORK-LOOP WebSocket (`/api/chat/loop`) — ralph-style autonomous
 * captain loop. Same event shape as the chat stream per round, plus
 * `loop_iter` after every round and a terminal `loop_done`. NOTE: `final`
 * ends one ROUND here, not the stream — keep the socket until `loop_done`.
 * Caller is responsible for closing the socket when done.
 */
export function openLoopStream(
  payload: {
    task_id: string;
    project_name: string;
    prompt: string;
    max_iters?: number;
    budget_usd?: number;
    /** "kimi_k3" runs the loop on the Kimi captain; omit for heavy Claude. */
    model?: "kimi_k3";
  },
  onEvent: (e: LoopStreamEvent) => void,
  onClose?: () => void
): WebSocket {
  const wsUrl = BACKEND.replace(/^http/, "ws") + "/api/chat/loop";
  const ws = new WebSocket(wsUrl);
  ws.onopen = () => ws.send(JSON.stringify(payload));
  ws.onmessage = (e) => {
    try {
      onEvent(JSON.parse(e.data) as LoopStreamEvent);
    } catch {
      // ignore
    }
  };
  ws.onclose = () => onClose?.();
  ws.onerror = () => {}; // `close` always follows — see openChatStream
  return ws;
}

// ---- Settings ----------------------------------------------------------------

export async function getConfig(): Promise<ConfigSnapshot> {
  return get<ConfigSnapshot>("/api/config/get");
}

export async function updateConfig(
  updates: Record<string, string>
): Promise<{ changed: number; env_file: string; note: string }> {
  return post<{ changed: number; env_file: string; note: string }>("/api/config/update", { updates });
}

export async function testEndpoint(
  which: "kitty" | "deepseek" | "elevenlabs" | "agent" | "anthropic" | "unity_mcp"
): Promise<TestResult> {
  return post<TestResult>(`/api/config/test/${which}`, {});
}

/** Restart the backend process (only possible under the desktop shell, which
 *  respawns it). `restarting: false` means it just returned manual advice. */
export async function reloadBackend(): Promise<{ ok: boolean; note: string; restarting?: boolean }> {
  return post<{ ok: boolean; note: string; restarting?: boolean }>("/api/config/reload", {});
}

// ---- Library -----------------------------------------------------------------

export async function getLibrary(projectName: string): Promise<ProjectLibrary> {
  return get<ProjectLibrary>(`/api/library/${encodeURIComponent(projectName)}`);
}

export function projectZipUrl(projectName: string): string {
  return `${BACKEND}/api/library/${encodeURIComponent(projectName)}/zip`;
}

export async function importLibraryAssetToUnity(
  projectName: string,
  assetId: string
): Promise<{ status: string; result: unknown }> {
  return post<{ status: string; result: unknown }>(
    `/api/library/${encodeURIComponent(projectName)}/import-to-unity?asset_id=${encodeURIComponent(assetId)}`,
    {}
  );
}

// ---- Smoke ------------------------------------------------------------------

export async function runSmokeTest(): Promise<SmokeTestReport> {
  return post<SmokeTestReport>("/api/smoke/pipeline", {});
}

// ---- Usage tracker ----------------------------------------------------------

export async function getGptImage2Usage(
  project?: string,
  sinceTs?: string,
  limit = 200
): Promise<UsageReport> {
  const params = new URLSearchParams();
  if (project) params.set("project", project);
  if (sinceTs) params.set("since_ts", sinceTs);
  params.set("limit", String(limit));
  return get<UsageReport>(`/api/usage/gpt-image-2?${params.toString()}`);
}

export function openGptImage2UsageStream(
  onEvent: (e: UsageStreamEvent) => void,
  onClose?: () => void
): WebSocket {
  const wsUrl = BACKEND.replace(/^http/, "ws") + "/api/usage/gpt-image-2/live";
  const ws = new WebSocket(wsUrl);
  ws.onmessage = (e) => {
    try {
      onEvent(JSON.parse(e.data) as UsageStreamEvent);
    } catch {
      // ignore
    }
  };
  ws.onclose = () => onClose?.();
  // A failed/dropped socket fires `error` and THEN `close`. Routing both to
  // onClose double-fires it, and any consumer that reconnects per call then
  // doubles its attempts each round (exponential storm). `close` always
  // follows, so a no-op here keeps onClose firing exactly once per socket.
  ws.onerror = () => {};
  return ws;
}

// ---- Context ----------------------------------------------------------------

export async function getContextSnapshot(): Promise<ContextSnapshot> {
  return get<ContextSnapshot>("/api/context/current");
}

export async function setActiveProject(
  name: string
): Promise<{ status: string; name: string }> {
  return post<{ status: string; name: string }>("/api/context/active-project", { name });
}

// ---- v2: Engine Hub ----------------------------------------------------------

export async function listHubProjects(): Promise<HubProjectList> {
  return get<HubProjectList>("/api/unity-hub/projects");
}

export async function getActiveHubProject(): Promise<ActiveProjectInfo> {
  return get<ActiveProjectInfo>("/api/unity-hub/active");
}

export async function setActiveHubProject(path: string): Promise<ActiveProjectInfo> {
  return post<ActiveProjectInfo>("/api/unity-hub/active", { path });
}

// ---- v2: Animation -----------------------------------------------------------

export interface CreateClipRequest {
  sprite_atlas_path: string;
  name: string;
  frames: AnimFrame[];
  loop_mode?: LoopMode;
  fps?: number;
}

export async function createAnimationClip(
  req: CreateClipRequest
): Promise<{ ok: boolean; spec_path: string; name: string; fps: number; loop_mode: LoopMode; frame_count: number }> {
  return post("/api/animation/create-clip", req);
}

export async function listAnimationSpecs(
  project = "default"
): Promise<{ project: string; specs: Array<{ filename: string; name: string; fps: number; frame_count: number; loop_mode: LoopMode }> }> {
  return get(`/api/animation/list?project=${encodeURIComponent(project)}`);
}

export async function saveAnimationSpec(
  project: string,
  name: string,
  spec: AnimationSpec
): Promise<{ ok: boolean; path: string }> {
  return post("/api/animation/save", { project, name, spec });
}

export function previewGifUrl(
  atlas: string,
  fps = 12,
  rows = 1,
  cols?: number,
  frameW = 0,
  frameH = 0
): string {
  const params = new URLSearchParams({
    atlas, fps: String(fps), rows: String(rows),
    frame_w: String(frameW), frame_h: String(frameH),
  });
  if (cols !== undefined) params.set("cols", String(cols));
  return `${BACKEND}/api/animation/preview-gif?${params.toString()}`;
}

// ---- v2: Generation queue ----------------------------------------------------

export async function listQueueTasks(): Promise<{ max_parallel: number; tasks: QueueTask[]; ts: number }> {
  return get("/api/gen-queue/list");
}

export async function cancelQueueTask(taskId: string): Promise<{ ok: boolean; task_id: string }> {
  return post(`/api/gen-queue/cancel/${encodeURIComponent(taskId)}`, {});
}

export async function clearQueueTasks(opts: {
  project?: string;
  statuses?: ("failed" | "cancelled" | "completed")[];
}): Promise<{ ok: boolean; removed: number; statuses: string[]; project: string | null }> {
  return post(`/api/gen-queue/clear`, {
    project: opts.project ?? null,
    statuses: opts.statuses ?? ["failed", "cancelled"],
  });
}

export async function enqueueSprite(opts: {
  description: string;
  project?: string;
  animations?: string[];
  frames_per_anim?: number;
  style?: string;
  sprite_size?: [number, number];
}): Promise<{ task_id: string; status: string }> {
  return post("/api/gen-queue/enqueue-sprite", opts);
}

export async function enqueueAsset(opts: {
  asset_type: string;
  description: string;
  project?: string;
  extra?: Record<string, unknown>;
}): Promise<{ task_id: string; status: string }> {
  return post("/api/gen-queue/enqueue-asset", opts);
}

export function openQueueWs(
  onEvent: (e: QueueWsEvent) => void,
  onClose?: () => void,
  project?: string,
): WebSocket {
  // The initial snapshot is scoped to ?project=<name>. Live broadcasts are
  // unfiltered — the client decides what to show per project.
  const qs = project ? `?project=${encodeURIComponent(project)}` : "";
  const wsUrl = BACKEND.replace(/^http/, "ws") + "/ws/gen-queue" + qs;
  const ws = new WebSocket(wsUrl);
  ws.onmessage = (e) => {
    try { onEvent(JSON.parse(e.data) as QueueWsEvent); } catch { /* ignore */ }
  };
  ws.onclose = () => onClose?.();
  // A failed/dropped socket fires `error` and THEN `close`. Routing both to
  // onClose double-fires it, and any consumer that reconnects per call then
  // doubles its attempts each round (exponential storm). `close` always
  // follows, so a no-op here keeps onClose firing exactly once per socket.
  ws.onerror = () => {};
  const ping = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }));
    else clearInterval(ping);
  }, 25000);
  return ws;
}

// ---- v2: Game build orchestrator --------------------------------------------

export interface CatTacToeBuildRequest {
  first_player?: "white" | "black" | "random";
  style?: "pixel" | "cartoon" | "realistic" | "cute";
  board_size?: number;
  ai_difficulty?: "optimal" | "random" | "mixed";
  project?: string;
  dry_run?: boolean;
}

export async function startCatTacToeBuild(
  req: CatTacToeBuildRequest
): Promise<{ build_id: string; status: string }> {
  return post("/api/game-build/cat-tac-toe", req);
}

export async function getBuildStatus(buildId: string): Promise<GameBuild> {
  return get<GameBuild>(`/api/game-build/status/${encodeURIComponent(buildId)}`);
}

export async function abortBuild(buildId: string): Promise<{ ok: boolean }> {
  return post(`/api/game-build/abort/${encodeURIComponent(buildId)}`, {});
}

export function openGameBuildWs(
  onEvent: (e: GameBuildWsEvent) => void,
  onClose?: () => void
): WebSocket {
  const wsUrl = BACKEND.replace(/^http/, "ws") + "/ws/game-build";
  const ws = new WebSocket(wsUrl);
  ws.onmessage = (e) => {
    try { onEvent(JSON.parse(e.data) as GameBuildWsEvent); } catch { /* ignore */ }
  };
  ws.onclose = () => onClose?.();
  // A failed/dropped socket fires `error` and THEN `close`. Routing both to
  // onClose double-fires it, and any consumer that reconnects per call then
  // doubles its attempts each round (exponential storm). `close` always
  // follows, so a no-op here keeps onClose firing exactly once per socket.
  ws.onerror = () => {};
  return ws;
}
