import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { Check, X, Info, AlertTriangle } from "lucide-react";
import { onForbidden } from "../api/client";

type ToastKind = "success" | "error" | "info" | "warning";

interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

interface ToastContextValue {
  show: (kind: ToastKind, message: string) => void;
  success: (m: string) => void;
  error: (m: string) => void;
  info: (m: string) => void;
  warning: (m: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const show = useCallback((kind: ToastKind, message: string) => {
    const id = Date.now() + Math.random();
    setItems((prev) => [...prev, { id, kind, message }]);
    // Errors hang around a touch longer so users can read them.
    const ttl = kind === "error" ? 5000 : 3000;
    setTimeout(() => {
      setItems((prev) => prev.filter((t) => t.id !== id));
    }, ttl);
  }, []);

  const value: ToastContextValue = {
    show,
    success: (m) => show("success", m),
    error: (m) => show("error", m),
    info: (m) => show("info", m),
    warning: (m) => show("warning", m),
  };

  // Surface every 403 as a toast. Some callers also catch + toast the
  // raw "403: …" error themselves, so we dedupe identical messages
  // inside a 1.5s window to avoid the same denial showing twice.
  useEffect(() => {
    let last = "";
    let lastAt = 0;
    return onForbidden((message) => {
      const now = Date.now();
      if (message === last && now - lastAt < 1500) return;
      last = message;
      lastAt = now;
      show("error", message);
    });
  }, [show]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {/* Top-center stack — slides in from above. Pinned to top so
          it doesn't collide with floating action bars or the PWA
          install banner pinned to the bottom. */}
      <div
        className="pointer-events-none fixed left-1/2 top-4 z-[200] flex w-full max-w-md -translate-x-1/2 flex-col items-center gap-2 px-3 sm:top-6"
        aria-live="polite"
        role="status"
      >
        {items.map((t) => (
          <ToastCard key={t.id} item={t} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastCard({ item }: { item: ToastItem }) {
  const palette =
    item.kind === "success"
      ? "border-synced/30 bg-surface text-ink"
      : item.kind === "error"
      ? "border-err/40 bg-surface text-ink"
      : item.kind === "warning"
      ? "border-amber-500/40 bg-surface text-ink"
      : "border-accent/30 bg-surface text-ink";
  const Icon =
    item.kind === "success"
      ? Check
      : item.kind === "error"
      ? X
      : item.kind === "warning"
      ? AlertTriangle
      : Info;
  const iconColor =
    item.kind === "success"
      ? "text-synced"
      : item.kind === "error"
      ? "text-err"
      : item.kind === "warning"
      ? "text-amber-600"
      : "text-accent";
  return (
    <div
      className={
        "pointer-events-auto flex w-full items-start gap-2.5 rounded-lg border px-4 py-2.5 text-[13px] shadow-slab animate-toast-in " +
        palette
      }
    >
      <Icon size={16} className={"mt-0.5 shrink-0 " + iconColor} />
      <span className="flex-1 leading-snug">{item.message}</span>
    </div>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside ToastProvider");
  return ctx;
}

/**
 * Toasts for a component that must ALSO render outside the provider — a shared
 * table control mounted bare in a unit test, say. Returns null there rather
 * than throwing, so "no toast host" degrades to "no toast" instead of to a
 * crash. Anything that genuinely needs a toast should keep using `useToast`.
 */
export function useToastOptional(): ToastContextValue | null {
  return useContext(ToastContext);
}
