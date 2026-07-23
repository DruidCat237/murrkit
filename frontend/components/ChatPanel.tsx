"use client";

/**
 * ChatPanel — main interactive chat with model picker, skill picker,
 * attachment drop, streaming markdown, cost meter, abort button.
 *
 * Ported from GameTestMVP/frontend/components/ChatPanel.tsx with adjustments:
 *   - Uses native WebSocket streaming (no polling fallback)
 *   - Multi-model picker (deepseek_v4, claude_sonnet, claude_opus, claude_fable)
 *   - Skill picker dropdown enumerating .claude/skills/ + global skills
 *   - Persists history per project via /api/chat/history
 *   - Live cost meter showing % of BUDGET_LIMIT_USD
 *   - Auto-load CLAUDE.md context indicator
 */

import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";
import {
  Bot,
  ChevronRight,
  Copy,
  CornerDownRight,
  FileImage,
  FileText,
  GitBranch,
  Keyboard,
  Loader2,
  Paperclip,
  RotateCw,
  Send,
  Sparkles,
  Square,
  Terminal,
  Trash2,
  User,
  Wand2,
  Wrench,
  X,
} from "lucide-react";
import {
  abortChatTask,
  backendReady,
  clearChatHistory,
  getConfig,
  getCostSnapshot,
  listSkills,
  loadChatHistory,
  openChatStream,
  openFileInEditor,
  openLoopStream,
  uploadChatAttachment,
} from "@/lib/api";
import type {
  ChatAttachment,
  ChatHistoryItem,
  ChatModel,
  ChatStreamEvent,
  CostSnapshot,
  SkillInfo,
} from "@/lib/types";

type Msg = {
  role: "user" | "agent";
  text: string;
  model?: ChatModel | null;
  attachments?: ChatAttachment[];
  cost?: number;
  tokens?: { in: number; out: number }; // input/output token counts (final event)
  liveEvents?: ChatStreamEvent[]; // for in-flight stream rendering
};

const MODEL_OPTIONS: { value: ChatModel; label: string; hint: string; tint: string }[] = [
  { value: "deepseek_v4",   label: "DeepSeek V4 Flash",  hint: "cheap, $/M",    tint: "text-blue-400" },
  { value: "claude_sonnet", label: "Claude Sonnet",  hint: "fast default route",    tint: "text-accent" },
  { value: "claude_opus",   label: "Opus 4.8",       hint: "default orchestrator", tint: "text-accent-hot" },
  { value: "claude_fable",  label: "Fable 5",        hint: "premium · $10/$50 MTok · credits", tint: "text-purple-400" },
  // Kimi K3 captain: Claude Code CLI → Moonshot Anthropic-compatible endpoint
  // (KIMI_API_KEY in Settings). Available under BOTH claude and codex CLI modes.
  { value: "kimi_k3",       label: "Kimi K3",        hint: "Moonshot · 1M ctx · $3/$15 MTok", tint: "text-emerald-400" },
];

function modelOptionsForAgent(agentCli: "claude" | "codex") {
  if (agentCli === "codex") {
    // Codex has no Fable model — drop it so the switch isn't a dead entry.
    return MODEL_OPTIONS.filter((opt) => opt.value !== "claude_fable").map((opt) => {
      if (opt.value === "claude_sonnet") return { ...opt, label: "Codex Balanced", hint: "fast Codex route" };
      if (opt.value === "claude_opus") return { ...opt, label: "Codex Heavy", hint: "heavy Codex route" };
      return opt;
    });
  }
  return MODEL_OPTIONS;
}

