// Pickup / Return step tracking (HC-0129), shown as two sections: Pickup Details
// (who collects, status, scheduled (ETA) + actual date, PIC) and Item Tracking
// (where the item is now). The scheduled date IS customer_pickup_at (the date
// the board / HC sheet already plan on), so it is relabelled here rather than
// duplicated. PIC and location are typed by hand (Operation Dept 2026-11-09).
// Kept out of ServiceCases.tsx, which is at its size ceiling.
import type { ReactElement } from "react";
import { cn } from "../../lib/utils";
import { InlineEdit } from "../InlineEdit";
import { PICKUP_STATUS_OPTIONS, pickupTrackingLabel } from "../../vendor/scm/lib/assr-pickup-tracking";
import { CaseSection } from "./CaseSection";
import { LogisticsConfirmedNote } from "./LogisticsConfirmedNote";

// Re-exported so the mobile case page takes the whole Pickup / Return set from one import (it is at its size ceiling).
export { PICKUP_STATUS_OPTIONS, pickupTrackingLabel, pickupTrackingOptions } from "../../vendor/scm/lib/assr-pickup-tracking";

export interface PickupTrackingRow {
  pickup_status?: string | null;
  customer_pickup_at?: string | null;
  actual_pickup_at?: string | null;
  pickup_by?: string | null;
  sched_pickup_date?: string | null;
  pickup_pic?: string | null;
  item_location?: string | null;
}

export interface PickupTrackingFieldsProps {
  c: PickupTrackingRow;
  patch: (body: Record<string, string | null>) => Promise<void>;
}

// Own team pickup (stored 'customer') = our logistics goes to the customer's
// house, which syncs the PICKUP leg to the HC Delivery sheet; Supplier direct =
// the supplier collects it themselves and it never reaches the sheet.
export const PICKUP_BY_OPTIONS = [
  { value: "customer", label: "Own team pickup" },
  { value: "supplier", label: "Supplier direct" },
] as const;

export function PickupTrackingFields({ c, patch }: PickupTrackingFieldsProps): ReactElement {
  return (
    <>
      <CaseSection title="1. Pickup Details" badge={null} icon={null} action={null} isCollapsible={false}>
        <div>
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">Pickup By</div>
          <div className="flex flex-wrap gap-1.5">
            {PICKUP_BY_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => patch({ pickup_by: c.pickup_by === option.value ? null : option.value })}
                className={cn(
                  "min-h-[36px] rounded-md border px-3 py-1.5 text-[12px] font-semibold transition-colors",
                  c.pickup_by === option.value
                    ? "border-primary bg-primary-soft text-primary"
                    : "border-border bg-surface text-ink-secondary hover:border-primary/40",
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          <InlineEdit
            label="Pickup Status"
            value={c.pickup_status}
            options={PICKUP_STATUS_OPTIONS}
            optionLabel={pickupTrackingLabel}
            onSave={(value) => patch({ pickup_status: value })}
          />
          <InlineEdit
            label="Pickup PIC"
            value={c.pickup_pic}
            placeholder="Who collects it, e.g. Zamree (HOK)"
            onSave={(value) => patch({ pickup_pic: value?.trim() || null })}
          />
          <InlineEdit
            label="Scheduled Pickup (ETA)"
            type="date"
            value={c.customer_pickup_at}
            onSave={(value) => patch({ customer_pickup_at: value })}
          />
          <InlineEdit
            label="Actual Pickup"
            type="date"
            value={c.actual_pickup_at}
            onSave={(value) => patch({ actual_pickup_at: value })}
          />
        </div>
        {c.pickup_by === "customer" && !c.actual_pickup_at && (
          <LogisticsConfirmedNote requested={c.customer_pickup_at} confirmed={c.sched_pickup_date} />
        )}
      </CaseSection>
      <CaseSection title="2. Item Tracking" badge={null} icon={null} action={null} isCollapsible={false}>
        <InlineEdit
          label="Current Item Location"
          value={c.item_location ? pickupTrackingLabel(c.item_location) : null}
          placeholder="Where the item is now, e.g. Warehouse - Balakong"
          onSave={(value) => patch({ item_location: value?.trim() || null })}
        />
      </CaseSection>
    </>
  );
}
