"use client";

/**
 * SettingsPanel — read/write `.env`, test API endpoints, see budget.
 */

import { useEffect, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  RefreshCw,
  Save,
  TestTube,
} from "lucide-react";
import {
  getConfig,
  reloadBackend,
  testEndpoint,
  updateConfig,
} from "@/lib/api";
import type { ConfigField, ConfigSnapshot, TestResult } from "@/lib/types";
import ClaudeCodeConfig from "@/components/ClaudeCodeConfig";

type TestKey = "kitty" | "deepseek" | "elevenlabs" | "anthropic";

// Per-field overrides for friendlier copy in the secret-key inputs.
const FIELD_OVERRIDES: Record<string, { label?: string; help?: string }> = {
  KITTY_APP_TOKEN: {
    label: "Kitty App code",
    help: "Paste your Kitty App code from druidcat.app/dashboard — used for every image generation.",
  },
};

const SECTIONS: { title: string; keys: string[] }[] = [
  {
    title: "Kitty App credits (image generation)",
    keys: ["KITTY_APP_TOKEN"],
  },
  {
    title: "DeepSeek V4 Flash",
    keys: ["DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL", "DEEPSEEK_MODEL"],
  },
  {
    title: "Google Gemini (Vision QA)",
    keys: ["GEMINI_API_KEY", "GEMINI_MODEL"],
  },
  {
    title: "ElevenLabs (Audio)",
    keys: ["ELEVENLABS_API_KEY"],
  },
  {
    title: "Anthropic Claude (CLI orchestrator)",
    keys: ["ANTHROPIC_API_KEY"],
  },
  {
    title: "Budget & Backend",
    keys: ["BUDGET_LIMIT_USD", "BACKEND_HOST", "BACKEND_PORT", "PUBLIC_BACKEND_URL", "LOG_LEVEL"],
  },
];