export default function ChatPanel({
  projectName = "default",
  compact = false,
}: {
  projectName?: string;
  compact?: boolean;
}) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [filePreviews, setFilePreviews] = useState<string[]>([]);
  const [uploadingAttachments, setUploadingAttachments] = useState(false);
  const [agentCli, setAgentCli] = useState<"claude" | "codex">("claude");
  const [model, setModel] = useState<ChatModel>("claude_opus");
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [skillPrefix, setSkillPrefix] = useState<string | null>(null);
  const [skillPickerOpen, setSkillPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [costSnapshot, setCostSnapshot] = useState<CostSnapshot | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [assetEvents, setAssetEvents] = useState<AssetEvent[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Stick-to-bottom: only auto-scroll while the user is ALREADY near the bottom.
  // If they scroll UP to read what Codex is doing, we leave them there (and show
  // a "↓ Latest" jump button) instead of yanking them back down on every streamed
  // token. Fixes "chat zawsze zwija mi się sam na dół i nie mogę poczytać".
  const stickToBottomRef = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const liveBufferRef = useRef<ChatStreamEvent[]>([]);
  const partialTextRef = useRef<string>("");
  // DESIGNER MODE REFORM — auto-completion watchdog.
  // User pain: "po skończonym prompcie nie zakończył się, dalej nabijał się
  // czas a już nic nie robił". Root cause: WS doesn't always close cleanly,
  // so onClose never fires, busy stays true forever. Fix: track last event
  // time; if no event arrives for 60s while busy, force-finalize the turn.
  const lastEventTimeRef = useRef<number>(Date.now());
  // Synchronous re-entry latch for send() — guards the attachment-upload window
  // before `busy` flips true, so a double Enter can't open two captain streams.
  const sendingRef = useRef(false);
  // Per-project local cache of the chat so navigating between panels/windows
  // (which can remount this component) never loses the last response.
  // `loadedProjectRef` gates the save effect so switching projects doesn't
  // write the previous project's messages under the new project's key.
  const loadedProjectRef = useRef<string>("");
  const modelOptions = useMemo(() => modelOptionsForAgent(agentCli), [agentCli]);

  useEffect(() => {
    let cancelled = false;
    async function refreshAgentCli() {
      const cfg = await getConfig().catch(() => null);
      if (cancelled || !cfg) return;
      const field = cfg.fields.find((f) => f.key === "MURRKIT_AGENT_CLI");
      setAgentCli(field?.value === "codex" ? "codex" : "claude");
    }
    refreshAgentCli();
    function onAgentChanged(e: Event) {
      const detail = (e as CustomEvent).detail as { agent?: "claude" | "codex" };
      if (detail?.agent === "claude" || detail?.agent === "codex") setAgentCli(detail.agent);
      else refreshAgentCli();
    }
    window.addEventListener("murrkit:agent-cli-changed", onAgentChanged);
    return () => {
      cancelled = true;
      window.removeEventListener("murrkit:agent-cli-changed", onAgentChanged);
    };
  }, []);

  // ---- Restore from local cache instantly, then reconcile with backend ----
  // On mount / project change: show the cached chat immediately (so a remount
  // from navigation keeps the last response visible), then fetch the
  // authoritative backend history. Keep whichever has MORE messages, so an
  // in-flight / just-finished response the backend hasn't persisted yet is
  // never wiped by the reload.
  useEffect(() => {
    let cancelled = false;
    loadedProjectRef.current = ""; // pause saving while we (re)load
    const key = `phaser2d.chat.${projectName}`;
    try {
      const raw = localStorage.getItem(key);
      if (raw) {
        const cached = JSON.parse(raw) as Msg[];
        if (Array.isArray(cached) && cached.length) setMsgs(cached);
      }
    } catch { /* ignore corrupt cache */ }
    (async () => {
      try {
        const hist = await loadChatHistory(projectName, 80);
        if (cancelled) return;
        const fromBackend: Msg[] = hist.map((h) => ({
          role: h.role,
          text: h.text,
          model: (h.model as ChatModel | null) ?? null,
          attachments: h.attachments,
          cost: h.cost_usd,
        }));
        // Backend is authoritative once it has caught up; otherwise keep the
        // (longer) local cache so the last response is not lost to a race.
        setMsgs((prev) => (fromBackend.length >= prev.length ? fromBackend : prev));
      } catch {
        // backend may be down — keep the cached view
      } finally {
        if (!cancelled) loadedProjectRef.current = projectName;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectName]);

  // ---- Persist the chat to a per-project local cache on every change ----
  useEffect(() => {
    if (loadedProjectRef.current !== projectName) return; // don't clobber during a switch
    try {
      const slim = msgs.slice(-60).map((m) => ({
        role: m.role,
        text: m.text,
        model: m.model ?? null,
        cost: m.cost ?? 0,
        attachments: m.attachments,
        tokens: m.tokens,
      }));
      localStorage.setItem(`phaser2d.chat.${projectName}`, JSON.stringify(slim));
    } catch { /* quota / serialization — ignore */ }
  }, [msgs, projectName]);

  // ---- v2: external skill pick (e.g. from command palette) ----
  useEffect(() => {
    function onSkillPick(e: Event) {
      const detail = (e as CustomEvent).detail as { skill?: string };
      if (detail?.skill) setSkillPrefix(detail.skill);
    }
    window.addEventListener("chat:skill-pick", onSkillPick);
    // Prefill event from empty-state quick actions / templates
    function onPrefill(e: Event) {
      const detail = (e as CustomEvent).detail;
      if (typeof detail === "string") setInput(detail);
    }
    window.addEventListener("chat:prefill", onPrefill);
    // Build-view exposes a visible, labeled model picker. It drives the
    // panel's internal model via this event (mirrors `chat:prefill`) so the
    // in-panel pill row and the external control stay in sync.
    function onSetModel(e: Event) {
      const detail = (e as CustomEvent).detail as { model?: ChatModel };
      if (detail?.model) setModel(detail.model);
    }
    window.addEventListener("chat:set-model", onSetModel);
    return () => {
      window.removeEventListener("chat:skill-pick", onSkillPick);
      window.removeEventListener("chat:prefill", onPrefill);
      window.removeEventListener("chat:set-model", onSetModel);
    };
  }, []);

  // Broadcast the panel's current model so an external picker (Build view)
  // can reflect the source of truth, including the initial value and any
  // in-panel pill clicks.
  useEffect(() => {
    window.dispatchEvent(new CustomEvent("chat:model-changed", { detail: { model } }));
  }, [model]);

  // ---- Skills enumeration ----
  useEffect(() => {
    listSkills().then(setSkills).catch(() => undefined);
  }, []);

  // ---- Cost snapshot polling (every 4s while busy, else 15s) ----
  useEffect(() => {
    let mounted = true;
    const tick = async () => {
      try {
        const cs = await getCostSnapshot();
        if (mounted) setCostSnapshot(cs);
      } catch {
        // ignore
      }
    };
    tick();
    const id = setInterval(tick, busy ? 4000 : 15000);
    return () => {
      mounted = false;
      clearInterval(id);
    };
  }, [busy]);

  // ---- Elapsed timer while busy ----
  useEffect(() => {
    if (!busy) {
      setElapsedSec(0);
      return;
    }
    const start = Date.now();
    const id = setInterval(() => setElapsedSec(Math.floor((Date.now() - start) / 1000)), 500);
    return () => clearInterval(id);
  }, [busy]);

  // ---- DESIGNER MODE REFORM — auto-completion watchdog (60s idle detector) ----
  // If the WS doesn't close cleanly after a `final` event (Windows network
  // hiccups, sock zombie, server crashed mid-finalize), `busy` stays true and
  // the user sees the timer kept ticking with nothing happening. This guards
  // against that: any 60-second gap between stream events while busy forces
  // a finalize.
  useEffect(() => {
    if (!busy) return;
    lastEventTimeRef.current = Date.now();
    const id = setInterval(() => {
      const idleMs = Date.now() - lastEventTimeRef.current;
      // 240s, not 60s: the inner Claude now runs MAX-effort extended thinking
      // plus long agent tools (playtest ~30s, sprite gen minutes) that emit no
      // stream events meanwhile — a 60s window force-killed working turns
      // ("zaciął się i wyłączył"). 4 min tolerates deep work; a genuinely dead
      // WS still gets cleaned up, and the user can always hit STOP.
      if (idleMs > 240_000) {
        const secs = Math.floor(idleMs / 1000);
        console.warn(`[watchdog] Chat WS idle for ${secs}s — force-finalizing turn`);
        if (wsRef.current) {
          try { wsRef.current.close(); } catch { /* ignore */ }
          wsRef.current = null;
        }
        // Make the abandonment VISIBLE — otherwise the last agent bubble just
        // freezes mid-sentence and the user can't tell the turn died vs is
        // still thinking. Append a marker to the last agent message.
        setMsgs((prev) => {
          const copy = [...prev];
          const last = copy[copy.length - 1];
          if (last && last.role === "agent") {
            copy[copy.length - 1] = {
              ...last,
              text:
                (last.text || "").replace(/\s+$/, "") +
                `\n\n_[Connection lost after ${secs}s of silence — the turn may be incomplete. Resend to continue.]_`,
            };
          }
          return copy;
        });
        setBusy(false);
        setActiveTaskId(null);
      }
    }, 5000);
    return () => clearInterval(id);
  }, [busy]);

  // ---- Track whether the user is parked at the bottom ----
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
      stickToBottomRef.current = atBottom;
      setShowJump(!atBottom);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // ---- Auto-scroll on new messages — ONLY while stuck to the bottom ----
  // so streaming output never yanks the user down while they read earlier text.
  useEffect(() => {
    if (stickToBottomRef.current) {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
    }
  }, [msgs]);

  // ---- Cleanup blob URLs on unmount ----
  useEffect(() => {
    return () => {
      filePreviews.forEach(URL.revokeObjectURL);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Auto-grow textarea: expand with content, clamp to ~12 rows ----
  // Uses useLayoutEffect so the height is committed synchronously before
  // paint — avoids a one-frame flash of the wrong size. Reset to "auto"
  // first so the element collapses before measuring scrollHeight, otherwise
  // shrinking on delete doesn't work. The CSS min/max-height clamp is set
  // via inline style so it survives SSR (no window.innerHeight needed here).
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    // Max: 12 × approx line-height(20px) + vertical padding(12px) = 252px
    const maxPx = 252;
    el.style.height = `${Math.min(el.scrollHeight, maxPx)}px`;
    el.style.overflowY = el.scrollHeight > maxPx ? "auto" : "hidden";
  }, [input]);

  // ---- Keyboard: Ctrl+K focus, Esc abort, Ctrl+L clear (when focused) ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        (document.querySelector("[data-chat-textarea]") as HTMLTextAreaElement | null)?.focus();
      }
      if (e.key === "Escape" && activeTaskId) {
        // Scope abort to when the chat input is focused. Escape is a global key
        // (dismisses menus/modals/lightboxes elsewhere), and stop() is
        // destructive — it kills the captain turn AND cancels every queued or
        // in-flight gen-queue job. A stray Esc from across the app must not do
        // that; the always-visible Stop button covers the unfocused case.
        const active = document.activeElement as HTMLElement | null;
        if (active?.matches("[data-chat-textarea]")) {
          e.preventDefault();
          stop();
        }
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "l") {
        const active = document.activeElement as HTMLElement | null;
        if (active?.matches("[data-chat-textarea]")) {
          e.preventDefault();
          clearAll();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTaskId]);

  function addFiles(newFiles: FileList | File[]) {
    const arr = Array.from(newFiles);
    if (!arr.length) return;
    setFiles((prev) => [...prev, ...arr]);
    setFilePreviews((prev) => [...prev, ...arr.map((f) => URL.createObjectURL(f))]);
  }

  function removeFile(idx: number) {
    setFiles((prev) => prev.filter((_, i) => i !== idx));
    setFilePreviews((prev) => {
      URL.revokeObjectURL(prev[idx]);
      return prev.filter((_, i) => i !== idx);
    });
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  }

  async function send() {
    const txt = input.trim();
    // `busy` only flips true AFTER the attachment upload await below, so it
    // can't guard the upload window. sendingRef is a synchronous latch: a
    // second Enter / Send click while a large PNG is still uploading would
    // otherwise re-enter send() and open a SECOND captain stream for the same
    // message. Cleared once `busy` takes over (or on an early return).
    if ((!txt && files.length === 0) || busy || sendingRef.current) return;
    sendingRef.current = true;

    // Wait for the port probe BEFORE we set busy/activeTaskId — openChatStream
    // reads the mutable BACKEND synchronously, and awaiting it later (between
    // setBusy and openChatStream) opened a window where a Stop during the probe
    // aborted a not-yet-created task, then the stream opened anyway, unabortable.
    await backendReady;

    // WORK LOOP: "/loop [--iters N] [--budget X] <zadanie>" runs the captain
    // in the autonomous ralph-style loop (WS /api/chat/loop) instead of one
    // chat turn. Attachments are not part of the loop protocol.
    if (txt.startsWith("/loop")) {
      startLoop(txt);
      return;
    }

    // 1. Upload all attachments first
    let uploaded: ChatAttachment[] = [];
    if (files.length > 0) {
      setUploadingAttachments(true);
      try {
        uploaded = await Promise.all(files.map((f) => uploadChatAttachment(f)));
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e);
        setMsgs((m) => [...m, { role: "agent", text: `Attachment upload failed: ${err}` }]);
        setUploadingAttachments(false);
        sendingRef.current = false;
        return;
      }
      setUploadingAttachments(false);
    }

    // 2. Push optimistic user message
    const userMsg: Msg = {
      role: "user",
      text: txt,
      model,
      attachments: uploaded,
    };
    // Sending = the user wants to follow the new output → re-stick to bottom.
    stickToBottomRef.current = true;
    setShowJump(false);
    setMsgs((m) => [...m, userMsg]);
    setInput("");
    setFiles([]);
    setFilePreviews([]);

    // 3. Push placeholder agent message (will fill via stream)
    const agentIdx = msgs.length + 1;
    liveBufferRef.current = [];
    partialTextRef.current = "";
    setAssetEvents([]);
    setMsgs((m) => [
      ...m,
      { role: "agent", text: "", model, liveEvents: [], cost: 0 },
    ]);

    // 4. Open stream
    const taskId = `chat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    setActiveTaskId(taskId);
    setBusy(true);
    sendingRef.current = false;  // `busy` now guards re-entry

    const ws = openChatStream(
      {
        task_id: taskId,
        project_name: projectName,
        message: txt,
        model,
        attachments: uploaded,
        skill_prefix: skillPrefix ?? undefined,
      },
      (evt) => {
        // DESIGNER MODE REFORM — reset idle watchdog on EVERY incoming event.
        // Any progress signal (token / tool_use / tool_result / system / ping)
        // tells the watchdog the stream is still alive.
        lastEventTimeRef.current = Date.now();
        if (evt.kind === "ping") return; // liveness heartbeat only — no content
        if (evt.kind === "token") {
          partialTextRef.current += evt.text;
          setMsgs((prev) => {
            const copy = [...prev];
            const last = copy[copy.length - 1];
            if (last && last.role === "agent") {
              copy[copy.length - 1] = { ...last, text: partialTextRef.current };
            }
            return copy;
          });
        } else if (
          evt.kind === "tool_use" ||
          evt.kind === "tool_result" ||
          evt.kind === "thought" ||
          evt.kind === "system"
        ) {
          liveBufferRef.current.push(evt);
          setMsgs((prev) => {
            const copy = [...prev];
            const last = copy[copy.length - 1];
            if (last && last.role === "agent") {
              copy[copy.length - 1] = { ...last, liveEvents: [...liveBufferRef.current] };
            }
            return copy;
          });
          // Feed the asset-plan panel so the user can see what's being built.
          if (evt.kind === "tool_use") {
            const ae = classifyAssetEvent(evt);
            if (ae) setAssetEvents((prev) => upsertAssetEvent(prev, ae));
          } else if (evt.kind === "tool_result") {
            setAssetEvents((prev) =>
              prev.map((a) =>
                a.toolId === evt.id
                  ? { ...a, status: evt.ok ? "done" : "failed", resultSummary: evt.result_summary }
                  : a,
              ),
            );
          }
        } else if (evt.kind === "final") {
          setMsgs((prev) => {
            const copy = [...prev];
            const last = copy[copy.length - 1];
            if (last && last.role === "agent") {
              copy[copy.length - 1] = {
                ...last,
                text: evt.text || partialTextRef.current,
                cost: evt.cost_usd ?? 0,
                tokens:
                  evt.input_tokens != null || evt.output_tokens != null
                    ? { in: evt.input_tokens ?? 0, out: evt.output_tokens ?? 0 }
                    : last.tokens,
              };
            }
            return copy;
          });
          // DESIGNER MODE REFORM — finalize the turn IMMEDIATELY on `final`
          // event, don't wait for WS onClose. The backend sends `final` after
          // result accounting; the close handshake can lag (or fail) on flaky
          // networks. Stopping busy here matches the user's mental model:
          // "agent finished its message → timer stops".
          setBusy(false);
          setActiveTaskId(null);
          if (wsRef.current) {
            try { wsRef.current.close(); } catch { /* ignore */ }
            wsRef.current = null;
          }
        } else if (evt.kind === "aborted") {
          setMsgs((prev) => {
            const copy = [...prev];
            const last = copy[copy.length - 1];
            if (last && last.role === "agent") {
              copy[copy.length - 1] = {
                ...last,
                text: (last.text || "") + "\n\n[Aborted by user]",
              };
            }
            return copy;
          });
        } else if (evt.kind === "error") {
          setMsgs((prev) => {
            const copy = [...prev];
            const last = copy[copy.length - 1];
            if (last && last.role === "agent") {
              copy[copy.length - 1] = { ...last, text: `[Error: ${evt.error}]` };
            }
            return copy;
          });
        }
      },
      () => {
        setBusy(false);
        setActiveTaskId(null);
        wsRef.current = null;
      }
    );
    wsRef.current = ws;
  }

  // WORK LOOP — one agent bubble accumulates ALL rounds; `final` ends a round
  // (accumulate cost, keep streaming), only `loop_done` finalizes the turn.
  // Stop works unchanged: the loop registers the same task_id in `_tasks`.
  function startLoop(raw: string) {
    sendingRef.current = false;
    // Parse: /loop [--iters N] [--budget X] <task prompt>
    let rest = raw.slice("/loop".length).trim();
    let maxIters: number | undefined;
    let budgetUsd: number | undefined;
    for (;;) {
      const m = rest.match(/^--(iters|budget)\s+(\d+(?:\.\d+)?)\s+/);
      if (!m) break;
      if (m[1] === "iters") maxIters = parseInt(m[2], 10);
      else budgetUsd = parseFloat(m[2]);
      rest = rest.slice(m[0].length);
    }
    const prompt = rest.trim();
    if (!prompt) {
      setMsgs((m) => [...m, {
        role: "agent",
        text: "Użycie: `/loop [--iters N] [--budget X] <zadanie>` — autonomiczna pętla robocza kapitana. Kapitan kończy każdą rundę markerem LOOP_CONTINUE / LOOP_DONE / LOOP_BLOCKED; log rund w `.omc/state/<projekt>/loop_log.md`.",
      }]);
      return;
    }

    stickToBottomRef.current = true;
    setShowJump(false);
    setMsgs((m) => [...m, { role: "user", text: raw, model }]);
    setInput("");
    liveBufferRef.current = [];
    partialTextRef.current = "";
    setAssetEvents([]);
    setMsgs((m) => [...m, { role: "agent", text: "", model, liveEvents: [], cost: 0 }]);

    const taskId = `loop_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    setActiveTaskId(taskId);
    setBusy(true);

    let costAccum = 0;
    const appendText = (chunk: string) => {
      partialTextRef.current += chunk;
      setMsgs((prev) => {
        const copy = [...prev];
        const last = copy[copy.length - 1];
        if (last && last.role === "agent") {
          copy[copy.length - 1] = { ...last, text: partialTextRef.current };
        }
        return copy;
      });
    };

    const ws = openLoopStream(
      {
        task_id: taskId,
        project_name: projectName,
        prompt,
        max_iters: maxIters,
        budget_usd: budgetUsd,
        // Loop runs on the currently selected captain: Kimi K3 when the
        // picker says so, otherwise the backend's heavy Claude route.
        model: model === "kimi_k3" ? "kimi_k3" : undefined,
      },
      (evt) => {
        lastEventTimeRef.current = Date.now();
        if (evt.kind === "token") {
          appendText(evt.text);
        } else if (
          evt.kind === "tool_use" ||
          evt.kind === "tool_result" ||
          evt.kind === "thought" ||
          evt.kind === "system"
        ) {
          liveBufferRef.current.push(evt);
          setMsgs((prev) => {
            const copy = [...prev];
            const last = copy[copy.length - 1];
            if (last && last.role === "agent") {
              copy[copy.length - 1] = { ...last, liveEvents: [...liveBufferRef.current] };
            }
            return copy;
          });
          if (evt.kind === "tool_use") {
            const ae = classifyAssetEvent(evt);
            if (ae) setAssetEvents((prev) => upsertAssetEvent(prev, ae));
          } else if (evt.kind === "tool_result") {
            setAssetEvents((prev) =>
              prev.map((a) =>
                a.toolId === evt.id
                  ? { ...a, status: evt.ok ? "done" : "failed", resultSummary: evt.result_summary }
                  : a,
              ),
            );
          }
        } else if (evt.kind === "final") {
          // End of ONE ROUND — accumulate cost, do NOT close/finalize.
          costAccum += evt.cost_usd ?? 0;
          setMsgs((prev) => {
            const copy = [...prev];
            const last = copy[copy.length - 1];
            if (last && last.role === "agent") {
              copy[copy.length - 1] = { ...last, cost: costAccum };
            }
            return copy;
          });
        } else if (evt.kind === "loop_iter") {
          appendText(
            `\n\n— runda ${evt.i + 1}: ${evt.status.toUpperCase()}` +
            `${evt.detail ? ` — ${evt.detail}` : ""} —\n\n`,
          );
        } else if (evt.kind === "warning") {
          appendText(`\n\n⚠ ${evt.text}\n`);
        } else if (evt.kind === "loop_done") {
          appendText(
            `\n\n■ LOOP ${evt.reason.toUpperCase()} po ${evt.iters} rundach ` +
            `($${evt.cost.toFixed(2)})${evt.detail ? ` — ${evt.detail}` : ""}`,
          );
          setBusy(false);
          setActiveTaskId(null);
          if (wsRef.current) {
            try { wsRef.current.close(); } catch { /* ignore */ }
            wsRef.current = null;
          }
        } else if (evt.kind === "aborted") {
          appendText("\n\n[Aborted by user]");
        } else if (evt.kind === "error") {
          appendText(`\n\n[Error: ${evt.error}]`);
          setBusy(false);
          setActiveTaskId(null);
        }
      },
      () => {
        setBusy(false);
        setActiveTaskId(null);
        wsRef.current = null;
      },
    );
    wsRef.current = ws;
  }

  async function stop() {
    if (activeTaskId) {
      abortChatTask(activeTaskId).catch(() => undefined);
    }
    if (wsRef.current) {
      try {
        wsRef.current.close();
      } catch {
        // ignore
      }
    }
    // Also cancel ANY in-flight generation queue jobs — when the user smashes
    // Stop they don't want sprite credits to keep burning in the background.
    try {
      const { useQueue } = await import("@/store/queue");
      const { cancelQueueTask } = await import("@/lib/api");
      const qstate = useQueue.getState();
      const active = qstate.order
        .map((id) => qstate.tasks[id])
        .filter((t) => t && (t.status === "started" || t.status === "progress" || t.status === "queued"));
      await Promise.all(active.map((t) => cancelQueueTask(t.id).catch(() => undefined)));
      // Cancels may trigger Kitty refunds — refresh the balance pill.
      const { refreshKittyBalance } = await import("@/components/CreditsBadge");
      refreshKittyBalance();
    } catch {
      // store/api unavailable — best effort
    }
    setBusy(false);
    setActiveTaskId(null);
  }

  async function clearAll() {
    if (!confirm("Clear all chat history for this project?")) return;
    await clearChatHistory(projectName).catch(() => undefined);
    setMsgs([]);
  }

  const filteredSkills = useMemo(() => {
    return skills.slice(0, 40);
  }, [skills]);

  return (
    <div
      className={[
        // min-w-0 + w-full: flex children default to min-width:auto which makes
        // wide markdown/code blocks overflow LEFT under the SidePanel. These
        // two classes force the chat to clip its content to its allocated
        // dock width instead of growing past it.
        "panel flex flex-col h-full w-full min-w-0 overflow-hidden relative",
        dragOver ? "ring-2 ring-accent/50" : "",
      ].join(" ")}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      {/* Header */}
      <div className="panel-header flex items-center justify-between flex-wrap gap-2">
        <span className="flex items-center gap-2">
          <Bot className="h-3.5 w-3.5 text-accent" />
          Chat <span className="text-text-subtle text-[10px]">/ {projectName}</span>
        </span>
        <div className="flex items-center gap-2">
          {/* CLAUDE.md context indicator */}
          <span
            className="text-[9px] px-1.5 py-0.5 rounded bg-accent/10 border border-accent/30 text-accent flex items-center gap-1"
            title="CLAUDE.md is injected into the Codex captain prompt"
          >
            <CornerDownRight className="h-2 w-2" />
            CLAUDE.md
          </span>
          {/* Live cost meter */}
          {costSnapshot && (
            <span
              className={[
                "text-[10px] font-mono tabular-nums px-1.5 py-0.5 rounded border",
                costSnapshot.pct_used > 90
                  ? "bg-accent-hot/10 border-accent-hot/40 text-accent-hot"
                  : costSnapshot.pct_used > 70
                  ? "bg-accent-warn/10 border-accent-warn/40 text-accent-warn"
                  : "bg-bg-subtle border-line text-text-dim",
              ].join(" ")}
              title={`Spent $${costSnapshot.spent_usd.toFixed(4)} of $${costSnapshot.budget_usd.toFixed(2)}`}
            >
              ${costSnapshot.spent_usd.toFixed(3)} / ${costSnapshot.budget_usd.toFixed(0)}
            </span>
          )}
          {busy && (
            <span className="text-[10px] text-text-dim tabular-nums">{elapsedSec}s</span>
          )}
          <button
            onClick={clearAll}
            className="text-text-dim hover:text-accent-hot p-0.5"
            title="Clear history"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      </div>

      {/* Drag overlay */}
      {dragOver && (
        <div className="absolute inset-0 z-10 bg-accent/10 border-2 border-dashed border-accent/60 rounded-lg flex items-center justify-center pointer-events-none">
          <div className="text-center">
            <FileImage className="h-12 w-12 mx-auto text-accent mb-2" />
            <p className="text-sm text-accent font-semibold">Drop files here</p>
            <p className="text-xs text-text-dim">PNG / JPG / GLB — multiple supported</p>
          </div>
        </div>
      )}

      {/* Streaming control banner — always visible above the messages while
          a task is running. Big STOP button so the user can never miss it,
          and a live counter of tool calls so the user sees progress even if
          tokens haven't arrived yet. */}
      {busy && (
        <div className="border-b-2 border-accent/40 bg-gradient-to-r from-accent/10 to-purple-500/10 px-3 py-2 flex items-center gap-3 shrink-0 animate-pulse">
          <span className="relative flex h-2.5 w-2.5">
            <span className="absolute inline-flex h-full w-full rounded-full bg-accent opacity-75 animate-ping" />
            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-accent" />
          </span>
          <div className="flex-1 min-w-0">
            <div className="text-xs font-semibold text-accent">
              {(modelOptions.find((o) => o.value === model)?.label) ?? model} is working…
            </div>
            <div className="text-[10px] text-text-dim tabular-nums">
              {elapsedSec}s · {liveBufferRef.current.length} steps so far
              {activeTaskId && <span className="ml-2 opacity-60">task: {activeTaskId.slice(-6)}</span>}
            </div>
          </div>
          <button
            onClick={stop}
            className="px-4 py-1.5 rounded-md bg-err text-bg hover:bg-err/90 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider shadow-md"
            title="Abort the running task (Esc)"
          >
            <Square className="h-3.5 w-3.5 fill-current" />
            Stop
          </button>
        </div>
      )}

      {/* Asset plan — shows planned/generating/done sprites + assets that
          the captain is creating, so the user has a clear picture of what's being
          built and can see thumbnails as they land. */}
      {assetEvents.length > 0 && (
        <AssetPlanPanel events={assetEvents} />
      )}

      {/* Messages scroll area */}
      <div className="relative flex-1 min-h-0 flex flex-col">
        <div ref={scrollRef} className={["flex-1 overflow-y-auto p-3 space-y-3", compact ? "text-xs" : ""].join(" ")}>
          {msgs.length === 0 && <EmptyStateHint />}

          {(() => {
            // Only MOUNT the last CHAT_WINDOW messages. A long conversation must
            // not grow the DOM (and the ReactMarkdown parse trees per bubble)
            // without bound — that was the "longer I chat → more memory + lag"
            // leak. Older messages stay in state + localStorage + backend history;
            // they're just not in the DOM. Absolute index keeps each key + isLast
            // stable as the window slides, so React never re-mounts a live bubble.
            const CHAT_WINDOW = 50;
            const start = Math.max(0, msgs.length - CHAT_WINDOW);
            const rendered: ReactNode[] = [];
            if (start > 0) {
              rendered.push(
                <div key="older-hidden" className="text-center text-[11px] text-text-subtle py-1">
                  {start} earlier message{start === 1 ? "" : "s"} hidden — full history is saved
                </div>,
              );
            }
            for (let i = start; i < msgs.length; i++) {
              rendered.push(
                <MessageBubble
                  key={i}
                  msg={msgs[i]}
                  compact={compact}
                  isLast={i === msgs.length - 1 && busy}
                />,
              );
            }
            return rendered;
          })()}
        </div>

        {/* Jump-to-latest — shown only when the user has scrolled up. Clicking it
            re-sticks to the bottom. While scrolled up, streaming no longer drags
            the view down, so the user can read freely. */}
        {showJump && (
          <button
            onClick={() => {
              stickToBottomRef.current = true;
              setShowJump(false);
              scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
            }}
            className="absolute bottom-3 right-4 z-10 flex items-center gap-1 h-7 px-3 rounded-full bg-accent text-bg text-[11px] font-semibold shadow-lg hover:brightness-110 transition"
            title="Jump to the latest message"
          >
            ↓ Latest{busy ? " · live" : ""}
          </button>
        )}
      </div>

      {/* Model + skill row */}
      <div className="border-t border-line px-3 py-1.5 flex items-center gap-2 flex-wrap text-[10px]">
        <span className="text-text-dim">Model:</span>
        {modelOptions.map((opt) => (
          <button
            key={opt.value}
            onClick={() => setModel(opt.value)}
            className={[
              "px-1.5 py-0.5 rounded border transition-colors",
              model === opt.value
                ? `bg-accent/15 border-accent/50 ${opt.tint}`
                : "border-line text-text-dim hover:text-text",
            ].join(" ")}
            title={opt.hint}
          >
            {opt.label.replace("DeepSeek V4 ", "DS-")}
          </button>
        ))}
        <span className="text-text-dim mx-2">·</span>
        <SkillPicker
          skills={filteredSkills}
          selected={skillPrefix}
          onSelect={setSkillPrefix}
          open={skillPickerOpen}
          setOpen={setSkillPickerOpen}
        />
        {skillPrefix && (
          <button
            onClick={() => setSkillPrefix(null)}
            className="text-text-dim hover:text-accent-hot ml-0.5"
            title="Clear skill prefix"
          >
            <X className="h-2.5 w-2.5" />
          </button>
        )}
      </div>

      {/* Attachments preview */}
      {filePreviews.length > 0 && (
        <div className="border-t border-line px-3 py-2 flex flex-wrap gap-2 max-h-24 overflow-y-auto">
          {filePreviews.map((url, i) => (
            <div key={i} className="relative group">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={url}
                alt={files[i]?.name}
                className="h-12 w-12 object-cover rounded border border-line"
              />
              <button
                onClick={() => removeFile(i)}
                className="absolute -top-1 -right-1 h-4 w-4 rounded-full bg-err text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <X className="h-2.5 w-2.5" />
              </button>
            </div>
          ))}
          {uploadingAttachments && (
            <div className="text-[10px] text-text-dim self-center">Uploading...</div>
          )}
        </div>
      )}

      {/* Input row */}
      <div className="border-t border-line p-2 flex gap-2">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,.glb,.gltf,.fbx"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={busy}
          className="btn-ghost px-2 self-end disabled:opacity-50"
          title="Attach files"
        >
          <Paperclip className="h-4 w-4" />
        </button>
        <textarea
          ref={textareaRef}
          data-chat-textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onPaste={(e) => {
            // EXP-4 FIX: enable Ctrl+V paste of clipboard images
            // (Snipping Tool / Win+Shift+S / Print Screen workflows).
            // Iterates clipboardData.items; if any is an image type,
            // converts to File and pushes through the same addFiles()
            // pipeline as drag-drop / file picker. Falls through to
            // normal text paste if no image present.
            const items = e.clipboardData?.items;
            if (!items) return;
            const imageFiles: File[] = [];
            for (let i = 0; i < items.length; i++) {
              const it = items[i];
              if (it.kind === "file" && it.type.startsWith("image/")) {
                const blob = it.getAsFile();
                if (blob) {
                  // Give the pasted image a stable filename so the
                  // upload endpoint can persist it predictably.
                  const ts = Date.now();
                  const ext = blob.type.split("/")[1] || "png";
                  const named = new File(
                    [blob],
                    `clipboard-${ts}.${ext}`,
                    { type: blob.type },
                  );
                  imageFiles.push(named);
                }
              }
            }
            if (imageFiles.length > 0) {
              e.preventDefault();
              const dt = new DataTransfer();
              imageFiles.forEach((f) => dt.items.add(f));
              addFiles(dt.files);
            }
          }}
          onKeyDown={(e) => {
            // Guard against IME composition (Polish/CJK accented chars):
            // browsers fire Enter at composition end — preventDefault would
            // eat the accented character.
            const composing =
              (e.nativeEvent as KeyboardEvent).isComposing ||
              e.keyCode === 229;
            if (e.key === "Enter" && !e.shiftKey && !composing) {
              e.preventDefault();
              if (!busy) send();
            }
          }}
          placeholder={
            busy
              ? "Task running — press STOP above to abort, or type to queue your next message…"
              : files.length > 0
              ? `${files.length} attachment(s) — describe what to do with them...`
              : skillPrefix
              ? `Using ${skillPrefix} — describe your task...`
              : "Type a message — Enter to send, Shift+Enter for new line"
          }
          // No `disabled` while busy — user can still type their next message.
          // The Send button is disabled instead, and the floating STOP banner
          // is the canonical abort control.
          //
          // Sizing: min-height holds 2 rows (~52px); max-height is enforced by
          // the useLayoutEffect above. resize-y lets the user drag it taller
          // beyond the auto-grow cap for very long pastes.
          className="flex-1 resize-y bg-bg-subtle border border-line rounded-md px-3 py-2 text-sm focus:outline-none focus:border-accent/60 leading-5 transition-[border-color] duration-150"
          style={{ minHeight: "52px", overflowY: "hidden" }}
        />
        {/* Send / Stop — premium composer button
            Active:   solid accent fill, slight glow on hover, scale-down on press
            Disabled: muted fill + cursor-not-allowed, no glow
            Stop:     accent-hot fill to signal destructive intent
            Focus:    2px accent ring (global focus-visible rule covers this)        */}
        <button
          onClick={send}
          disabled={busy || (!input.trim() && files.length === 0)}
          aria-label={busy ? "Stop running task" : "Send message"}
          title={busy ? "Use the STOP button above to abort the running task" : "Send (Enter)"}
          className={[
            // Base geometry — rounded pill-ish, not a hard square
            "self-end flex items-center justify-center shrink-0",
            "h-9 w-9 rounded-lg",
            // Typography / icon colour
            "text-[var(--bg)] font-medium",
            // Transitions
            "transition-[background,box-shadow,opacity,transform] duration-150 ease-out",
            // Active press
            "active:scale-95",
            // Focus ring handled globally via focus-visible rule
            // Disabled state
            "disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-none disabled:scale-100",
            // Color intent: busy = hot (stop), else accent
            busy
              ? "bg-[var(--accent-hot)] hover:shadow-[0_0_0_3px_color-mix(in_oklab,var(--accent-hot)_25%,transparent)]"
              : (!input.trim() && files.length === 0)
                ? "bg-[var(--accent)]/50"
                : "bg-[var(--accent)] hover:brightness-110 hover:shadow-[0_0_0_3px_color-mix(in_oklab,var(--accent)_25%,transparent)]",
          ].join(" ")}
        >
          {busy
            ? <Square className="h-[14px] w-[14px] fill-current" />
            : <Send className="h-[15px] w-[15px] translate-x-px -translate-y-px" />
          }
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Message bubble + live event timeline
// ---------------------------------------------------------------------------

// Memoized so a streamed token (which only replaces the LAST message object,
// preserving every earlier message's identity) re-renders ONLY the streaming
// bubble — NOT the whole growing list. Without this, every token re-parsed the
// markdown of EVERY message (O(n²)) — the "longer I chat the more it lags" bug.
const MessageBubble = memo(MessageBubbleBase);

function MessageBubbleBase({ msg, compact, isLast }: { msg: Msg; compact: boolean; isLast: boolean }) {
  const isUser = msg.role === "user";
  const [menuOpen, setMenuOpen] = useState(false);
  const startedAt = useRef(Date.now());

  function copyMarkdown() {
    navigator.clipboard.writeText(msg.text || "");
    setMenuOpen(false);
  }
  function copyAsText() {
    // Strip markdown for plain text
    const plain = (msg.text || "")
      .replace(/```[\s\S]*?```/g, (m) => m.replace(/```/g, ""))
      .replace(/[*_`]/g, "");
    navigator.clipboard.writeText(plain);
    setMenuOpen(false);
  }

  // Render tool-call details aggregated by tool_use_id for compact display
  const toolPairs = useMemo(() => {
    if (!msg.liveEvents) return [] as Array<{ use: ChatStreamEventToolUse; result?: ChatStreamEventToolResult }>;
    const uses = msg.liveEvents.filter((e): e is ChatStreamEventToolUse => e.kind === "tool_use");
    const results = msg.liveEvents.filter((e): e is ChatStreamEventToolResult => e.kind === "tool_result");
    return uses.map((u) => ({
      use: u,
      result: results.find((r) => r.id === u.id),
    }));
  }, [msg.liveEvents]);

  const thoughts = msg.liveEvents?.filter((e) => e.kind === "thought") ?? [];

  return (
    <div
      className={["flex gap-2 group", isUser ? "flex-row-reverse" : ""].join(" ")}
      onContextMenu={(e) => {
        if (msg.role === "agent") {
          e.preventDefault();
          setMenuOpen(true);
        }
      }}
    >
      <div
        className={[
          "shrink-0 h-7 w-7 rounded-full flex items-center justify-center",
          isUser ? "bg-accent/20 text-accent" : "bg-line text-text-dim",
        ].join(" ")}
      >
        {isUser ? <User className="h-3.5 w-3.5" /> : <Bot className="h-3.5 w-3.5" />}
      </div>
      <div className={[
        // w-full + min-w-0 = bubble container fills the row up to 92% so
        // markdown/code blocks have a stable wrap target instead of
        // overflowing leftward under the side panel.
        "flex-1 max-w-[92%] min-w-0 flex flex-col gap-1 relative overflow-hidden",
        isUser ? "items-end" : ""
      ].join(" ")}>
        {/* Thoughts (italic, collapsed when next non-thought arrives) */}
        {thoughts.length > 0 && isLast && (
          <details className="bg-bg-subtle/50 border border-line/50 rounded px-2 py-1 text-[10px] text-text-dim w-full">
            <summary className="cursor-pointer flex items-center gap-1">
              <span className="text-accent">🤔</span>
              <span className="italic">Thinking ({thoughts.length})</span>
            </summary>
            <div className="mt-1 space-y-0.5 italic">
              {thoughts.slice(-6).map((t, i) =>
                t.kind === "thought" ? (
                  <div key={i} className="pl-2 border-l border-accent/30">
                    {t.text.slice(0, 400)}
                  </div>
                ) : null
              )}
            </div>
          </details>
        )}

        {/* Tool-call timeline (collapsed details blocks per call) */}
        {toolPairs.length > 0 && (
          <div className="space-y-1 w-full">
            {toolPairs.map(({ use, result }) => (
              <ToolCallBlock key={use.id} use={use} result={result} compact={compact} />
            ))}
          </div>
        )}

        {/* Main text bubble — rendered as markdown for agent, plain for user */}
        {msg.text && (
          <div
            className={[
              // `break-words` alone doesn't break inside long unbroken strings
              // (e.g. multi-line curl commands, base64 URLs) so they overflow
              // the bubble and clip behind the side-panel. Adding `break-all`
              // + explicit `overflow-wrap: anywhere` via the style prop forces
              // breaks anywhere when there is no whitespace anchor.
              "rounded-md px-2.5 py-1.5 break-all overflow-hidden min-w-0 w-full",
              compact ? "text-xs" : "text-sm",
              isUser
                ? "bg-accent/10 border border-accent/30"
                : "bg-bg-subtle border border-line",
            ].join(" ")}
            style={{ overflowWrap: "anywhere", wordBreak: "break-word" }}
          >
            {isUser ? (
              <div
                className="whitespace-pre-wrap break-all"
                style={{ overflowWrap: "anywhere" }}
              >
                {msg.text}
              </div>
            ) : (
              <MarkdownView text={msg.text} compact={compact} />
            )}
            {(msg.cost !== undefined && msg.cost > 0) && (
              <CostBadge cost={msg.cost} model={msg.model ?? null} />
            )}
          </div>
        )}

        {/* Attached images */}
        {msg.attachments && msg.attachments.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {msg.attachments.map((a, j) => (
              <div
                key={j}
                className="text-[10px] px-1.5 py-0.5 bg-bg-subtle border border-line rounded flex items-center gap-1"
                title={a.abs_path}
              >
                <FileImage className="h-2.5 w-2.5" />
                {a.filename}
              </div>
            ))}
          </div>
        )}

        {/* Live status when in-flight */}
        {isLast && msg.liveEvents && (
          <div className="text-[9px] text-text-subtle flex items-center gap-1">
            <span className="h-1 w-1 rounded-full bg-accent animate-pulse" />
            {msg.liveEvents.length} events · {Math.floor((Date.now() - startedAt.current) / 1000)}s
          </div>
        )}

        {/* Completed-turn meta — token + cost readout */}
        {msg.role === "agent" && !isLast && (msg.tokens || (msg.cost ?? 0) > 0) && (
          <div className="text-[9px] text-text-subtle flex items-center gap-1.5 mt-0.5 flex-wrap">
            {msg.tokens && (msg.tokens.in > 0 || msg.tokens.out > 0) && (
              <span title="input / output tokens">
                ↑{msg.tokens.in.toLocaleString()} ↓{msg.tokens.out.toLocaleString()} tokens
              </span>
            )}
            {(msg.cost ?? 0) > 0 && <span>· ${(msg.cost ?? 0).toFixed(4)}</span>}
            {msg.model && <span className="opacity-70">· {msg.model}</span>}
          </div>
        )}

        {/* Right-click menu */}
        {menuOpen && !isUser && (
          <div
            className="absolute top-full right-0 mt-1 z-30 bg-bg-panel border border-line rounded-md shadow-lg p-1 text-[10px] min-w-[140px]"
            onMouseLeave={() => setMenuOpen(false)}
          >
            <button
              onClick={copyMarkdown}
              className="w-full text-left px-2 py-1 hover:bg-bg-subtle rounded flex items-center gap-1.5"
            >
              <Copy className="h-2.5 w-2.5" />
              Copy markdown
            </button>
            <button
              onClick={copyAsText}
              className="w-full text-left px-2 py-1 hover:bg-bg-subtle rounded flex items-center gap-1.5"
            >
              <Copy className="h-2.5 w-2.5" />
              Copy as text
            </button>
            <button
              onClick={() => setMenuOpen(false)}
              className="w-full text-left px-2 py-1 hover:bg-bg-subtle rounded flex items-center gap-1.5 text-text-dim"
              title="Coming soon"
              disabled
            >
              <RotateCw className="h-2.5 w-2.5" />
              Re-run from here
            </button>
            <button
              onClick={() => setMenuOpen(false)}
              className="w-full text-left px-2 py-1 hover:bg-bg-subtle rounded flex items-center gap-1.5 text-text-dim"
              title="Coming soon"
              disabled
            >
              <GitBranch className="h-2.5 w-2.5" />
              Fork conversation
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Clickable file paths — turn inline `code` that is a file path (e.g.
// `.omc/state/Cat_Volleyball/design.md`) into a chip that opens the file in
// the OS editor (Notepad on Windows) via POST /api/fs/open.
// ---------------------------------------------------------------------------

const OPENABLE_FILE_EXT =
  /\.(md|markdown|txt|json|ya?ml|csv|log|tsx?|jsx?|mjs|cjs|py|css|scss|html?|xml|toml|ini|cfg|env|sh|bat|ps1)$/i;
// Doc-like files are worth making clickable even when mentioned as a BARE
// filename (no folder). Code/config files (package.json, main.ts) only become
// chips when they appear as a real path (with a slash) — avoids turning every
// prose mention of `package.json` into a misleading clickable chip.
const BARE_OK_EXT = /\.(md|markdown|txt|log)$/i;

/** True when an inline-code string looks like a file path we can open. */
function isOpenableFilePath(raw: string): boolean {
  const t = raw.trim();
  if (!t || t.length > 300 || t.includes("\n")) return false;
  if (!OPENABLE_FILE_EXT.test(t)) return false;
  // Real paths (.omc/.../design.md, C:\…\x.md) are always openable.
  if (/[\\/]/.test(t)) return true;
  // Bare filename (no folder): only doc-like files, and must be a clean token.
  return BARE_OK_EXT.test(t) && /^[\w.\-]+$/.test(t);
}

function FilePathChip({ path, children }: { path: string; children: React.ReactNode }) {
  const [state, setState] = useState<"idle" | "opening" | "error">("idle");
  return (
    <button
      type="button"
      onClick={async (e) => {
        e.preventDefault();
        setState("opening");
        try {
          await openFileInEditor(path);
          setState("idle");
        } catch {
          setState("error");
          setTimeout(() => setState("idle"), 2500);
        }
      }}
      title={
        state === "error"
          ? `Nie udało się otworzyć (plik nie istnieje?): ${path}`
          : `Otwórz w Notatniku: ${path}`
      }
      className={[
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[0.85em] font-mono align-baseline border transition-colors cursor-pointer",
        state === "error"
          ? "bg-red-500/10 border-red-500/50 text-red-400"
          : "bg-accent/10 hover:bg-accent/20 border-accent/40 hover:border-accent/70 text-accent",
      ].join(" ")}
    >
      {state === "opening" ? (
        <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
      ) : (
        <FileText className="h-3 w-3 shrink-0" />
      )}
      <span className="underline decoration-dotted underline-offset-2">{children}</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Markdown renderer with syntax highlighting + Bash special-case
// ---------------------------------------------------------------------------

function MarkdownView({ text, compact }: { text: string; compact: boolean }) {
  return (
    <div
      className={[
        "prose prose-invert max-w-none break-words",
        compact ? "prose-xs" : "prose-sm",
      ].join(" ")}
      style={{
        // Tailwind typography overrides for our color palette
        ["--tw-prose-body" as never]: "rgb(var(--text-rgb, 230 230 230))",
      } as React.CSSProperties}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code(props) {
            // The `inline` prop was removed in react-markdown v9; use `node`'s siblings instead
            const { className, children, ...rest } = props as { className?: string; children?: React.ReactNode };
            const match = /language-(\w+)/.exec(className || "");
            const lang = match?.[1] ?? "";
            const codeStr = String(children).replace(/\n$/, "");
            // Heuristic: short or no-language → render inline
            const looksInline = !lang && !codeStr.includes("\n");
            if (looksInline) {
              // File-path-looking inline code → clickable "open in Notepad" chip.
              if (isOpenableFilePath(codeStr)) {
                return <FilePathChip path={codeStr}>{children}</FilePathChip>;
              }
              return (
                <code
                  className="bg-bg/70 border border-line/60 rounded px-1 py-0.5 text-[0.85em] font-mono text-accent"
                  {...rest}
                >
                  {children}
                </code>
              );
            }
            return (
              <CodeBlock language={lang || "text"} code={codeStr} />
            );
          },
          a({ children, href }) {
            return (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent hover:underline"
              >
                {children}
              </a>
            );
          },
          p({ children }) {
            return <p className="my-1 leading-relaxed">{children}</p>;
          },
          ul({ children }) {
            return <ul className="my-1 ml-4 list-disc space-y-0.5">{children}</ul>;
          },
          ol({ children }) {
            return <ol className="my-1 ml-4 list-decimal space-y-0.5">{children}</ol>;
          },
          h1({ children }) {
            return <h1 className="text-base font-bold my-2">{children}</h1>;
          },
          h2({ children }) {
            return <h2 className="text-sm font-semibold my-1.5">{children}</h2>;
          },
          h3({ children }) {
            return <h3 className="text-xs font-semibold my-1 uppercase tracking-wider text-text-dim">{children}</h3>;
          },
          blockquote({ children }) {
            return (
              <blockquote className="border-l-2 border-accent/50 pl-2 my-1 text-text-dim">
                {children}
              </blockquote>
            );
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

function CodeBlock({ language, code }: { language: string; code: string }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }
  return (
    <div className="relative my-1.5 group/code">
      <div className="flex items-center justify-between text-[9px] uppercase tracking-wider text-text-dim bg-bg-subtle border border-line border-b-0 rounded-t px-2 py-0.5">
        <span className="flex items-center gap-1">
          <Terminal className="h-2.5 w-2.5" />
          {language}
        </span>
        <button
          onClick={copy}
          className="opacity-0 group-hover/code:opacity-100 transition-opacity hover:text-accent"
        >
          {copied ? "copied!" : "copy"}
        </button>
      </div>
      <SyntaxHighlighter
        language={language || "text"}
        style={vscDarkPlus as Record<string, React.CSSProperties>}
        customStyle={{
          margin: 0,
          padding: "0.5rem 0.75rem",
          fontSize: "11px",
          lineHeight: "1.4",
          borderRadius: "0 0 4px 4px",
          background: "rgba(0,0,0,0.4)",
        }}
        wrapLongLines={true}
      >
        {code}
      </SyntaxHighlighter>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tool-call collapsed block (Bash gets special-cased)
// ---------------------------------------------------------------------------

type ChatStreamEventToolUse = Extract<ChatStreamEvent, { kind: "tool_use" }>;
type ChatStreamEventToolResult = Extract<ChatStreamEvent, { kind: "tool_result" }>;

function ToolCallBlock({
  use,
  result,
  compact,
}: {
  use: ChatStreamEventToolUse;
  result?: ChatStreamEventToolResult;
  compact: boolean;
}) {
  const isBash = use.name === "Bash";
  let argsPreview = use.args_summary || "";
  // Parse args as JSON for nicer preview
  let parsedArgs: Record<string, unknown> | null = null;
  try {
    parsedArgs = JSON.parse(use.args_summary);
  } catch {
    parsedArgs = null;
  }

  if (parsedArgs) {
    if (isBash && typeof parsedArgs.command === "string") {
      argsPreview = parsedArgs.command;
    } else if (typeof parsedArgs.file_path === "string") {
      argsPreview = parsedArgs.file_path;
    } else if (typeof parsedArgs.pattern === "string") {
      argsPreview = parsedArgs.pattern;
    }
  }

  const statusIcon = !result ? (
    <Loader2 className="h-2.5 w-2.5 animate-spin text-text-dim" />
  ) : result.ok ? (
    <span className="text-accent">✓</span>
  ) : (
    <span className="text-err">✗</span>
  );

  return (
    <details
      className={[
        "bg-bg-subtle/60 border border-line rounded text-[10px] group/tool w-full overflow-hidden",
        compact ? "" : "",
      ].join(" ")}
    >
      <summary className="cursor-pointer px-2 py-1 flex items-center gap-1.5 hover:bg-bg-subtle">
        <ChevronRight className="h-2.5 w-2.5 text-text-dim group-open/tool:rotate-90 transition-transform" />
        {isBash ? (
          <Terminal className="h-2.5 w-2.5 text-accent shrink-0" />
        ) : (
          <Wrench className="h-2.5 w-2.5 text-accent shrink-0" />
        )}
        <span className="text-text shrink-0 font-mono">{use.name}</span>
        <span className="text-text-subtle truncate flex-1 min-w-0 font-mono" title={argsPreview}>
          {isBash ? `$ ${argsPreview.slice(0, 100)}` : argsPreview.slice(0, 100)}
        </span>
        {statusIcon}
      </summary>
      <div className="px-2 pb-2 space-y-1.5 text-[10px] font-mono">
        {parsedArgs && (
          <div>
            <div className="text-text-dim uppercase tracking-wider text-[8px] mt-1">
              Arguments
            </div>
            <pre className="bg-bg/60 border border-line/60 rounded p-1.5 overflow-x-auto whitespace-pre-wrap break-all">
              {JSON.stringify(parsedArgs, null, 2)}
            </pre>
          </div>
        )}
        {result && (
          <div>
            <div className="text-text-dim uppercase tracking-wider text-[8px]">
              Result {result.ok ? "" : "(error)"}
            </div>
            <pre
              className={[
                "border rounded p-1.5 overflow-x-auto whitespace-pre-wrap break-all max-h-48",
                result.ok ? "border-line/60 bg-bg/60" : "border-err/40 bg-err/5",
              ].join(" ")}
            >
              {result.result_summary || "(no output)"}
            </pre>
          </div>
        )}
      </div>
    </details>
  );
}

// ---------------------------------------------------------------------------
// Cost badge under each assistant message
// ---------------------------------------------------------------------------

function CostBadge({ cost, model }: { cost: number; model: string | null }) {
  return (
    <div className="mt-2 flex items-center gap-2 text-[9px] text-text-subtle border-t border-line/40 pt-1">
      <span className="font-mono">${cost.toFixed(4)}</span>
      <span>·</span>
      <span className="font-mono">{model ?? "?"}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty-state hint with collapsible keyboard shortcuts
// ---------------------------------------------------------------------------

function EmptyStateHint() {
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const quickActions = [
    { emoji: "🎨", title: "Generate a sprite", prompt: "/sprite-pipeline generate a pixel-art knight with idle, walk and attack animations at 64x64" },
    { emoji: "🗺️", title: "Make a tileset", prompt: "/tilemap-builder forest grass + path + water tiles, 32x32, 4x4 grid" },
    { emoji: "🎬", title: "Animate a sprite sheet", prompt: "Open the Animator tab and load my sprite sheet to preview + tune playback speed before exporting." },
    { emoji: "🧭", title: "Plan a game", prompt: "/2d-game-design I want to build a cozy farming sim" },
  ];
  return (
    <div className="max-w-2xl mx-auto py-12 px-6 text-center">
      <div className="inline-flex items-center justify-center h-16 w-16 rounded-2xl bg-gradient-to-br from-accent/20 to-purple-500/20 border border-accent/30 mb-4">
        <Sparkles className="h-8 w-8 text-accent" />
      </div>
      <h2 className="text-2xl font-semibold mb-2">Hi! What do we build today?</h2>
      <p className="text-text-dim text-sm mb-6">
        Pick a quick action below, or just describe your game idea.
        The selected captain orchestrates sprites, scenes, scripts, and animations.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-8 text-left">
        {quickActions.map((qa) => (
          <button
            key={qa.title}
            onClick={() => {
              window.dispatchEvent(
                new CustomEvent("chat:prefill", { detail: qa.prompt }),
              );
            }}
            className="group flex items-start gap-3 px-4 py-3 rounded-lg border border-line bg-bg-subtle hover:border-accent/60 hover:bg-accent/5 transition-colors"
          >
            <span className="text-2xl leading-none mt-0.5">{qa.emoji}</span>
            <div className="flex-1 min-w-0">
              <div className="font-medium text-sm">{qa.title}</div>
              <div className="text-[10px] text-text-subtle truncate group-hover:text-text-dim">
                {qa.prompt}
              </div>
            </div>
          </button>
        ))}
      </div>

      <button
        onClick={() => setShortcutsOpen((o) => !o)}
        className="text-[10px] text-text-dim hover:text-accent inline-flex items-center gap-1"
      >
        <Keyboard className="h-3 w-3" />
        Keyboard shortcuts
        <ChevronRight
          className={[
            "h-2.5 w-2.5 transition-transform",
            shortcutsOpen ? "rotate-90" : "",
          ].join(" ")}
        />
      </button>
      {shortcutsOpen && (
        <div className="mt-3 inline-grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5 text-[10px] text-text-dim items-center">
          <kbd className="kbd">Ctrl+K</kbd>
          <span>focus input</span>
          <kbd className="kbd">Ctrl+P</kbd>
          <span>command palette</span>
          <kbd className="kbd">Ctrl+B</kbd>
          <span>toggle side panel</span>
          <kbd className="kbd">Ctrl+J</kbd>
          <span>toggle bottom dock</span>
          <kbd className="kbd">Esc</kbd>
          <span>abort current request</span>
          <kbd className="kbd">Enter</kbd>
          <span>send</span>
          <kbd className="kbd">Shift+Enter</kbd>
          <span>newline</span>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Skill picker dropdown
// ---------------------------------------------------------------------------

function SkillPicker({
  skills,
  selected,
  onSelect,
  open,
  setOpen,
}: {
  skills: SkillInfo[];
  selected: string | null;
  onSelect: (v: string | null) => void;
  open: boolean;
  setOpen: (v: boolean) => void;
}) {
  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className={[
          "px-1.5 py-0.5 rounded border flex items-center gap-1",
          selected
            ? "bg-accent-hot/15 border-accent-hot/50 text-accent-hot"
            : "border-line text-text-dim hover:text-text",
        ].join(" ")}
        title={selected ? `Active skill: ${selected}` : "Pick a skill to prepend to your message"}
      >
        <Wand2 className="h-2.5 w-2.5" />
        {selected ? selected : "Skill"}
      </button>
      {open && (
        <div className="absolute bottom-full mb-1 left-0 w-80 max-h-72 overflow-y-auto bg-bg-panel border border-line rounded-md shadow-lg z-20 p-1">
          <div className="text-[9px] uppercase text-text-subtle px-2 py-1 tracking-wider">
            {skills.length} skills available · click to use
          </div>
          {skills.map((s) => (
            <button
              key={s.path}
              onClick={() => {
                onSelect(`/${s.name}`);
                setOpen(false);
              }}
              className="w-full text-left p-1.5 hover:bg-bg-subtle rounded text-[10px]"
            >
              <div className="flex items-center gap-1">
                <span className="text-accent font-medium">/{s.name}</span>
                <span
                  className={[
                    "ml-auto text-[9px] px-1 py-0.5 rounded",
                    s.source === "project"
                      ? "bg-accent/10 text-accent"
                      : "bg-bg-subtle text-text-dim",
                  ].join(" ")}
                >
                  {s.source}
                </span>
              </div>
              <div className="text-text-subtle leading-tight line-clamp-2 mt-0.5">
                {s.description}
              </div>
            </button>
          ))}
          {skills.length === 0 && (
            <div className="p-3 text-center text-text-subtle text-[10px]">No skills found.</div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Asset plan tracking — derived from local agent CLI tool_use / tool_result events.
// ---------------------------------------------------------------------------

interface AssetEvent {
  toolId: string;
  category: "sprite" | "asset" | "unity" | "skill";
  toolName: string;
  label: string;
  prompt: string;
  unityPath?: string;
  status: "planning" | "running" | "done" | "failed";
  startedAt: number;
  resultSummary?: string;
}

const SPRITE_TOOL_NAMES = [
  "generate_character_sprite",
  "generate_character_spritesheet",
  "sprite-pipeline",
  "pixel-art-pipeline",
];
const ASSET_TOOL_NAMES = [
  "generate_background",
  "generate_tileset",
  "generate_ui_element",
  "generate_particle_fx",
  "asset-pipeline",
  "tilemap-builder",
];
const UNITY_HINTS = [
  "unity",
  "import_sprite",
  "create_script",
  "create_scene",
  "create_gameobject",
  "add_component",
];

function classifyAssetEvent(evt: ChatStreamEvent & { kind: "tool_use" }): AssetEvent | null {
  const name = evt.name || "";
  const args = parseToolArgs(evt.args_summary);
  const prompt: string =
    args?.description ||
    args?.prompt ||
    args?.input?.prompt ||
    args?.contents?.slice?.(0, 120) ||
    "";
  const unityPath: string | undefined =
    args?.project_relative_path ||
    args?.dest_path ||
    args?.output_path;

  const lower = name.toLowerCase();
  let category: AssetEvent["category"] | null = null;
  let label = name;

  if (SPRITE_TOOL_NAMES.some((s) => lower.includes(s.toLowerCase()))) {
    category = "sprite";
    label = "Sprite generation";
  } else if (ASSET_TOOL_NAMES.some((s) => lower.includes(s.toLowerCase()))) {
    category = "asset";
    label = "Asset generation";
  } else if (UNITY_HINTS.some((s) => lower.includes(s))) {
    category = "unity";
    label = humanizeUnityTool(name);
  } else if (lower.startsWith("/") || lower.includes("skill")) {
    category = "skill";
    label = name;
  } else {
    return null;
  }

  return {
    toolId: evt.id || `${name}-${Date.now()}`,
    category,
    toolName: name,
    label,
    prompt: typeof prompt === "string" ? prompt : JSON.stringify(prompt).slice(0, 160),
    unityPath,
    status: "running",
    startedAt: Date.now(),
  };
}

function humanizeUnityTool(name: string): string {
  return name
    .replace(/^unity[_-]?/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function parseToolArgs(summary: string | undefined): Record<string, any> | null {
  if (!summary) return null;
  try {
    return JSON.parse(summary);
  } catch {
    return null;
  }
}

function upsertAssetEvent(prev: AssetEvent[], next: AssetEvent): AssetEvent[] {
  const idx = prev.findIndex((p) => p.toolId === next.toolId);
  if (idx >= 0) {
    const copy = [...prev];
    copy[idx] = { ...copy[idx], ...next };
    return copy;
  }
  return [...prev, next];
}

function AssetPlanPanel({ events }: { events: AssetEvent[] }) {
  const done = events.filter((e) => e.status === "done").length;
  const failed = events.filter((e) => e.status === "failed").length;
  const running = events.filter((e) => e.status === "running").length;
  // Rough cost estimate for visualisation — assumes 1K-low/medium tier.
  const estCost = (running + done) * 0.10;

  async function cancelAllRunning() {
    if (!confirm(`Cancel ${running} running generation${running === 1 ? "" : "s"}? Credits already paid to the upstream cannot be refunded.`)) return;
    try {
      const { useQueue } = await import("@/store/queue");
      const { cancelQueueTask } = await import("@/lib/api");
      const qstate = useQueue.getState();
      const active = qstate.order
        .map((id) => qstate.tasks[id])
        .filter((t) => t && (t.status === "started" || t.status === "progress" || t.status === "queued"));
      await Promise.all(active.map((t) => cancelQueueTask(t.id).catch(() => undefined)));
      const { refreshKittyBalance } = await import("@/components/CreditsBadge");
      refreshKittyBalance();
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="border-b border-line bg-bg-subtle/40 px-3 py-2 shrink-0 max-h-[40%] overflow-y-auto">
      <div className="flex items-center gap-2 mb-1.5 flex-wrap">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-text-dim">
          Asset plan
        </span>
        <span className="text-[10px] text-text-subtle">
          {events.length} {events.length === 1 ? "step" : "steps"}
          {done > 0 && <span className="text-accent ml-1">· {done} done</span>}
          {running > 0 && <span className="text-accent-warn ml-1">· {running} running</span>}
          {failed > 0 && <span className="text-err ml-1">· {failed} failed</span>}
          {estCost > 0 && (
            <span className="text-text-dim ml-1 font-mono">
              · ≈ ${estCost.toFixed(2)}
            </span>
          )}
        </span>
        {running > 0 && (
          <button
            onClick={cancelAllRunning}
            className="ml-auto text-[10px] px-2 py-0.5 rounded border border-err/40 text-err hover:bg-err/10"
            title="Stop every in-flight sprite/asset generation"
          >
            Cancel running
          </button>
        )}
      </div>
      <ul className="space-y-1">
        {events.map((e) => (
          <AssetRow key={e.toolId} e={e} />
        ))}
      </ul>
    </div>
  );
}

function AssetRow({ e }: { e: AssetEvent }) {
  const statusIcon =
    e.status === "done" ? "✓"
    : e.status === "failed" ? "✗"
    : e.status === "running" ? "•"
    : "…";
  const statusColor =
    e.status === "done" ? "text-accent"
    : e.status === "failed" ? "text-err"
    : e.status === "running" ? "text-accent-warn animate-pulse"
    : "text-text-dim";
  const catTint =
    e.category === "sprite" ? "bg-purple-500/10 border-purple-500/30 text-purple-300"
    : e.category === "asset" ? "bg-cyan-500/10 border-cyan-500/30 text-cyan-300"
    : e.category === "unity" ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-300"
    : "bg-bg-subtle border-line text-text-dim";
  return (
    <li className="flex items-start gap-2 text-[11px] py-0.5">
      <span className={`font-mono text-sm shrink-0 w-3 ${statusColor}`}>{statusIcon}</span>
      <span className={`shrink-0 text-[9px] px-1.5 py-0.5 rounded border uppercase tracking-wider ${catTint}`}>
        {e.category}
      </span>
      <div className="flex-1 min-w-0">
        <div className="font-medium text-text truncate" title={e.toolName}>{e.label}</div>
        {e.prompt && (
          <div className="text-[10px] text-text-subtle truncate" title={e.prompt}>
            {e.prompt}
          </div>
        )}
        {e.unityPath && (
          <div className="text-[10px] text-emerald-400 font-mono truncate" title={e.unityPath}>
            → {e.unityPath}
          </div>
        )}
        {e.status === "failed" && e.resultSummary && (
          <div className="text-[10px] text-err truncate" title={e.resultSummary}>
            {e.resultSummary}
          </div>
        )}
      </div>
    </li>
  );
}
