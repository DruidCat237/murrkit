"use client";

/**
 * FileTree — browses the REAL Phaser game source (`phaser_game/`) for the
 * dashboard "Code" tab. Fetches GET /api/fs/tree?root=phaser_game and renders
 * collapsible folders. Clicking a file opens it in the Monaco editor (the
 * parent reads it via /api/fs/read).
 *
 * The backend returns a single root node ({name:'phaser_game', children:[…]}).
 * We render its CHILDREN as the top-level rows so `src/` and `levels/` land at
 * tree level 0 and start expanded (TreeView auto-opens level < 1). The footer
 * still shows the repo-relative root.
 */

import { useEffect, useMemo, useState } from "react";
import { RefreshCcw, Search, FileCode } from "lucide-react";
import { getFsTree, type FsTreeNode } from "@/lib/api";
import TreeView, { type TreeNode } from "../browser/TreeView";

interface FileTreeProps {
  onPick: (path: string) => void;
  activePath: string | null;
  /** repo-relative root to browse. Defaults to the Phaser game source. */
  root?: string;
}

export default function FileTree({ onPick, activePath, root = "phaser_game" }: FileTreeProps) {
  const [tree, setTree] = useState<FsTreeNode | null>(null);
  const [filter, setFilter] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setRefreshing(true);
    setError(null);
    try {
      const r = await getFsTree(root);
      setTree(r);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root]);

  // Render the root's children as top-level rows (so src/ + levels/ auto-expand).
  const nodes: TreeNode[] = useMemo(() => {
    if (!tree?.children) return [];
    return toTreeNodes(tree.children);
  }, [tree]);

  return (
    <div className="h-full flex flex-col bg-bg-panel border-r border-line min-w-[200px]">
      <div className="p-2 border-b border-line shrink-0 flex items-center gap-1">
        <div className="relative flex-1">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-text-dim" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter files…"
            className="w-full bg-bg pl-7 pr-2 py-1 text-xs border border-line rounded-md outline-none focus:border-accent"
          />
        </div>
        <button onClick={refresh} className="btn btn-ghost p-1" title="Refresh tree" aria-label="Refresh">
          <RefreshCcw className={`h-3 w-3 ${refreshing ? "animate-spin" : ""}`} />
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">
        {error ? (
          <div className="p-3 text-xs text-err">
            Failed to load file tree: {error}
            <button onClick={refresh} className="block mt-2 btn btn-ghost text-xs">Retry</button>
          </div>
        ) : !tree ? (
          <div className="p-3 space-y-2">
            <div className="skeleton h-4 w-3/4" />
            <div className="skeleton h-4 w-1/2" />
            <div className="skeleton h-4 w-2/3" />
          </div>
        ) : (
          <TreeView
            nodes={nodes}
            activePath={activePath}
            filter={filter}
            onSelect={(n) => { if (!n.isDir) onPick(n.path); }}
            iconFor={(n) => n.isDir ? undefined : <FileCode className="h-3.5 w-3.5 text-accent-warn shrink-0" />}
          />
        )}
      </div>
      <div className="px-2 py-1 text-[10px] text-text-subtle border-t border-line truncate" title={root}>
        {root}
      </div>
    </div>
  );
}

/** Map the backend's {type:'dir'|'file'} nodes to TreeView's {isDir} shape. */
function toTreeNodes(input: FsTreeNode[]): TreeNode[] {
  return input.map((n) => ({
    name: n.name,
    path: n.path,
    isDir: n.type === "dir",
    children: n.children ? toTreeNodes(n.children) : undefined,
  }));
}
