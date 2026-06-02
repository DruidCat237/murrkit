"use client";

import { ChevronRight, ChevronDown, File as FileIcon, Folder, FolderOpen } from "lucide-react";
import { useState } from "react";

export interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children?: TreeNode[];
  meta?: { size?: number; mtime?: number };
}

interface TreeViewProps {
  nodes: TreeNode[];
  activePath?: string | null;
  onSelect?: (n: TreeNode) => void;
  onContextMenu?: (n: TreeNode, e: React.MouseEvent) => void;
  iconFor?: (n: TreeNode) => React.ReactNode;
  level?: number;
  filter?: string;
}

export default function TreeView({
  nodes,
  activePath,
  onSelect,
  onContextMenu,
  iconFor,
  level = 0,
  filter = "",
}: TreeViewProps) {
  if (!nodes.length) {
    return level === 0 ? <div className="px-3 py-2 text-xs text-text-subtle">No items</div> : null;
  }

  const filtered = filter
    ? nodes
        .map((n) => filterNode(n, filter.toLowerCase()))
        .filter(Boolean) as TreeNode[]
    : nodes;

  return (
    <ul className="select-none">
      {filtered.map((n) => (
        <TreeRow
          key={n.path || n.name}
          node={n}
          level={level}
          activePath={activePath}
          onSelect={onSelect}
          onContextMenu={onContextMenu}
          iconFor={iconFor}
          filter={filter}
        />
      ))}
    </ul>
  );
}

function filterNode(n: TreeNode, q: string): TreeNode | null {
  if (n.name.toLowerCase().includes(q)) return n;
  if (n.children && n.children.length) {
    const kids = n.children.map((c) => filterNode(c, q)).filter(Boolean) as TreeNode[];
    if (kids.length) return { ...n, children: kids };
  }
  return null;
}

function TreeRow({
  node, level, activePath, onSelect, onContextMenu, iconFor, filter,
}: { node: TreeNode; level: number; activePath?: string | null; onSelect?: (n: TreeNode) => void; onContextMenu?: (n: TreeNode, e: React.MouseEvent) => void; iconFor?: (n: TreeNode) => React.ReactNode; filter: string; }) {
  const [open, setOpen] = useState(level < 1 || !!filter);
  const isActive = activePath === node.path;

  function handleClick(e: React.MouseEvent) {
    e.stopPropagation();
    if (node.isDir) setOpen((v) => !v);
    onSelect?.(node);
  }

  return (
    <li>
      <div
        className={`file-row ${isActive ? "active" : ""}`}
        style={{ paddingLeft: `${level * 12 + 8}px` }}
        onClick={handleClick}
        onContextMenu={(e) => {
          e.preventDefault();
          onContextMenu?.(node, e);
        }}
        role={node.isDir ? "treeitem" : "treeitem"}
        tabIndex={0}
        aria-expanded={node.isDir ? open : undefined}
      >
        {node.isDir
          ? (open ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />)
          : <span className="w-3 shrink-0" />
        }
        {iconFor
          ? iconFor(node)
          : (node.isDir
              ? (open ? <FolderOpen className="h-3.5 w-3.5 text-accent-warn shrink-0" /> : <Folder className="h-3.5 w-3.5 text-accent-warn shrink-0" />)
              : <FileIcon className="h-3.5 w-3.5 text-text-dim shrink-0" />)
        }
        <span className="truncate" title={node.path}>{node.name}</span>
        {!node.isDir && node.meta?.size != null && (
          <span className="ml-auto text-[10px] text-text-subtle">{formatSize(node.meta.size)}</span>
        )}
      </div>
      {node.isDir && open && node.children && (
        <TreeView
          nodes={node.children}
          activePath={activePath}
          onSelect={onSelect}
          onContextMenu={onContextMenu}
          iconFor={iconFor}
          level={level + 1}
          filter={filter}
        />
      )}
    </li>
  );
}

function formatSize(b: number): string {
  if (b < 1024) return `${b}B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)}K`;
  return `${(b / 1024 / 1024).toFixed(1)}M`;
}
