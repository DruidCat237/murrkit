"use client";

import { useState } from "react";
import { ExternalLink, Keyboard } from "lucide-react";

const SHORTCUTS: { combo: string; description: string }[] = [
  { combo: "Cmd/Ctrl + K",        description: "Open command palette" },
  { combo: "Cmd/Ctrl + Shift + P", description: "Same — palette" },
  { combo: "Cmd/Ctrl + B",        description: "Toggle side panel" },
  { combo: "Cmd/Ctrl + J",        description: "Toggle bottom panel" },
  { combo: "Cmd/Ctrl + Alt + B",  description: "Toggle right panel" },
  { combo: "Cmd/Ctrl + W",        description: "Close active tab" },
  { combo: "Cmd/Ctrl + \\",       description: "Split center tab vertically" },
  { combo: "Cmd/Ctrl + 1",        description: "Switch theme: Dark" },
  { combo: "Cmd/Ctrl + 2",        description: "Switch theme: Light" },
  { combo: "Cmd/Ctrl + 3",        description: "Switch theme: RPG Maker" },
  { combo: "Cmd/Ctrl + 4",        description: "Switch theme: Synthwave" },
  { combo: "Esc",                  description: "Close palette / drawer / modal" },
];

const RESOURCES = [
  { label: "User Guide", path: "docs/USER_GUIDE.md" },
  { label: "Architecture v2", path: "docs/ARCHITECTURE_v2.md" },
  { label: "Cat-Tac-Toe Tutorial", path: "docs/CAT_TAC_TOE_TUTORIAL.md" },
  { label: "Keyboard Shortcuts", path: "docs/KEYBOARD_SHORTCUTS.md" },
  { label: "Changelog", path: "docs/CHANGELOG.md" },
];

export default function HelpPanel() {
  const [tab, setTab] = useState<"shortcuts" | "resources">("shortcuts");

  return (
    <div className="p-3 text-xs">
      <div className="flex gap-1 mb-3">
        <button
          className={`btn btn-ghost text-xs ${tab === "shortcuts" ? "bg-bg-subtle" : ""}`}
          onClick={() => setTab("shortcuts")}
        >
          <Keyboard className="h-3 w-3 mr-1 inline" /> Shortcuts
        </button>
        <button
          className={`btn btn-ghost text-xs ${tab === "resources" ? "bg-bg-subtle" : ""}`}
          onClick={() => setTab("resources")}
        >
          <ExternalLink className="h-3 w-3 mr-1 inline" /> Docs
        </button>
      </div>

      {tab === "shortcuts" && (
        <ul className="space-y-1.5">
          {SHORTCUTS.map((s) => (
            <li key={s.combo} className="flex items-start gap-2">
              <span className="kbd flex-shrink-0 min-w-[120px] text-center">{s.combo}</span>
              <span className="text-text-dim flex-1">{s.description}</span>
            </li>
          ))}
        </ul>
      )}

      {tab === "resources" && (
        <ul className="space-y-1.5">
          {RESOURCES.map((r) => (
            <li key={r.path}>
              <div className="text-text-dim">{r.label}</div>
              <code className="text-[10px] text-text-subtle font-mono">{r.path}</code>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
