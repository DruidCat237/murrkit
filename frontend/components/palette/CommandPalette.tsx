"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Search, Cpu, Hash, FileCode, MessageSquare, Wand2, Film, Boxes,
  Sparkles, Sun, Moon, Star, Play, Box, Code2,
} from "lucide-react";
import { useSession } from "@/store/session";
import { useLayout } from "@/store/layout";
import Drawer from "../dock/Drawer";
import { listSkills } from "@/lib/api";
import type { SkillInfo } from "@/lib/types";

interface PaletteItem {
  id: string;
  label: string;
  hint?: string;
  group: "actions" | "tabs" | "skills" | "themes";
  icon: React.ReactNode;
  run: () => void;
}

export default function CommandPalette() {
  const open = useSession((s) => s.paletteOpen);
  const close = useSession((s) => s.closePalette);
  const openTab = useLayout((s) => s.openOrFocusCenterTab);
  const setTheme = useLayout((s) => s.setTheme);
  const openBottom = useLayout((s) => s.openOrFocusBottomTab);

  const [q, setQ] = useState("");
  const [selected, setSelected] = useState(0);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [skillsError, setSkillsError] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQ("");
    setSelected(0);
    setTimeout(() => inputRef.current?.focus(), 30);
    setSkillsError(false);
    listSkills().then(setSkills).catch(() => setSkillsError(true));
  }, [open]);

  const items = useMemo<PaletteItem[]>(() => {
    const list: PaletteItem[] = [
      // Actions
      { id: "act-chat",     group: "actions", icon: <MessageSquare className="h-4 w-4 text-accent" />, label: "Open Chat", run: () => openTab("chat") },
      { id: "act-gen",      group: "actions", icon: <Wand2 className="h-4 w-4 text-accent" />, label: "Open Generate panel", run: () => openTab("generate") },
      { id: "act-lib",      group: "actions", icon: <Box className="h-4 w-4 text-accent" />, label: "Open Asset Library", run: () => openTab("library") },
      { id: "act-code",     group: "actions", icon: <Code2 className="h-4 w-4 text-accent" />, label: "Open Code Editor", run: () => openTab("code", { title: "Code" }) },
      { id: "act-anim",     group: "actions", icon: <Film className="h-4 w-4 text-accent" />, label: "Open Animator", run: () => openTab("animator") },
      { id: "act-scene",    group: "actions", icon: <Boxes className="h-4 w-4 text-accent" />, label: "Open Phaser Game", run: () => openTab("scene") },
      { id: "act-queue",    group: "actions", icon: <Cpu className="h-4 w-4 text-accent" />, label: "Show Generation Queue", run: () => openBottom("gen-queue") },
      { id: "act-logs",     group: "actions", icon: <FileCode className="h-4 w-4 text-accent" />, label: "Show Logs", run: () => openBottom("logs") },
      { id: "act-problems", group: "actions", icon: <Hash className="h-4 w-4 text-accent" />, label: "Show Problems (Phaser Console)", run: () => openBottom("unity-console") },

      // Themes
      { id: "theme-dark",  group: "themes", icon: <Moon className="h-4 w-4 text-text-dim" />, label: "Theme: Dark", run: () => setTheme("dark") },
      { id: "theme-light", group: "themes", icon: <Sun className="h-4 w-4 text-text-dim" />, label: "Theme: Light", run: () => setTheme("light") },
      { id: "theme-rpg",   group: "themes", icon: <Star className="h-4 w-4 text-accent-warn" />, label: "Theme: RPG Maker (retro purple)", run: () => setTheme("rpg") },
      { id: "theme-synth", group: "themes", icon: <Star className="h-4 w-4 text-accent-hot" />, label: "Theme: Synthwave", run: () => setTheme("synthwave") },
    ];

    for (const s of skills) {
      list.push({
        id: `skill-${s.name}`,
        group: "skills",
        icon: <Play className="h-4 w-4 text-accent-warn" />,
        label: `/${s.name}`,
        hint: s.description ?? s.source,
        run: () => {
          openTab("chat");
          // attach skill prefix into chat via custom event
          window.dispatchEvent(new CustomEvent("chat:skill-pick", { detail: { skill: s.name } }));
        },
      });
    }

    return list;
  }, [openTab, openBottom, setTheme, skills]);

  const filtered = useMemo(() => {
    if (!q.trim()) return items;
    const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
    return items
      .map((it) => ({
        item: it,
        score: scoreItem(it, tokens),
      }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.item);
  }, [items, q]);

  function runSelected() {
    const item = filtered[selected];
    if (!item) return;
    item.run();
    close();
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) => Math.min(filtered.length - 1, s + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) => Math.max(0, s - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      runSelected();
    } else if (e.key === "Escape") {
      close();
    }
  }

  // Group filtered items
  const grouped = useMemo(() => {
    const out: Record<string, PaletteItem[]> = { actions: [], tabs: [], skills: [], themes: [] };
    filtered.forEach((it) => out[it.group].push(it));
    return out;
  }, [filtered]);

  const groupOrder: PaletteItem["group"][] = ["actions", "skills", "themes", "tabs"];

  return (
    <Drawer open={open} onClose={close} side="center" className="max-w-2xl">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-line">
        <Search className="h-4 w-4 text-text-dim shrink-0" />
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => { setQ(e.target.value); setSelected(0); }}
          onKeyDown={onKey}
          placeholder="Search actions, files, skills…"
          className="palette-input"
          aria-label="Command palette query"
        />
        <kbd className="kbd">Esc</kbd>
      </div>
      <div className="max-h-[520px] overflow-y-auto">
        {filtered.length === 0 && (
          <div className="p-6 text-center text-text-subtle text-sm">
            No matches. Try a different query.
          </div>
        )}
        {skillsError && (
          <div className="px-3 py-1.5 text-[11px] text-accent-warn bg-bg-subtle border-b border-line">
            Skills unavailable — backend not reachable, so /skill commands are hidden.
          </div>
        )}
        {groupOrder.map((g) =>
          grouped[g].length === 0 ? null : (
            <div key={g}>
              <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-text-subtle bg-bg-subtle">
                {g}
              </div>
              {grouped[g].map((it) => {
                const idx = filtered.findIndex((x) => x.id === it.id);
                return (
                  <div
                    key={it.id}
                    className={`palette-item ${idx === selected ? "active" : ""}`}
                    onMouseEnter={() => setSelected(idx)}
                    onClick={() => { it.run(); close(); }}
                  >
                    <span className="shrink-0">{it.icon}</span>
                    <span className="flex-1 truncate">{it.label}</span>
                    {it.hint && <span className="ml-auto text-[10px] text-text-subtle truncate max-w-[180px]">{it.hint}</span>}
                  </div>
                );
              })}
            </div>
          )
        )}
      </div>
      <div className="px-3 py-2 text-[10px] text-text-subtle border-t border-line flex items-center gap-3">
        <span><kbd className="kbd">↑↓</kbd> navigate</span>
        <span><kbd className="kbd">↵</kbd> select</span>
        <span><kbd className="kbd">Esc</kbd> close</span>
      </div>
    </Drawer>
  );
}

function scoreItem(it: PaletteItem, tokens: string[]): number {
  const hay = `${it.label} ${it.hint ?? ""}`.toLowerCase();
  let score = 0;
  for (const tok of tokens) {
    if (!hay.includes(tok)) return 0;
    score += 5;
    if (it.label.toLowerCase().startsWith(tok)) score += 4;
  }
  if (it.group === "actions") score += 1;
  return score;
}
