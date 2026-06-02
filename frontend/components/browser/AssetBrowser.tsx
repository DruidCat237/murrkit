"use client";

import { useEffect, useMemo, useState } from "react";
import { Search, Image as ImageIcon, FileCode, X, ExternalLink } from "lucide-react";
import { BACKEND, getLibrary } from "@/lib/api";
import type { LibraryAsset, ProjectLibrary } from "@/lib/types";
import TreeView, { type TreeNode } from "./TreeView";
import { useLayout } from "@/store/layout";

interface AssetBrowserProps { projectName: string }

export default function AssetBrowser({ projectName }: AssetBrowserProps) {
  const [lib, setLib] = useState<ProjectLibrary | null>(null);
  const [filter, setFilter] = useState("");
  const [active, setActive] = useState<string | null>(null);
  const [preview, setPreview] = useState<LibraryAsset | null>(null);
  const openCenterTab = useLayout((s) => s.openOrFocusCenterTab);

  // Build a quick lookup: tree path -> LibraryAsset so we can pop a preview
  // straight from the tree without a round-trip.
  const assetByPath = useMemo(() => {
    const m = new Map<string, LibraryAsset>();
    if (!lib) return m;
    for (const a of lib.assets) {
      const parts = a.rel_path.split("/").filter(Boolean);
      m.set(parts.join("/"), a);
    }
    return m;
  }, [lib]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const r = await getLibrary(projectName);
        if (!cancelled) setLib(r);
      } catch { /* ignore */ }
    }
    load();
    const t = setInterval(load, 8000);
    return () => { cancelled = true; clearInterval(t); };
  }, [projectName]);

  // Esc closes the preview popup
  useEffect(() => {
    if (!preview) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setPreview(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [preview]);

  const tree = useMemo<TreeNode[]>(() => {
    if (!lib) return [];
    return buildAssetTree(lib.assets);
  }, [lib]);

  function selectNode(n: TreeNode) {
    if (n.isDir) return;
    setActive(n.path);
    const asset = assetByPath.get(n.path);
    if (asset && /\.(png|jpe?g|webp|gif)$/i.test(asset.name)) {
      // Image → open the full-screen preview right here in the sidebar's host
      // (no round-trip through the center pane).
      setPreview(asset);
    } else {
      // Non-image (script, json, scene) → open Library tab so the user
      // sees full details.
      openCenterTab("library");
    }
  }

  return (
    <div className="h-full flex flex-col">
      <div className="p-2 border-b border-line shrink-0">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-text-dim" />
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter assets…"
            className="w-full bg-bg pl-7 pr-2 py-1 text-xs border border-line rounded-md placeholder:text-text-subtle focus:border-accent outline-none"
            aria-label="Filter assets"
          />
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        {!lib ? (
          <div className="p-3 space-y-2">
            <div className="skeleton h-4 w-3/4" />
            <div className="skeleton h-4 w-1/2" />
            <div className="skeleton h-4 w-4/5" />
          </div>
        ) : (
          <TreeView
            nodes={tree}
            filter={filter}
            activePath={active}
            onSelect={selectNode}
            iconFor={(n) => iconForAsset(n)}
          />
        )}
      </div>
      <div className="px-3 py-1.5 text-[10px] text-text-subtle border-t border-line shrink-0">
        {lib ? (
          <>{lib.asset_count} asset{lib.asset_count !== 1 && "s"} · {(lib.total_bytes / 1024 / 1024).toFixed(2)} MB</>
        ) : "loading…"}
      </div>
      {preview && (
        <SidebarPreview asset={preview} onClose={() => setPreview(null)} />
      )}
    </div>
  );
}

function SidebarPreview({
  asset,
  onClose,
}: {
  asset: LibraryAsset;
  onClose: () => void;
}) {
  const url = `${BACKEND}${asset.served_url}`;
  const pixelated = asset.type === "sprite" || asset.type === "tileset" || asset.type === "atlas";
  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 bg-bg/95 backdrop-blur-sm flex flex-col"
      role="dialog"
      aria-modal="true"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex items-center gap-2 px-4 py-2 border-b border-line bg-bg/80"
      >
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium truncate" title={asset.name}>{asset.name}</div>
          <div className="text-[10px] text-text-subtle font-mono truncate" title={asset.rel_path}>
            {asset.rel_path}
          </div>
        </div>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="btn border border-line text-xs flex items-center gap-1"
        >
          <ExternalLink className="h-3 w-3" />
          Open
        </a>
        <button onClick={onClose} className="text-text-dim hover:text-accent-hot p-1" aria-label="Close">
          <X className="h-5 w-5" />
        </button>
      </div>
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex-1 min-h-0 flex items-center justify-center p-6 overflow-auto"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={url}
          alt={asset.name}
          className="max-w-full max-h-full object-contain shadow-2xl"
          style={{
            imageRendering: pixelated ? "pixelated" : "auto",
            background: "repeating-conic-gradient(#222 0% 25%, #2a2a2a 0% 50%) 50%/24px 24px",
          }}
        />
      </div>
      <div className="px-4 py-1.5 text-[10px] text-text-subtle border-t border-line bg-bg/80 text-center">
        Press <kbd className="px-1 py-0.5 border border-line rounded font-mono">Esc</kbd> or click outside to close
      </div>
    </div>
  );
}

function iconForAsset(n: TreeNode) {
  if (n.isDir) return undefined;
  const lower = n.name.toLowerCase();
  if (/\.(png|jpg|jpeg|gif|webp|tga)$/i.test(lower)) return <ImageIcon className="h-3.5 w-3.5 text-accent shrink-0" />;
  if (/\.(cs|json|yaml|yml|txt|md)$/i.test(lower)) return <FileCode className="h-3.5 w-3.5 text-accent-warn shrink-0" />;
  return undefined;
}

function buildAssetTree(assets: LibraryAsset[]): TreeNode[] {
  const root: Record<string, any> = {};
  for (const a of assets) {
    const parts = a.rel_path.split("/").filter(Boolean);
    let cur = root;
    parts.forEach((p, i) => {
      if (i === parts.length - 1) {
        cur[p] = { _asset: a };
      } else {
        cur[p] = cur[p] || {};
        cur = cur[p];
      }
    });
  }

  function build(obj: Record<string, any>, prefix: string): TreeNode[] {
    const out: TreeNode[] = [];
    for (const [k, v] of Object.entries(obj)) {
      const path = prefix ? `${prefix}/${k}` : k;
      if (v && typeof v === "object" && !v._asset) {
        out.push({
          name: k,
          path,
          isDir: true,
          children: build(v, path),
        });
      } else {
        const a = (v as { _asset: LibraryAsset })._asset;
        out.push({
          name: k,
          path,
          isDir: false,
          meta: { size: a.size_bytes },
        });
      }
    }
    out.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return out;
  }

  return build(root, "");
}
