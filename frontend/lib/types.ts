// murrkit — frontend type definitions

// ---- Sprite generation -------------------------------------------------------

export interface SpriteGenRequest {
  description: string;
  animations?: string[];
  frames_per_anim?: number;
  style?: "pixel_art" | "vector" | "hand_painted" | "cartoon";
  sprite_size?: [number, number];
  output_dir?: string;
}

export interface SpriteStrip {
  name: string;
  path: string;
  frame_count: number;
  frame_width: number;
  frame_height: number;
}

export interface SpriteGenResponse {
  character_name: string;
  output_dir: string;
  atlas_path: string;
  frames_json_path: string;
  strips: SpriteStrip[];
  cost_usd: number;
}

// ---- Spritesheet import (upload + grid slice) --------------------------------

export interface SpritesheetImportResponse {
  ok: boolean;
  /** Backend-served URLs (relative to BACKEND) for each sliced frame, in order. */
  frames: string[];
  /** Backend-served URL of the generated frames.json sidecar. */
  frames_json_url: string;
  rows: number;
  cols: number;
  frame_w: number;
  frame_h: number;
}

// ---- Asset generation --------------------------------------------------------

export interface AssetGenResponse {
  asset_type: "background" | "tileset" | "ui_element" | "particle_fx";
  name: string;
  output_dir: string;
  files: string[];
  metadata: Record<string, unknown>;
  cost_usd: number;
}

// ---- Engine ------------------------------------------------------------------

export interface UnityEditorState {
  is_compiling: boolean;
  ready_for_tools: boolean;
  blocking_reasons: string[];
}

// ---- Projects ----------------------------------------------------------------

export interface Project {
  name: string;
  path: string;
  files: string[];
  /** Last-touched epoch seconds (max mtime of dir + level/sprite subdirs). */
  mtime?: number;
  /** Non-ignored file count under the project dir. */
  asset_count?: number;
}

// ---- WebSocket events --------------------------------------------------------

export type WsEvent =
  | { type: "sprite_gen_start"; description: string; animations: string[] }
  | { type: "sprite_gen_done"; atlas: string; cost_usd: number }
  | { type: "sprite_gen_error"; error: string }
  | { type: "asset_gen_start"; type_: string; description: string }
  | { type: "asset_gen_done"; type_: string }
  | { type: "pong" };

// ---- Chat --------------------------------------------------------------------

export type ChatModel = "deepseek_v4" | "claude_sonnet" | "claude_opus";

export interface ChatAttachment {
  filename: string;
  served_url: string;
  abs_path: string;
}

export interface ChatHistoryItem {
  id: number;
  role: "user" | "agent";
  text: string;
  model: string | null;
  attachments: ChatAttachment[];
  cost_usd: number;
  created_at: string;
}

export interface SkillInfo {
  name: string;
  description: string;
  source: "project" | "global";
  path: string;
}

export interface CostSnapshot {
  spent_usd: number;
  budget_usd: number;
  remaining_usd: number;
  pct_used: number;
}

export type ChatStreamEvent =
  | { kind: "started"; task_id: string; model: string }
  | { kind: "token"; text: string }
  | { kind: "thought"; text: string }
  | { kind: "tool_use"; id: string; name: string; args_summary: string }
  | { kind: "tool_result"; id: string; ok: boolean; result_summary: string }
  | { kind: "system"; subtype: string; session_id: string }
  | { kind: "final"; text: string; cost_usd: number; duration_ms?: number; num_turns?: number; input_tokens?: number; output_tokens?: number }
  | { kind: "aborted"; reason: string }
  | { kind: "error"; error: string };

/** Events of the WS /api/chat/loop work-loop stream: the normal chat events
 *  (one inner captain turn per round) plus loop control events. `final` here
 *  ends ONE ROUND, not the stream — only `loop_done` is terminal. */
export type LoopStreamEvent =
  | ChatStreamEvent
  | { kind: "warning"; level: string; text: string }
  | { kind: "loop_iter"; i: number; status: "continue" | "done" | "blocked" | "missing"; detail: string; cost_so_far: number }
  | { kind: "loop_done"; reason: "done" | "blocked" | "caps" | "stuck"; detail: string; iters: number; cost: number };

// ---- Settings / Config -------------------------------------------------------

export interface ConfigField {
  key: string;
  label: string;
  kind: "secret" | "plain" | "path" | "number" | "bool";
  value: string;
  is_set: boolean;
  default: string;
}

export interface ConfigSnapshot {
  fields: ConfigField[];
  env_file_path: string;
  budget_spent_usd: number;
  budget_limit_usd: number;
  backend_port: number;
}

export interface TestResult {
  ok: boolean;
  detail: string;
  elapsed_ms: number;
  extra: Record<string, unknown>;
}

// ---- Library -----------------------------------------------------------------

export interface LibraryAsset {
  id: string;
  project_name: string;
  type: string;
  name: string;
  rel_path: string;
  served_url: string;
  size_bytes: number;
  modified_at: string;
}

