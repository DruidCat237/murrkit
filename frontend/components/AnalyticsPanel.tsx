"use client";

import { useEffect, useState } from "react";
import { Activity, DollarSign, Image as ImageIcon } from "lucide-react";
import { getGptImage2Usage } from "@/lib/api";
import type { UsageReport } from "@/lib/types";

export default function AnalyticsPanel() {
  const [data, setData] = useState<UsageReport | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const r = await getGptImage2Usage(undefined, undefined, 100);
        if (!cancelled) setData(r);
      } catch { /* ignore */ }
      finally { if (!cancelled) setLoading(false); }
    }
    load();
    const t = setInterval(load, 15_000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  if (loading) {
    return (
      <div className="p-3 space-y-2">
        <div className="skeleton h-6 w-full" />
        <div className="skeleton h-6 w-3/4" />
        <div className="skeleton h-6 w-1/2" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="p-4 text-xs text-text-dim">
        <Activity className="h-8 w-8 mx-auto mb-2 opacity-50" />
        <p className="text-center">No usage data yet.</p>
        <p className="text-center text-text-subtle mt-1">Generate an asset to populate analytics.</p>
      </div>
    );
  }

  return (
    <div className="p-3 space-y-3 text-xs">
      <Stat icon={<ImageIcon className="h-3 w-3" />} label="Total calls" value={data.total_calls.toString()} />
      <Stat icon={<DollarSign className="h-3 w-3" />} label="Total cost"
            value={`$${data.total_cost_usd.toFixed(3)}`} />

      <div>
        <div className="text-text-dim mb-1 font-semibold">By resolution</div>
        <ul className="space-y-1">
          {Object.entries(data.by_resolution).map(([res, v]) => (
            <li key={res} className="flex justify-between">
              <span className="text-text-dim">{res}</span>
              <span>{v.count} · ${v.cost_usd.toFixed(3)}</span>
            </li>
          ))}
        </ul>
      </div>

      <div>
        <div className="text-text-dim mb-1 font-semibold">Last 5 calls</div>
        <ul className="space-y-1 max-h-40 overflow-y-auto">
          {data.calls.slice(0, 5).map((c) => (
            <li key={c.id} className="border border-line rounded p-1.5">
              <div className="flex justify-between">
                <span className="text-text">{c.model}</span>
                <span className="text-text-dim">${c.cost_usd.toFixed(3)}</span>
              </div>
              <div className="text-[10px] text-text-subtle truncate" title={c.prompt}>{c.prompt}</div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function Stat({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2 p-2 panel">
      <div className="text-accent">{icon}</div>
      <div className="flex-1">
        <div className="text-[10px] text-text-subtle">{label}</div>
        <div className="text-sm font-semibold">{value}</div>
      </div>
    </div>
  );
}
