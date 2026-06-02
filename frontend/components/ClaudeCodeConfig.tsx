"use client";

/**
 * ClaudeCodeConfig — dedicated Claude Code configuration panel.
 *
 * Shows everything user needs to understand and tweak Claude CLI behavior:
 *   - CLI status (path, version, subscription vs API mode)
 *   - Permission mode (bypassPermissions badge)
 *   - Default model (Sonnet/Opus selector — persisted)
 *   - Settings files (.claude/settings.local.json, CLAUDE.md) — open in OS editor
 *   - Skills counter (project + global)
 *   - Working directory
 *
 * Lives in the Settings tab as a dedicated section above the API keys.
 */

import { useEffect, useState } from "react";
import {
  Brain, CheckCircle2, XCircle, FileText, ExternalLink, RefreshCw,
  Shield, FolderOpen, Cpu, Sparkles,
} from "lucide-react";
import { BACKEND, testEndpoint } from "@/lib/api";

interface ClaudeStatus {
  ok: boolean;
  cli_path?: string;
  version?: string;
  mode?: "subscription" | "api";
  detail?: string;
}

interface SkillCount {
  project: number;
  global: number;
}

export default function ClaudeCodeConfig() {
  const [status, setStatus] = useState<ClaudeStatus | null>(null);
  const [skillCount, setSkillCount] = useState<SkillCount>({ project: 0, global: 0 });
  const [defaultModel, setDefaultModel] = useState<string>(() =>
    typeof window !== "undefined"
      ? localStorage.getItem("superagent2d.default_model") ?? "claude_sonnet"
      : "claude_sonnet"
  );
  const [busy, setBusy] = useState(false);

  async function refresh() {
    setBusy(true);
    try {
      const [anthropic, skills] = await Promise.all([
        testEndpoint("anthropic").catch(() => null),
        fetch(`${BACKEND}/api/chat/skills`).then((r) => r.json()).catch(() => []),
      ]);
      if (anthropic) {
        setStatus({
          ok: anthropic.ok,
          cli_path: anthropic.extra?.cli_path as string | undefined,
          version: anthropic.extra?.version as string | undefined,
          mode: (anthropic.extra?.mode as "subscription" | "api" | undefined) ?? "subscription",
          detail: anthropic.detail,
        });
      }
      if (Array.isArray(skills)) {
        const project = skills.filter((s: { source?: string }) => s.source === "project").length;
        const global = skills.filter((s: { source?: string }) => s.source === "global").length;
        setSkillCount({ project, global });
      }
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  function setModel(m: string) {
    setDefaultModel(m);
    localStorage.setItem("superagent2d.default_model", m);
    window.dispatchEvent(new CustomEvent("chat:default-model", { detail: m }));
  }

  return (
    <div className="panel">
      <div className="panel-header flex items-center justify-between">
        <span className="flex items-center gap-2">
          <Brain className="h-4 w-4 text-accent" />
          Claude Code
        </span>
        <button
          onClick={refresh}
          disabled={busy}
          className="btn btn-ghost text-[10px] flex items-center gap-1"
          title="Re-probe CLI + MCP + skills"
        >
          <RefreshCw className={`h-3 w-3 ${busy ? "animate-spin" : ""}`} /> Refresh
        </button>
      </div>

      <div className="p-3 space-y-3">
        {/* === CLI Status === */}
        <div className="grid grid-cols-2 gap-3">
          <StatusCard
            icon={<Cpu className="h-3.5 w-3.5" />}
            label="CLI status"
            value={status?.ok ? "Installed" : "Not detected"}
            ok={status?.ok}
            hint={status?.version ? `v${status.version}` : status?.detail}
          />
          <StatusCard
            icon={<Shield className="h-3.5 w-3.5" />}
            label="Mode"
            value={status?.mode === "api" ? "API key" : "Subscription"}
            ok={true}
            hint={status?.mode === "subscription" ? "$0 per call" : "Pay-per-token"}
          />
          <StatusCard
            icon={<Sparkles className="h-3.5 w-3.5" />}
            label="Skills available"
            value={`${skillCount.project + skillCount.global}`}
            ok={skillCount.project + skillCount.global > 0}
            hint={`${skillCount.project} project + ${skillCount.global} global`}
          />
        </div>

        {/* === Permission mode === */}
        <div className="bg-bg-subtle border border-line rounded p-2.5">
          <div className="flex items-center justify-between text-xs">
            <span className="flex items-center gap-1.5 text-text-dim">
              <Shield className="h-3 w-3" /> Permission mode
            </span>
            <span className="px-2 py-0.5 rounded-full bg-accent/20 text-accent text-[10px] font-mono font-semibold">
              bypassPermissions
            </span>
          </div>
          <p className="text-[10px] text-text-subtle mt-1.5">
            Claude never asks for confirmation — fully autonomous. Configured in{" "}
            <code className="font-mono text-[9px]">.claude/settings.local.json</code>.
          </p>
        </div>

        {/* === Default model === */}
        <div>
          <div className="text-xs text-text-dim mb-1.5 flex items-center gap-1.5">
            <Brain className="h-3 w-3" /> Default model for new chats
          </div>
          <div className="grid grid-cols-3 gap-2">
            {([
              { id: "claude_sonnet", label: "Sonnet 4.7", desc: "Balanced — default" },
              { id: "claude_opus", label: "Opus 4.8", desc: "Most powerful" },
              { id: "deepseek_v4", label: "DeepSeek V4", desc: "Cheap fallback" },
            ] as const).map((m) => (
              <button
                key={m.id}
                onClick={() => setModel(m.id)}
                className={`text-left px-2.5 py-2 rounded border transition-colors ${
                  defaultModel === m.id
                    ? "border-accent bg-accent/10 text-text"
                    : "border-line bg-bg hover:bg-bg-subtle text-text-dim"
                }`}
              >
                <div className="text-xs font-semibold">{m.label}</div>
                <div className="text-[9px] text-text-subtle mt-0.5">{m.desc}</div>
              </button>
            ))}
          </div>
        </div>

        {/* === Config files === */}
        <div>
          <div className="text-xs text-text-dim mb-1.5 flex items-center gap-1.5">
            <FileText className="h-3 w-3" /> Configuration files
          </div>
          <div className="space-y-1">
            <FileRow
              label="CLAUDE.md"
              path="CLAUDE.md"
              desc="Auto-loaded project context (skills, conventions, API surface)"
            />
            <FileRow
              label="settings.local.json"
              path=".claude/settings.local.json"
              desc="Permission mode + tool whitelist"
            />
            <FileRow
              label="Skills directory"
              path=".claude/skills"
              desc={`${skillCount.project} project skills`}
            />
            <FileRow
              label="Working directory"
              path="."
              desc="Claude CLI cwd for all subprocesses"
              icon={<FolderOpen className="h-3 w-3" />}
            />
          </div>
        </div>

        {/* === CLI path === */}
        {status?.cli_path && (
          <div className="bg-bg-subtle border border-line rounded p-2 text-[10px]">
            <div className="text-text-dim mb-0.5">CLI binary</div>
            <code className="font-mono text-text break-all">{status.cli_path}</code>
          </div>
        )}
      </div>
    </div>
  );
}

function StatusCard({
  icon, label, value, ok, hint,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  ok?: boolean;
  hint?: string;
}) {
  return (
    <div className="bg-bg-subtle border border-line rounded p-2.5">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] text-text-dim uppercase tracking-wider flex items-center gap-1">
          {icon} {label}
        </span>
        {ok === true && <CheckCircle2 className="h-3 w-3 text-accent" />}
        {ok === false && <XCircle className="h-3 w-3 text-err" />}
      </div>
      <div className="text-sm font-semibold">{value}</div>
      {hint && <div className="text-[9px] text-text-subtle mt-0.5">{hint}</div>}
    </div>
  );
}

function FileRow({
  label, path, desc, icon,
}: {
  label: string;
  path: string;
  desc: string;
  icon?: React.ReactNode;
}) {
  const [opened, setOpened] = useState(false);
  // Reveal the file/folder in the OS file manager. `path` is repo-relative;
  // the backend (/api/fs/open) resolves it against the project root, so this
  // works on any machine with no hard-coded path.
  async function openInOS() {
    try {
      await fetch(`${BACKEND}/api/fs/open`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, reveal: true }),
      });
      setOpened(true);
      setTimeout(() => setOpened(false), 1400);
    } catch {
      /* backend not reachable — ignore */
    }
  }
  return (
    <div className="flex items-start justify-between gap-2 px-2 py-1.5 hover:bg-bg-subtle rounded border border-transparent hover:border-line transition-colors">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 text-xs">
          {icon ?? <FileText className="h-3 w-3 text-text-dim" />}
          <span className="font-semibold">{label}</span>
        </div>
        <div className="text-[9px] text-text-subtle font-mono break-all mt-0.5">{path}</div>
        <div className="text-[9px] text-text-dim mt-0.5">{desc}</div>
      </div>
      <button
        onClick={openInOS}
        className="btn btn-ghost text-[9px] shrink-0"
        title="Open in file explorer"
      >
        {opened ? (
          <CheckCircle2 className="h-3 w-3 text-accent" />
        ) : (
          <ExternalLink className="h-3 w-3" />
        )}
      </button>
    </div>
  );
}
