"use client";

import { useEffect, useState } from "react";
import {
  ArrowRight,
  CheckCircle2,
  ExternalLink,
  KeyRound,
  Loader2,
  RefreshCw,
  Sparkles,
  TerminalSquare,
  XCircle,
} from "lucide-react";
import { getConfig, testEndpoint, updateConfig } from "@/lib/api";
import { useSession } from "@/store/session";

type AgentCli = "claude" | "codex";

const AGENT_COPY: Record<AgentCli, {
  title: string;
  binary: string;
  body: string;
  commands: string;
  docsHref: string;
  docsLabel: string;
  modeLabel: string;
}> = {
  claude: {
    title: "Claude Code CLI — the captain",
    binary: "claude",
    body: "Install and sign in once. A Claude Pro/Max subscription works, or an Anthropic API key.",
    commands: "npm install -g @anthropic-ai/claude-code\nclaude        # sign in, then /exit",
    docsHref: "https://claude.com/claude-code",
    docsLabel: "Claude Code docs",
    modeLabel: "Claude Code",
  },
  codex: {
    title: "Codex CLI — the captain",
    binary: "codex",
    body: "Open Codex Desktop and sign in once, or use the Codex CLI login flow.",
    commands: "codex --version\ncodex login   # only if Codex is not signed in yet",
    docsHref: "https://openai.com/codex/",
    docsLabel: "Codex docs",
    modeLabel: "Codex",
  },
};

/**
 * FirstRunSetup — one-time guided setup gate (shown over the whole app).
 *
 * Surfaces the BARE MINIMUM to run murrkit and walks the user through it:
 *   1. Local agent CLI — Claude Code by default, or Codex if selected.
 *   2. A Kitty API token — image generation (paste + verify, saved to .env)
 *
 * Already configured? It probes once and dismisses silently (no nagging).
 * Backend not up yet? It quietly retries, then stays out of the way.
 * Re-openable any time from Settings → API keys. No secret values are ever
 * shown — only "set / not set" status comes from the backend.
 */
