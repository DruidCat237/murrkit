"use client";

import { useEffect, useState } from "react";
import { Info, Cpu, Plug, DollarSign } from "lucide-react";
import { useSession } from "@/store/session";
import { useQueue } from "@/store/queue";
import { useLayout } from "@/store/layout";
import { BACKEND } from "@/lib/api";

/**
 * RightPanel — context-sensitive inspector. Shows:
 *   - Active tab summary (which kind, etc.)
 *   - Gen-queue mini view (always)
 *   - Project / runtime info
 */
export default function RightPanel() {
  const activeId = useLayout((s) => s.activeCenterTabId);
  const tabs = useLayout((s) => s.centerTabs);
  const activeTab = tabs.find((t) => t.id === activeId);
  const tasks = useQueue((s) => s.tasks);
  const order = useQueue((s) => s.order);
  const context = useSession((s) => s.context);
  const cost = useSession((s) => s.costSnapshot);

  const recent = order.slice(-5).reverse();

  return (
    <aside className="h-full w-full flex flex-col bg-bg-panel overflow-hidden">
      <div className="px-3 py-2 border-b border-line shrink-0">
        <div className="text-[10px] uppercase tracking-wider text-text-dim font-semibold">
          Inspector
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-4 text-xs">
        <Section title="Active tab">
          <div className="text-text-dim">Kind: <span className="text-text">{activeTab?.kind ?? "—"}</span></div>
          <div className="text-text-dim">Title: <span className="text-text">{activeTab?.title ?? "—"}</span></div>
          {activeTab?.file && (
            <div className="text-text-dim">File: <span className="text-text font-mono">{activeTab.file}</span></div>
          )}
          {activeTab?.paneId && (
            <div className="text-text-dim">Pane: <span className="text-text">{activeTab.paneId}</span></div>
          )}
        </Section>

        <Section title="Runtime">
          <Row label="Project" value={context?.superagent_project ?? "default"} />
          <Row label="Backend" value={`${context?.backend_port ?? 8001}`} />
          <Row label="Model" value={context?.deepseek_model ?? ""} />
          <Row label="Engine" value={context?.mcp_unity_status ?? "—"} />
          <Row label="Transport" value={context?.mcp_unity_transport ?? "—"} />
        </Section>

        <Section title="Budget">
          <Row label="Spent" value={`$${(cost?.spent_usd ?? 0).toFixed(3)}`} />
          <Row label="Limit" value={`$${(cost?.budget_usd ?? 0).toFixed(2)}`} />
          {cost && (
            <div className="mt-1">
              <div className="h-1 bg-bg-subtle rounded-full overflow-hidden">
                <div
                  className={`h-full transition-all duration-500 ${cost.pct_used > 80 ? "bg-err" : cost.pct_used > 50 ? "bg-accent-warn" : "bg-accent"}`}
                  style={{ width: `${Math.min(100, cost.pct_used)}%` }}
                />
              </div>
              <div className="text-[10px] text-text-subtle mt-0.5">
                {cost.pct_used.toFixed(1)}% of budget used
              </div>
            </div>
          )}
        </Section>

        <Section title="Recent jobs">
          {recent.length === 0 ? (
            <div className="text-text-subtle italic">No queue activity yet</div>
          ) : (
            <ul className="space-y-1.5">
              {recent.map((id) => {
                const t = tasks[id];
                if (!t) return null;
                return (
                  <li key={id} className="border border-line rounded p-1.5">
                    <div className="flex items-center gap-1">
                      <span className="text-text-dim">{t.asset_type}</span>
                      <StatusDot status={t.status} />
                    </div>
                    <div className="text-[10px] text-text-subtle truncate" title={t.prompt}>
                      {t.prompt}
                    </div>
                    {t.thumbnail_url && t.status === "completed" && (
                      <img
                        src={`${BACKEND}${t.thumbnail_url}`}
                        alt=""
                        loading="lazy"
                        className="mt-1 h-10 w-10 object-cover rounded border border-line"
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Section>
      </div>
    </aside>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-text-subtle mb-1.5 flex items-center gap-1">
        <Info className="h-2.5 w-2.5" /> {title}
      </div>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between text-[11px]">
      <span className="text-text-dim">{label}</span>
      <span className="font-mono truncate ml-2">{value}</span>
    </div>
  );
}

function StatusDot({ status }: { status: string }) {
  const color = status === "completed" ? "bg-ok" :
    status === "failed" ? "bg-err" :
    status === "progress" || status === "started" ? "bg-accent" :
    "bg-text-subtle";
  return <span className={`inline-block h-1.5 w-1.5 rounded-full ${color} ml-1`} />;
}
