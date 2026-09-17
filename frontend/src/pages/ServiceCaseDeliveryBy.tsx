import { InlineEdit } from "../components/InlineEdit";
import { cn } from "../lib/utils";

/**
 * Delivery-by own-team gate for a Service Case's delivery-back leg. Own team =
 * our lorry, which syncs this DELIVERY leg to the HC Delivery sheet on its DO
 * date; Supplier = a supplier / 3PL delivers and it never reaches the sheet.
 * Mirrors the Inspect-by / Pickup-by own-team gate on the other legs.
 *
 * Extracted from ServiceCases.tsx so that (8,000-line) file stays under its
 * size ceiling; props are kept minimal so it does not couple to the full
 * AssrDetail type.
 */
export function DeliveryByCard({
  c,
  patch,
}: {
  c: { delivery_by?: string | null; do_date?: string | null };
  patch: (body: Record<string, unknown>) => void;
}) {
  return (
    <div className="mb-3 space-y-2 rounded-md border border-border-subtle bg-surface px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span className="w-[130px] shrink-0 text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
          Delivery by
        </span>
        <div className="flex gap-1.5">
          {([
            { v: "own", label: "Own team" },
            { v: "supplier", label: "Supplier" },
          ] as const).map((o) => (
            <button
              key={o.v}
              type="button"
              onClick={() => patch({ delivery_by: c.delivery_by === o.v ? null : o.v })}
              className={cn(
                "rounded-md border px-3 py-1.5 text-[12px] font-semibold transition-colors",
                c.delivery_by === o.v
                  ? "border-primary bg-primary-soft text-primary"
                  : "border-border bg-surface text-ink-secondary hover:border-primary/40",
              )}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>
      {c.delivery_by === "own" && (
        <>
          <InlineEdit
            label="Delivery Date"
            type="date"
            value={c.do_date}
            onSave={(v) => patch({ do_date: v || null })}
          />
          <div className="rounded-md bg-bg/60 px-3 py-2 text-[11.5px] leading-relaxed text-ink-secondary">
            {c.do_date
              ? "Own-team delivery — syncs to the HC Delivery sheet as a delivery job on this date."
              : "Set the delivery date — the own-team delivery then syncs to the HC Delivery sheet."}
          </div>
        </>
      )}
      {c.delivery_by === "supplier" && (
        <div className="rounded-md bg-bg/60 px-3 py-2 text-[11.5px] leading-relaxed text-ink-secondary">
          Supplier / 3PL delivers — not scheduled on the HC Delivery sheet.
        </div>
      )}
    </div>
  );
}
