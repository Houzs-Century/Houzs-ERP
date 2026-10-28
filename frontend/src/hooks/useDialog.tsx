import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Info, X } from "lucide-react";
import { cn } from "../lib/utils";

/**
 * Promise-based confirm/prompt dialogs. Replaces the native
 * window.confirm / window.alert / window.prompt usage so:
 *   • styling matches the rest of the app
 *   • keyboard + focus behaviour works on mobile (where native
 *     confirm() can be blocked or look terrible)
 *   • we can theme errors/destructive actions distinctly
 *
 * Usage:
 *   const dialog = useDialog();
 *   if (!(await dialog.confirm("Delete this?"))) return;
 *   const reason = await dialog.prompt({ title: "Reason?" });
 */

export interface ConfirmOptions {
  title?: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Destructive: red confirm button + warning icon. */
  danger?: boolean;
  tone?: "default" | "danger" | "info";
}

export interface PromptOptions extends ConfirmOptions {
  placeholder?: string;
  defaultValue?: string;
  /** Block confirm when input is empty. */
  required?: boolean;
  /** "text" | "textarea" — pick the input shape. */
  multiline?: boolean;
  inputType?: "text" | "email" | "number";
}

interface DialogContextValue {
  confirm: (opts: ConfirmOptions | string) => Promise<boolean>;
  prompt: (opts: PromptOptions | string) => Promise<string | null>;
}

const DialogContext = createContext<DialogContextValue | null>(null);

type PendingItem =
  | {
      kind: "confirm";
      id: number;
      opts: ConfirmOptions;
      resolve: (v: boolean) => void;
    }
  | {
      kind: "prompt";
      id: number;
      opts: PromptOptions;
      resolve: (v: string | null) => void;
    };

export function DialogProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<PendingItem[]>([]);
  const counter = useRef(0);

  const confirm = useCallback(
    (opts: ConfirmOptions | string) =>
      new Promise<boolean>((resolve) => {
        const id = ++counter.current;
        const normalized: ConfirmOptions =
          typeof opts === "string" ? { message: opts } : opts;
        setQueue((q) => [...q, { kind: "confirm", id, opts: normalized, resolve }]);
      }),
    []
  );

  const prompt = useCallback(
    (opts: PromptOptions | string) =>
      new Promise<string | null>((resolve) => {
        const id = ++counter.current;
        const normalized: PromptOptions =
          typeof opts === "string" ? { message: opts } : opts;
        setQueue((q) => [...q, { kind: "prompt", id, opts: normalized, resolve }]);
      }),
    []
  );

  const top = queue[0] ?? null;

  function dismiss(value: boolean | string | null) {
    if (!top) return;
    if (top.kind === "confirm") (top.resolve as (v: boolean) => void)(!!value);
    else (top.resolve as (v: string | null) => void)(value as string | null);
    setQueue((q) => q.slice(1));
  }

  return (
    <DialogContext.Provider value={{ confirm, prompt }}>
      {children}
      {top &&
        typeof document !== "undefined" &&
        createPortal(
          <DialogShell key={top.id} item={top} onClose={dismiss} />,
          document.body
        )}
    </DialogContext.Provider>
  );
}

