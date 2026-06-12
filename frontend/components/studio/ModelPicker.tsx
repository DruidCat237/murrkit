"use client";

/**
 * ModelPicker — a VISIBLE, labeled model control for the Build view.
 *
 * The chat panel keeps its model in internal state and (historically) exposed
 * it only as a tiny unlabeled pill row at the bottom of the panel. Prompt-first
 * users need the model choice to be a first-class, obvious control, so this
 * renders a labeled segmented switch and drives ChatPanel through the
 * `chat:set-model` window event. It listens to `chat:model-changed` to stay in
 * sync with in-panel clicks and the panel's initial value.
 */

import { useEffect, useState } from "react";
import { Cpu } from "lucide-react";
import type { ChatModel } from "@/lib/types";
import { useSession } from "@/store/session";
import { getConfig } from "@/lib/api";

const OPTIONS: { value: ChatModel; label: string; hint: string }[] = [
  { value: "deepseek_v4", label: "DeepSeek", hint: "Cheapest · log triage" },
  { value: "claude_sonnet", label: "Sonnet", hint: "Fast · balanced" },
  { value: "claude_opus", label: "Fable 5", hint: "Default · best reasoning" },
];

function optionsForAgent(agentCli: "claude" | "codex") {
  if (agentCli === "codex") {
    return OPTIONS.map((opt) => {
      if (opt.value === "claude_sonnet") return { ...opt, label: "Codex Balanced" };
      if (opt.value === "claude_opus") return { ...opt, label: "Codex Heavy" };
      return opt;
    });
  }
  return OPTIONS;
}

export default function ModelPicker({ className = "" }: { className?: string }) {
  const activeModel = useSession((s) => s.activeModel);
  const setActiveModel = useSession((s) => s.setActiveModel);
  // Local mirror so the control reflects ChatPanel's source of truth even
  // before the session store is hydrated.
  const [model, setModel] = useState<ChatModel>(activeModel);
  const [agentCli, setAgentCli] = useState<"claude" | "codex">("claude");

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

  useEffect(() => {
    function onChanged(e: Event) {
      const detail = (e as CustomEvent).detail as { model?: ChatModel };
      if (detail?.model) setModel(detail.model);
    }
    window.addEventListener("chat:model-changed", onChanged);
    return () => window.removeEventListener("chat:model-changed", onChanged);
  }, []);

  function pick(next: ChatModel) {
    setModel(next);
    setActiveModel(next);
    window.dispatchEvent(new CustomEvent("chat:set-model", { detail: { model: next } }));
  }

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-text-dim">
        <Cpu className="h-3.5 w-3.5 text-accent" />
        Model
      </span>
      <div
        role="radiogroup"
        aria-label="Chat model"
        className="flex items-center rounded-lg border border-line bg-bg-subtle p-0.5"
      >
        {optionsForAgent(agentCli).map((opt) => {
          const selected = model === opt.value;
          return (
            <button
              key={opt.value}
              role="radio"
              aria-checked={selected}
              onClick={() => pick(opt.value)}
              title={opt.hint}
              className={[
                "px-2.5 py-1 text-xs font-medium rounded-md transition-all duration-150",
                selected
                  ? "bg-accent/15 text-accent shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--accent)_45%,transparent)]"
                  : "text-text-dim hover:text-text",
              ].join(" ")}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
