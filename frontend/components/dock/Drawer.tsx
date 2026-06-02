"use client";

/**
 * Drawer — simple modal panel that slides from the bottom (mobile-ish)
 * or center (full-screen). CSS-only animation, no dep.
 */

import { useEffect } from "react";
import { X } from "lucide-react";

interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  side?: "center" | "bottom";
  className?: string;
}

export default function Drawer({ open, onClose, title, children, side = "center", className = "" }: DrawerProps) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    if (open) window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const containerCls = side === "center"
    ? "fixed inset-0 z-50 flex items-center justify-center p-6"
    : "fixed inset-0 z-50 flex items-end justify-center";

  const panelCls = side === "center"
    ? "panel max-w-3xl w-full max-h-[85vh] flex flex-col shadow-elev"
    : "panel w-full max-w-3xl rounded-t-lg rounded-b-none max-h-[85vh] flex flex-col shadow-elev";

  return (
    <div className={containerCls} role="dialog" aria-modal="true">
      <div
        className="absolute inset-0 bg-bg-overlay backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <div className={`relative ${panelCls} ${className}`}>
        {title && (
          <div className="flex items-center justify-between px-4 py-3 border-b border-line shrink-0">
            <h2 className="text-sm font-semibold">{title}</h2>
            <button
              onClick={onClose}
              className="p-1 text-text-dim hover:text-text"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}
        <div className="flex-1 min-h-0 overflow-auto">{children}</div>
      </div>
    </div>
  );
}