export interface ProjectLibrary {
  project_name: string;
  project_path: string;
  asset_count: number;
  total_bytes: number;
  assets: LibraryAsset[];
}

// ---- Logs --------------------------------------------------------------------

export interface LogLine {
  kind?: "line" | "error";
  ts?: string;
  level?: string;
  module?: string;
  component?: string;
  msg?: string;
  raw?: string;
  error?: string;
}

// ---- Smoke test --------------------------------------------------------------

export interface SmokeStage {
  name: string;
  ok: boolean;
  detail: string;
  elapsed_ms: number;
  extra: Record<string, unknown>;
}

export interface SmokeTestReport {
  started_at: string;
  total_elapsed_ms: number;
  total_cost_usd: number;
  stages: SmokeStage[];
  overall_ok: boolean;
  summary: string;
}

// ---- Usage tracking ----------------------------------------------------------

export interface UsageCall {
  id: number;
  project: string;
  model: string;
  resolution: string;
  quality: string;
  size: string;
  cost_usd: number;
  prompt: string;
  task_id: string;
  ts: string;
  elapsed_ms: number;
  status: string;
  extra: Record<string, unknown>;
}

export interface UsageReport {
  total_calls: number;
  total_cost_usd: number;
  by_resolution: Record<string, { count: number; cost_usd: number }>;
  by_day: Record<string, { count: number; cost_usd: number }>;
  calls: UsageCall[];
}

export type UsageStreamEvent =
  | { type: "usage_snapshot"; totals: { total_calls: number; total_cost_usd: number } }
  | { type: "usage_event"; record: UsageCall };

// ---- Context snapshot --------------------------------------------------------

export interface ContextSnapshot {
  superagent_project: string | null;
  unity_project_path: string;
  unity_project_name: string;
  claude_cli_version: string | null;
  claude_cli_path: string | null;
  mcp_unity_status: "ready" | "offline" | "unknown";
  mcp_unity_transport: "http" | "stdio" | "unknown";
  deepseek_model: string;
  budget_limit_usd: number;
  budget_spent_usd: number;
  budget_remaining_usd: number;
  backend_port: number;
}

// ---- v2: Engine Hub ----------------------------------------------------------

export interface HubProject {
  title: string;
  path: string;
  version: string | null;
  last_modified: number | null;
  is_favorite: boolean;
  project_type: string | null;
}

export interface HubProjectList {
  projects: HubProject[];
  hub_json_path: string;
  hub_json_exists: boolean;
}

export interface ActiveProjectInfo {
  path: string;
  name: string;
  exists: boolean;
  has_assets: boolean;
  version: string | null;
  last_modified: number | null;
}

// ---- v2: Animation -----------------------------------------------------------

export interface AnimFrame {
  rect: [number, number, number, number];
  duration_ms: number;
  tag?: string | null;
}

export type LoopMode = "once" | "loop" | "ping-pong" | "reverse";

export interface AnimationSpec {
  name: string;
  atlas: string;
  fps: number;
  loop_mode: LoopMode;
  frames: AnimFrame[];
  tags?: { name: string; from: number; to: number }[];
}

// ---- v2: Generation queue ----------------------------------------------------

export interface QueueTask {
  id: string;
  asset_type: string;
  prompt: string;
  status: "planned" | "queued" | "started" | "progress" | "completed" | "failed" | "cancelled";
  project: string;
  eta_seconds: number;
  cost_usd: number;
  thumbnail_url: string | null;
  started_at: number | null;
  completed_at: number | null;
  progress_pct: number;
  progress_text: string;
  error: string | null;
  extra: Record<string, unknown>;
  planned_workflow?: string | null;
  planned_quality?: string | null;
  planned_resolution?: string | null;
  planned_aspect_ratio?: string | null;
  // Edit-reference path (absolute disk). Required when
  // planned_workflow === "gpt-image-2-edit". null/empty → fresh-gen.
  base_image_path?: string | null;
}

export type QueueWsEvent =
  | { event: "snapshot"; tasks: QueueTask[]; max_parallel: number }
  | {
      event: "planned" | "queued" | "started" | "progress" | "completed" | "failed" | "cancelled" | "removed";
      task: QueueTask;
      ts: number;
    };

// ---- v2: Game build orchestrator --------------------------------------------

export interface BuildStep {
  index: number;
  name: string;
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  message: string;
  thumbnail_url: string | null;
  started_at: number | null;
  completed_at: number | null;
  error: string | null;
  extra: Record<string, unknown>;
}

export interface GameBuild {
  id: string;
  template: string;
  started_at: number;
  completed_at: number | null;
  status: "running" | "completed" | "failed" | "cancelled";
  steps: BuildStep[];
  params: Record<string, unknown>;
  cost_usd_total: number;
}

export type GameBuildWsEvent =
  | { event: "snapshot"; builds: GameBuild[] }
  | { event: "started" | "finished" | "failed" | "cancelled"; ts: number; build: GameBuild; step: null }
  | { event: "step"; ts: number; build: GameBuild; step: BuildStep };

