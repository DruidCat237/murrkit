"use client";

/**
 * Toaster — lightweight toast system, sonner-style API.
 *
 * Usage:
 *   import { useToasts } from '@/components/Toaster';
 *   const toast = useToasts();
 *   toast.success("Saved");
 *   toast.error("Failed");
 *   toast.warn("Watch out");
 *   toast.info("Note");
 *   toast.loading("Generating…", { promise: doWork() });
 *
 * Backwards-compat:
 *   window.dispatchEvent(new CustomEvent('toast', { detail: { type, message } }));
 */

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, AlertCircle, Info, X, Loader2, AlertTriangle } from "lucide-react";

export type ToastType = "success" | "error" | "info" | "warn" | "loading";

interface Toast {
  id: number;
  type: ToastType;
  message: string;
  description?: string;
  expiresAt: number;
  dismissable: boolean;
}

const ICON: Record<ToastType, React.ReactNode> = {
  success: <CheckCircle2 className="h-4 w-4" />,
  error:   <AlertCircle className="h-4 w-4" />,
  info:    <Info className="h-4 w-4" />,
  warn:    <AlertTriangle className="h-4 w-4" />,
  loading: <Loader2 className="h-4 w-4 animate-spin" />,
};

const COLOR_CLASS: Record<ToastType, string> = {
  success: "success",
  error:   "error",
  info:    "info",
  warn:    "warn",
  loading: "info",
};

let _id = 1;

export default function Toaster() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => {
    const handler = (e: Event) => {
      const d = (e as CustomEvent).detail as {
        type?: ToastType; message: string; description?: string; ttl_ms?: number; dismissable?: boolean; id?: number;
      };
      const ttl = d.ttl_ms ?? (d.type === "error" ? 8000 : 5000);
      const id = d.id ?? _id++;
      setToasts((prev) => {
        // dedupe by id (lets promise() update the same toast)
        const filtered = prev.filter((t) => t.id !== id);
        return [
          ...filtered,
          {
            id,
            type: d.type ?? "info",
            message: d.message,
            description: d.description,
            expiresAt: Date.now() + ttl,
            dismissable: d.dismissable !== false,
          },
        ];
      });
    };
    window.addEventListener("toast", handler);
    return () => window.removeEventListener("toast", handler);
  }, []);

  useEffect(() => {
    if (toasts.length === 0) return;
    const id = setInterval(() => {
      const now = Date.now();
      setToasts((prev) => prev.filter((t) => t.expiresAt > now));
    }, 500);
    return () => clearInterval(id);
  }, [toasts]);

  return (
    <div className="fixed bottom-8 right-4 z-50 flex flex-col gap-2 max-w-sm pointer-events-none" aria-live="polite" aria-atomic="true">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`toast ${COLOR_CLASS[t.type]} pointer-events-auto flex items-start gap-2`}
          role={t.type === "error" ? "alert" : "status"}
        >
          <span className={`shrink-0 ${t.type === "loading" ? "text-accent" : `text-${cssColor(t.type)}`}`}>
            {ICON[t.type]}
          </span>
          <div className="flex-1 min-w-0">
            <div className="text-sm">{t.message}</div>
            {t.description && (
              <div className="text-xs text-text-dim mt-0.5">{t.description}</div>
            )}
          </div>
          {t.dismissable && (
            <button
              className="shrink-0 text-text-dim hover:text-text"
              onClick={() => setToasts((p) => p.filter((x) => x.id !== t.id))}
              aria-label="Dismiss"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function cssColor(t: ToastType): string {
  if (t === "success") return "ok";
  if (t === "error") return "err";
  if (t === "warn") return "accent-warn";
  return "accent";
}

interface ToastApi {
  success: (message: string, opts?: { description?: string; ttl_ms?: number }) => void;
  error:   (message: string, opts?: { description?: string; ttl_ms?: number }) => void;
  warn:    (message: string, opts?: { description?: string; ttl_ms?: number }) => void;
  info:    (message: string, opts?: { description?: string; ttl_ms?: number }) => void;
  loading: <T>(message: string, opts: { promise: Promise<T>; success?: (v: T) => string; error?: (e: unknown) => string }) => Promise<T>;
}

/** Hook usable in any client component. */
export function useToasts(): ToastApi {
  const dispatch = useCallback((type: ToastType, message: string, opts?: { description?: string; ttl_ms?: number; id?: number; dismissable?: boolean }) => {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent("toast", {
      detail: { type, message, ...opts },
    }));
  }, []);

  return {
    success: (m, o) => dispatch("success", m, o),
    error:   (m, o) => dispatch("error", m, o),
    warn:    (m, o) => dispatch("warn", m, o),
    info:    (m, o) => dispatch("info", m, o),
    loading: async (message, { promise, success, error }) => {
      const id = _id++;
      dispatch("loading", message, { id, ttl_ms: 60_000, dismissable: false });
      try {
        const v = await promise;
        dispatch("success", success ? success(v) : message, { id, ttl_ms: 4000 });
        return v;
      } catch (e) {
        dispatch("error", error ? error(e) : (e as Error).message, { id, ttl_ms: 8000 });
        throw e;
      }
    },
  };
}

/** Legacy helper kept for backwards compat. */
export function toast(type: ToastType, message: string, ttl_ms = 5000) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("toast", { detail: { type, message, ttl_ms } }));
}