export default function SettingsPanel() {
  const [snapshot, setSnapshot] = useState<ConfigSnapshot | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<TestKey | null>(null);
  const [testResults, setTestResults] = useState<Partial<Record<TestKey, TestResult>>>({});
  const [reloadNote, setReloadNote] = useState<string | null>(null);

  async function refresh() {
    const s = await getConfig();
    setSnapshot(s);
    setEdits({});
  }

  useEffect(() => {
    refresh().catch(() => undefined);
  }, []);

  function setEdit(key: string, value: string) {
    setEdits((prev) => ({ ...prev, [key]: value }));
  }

  async function save(): Promise<boolean> {
    if (Object.keys(edits).length === 0) return true;
    setSaving(true);
    try {
      await updateConfig(edits);
      await refresh();
      return true;
    } catch (e) {
      alert(`Save failed: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function runTest(which: TestKey) {
    // Auto-save unsaved edits first — otherwise Test would hit the OLD .env value
    if (Object.keys(edits).length > 0) {
      const ok = await save();
      if (!ok) return;
    }
    setTesting(which);
    try {
      const r = await testEndpoint(which);
      setTestResults((prev) => ({ ...prev, [which]: r }));
    } catch (e) {
      setTestResults((prev) => ({
        ...prev,
        [which]: {
          ok: false,
          detail: e instanceof Error ? e.message : String(e),
          elapsed_ms: 0,
          extra: {},
        },
      }));
    } finally {
      setTesting(null);
    }
  }

  // Cmd+S / Ctrl+S to save
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        if (Object.keys(edits).length > 0) void save();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edits]);

  async function doReload() {
    const r = await reloadBackend();
    setReloadNote(r.note);
  }

  if (!snapshot) {
    return (
      <div className="h-full flex items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-accent" />
      </div>
    );
  }

  const fieldsByKey: Record<string, ConfigField> = Object.fromEntries(
    snapshot.fields.map((f) => [f.key, f])
  );

  const editCount = Object.keys(edits).length;
  const hasUnsaved = editCount > 0;

  return (
    <div className="h-full flex flex-col">
      <div className="flex-1 min-h-0 overflow-auto">
        <div className="max-w-3xl mx-auto p-6 space-y-4 pb-24">
      <div className="flex items-center gap-2">
        <KeyRound className="h-5 w-5 text-accent" />
        <h2 className="text-lg font-semibold">Settings &amp; API Config</h2>
        <span className="text-xs text-text-subtle ml-2 font-mono">
          {snapshot.env_file_path.split(/[\\/]/).pop()}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={refresh}
            className="btn border border-line text-xs flex items-center gap-1"
            title="Reload values from .env on disk"
          >
            <RefreshCw className="h-3 w-3" />
            Reload from .env
          </button>
          <button
            onClick={doReload}
            className="btn border border-line text-xs flex items-center gap-1"
            title="Best-effort hint for restarting backend"
          >
            Reload backend
          </button>
        </div>
      </div>

      {reloadNote && (
        <div className="panel p-3 text-xs text-accent-warn border-accent-warn/40 bg-accent-warn/5">
          {reloadNote}
        </div>
      )}

      {/* Budget meter */}
      <div className="panel p-3 flex items-center gap-3">
        <div className="text-xs text-text-dim">Budget:</div>
        <div className="flex-1 h-2 bg-bg-subtle rounded-full overflow-hidden">
          <div
            className="h-full bg-accent"
            style={{
              width: `${Math.min(
                100,
                (snapshot.budget_spent_usd / Math.max(0.01, snapshot.budget_limit_usd)) * 100
              ).toFixed(1)}%`,
            }}
          />
        </div>
        <div className="text-xs font-mono tabular-nums">
          ${snapshot.budget_spent_usd.toFixed(4)} / ${snapshot.budget_limit_usd.toFixed(2)}
        </div>
      </div>

      {/* Claude Code — dedicated section (richer than just API key field) */}
      <ClaudeCodeConfig />

      {/* Sections */}
      {SECTIONS.map((section) => (
        <div key={section.title} className="panel">
          <div className="panel-header flex items-center justify-between">
            <span>{section.title}</span>
            {sectionTestKey(section.title) && (
              <button
                onClick={() => runTest(sectionTestKey(section.title)!)}
                disabled={testing === sectionTestKey(section.title)}
                className="text-[10px] px-1.5 py-0.5 rounded bg-accent/10 border border-accent/30 text-accent hover:bg-accent/20 flex items-center gap-1"
              >
                {testing === sectionTestKey(section.title) ? (
                  <Loader2 className="h-2.5 w-2.5 animate-spin" />
                ) : (
                  <TestTube className="h-2.5 w-2.5" />
                )}
                Test
              </button>
            )}
          </div>
          <div className="p-3 space-y-2">
            {section.keys.map((k) => {
              const f = fieldsByKey[k];
              if (!f) return null;
              return (
                <FieldRow
                  key={k}
                  field={f}
                  editValue={edits[k]}
                  setEditValue={(v) => setEdit(k, v)}
                  revealed={!!revealed[k]}
                  toggleReveal={() =>
                    setRevealed((p) => ({ ...p, [k]: !p[k] }))
                  }
                />
              );
            })}
            {(() => {
              const tk = sectionTestKey(section.title);
              if (!tk) return null;
              const tr = testResults[tk];
              if (!tr) return null;
              return (
                <div
                  className={[
                    "mt-2 text-xs p-2 rounded border flex items-start gap-2",
                    tr.ok
                      ? "bg-accent/5 border-accent/30 text-accent"
                      : "bg-err/5 border-err/30 text-err",
                  ].join(" ")}
                >
                  {tr.ok ? (
                    <CheckCircle2 className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                  ) : (
                    <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                  )}
                  <div className="flex-1 break-words">
                    <div>{tr.detail}</div>
                    <div className="text-[10px] text-text-subtle mt-0.5">
                      {tr.elapsed_ms}ms
                    </div>
                  </div>
                </div>
              );
            })()}
          </div>
        </div>
      ))}
        </div>
      </div>

      {/* Sticky save bar — always visible, glows amber when there are unsaved edits */}
      <div
        className={[
          "shrink-0 border-t-2 px-6 py-3 flex items-center gap-3 transition-colors",
          hasUnsaved
            ? "border-accent-warn bg-accent-warn/10"
            : "border-line bg-bg-panel/95 backdrop-blur",
        ].join(" ")}
      >
        {hasUnsaved && (
          <span className="h-2 w-2 rounded-full bg-accent-warn animate-pulse shrink-0" />
        )}
        <div className="text-sm">
          {hasUnsaved ? (
            <span className="text-accent-warn font-medium">
              {editCount} unsaved change{editCount === 1 ? "" : "s"}
            </span>
          ) : (
            <span className="text-text-subtle">No unsaved changes</span>
          )}
        </div>
        {hasUnsaved && (
          <button
            onClick={() => setEdits({})}
            className="text-xs text-text-dim hover:text-text underline-offset-2 hover:underline"
          >
            Discard
          </button>
        )}
        <span className="ml-auto text-[10px] text-text-subtle font-mono mr-1">
          {hasUnsaved ? "Ctrl+S" : ""}
        </span>
        <button
          onClick={save}
          disabled={saving || !hasUnsaved}
          className={[
            "text-sm flex items-center gap-2 px-5 py-2 rounded-md font-semibold transition-colors shadow-sm",
            hasUnsaved
              ? "bg-accent text-bg hover:bg-accent/90 ring-2 ring-accent/40"
              : "bg-bg-subtle text-text-subtle cursor-not-allowed",
          ].join(" ")}
        >
          {saving ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Save className="h-4 w-4" />
          )}
          {saving ? "Saving…" : hasUnsaved ? `Save .env (${editCount})` : "Saved"}
        </button>
      </div>
    </div>
  );
}

function sectionTestKey(title: string): TestKey | null {
  if (title.includes("Kitty")) return "kitty";
  if (title.includes("DeepSeek")) return "deepseek";
  if (title.includes("ElevenLabs")) return "elevenlabs";
  if (title.includes("Claude") || title.includes("Anthropic")) return "anthropic";
  return null;
}

function FieldRow({
  field,
  editValue,
  setEditValue,
  revealed,
  toggleReveal,
}: {
  field: ConfigField;
  editValue: string | undefined;
  setEditValue: (v: string) => void;
  revealed: boolean;
  toggleReveal: () => void;
}) {
  const isSecret = field.kind === "secret";
  const currentValue = editValue ?? "";
  // Display value: for secrets, show *** unless revealed
  const inputType = isSecret && !revealed ? "password" : "text";

  const override = FIELD_OVERRIDES[field.key];
  const displayLabel = override?.label ?? field.label;

  return (
    <div className="grid grid-cols-12 gap-2 items-start">
      <div className="col-span-4 pt-1.5">
        <div className="text-sm font-medium">{displayLabel}</div>
        {override?.help && (
          <div className="text-[10px] text-text-subtle mt-0.5">{override.help}</div>
        )}
      </div>
      <div className="col-span-7">
        <div className="flex gap-1">
          <input
            type={inputType}
            value={currentValue}
            onChange={(e) => setEditValue(e.target.value)}
            placeholder={
              isSecret
                ? field.is_set
                  ? "•••• (set — type to overwrite)"
                  : "(not set)"
                : field.value || field.default
            }
            className="flex-1 bg-bg-subtle border border-line rounded-md px-2 py-1 text-xs font-mono focus:outline-none focus:border-accent"
          />
          {isSecret && (
            <button
              onClick={toggleReveal}
              className="px-1.5 text-text-dim hover:text-text"
              title={revealed ? "Hide" : "Reveal"}
            >
              {revealed ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
            </button>
          )}
        </div>
        {!isSecret && field.value && field.value !== field.default && (
          <div className="text-[9px] text-text-subtle mt-0.5">
            current: <span className="font-mono">{field.value}</span>
          </div>
        )}
      </div>
      <div className="col-span-1 flex items-center gap-1 pt-2">
        {editValue !== undefined && editValue !== "" ? (
          <span
            className="text-[10px] px-1.5 py-0.5 rounded bg-accent-warn/20 border border-accent-warn/40 text-accent-warn font-medium animate-pulse"
            title="Unsaved — Ctrl+S to save"
          >
            ●
          </span>
        ) : field.is_set ? (
          <span
            className="text-[10px] px-1.5 py-0.5 rounded bg-accent/10 border border-accent/30 text-accent"
            title="Set in .env"
          >
            ✓
          </span>
        ) : null}
      </div>
    </div>
  );
}
