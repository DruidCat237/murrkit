"use client";

import { Palette } from "lucide-react";
import { useState } from "react";
import { useLayout } from "@/store/layout";
import type { ThemeName } from "@/lib/types";

const THEMES: { name: ThemeName; label: string; swatch: string[] }[] = [
  { name: "dark",      label: "Dark",      swatch: ["#171a25", "#5fe3c1", "#ff5e8a"] },
  { name: "light",     label: "Light",     swatch: ["#ffffff", "#1d9b7a", "#d83466"] },
  { name: "rpg",       label: "RPG Maker", swatch: ["#2d1d52", "#ffb454", "#ff5ea6"] },
  { name: "synthwave", label: "Synthwave", swatch: ["#3c096c", "#ff00ff", "#00ffff"] },
];

export default function ThemeSwitcher() {
  const theme = useLayout((s) => s.theme);
  const setTheme = useLayout((s) => s.setTheme);
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="btn btn-ghost p-1.5"
        aria-label={`Theme: ${theme}`}
        title="Switch theme"
      >
        <Palette className="h-4 w-4" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} aria-hidden="true" />
          <div className="absolute right-0 mt-1 z-40 panel shadow-elev min-w-[180px]">
            <div className="px-3 py-2 text-[10px] uppercase tracking-wider text-text-dim border-b border-line">
              Theme
            </div>
            {THEMES.map((t) => (
              <button
                key={t.name}
                onClick={() => { setTheme(t.name); setOpen(false); }}
                className={`w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-bg-subtle ${theme === t.name ? "bg-bg-subtle" : ""}`}
              >
                <div className="flex gap-0.5">
                  {t.swatch.map((c) => (
                    <span key={c} className="block w-3 h-3 rounded-sm" style={{ background: c }} />
                  ))}
                </div>
                <span className="text-xs">{t.label}</span>
                {theme === t.name && <span className="ml-auto text-accent text-xs">●</span>}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