export default function FirstRunSetup() {
  const hydrated = useSession((s) => s.hydrated);
  const onboardingDone = useSession((s) => s.onboardingDone);
  const setOnboardingDone = useSession((s) => s.setOnboardingDone);

  const [open, setOpen] = useState(false);
  const [agentCli, setAgentCli] = useState<AgentCli>("claude");
  const [agentOk, setAgentOk] = useState<boolean | null>(null);
  const [agentDetail, setAgentDetail] = useState("");
  const [kittySet, setKittySet] = useState<boolean | null>(null);
  const [kittyOk, setKittyOk] = useState<boolean | null>(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState<"" | "agent" | "kitty">("");

  // First-mount decision. Only OPEN the gate once we actually know the backend
  // state and the minimum is missing. Retry a few times so a still-booting
  // backend doesn't trigger a false "needs setup".
  useEffect(() => {
    if (!hydrated) return;
    // `?setup` in the URL force-opens the gate so it can be re-run any time,
    // even when already configured.
    const forced =
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).has("setup");
    if (onboardingDone && !forced) return;
    let alive = true;
    (async () => {
      for (let attempt = 0; attempt < 4; attempt++) {
        const cfg = await getConfig().catch(() => null);
        if (!alive) return;
        if (cfg) {
          const configuredAgent = cfg.fields.find((f) => f.key === "MURRKIT_AGENT_CLI");
          const nextAgent = configuredAgent?.value === "codex" ? "codex" : "claude";
          setAgentCli(nextAgent);
          const agent = await testEndpoint("anthropic").catch(() => null);
          if (!alive) return;
          const kitty = cfg.fields.find((f) => f.key === "KITTY_APP_TOKEN");
          const kSet = !!kitty?.is_set;
          const aOk = !!agent?.ok;
          setKittySet(kSet);
          setAgentOk(aOk);
          setAgentDetail(agent?.detail ?? "");
          if (kSet && aOk && !forced) setOnboardingDone(true);
          else setOpen(true);
          return;
        }
        await new Promise((r) => setTimeout(r, 1500)); // backend booting — retry
      }
    })();
    return () => {
      alive = false;
    };
  }, [hydrated, onboardingDone, setOnboardingDone]);

  async function setAgent(next: AgentCli) {
    setAgentCli(next);
    setBusy("agent");
    try {
      await updateConfig({ MURRKIT_AGENT_CLI: next }).catch(() => null);
      window.dispatchEvent(new CustomEvent("murrkit:agent-cli-changed", { detail: { agent: next } }));
      const r = await testEndpoint("anthropic").catch(() => null);
      setAgentOk(!!r?.ok);
      setAgentDetail(r?.detail ?? "");
    } finally {
      setBusy("");
    }
  }

  async function recheckAgent() {
    setBusy("agent");
    const r = await testEndpoint("anthropic").catch(() => null);
    setAgentOk(!!r?.ok);
    setAgentDetail(r?.detail ?? "");
    setBusy("");
  }

  async function saveKitty() {
    const v = token.trim();
    if (!v) return;
    setBusy("kitty");
    try {
      await updateConfig({ KITTY_APP_TOKEN: v }).catch(() => null);
      const r = await testEndpoint("kitty").catch(() => null);
      setKittySet(true);
      setKittyOk(!!r?.ok);
      setToken("");
    } finally {
      setBusy("");
    }
  }

  function finish() {
    setOnboardingDone(true);
    setOpen(false);
  }

  if (!open) return null;
  const selectedCopy = AGENT_COPY[agentCli];
  const minimumMet = agentOk === true && kittySet === true;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="w-full max-w-2xl max-h-[92vh] overflow-y-auto rounded-2xl border border-line bg-bg shadow-2xl">
        {/* Header */}
        <div className="px-6 pt-6 pb-4 border-b border-line">
          <div className="flex items-center gap-2 text-accent">
            <Sparkles className="h-5 w-5" />
            <span className="text-xs font-semibold uppercase tracking-widest text-text-dim">
              Welcome to murrkit
            </span>
          </div>
          <h1 className="mt-2 text-2xl font-bold text-text">
            Two things and you&apos;re building games.
          </h1>
          <p className="mt-1 text-sm text-text-dim">
            murrkit is the orchestrator — it plugs into the AI brain and the image model you bring.
            This is the <span className="text-text font-medium">whole minimum</span>:
          </p>
        </div>

        {/* Steps */}
        <div className="p-6 space-y-4">
          {/* STEP 1 — local agent */}
          <StepCard n={1} icon={<TerminalSquare className="h-4 w-4" />} title={selectedCopy.title} ok={agentOk}>
            <div
              role="radiogroup"
              aria-label="Local agent CLI"
              className="mb-3 grid grid-cols-2 gap-2"
            >
              {(["claude", "codex"] as const).map((option) => {
                const selected = agentCli === option;
                return (
                  <button
                    key={option}
                    type="button"
                    onClick={() => setAgent(option)}
                    disabled={busy === "agent"}
                    className={`text-left px-3 py-2 rounded border transition-colors ${
                      selected
                        ? "border-accent bg-accent/10 text-text"
                        : "border-line bg-bg-subtle text-text-dim hover:text-text"
                    }`}
                  >
                    <div className="text-xs font-semibold">{AGENT_COPY[option].modeLabel}</div>
                    <div className="text-[10px] text-text-subtle mt-0.5">
                      {option === "claude" ? "Original upstream route" : "Optional Codex route"}
                    </div>
                  </button>
                );
              })}
            </div>
            <p className="text-xs text-text-dim leading-relaxed">
              The agent that designs &amp; writes your game. murrkit spawns the{" "}
              <code className="px-1 rounded bg-bg-subtle font-mono">{selectedCopy.binary}</code> binary locally.
              {" "}{selectedCopy.body}
            </p>
            <pre className="mt-2 text-[11px] bg-bg-subtle border border-line rounded p-2 overflow-x-auto font-mono text-text whitespace-pre">
{selectedCopy.commands}
            </pre>
            {agentDetail && (
              <div className="mt-1 text-[10px] font-mono text-text-subtle truncate">{agentDetail}</div>
            )}
            <div className="mt-2 flex items-center gap-3">
              <button onClick={recheckAgent} className="btn btn-ghost text-[11px]" disabled={busy === "agent"}>
                {busy === "agent" ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                Re-check
              </button>
              <a
                href={selectedCopy.docsHref}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[11px] text-accent hover:underline inline-flex items-center gap-1"
              >
                {selectedCopy.docsLabel} <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          </StepCard>

          {/* STEP 2 — Kitty token */}
          <StepCard n={2} icon={<KeyRound className="h-4 w-4" />} title="Kitty API token — image generation" ok={kittySet}>
            <p className="text-xs text-text-dim leading-relaxed">
              Turns prompts into sprite sheets — one token, no Google/OpenAI setup. Stored locally in{" "}
              <code className="px-1 rounded bg-bg-subtle font-mono">.env</code>, sent only to Kitty.
            </p>
            <ol className="mt-2 text-[11px] text-text-dim list-decimal list-inside space-y-0.5">
              <li>
                Open{" "}
                <a
                  href="https://druidcat.app/dashboard"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent hover:underline inline-flex items-center gap-0.5"
                >
                  druidcat.app/dashboard <ExternalLink className="h-2.5 w-2.5" />
                </a>
              </li>
              <li>Sign in (or create a free account) &amp; top up a little credit</li>
              <li>
                Copy your <span className="font-mono">kitty_…</span> App token
              </li>
            </ol>
            {kittySet ? (
              <div className="mt-2 text-[11px] inline-flex items-center gap-1 text-accent">
                <CheckCircle2 className="h-3.5 w-3.5" /> Token saved
                {kittyOk === false && (
                  <span className="text-err ml-1">— but the verify call failed, double-check it</span>
                )}
              </div>
            ) : (
              <div className="mt-2 flex items-center gap-2">
                <input
                  type="password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="kitty_…"
                  className="flex-1 px-2 py-1.5 text-xs rounded border border-line bg-bg-subtle font-mono outline-none focus:border-accent"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") saveKitty();
                  }}
                />
                <button
                  onClick={saveKitty}
                  disabled={!token.trim() || busy === "kitty"}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded bg-accent text-black text-[11px] font-medium hover:opacity-90 disabled:opacity-40"
                >
                  {busy === "kitty" ? <Loader2 className="h-3 w-3 animate-spin" /> : "Save & verify"}
                </button>
              </div>
            )}
          </StepCard>

          {/* Optional keys note */}
          <div className="text-[11px] text-text-subtle leading-relaxed border-t border-line pt-3">
            <span className="text-text-dim font-medium">Optional later:</span> a DeepSeek key (cheap code triage) and a
            Gemini key (vision compare-gate) sharpen quality — add them any time in{" "}
            <span className="text-text-dim">Settings → API keys</span>. Not needed to start.
          </div>

          {/* Chrome MCP tip */}
          <div className="text-[11px] text-text-dim bg-accent/5 border border-accent/30 rounded-lg p-3 leading-relaxed">
            <span className="font-medium text-text">Double control:</span> use the browser/playtest tooling with your selected
            captain, then ask it <span className="italic">&ldquo;launch murrkit in Chrome and show me the dashboard&rdquo;</span>.
            The same murrkit rules, imagination step, and verification gates apply to both Claude Code and Codex.
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-line flex items-center justify-between gap-3">
          <button onClick={finish} className="text-[11px] text-text-subtle hover:text-text-dim">
            Skip for now
          </button>
          <button
            onClick={finish}
            disabled={!minimumMet}
            className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold transition-colors ${
              minimumMet
                ? "bg-accent text-black hover:opacity-90"
                : "bg-bg-subtle text-text-subtle cursor-not-allowed"
            }`}
          >
            {minimumMet ? "Enter murrkit" : "Choose an agent and add Kitty to continue"}
            <ArrowRight className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

function StepCard({
  n,
  icon,
  title,
  ok,
  children,
}: {
  n: number;
  icon: React.ReactNode;
  title: string;
  ok: boolean | null;
  children: React.ReactNode;
}) {
  return (
    <div className={`rounded-xl border p-4 ${ok ? "border-accent/40 bg-accent/5" : "border-line bg-bg-panel"}`}>
      <div className="flex items-center gap-2">
        <span
          className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${
            ok ? "bg-accent text-black" : "bg-bg-subtle text-text-dim"
          }`}
        >
          {n}
        </span>
        <span className="text-text-dim">{icon}</span>
        <span className="text-sm font-semibold text-text flex-1">{title}</span>
        {ok === true ? (
          <span className="text-accent inline-flex items-center gap-1 text-[11px] font-medium">
            <CheckCircle2 className="h-4 w-4" /> Ready
          </span>
        ) : ok === false ? (
          <span className="text-err inline-flex items-center gap-1 text-[11px] font-medium">
            <XCircle className="h-4 w-4" /> Needed
          </span>
        ) : (
          <Loader2 className="h-4 w-4 animate-spin text-text-subtle" />
        )}
      </div>
      <div className="mt-2 pl-8">{children}</div>
    </div>
  );
}