// ---- v2: Layout persistence --------------------------------------------------

export type ThemeName = "dark" | "light" | "rpg" | "synthwave";

export type ActivitySection =
  | "projects" | "browser" | "chat" | "animator"
  | "unity" | "analytics" | "settings" | "help";

export type CenterTabKind =
  | "chat" | "code" | "animator" | "scene"
  | "library" | "generate" | "wizard" | "queue" | "settings" | "qwen" | "vision" | "references"
  | "spritesheet" | "map";

// ---- Map Studio (phaser_game/maps/*.map.yaml over /api/maps) -----------------

export interface MapListEntry {
  id: string;
  path: string;
  bytes: number;
  mtime: number;
}

/** Per-biome tileset generation status for one map. */
export interface MapTilesetStatus {
  biome: string;
  image: string | null;
  image_exists: boolean;
  /** Stable publish path a `biome_tileset` gen lands at for this project. */
  suggested_image: string;
  suggested_exists: boolean;
  /** Disk path of the published sheet (null until generated) — used as
   *  base_image_path so later biomes style-match the first via edit-mode. */
  published_disk_path: string | null;
  walkable: boolean;
  color: string | null;
}

export interface MapDetail {
  id: string;
  yaml: string;
  /** Parsed spec, or null when the file fails validation (see `errors`). */
  spec: Record<string, unknown> | null;
  errors: string[];
  tilesets: MapTilesetStatus[];
  play_url_hint: string;
}

export interface MapParseResult {
  ok: boolean;
  spec: Record<string, unknown> | null;
  errors: string[];
}

/** Proposal from POST /api/maps/{id}/ai-paint — applied client-side, never
 *  written to disk by the backend. */
export interface AiPaintResult {
  ok: boolean;
  legend: Record<string, string>;
  rows: string[];
  /** >1 when the model painted at 1/k scale and the grid was upscaled. */
  downscale: number;
  cost_usd: number;
}

// ---- v2: User Reference Materials (drag-drop folder) ------------------------

export interface ReferenceFile {
  name: string;
  category: "image" | "video" | "document" | "other";
  size_bytes: number;
  modified_at: number;
  mime_type: string;
  served_url: string;
  abs_path: string;
  keyframe_count?: number;     // videos only
  keyframe_paths?: string[];   // videos only
}

export interface ReferenceList {
  project: string;
  root: string;
  total: number;
  entries: ReferenceFile[];
}

// ---- v2: Vision (Gemini default, peer fallback, DeepSeek triage) ------------

export interface VisionHistoryEntry {
  type: "review" | "triage";
  ts: number;
  project: string;
  provider: "gemini" | "qwen" | "deepseek";
  transport: "kitty_proxy" | "direct_google_ai" | "direct";
  model: string;
  tokens: { input: number; output: number };
  cost_usd: number;
  // review-only
  frames?: string[];
  frame_count?: number;
  question?: string | null;
  analysis?: string;
  // triage-only
  context_hint?: string | null;
  log_chars?: number;
  summary?: string;
  severity?: "info" | "warning" | "error" | "fatal";
  cluster_count?: number;
  top_actions?: string[];
}

export interface VisionProvidersInfo {
  default_vision_provider: "gemini";
  providers: {
    gemini: {
      purpose: string;
      transport: "kitty_proxy" | "direct_google_ai";
      transport_note: string;
      model?: string;
      pricing?: Record<string, number | string>;
      tiers?: Record<string, { model: string; cost_per_m_input_usd: number; cost_per_m_output_usd: number; use_for: string }>;
      note?: string;
    };
    qwen: {
      purpose: string;
      guidance: string;
      model: string;
      cost_per_m_input_usd: number;
      cost_per_m_output_usd: number;
      kitty_markup: string;
    };
  };
  triage_provider: {
    name: "deepseek";
    model: string;
    purpose: string;
    cost_per_m_input_usd: number;
    cost_per_m_cached_input_usd: number;
    cost_per_m_output_usd: number;
    no_vision: boolean;
    use_for: string;
  };
}

export interface CenterTab {
  id: string;
  kind: CenterTabKind;
  title: string;
  sticky?: boolean;
  file?: string;
  // Pane id for split-view; tabs with same paneId render in the same pane.
  paneId?: string;
}

export type BottomTabKind =
  | "terminal" | "output" | "problems"
  | "gen-queue" | "unity-console" | "logs";

export interface BottomTab {
  id: string;
  kind: BottomTabKind;
  title: string;
}

export interface LayoutSnapshot {
  version: 2 | 3 | 4 | 5 | 6 | 7;
  sidePanelWidth: number;
  rightPanelWidth: number;
  bottomDockHeight: number;
  bottomDockOpen: boolean;
  rightPanelOpen: boolean;
  sidePanelOpen: boolean;
  activitySection: ActivitySection;
  centerTabs: CenterTab[];
  activeCenterTabId: string | null;
  bottomTabs: BottomTab[];
  activeBottomTabId: string | null;
  theme: ThemeName;
}