function DialogShell({
  item,
  onClose,
}: {
  item: PendingItem;
  onClose: (value: boolean | string | null) => void;
}) {
  const tone =
    item.opts.tone ??
    (item.opts.danger ? "danger" : "default");
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const [draft, setDraft] = useState<string>(
    item.kind === "prompt" ? item.opts.defaultValue ?? "" : ""
  );

  // Focus first interactive element on open. Confirm dialogs focus the
  // confirm button; prompts focus the input.
  const confirmBtnRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    const t = setTimeout(() => {
      if (item.kind === "prompt") inputRef.current?.focus();
      else confirmBtnRef.current?.focus();
    }, 30);
    return () => clearTimeout(t);
  }, [item.kind]);

  // Esc closes (cancel). Enter confirms when not in a textarea.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose(item.kind === "confirm" ? false : null);
      } else if (e.key === "Enter") {
        // Enter inside a textarea adds a newline — let it through.
        const target = e.target as HTMLElement;
        if (target.tagName === "TEXTAREA") return;
        if (item.kind === "prompt") {
          const v = (draft || "").trim();
          if (item.opts.required && !v) return;
          e.preventDefault();
          onClose(v);
        } else {
          e.preventDefault();
          onClose(true);
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [item, draft, onClose]);

  const Icon = tone === "danger" ? AlertTriangle : Info;
  const iconCls =
    tone === "danger"
      ? "bg-err/10 text-err"
      : tone === "info"
      ? "bg-accent/10 text-accent"
      : "bg-accent/10 text-accent";

  const confirmLabel =
    item.opts.confirmLabel ??
    (item.kind === "prompt" ? "OK" : tone === "danger" ? "Confirm" : "OK");
  const cancelLabel = item.opts.cancelLabel ?? "Cancel";

  const confirmBtnCls =
    tone === "danger"
      ? "bg-err text-white hover:bg-err/90 border border-err"
      : "bg-primary text-white hover:bg-primary-ink border border-primary";

  const requiredAndEmpty =
    item.kind === "prompt" && item.opts.required && !(draft || "").trim();

  return (
    <div
      className="fixed inset-0 z-[300] flex items-center justify-center bg-ink/40 backdrop-blur-sm animate-fade-in"
      onClick={(e) => {
        // Click on backdrop dismisses (cancel). Click inside the
        // panel doesn't bubble.
        if (e.target === e.currentTarget) {
          onClose(item.kind === "confirm" ? false : null);
        }
      }}
    >
      <div className="w-full max-w-md mx-4 rounded-xl border border-border bg-surface shadow-slab animate-modal-in">
        <div className="flex items-start gap-3 px-5 py-4">
          <div
            className={cn(
              "flex h-10 w-10 shrink-0 items-center justify-center rounded-full",
              iconCls
            )}
          >
            <Icon size={18} />
          </div>
          <div className="flex-1 min-w-0">
            {item.opts.title && (
              <div className="font-display text-[15px] font-bold text-ink">
                {item.opts.title}
              </div>
            )}
            {item.opts.message && (
              <div
                className={cn(
                  "whitespace-pre-line text-[13px] text-ink-secondary",
                  item.opts.title ? "mt-1" : ""
                )}
              >
                {item.opts.message}
              </div>
            )}
          </div>
          <button
            onClick={() => onClose(item.kind === "confirm" ? false : null)}
            className="shrink-0 rounded p-1 text-ink-muted hover:bg-surface-dim hover:text-ink"
            aria-label="Close"
          >
            <X size={14} />
          </button>
        </div>

        {item.kind === "prompt" && (
          <div className="px-5 pb-3">
            {item.opts.multiline ? (
              <textarea
                ref={(el) => { inputRef.current = el; }}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={item.opts.placeholder}
                rows={3}
                className="w-full resize-y rounded-md border border-border bg-surface px-3 py-2 text-[13px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
              />
            ) : (
              <input
                ref={(el) => { inputRef.current = el; }}
                type={item.opts.inputType ?? "text"}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={item.opts.placeholder}
                className="h-10 w-full rounded-md border border-border bg-surface px-3 text-[13px] outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
              />
            )}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 border-t border-border-subtle px-5 py-3">
          <button
            onClick={() => onClose(item.kind === "confirm" ? false : null)}
            className="rounded-md border border-border bg-surface px-3 py-1.5 text-[12px] font-semibold text-ink-secondary hover:text-ink"
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmBtnRef}
            disabled={requiredAndEmpty}
            onClick={() => {
              if (item.kind === "prompt") {
                const v = (draft || "").trim();
                if (item.opts.required && !v) return;
                onClose(v);
              } else {
                onClose(true);
              }
            }}
            className={cn(
              "inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-[12px] font-bold disabled:opacity-50",
              confirmBtnCls
            )}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function useDialog(): DialogContextValue {
  const ctx = useContext(DialogContext);
  if (!ctx) throw new Error("useDialog must be used inside DialogProvider");
  return ctx;
}

/** Dialogs for a component that must ALSO render outside the provider — a
 *  shared table control mounted bare in a unit test. Null there rather than a
 *  throw; the caller is expected to skip the action it would have confirmed.
 *  Anything that genuinely needs a dialog should keep using `useDialog`. */
export function useDialogOptional(): DialogContextValue | null {
  return useContext(DialogContext);
}
