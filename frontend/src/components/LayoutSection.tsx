import { Check } from "lucide-react";
import { Button } from "./Button";
import { cn } from "../lib/utils";

/**
 * The "Layout" block at the top of a columns drawer — named layouts to pick
 * from, plus (for an admin) publishing the arrangement on screen as this
 * company's default.
 *
 * Shared on purpose: the app runs two table components (DataTable and the
 * vendored SCM DataGrid) and both drawers show this. One copy is what keeps
 * them from drifting into two different affordances for one feature.
 *
 * Purely presentational — every decision (which layouts exist, which one is
 * active, whether this user may publish) is made by the caller.
 */

export interface LayoutPresetOption {
  id: string;
  label: string;
  hint?: string;
  /** How many columns it shows, excluding always-visible ones. */
  count: number;
  /** The table currently matches this layout exactly. */
  active: boolean;
  /** This company's default — what an untouched table starts on. */
  isDefault: boolean;
  /** Set only for a layout the USER saved (mig 0239) — the id CRUD acts on.
   *  Absent for a company default or a page seed, which they cannot rename or
   *  delete. */
  savedId?: number;
}

export interface LayoutDefaultManager {
  /** Company the save publishes to, e.g. "2990's Home". */
  companyLabel: string;
  /** A default already exists (enables Clear). */
  hasSaved: boolean;
  state: "idle" | "saving" | "saved" | "error";
  onSave: () => void;
  onClear: () => void;
}

interface Props {
  presets?: LayoutPresetOption[];
  onApplyPreset?: (id: string) => void;
  /** Present only for an admin who may publish this company's default view.
   *  Absent for everyone else — including when the layout server is
   *  unreachable, so the control never appears where it can't work. */
  defaultManager?: LayoutDefaultManager;
}

export function LayoutSection({ presets, onApplyPreset, defaultManager }: Props) {
  const hasPresets = Boolean(presets && presets.length > 0);
  /* Shown when there is EITHER something to pick or the right to publish a
     default. Gating on presets alone was a chicken-and-egg: a list that ships
     no seed layout had no section, so an admin could never save its first
     company default — which was every list but Sales Orders. */
  if (!hasPresets && !defaultManager) return null;

  return (
    <section className="mb-6">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
          Layout
        </h3>
        {/* No preset matches ⇒ a hand-arranged layout. Saying so stops the
            highlighted-nothing state from reading as a bug. */}
        {hasPresets && !presets!.some((p) => p.active) && (
          <span className="rounded bg-surface-2 px-1.5 py-px text-[9px] font-semibold uppercase tracking-wider text-ink-muted">
            Custom
          </span>
        )}
      </div>
      {hasPresets && (
        <div className="divide-y divide-border-subtle overflow-hidden rounded-md border border-border bg-surface">
          {presets!.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => onApplyPreset?.(p.id)}
              aria-pressed={p.active}
              className={cn(
                "flex w-full items-center gap-2.5 px-2 py-2.5 text-left transition-colors",
                p.active ? "bg-primary-soft/40" : "hover:bg-accent-soft/30"
              )}
            >
              <span
                className={cn(
                  "grid h-4 w-4 shrink-0 place-items-center rounded-full border transition-colors",
                  p.active
                    ? "border-primary bg-primary text-white"
                    : "border-border bg-surface"
                )}
              >
                {p.active && <Check size={9} strokeWidth={3} />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className={cn("text-[12.5px] text-ink", p.active && "font-semibold")}>
                    {p.label}
                  </span>
                  {p.isDefault && (
                    <span className="rounded bg-accent-soft px-1.5 py-px text-[9px] font-semibold uppercase tracking-wider text-accent-ink">
                      Default
                    </span>
                  )}
                </span>
                <span className="mt-0.5 block truncate text-[10.5px] text-ink-muted">
                  {p.hint ? `${p.hint} · ` : ""}
                  {p.count} columns
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
      <p className="mt-1.5 text-[10px] text-ink-muted">
        {hasPresets
          ? "Picking a layout replaces the columns below — adjust them afterwards as usual. Your arrangement is saved to your account."
          : "Your column arrangement is saved to your account, so it follows you to another machine."}
      </p>

      {/* Admin: publish the CURRENT arrangement as the company default. It
          reaches only people who have never arranged this table themselves, so
          nobody's own columns move. */}
      {defaultManager && (
        <div className="mt-2 rounded-md border border-dashed border-border bg-bg/60 px-2.5 py-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
              {defaultManager.companyLabel} default
            </span>
            {defaultManager.hasSaved && (
              <button
                onClick={defaultManager.onClear}
                disabled={defaultManager.state === "saving"}
                className="text-[10px] text-ink-muted underline-offset-2 hover:text-err hover:underline disabled:opacity-50"
              >
                Clear
              </button>
            )}
          </div>
          <Button
            variant="ghost"
            onClick={defaultManager.onSave}
            disabled={defaultManager.state === "saving"}
            className="mt-1.5 w-full justify-center"
          >
            {defaultManager.state === "saving"
              ? "Saving…"
              : "Save current columns as default"}
          </Button>
          <p className="mt-1 text-[10px] text-ink-muted">
            {defaultManager.state === "saved"
              ? "Saved. New users of this company start here."
              : defaultManager.state === "error"
                ? "Could not save — please try again."
                : "Applies to everyone who hasn't arranged this table themselves."}
          </p>
        </div>
      )}
    </section>
  );
}
