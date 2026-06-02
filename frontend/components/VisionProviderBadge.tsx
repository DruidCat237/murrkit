"use client";

/**
 * VisionProviderBadge — title-bar pill showing the active vision provider
 * + transport mode. Click → focuses the Vision Reviews tab so the user can
 * see the timeline of every call Claude has made.
 *
 * Polls /api/vision/providers every 30s (transport rarely changes — only
 * flips when the user toggles SUPERAGENT_GEMINI_VIA_KITTY).
 *
 * Surface naming: never expose cloud-platform names or the upstream provider.
 */

import { useCallback, useEffect, useState } from "react";
import { Eye, Sparkles } from "lucide-react";
import { BACKEND } from "@/lib/api";
import { useLayout } from "@/store/layout";
import type { VisionProvidersInfo } from "@/lib/types";

export default function VisionProviderBadge() {
  const [info, setInfo] = useState<VisionProvidersInfo | null>(null);
  const [todayCount, setTodayCount] = useState<number | null>(null);
  const openOrFocusCenterTab = useLayout((s) => s.openOrFocusCenterTab);

  const poll = useCallback(async () => {
    try {
      const r = await fetch(`${BACKEND}/api/vision/providers`, {
        signal: AbortSignal.timeout(2000),
      });
      if (!r.ok) {
        setInfo(null);
        return;
      }
      setInfo(await r.json());
    } catch {
      setInfo(null);
    }
  }, []);

  // Lightweight history ping — just to show a quick "n today" count next to
  // the provider. We don't store entries here, just the size.
  const pollHistory = useCallback(async () => {
    try {
      // 'default' is the canonical project — most consults land here unless
      // Claude tagged a specific project. Good enough for an at-a-glance pill.
      const r = await fetch(
        `${BACKEND}/api/vision/history?project=default&limit=200`,
        { signal: AbortSignal.timeout(2000) },
      );
      if (!r.ok) {
        setTodayCount(null);
        return;
      }
      const data = await r.json();
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const cutoff = today.getTime() / 1000;
      const n = (data.entries ?? []).filter(
        (e: { ts: number }) => e.ts >= cutoff,
      ).length;
      setTodayCount(n);
    } catch {
      setTodayCount(null);
    }
  }, []);

  useEffect(() => {
    poll();
    pollHistory();
    const t1 = setInterval(poll, 30_000);
    const t2 = setInterval(pollHistory, 8_000);
    return () => {
      clearInterval(t1);
      clearInterval(t2);
    };
  }, [poll, pollHistory]);

  if (!info) {
    // Fail-soft: render nothing rather than a broken pill if the endpoint
    // hasn't responded yet. Avoids title-bar flicker on first paint.
    return null;
  }

  const transport = info.providers?.gemini?.transport ?? "kitty_proxy";
  const isKitty = transport === "kitty_proxy";
  const transportLabel = isKitty ? "via Kitty" : "direct";

  return (
    <button
      onClick={() => openOrFocusCenterTab("vision")}
      className={[
        "h-7 px-2 rounded-md flex items-center gap-1.5 border text-[10px] font-mono transition-colors",
        "border-emerald-500/50 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20",
      ].join(" ")}
      title={
        isKitty
          ? "Gemini 3.1 Pro routed through Kitty App (no Google Cloud setup). " +
            `${todayCount ?? 0} consult${todayCount === 1 ? "" : "s"} today. ` +
            "Click to open Vision Reviews."
          : "Gemini direct via Google AI Studio key. " +
            `${todayCount ?? 0} consult${todayCount === 1 ? "" : "s"} today. ` +
            "Click to open Vision Reviews."
      }
    >
      <Eye className="h-3 w-3" />
      <Sparkles className="h-2.5 w-2.5 -ml-0.5" />
      <span>Gemini</span>
      <span className="text-emerald-400/70">·</span>
      <span className="text-emerald-300/80">{transportLabel}</span>
      {todayCount !== null && todayCount > 0 && (
        <span className="ml-1 px-1 rounded bg-emerald-500/20 text-emerald-200">
          {todayCount}
        </span>
      )}
    </button>
  );
}
