"use client";

import { useHotkeys } from "@/hooks/useHotkeys";
import { useLayout } from "@/store/layout";
import { useSession } from "@/store/session";

/**
 * Renders nothing — just installs global hotkeys.
 *  Cmd+K              -> open command palette
 *  Cmd+B              -> toggle side panel
 *  Cmd+J              -> toggle bottom panel
 *  Cmd+Alt+B          -> toggle right panel
 *  Cmd+W              -> close active center tab
 *  Cmd+\\             -> split active center tab vertically
 *  Cmd+1..4           -> switch theme
 *  Esc                -> close command palette / drawer (handled per-modal)
 */
export default function KeyboardShortcuts() {
  const togglePalette = useSession((s) => s.togglePalette);
  const toggleSide = useLayout((s) => s.toggleSidePanel);
  const toggleBottom = useLayout((s) => s.toggleBottomDock);
  const toggleRight = useLayout((s) => s.toggleRightPanel);
  const removeTab = useLayout((s) => s.removeCenterTab);
  const activeId = useLayout((s) => s.activeCenterTabId);
  const split = useLayout((s) => s.splitCenterTab);
  const setTheme = useLayout((s) => s.setTheme);

  useHotkeys("mod+k", () => togglePalette(), { inInputs: true });
  useHotkeys("mod+shift+p", () => togglePalette(), { inInputs: true });
  useHotkeys("mod+b", () => toggleSide());
  useHotkeys("mod+j", () => toggleBottom());
  useHotkeys("mod+alt+b", () => toggleRight());
  useHotkeys("mod+w", () => { if (activeId) removeTab(activeId); });
  useHotkeys("mod+\\", () => { if (activeId) split(activeId, "vertical"); });
  useHotkeys("mod+1", () => setTheme("dark"));
  useHotkeys("mod+2", () => setTheme("light"));
  useHotkeys("mod+3", () => setTheme("rpg"));
  useHotkeys("mod+4", () => setTheme("synthwave"));

  return null;
}
