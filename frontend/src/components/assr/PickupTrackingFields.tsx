// Pickup / Return step tracking (HC-0129): status, scheduled (ETA) + actual
// pickup date side by side, PIC, and where the item is now. The scheduled date
// IS customer_pickup_at (the date the board / HC sheet already plan on), so it
// is relabelled here rather than duplicated. Kept out of ServiceCases.tsx,
// which is at its size ceiling.
import { useQuery } from "@tanstack/react-query";
import { api } from "../../api/client";
import { InlineEdit } from "../InlineEdit";
import {
  ITEM_LOCATION_OPTIONS,
  PICKUP_STATUS_OPTIONS,
  pickupTrackingLabel,
} from "../../vendor/scm/lib/assr-pickup-tracking";

type Row = {
  pickup_status?: string | null;
  customer_pickup_at?: string | null;
  actual_pickup_at?: string | null;
  pickup_pic?: string | null;
  item_location?: string | null;
  creditor_name?: string | null;
  supplier?: string | null;
};

/** Active Fleet drivers' names, for the Pickup PIC dropdown (HC-0129). */
export function usePickupPicDrivers(): string[] {
  const { data } = useQuery({
    queryKey: ["assr-pickup-pic-drivers"],
    queryFn: () => api.get<{ data?: { name: string }[] }>("/api/assr/pickup-pic-drivers"),
    staleTime: 5 * 60_000,
  });
  return (data?.data ?? []).map((d) => d.name);
}

/** The case's supplier first, then the drivers. A PIC typed before the
 *  dropdown is not in here; the callers keep showing it. */
export function pickupPicChoices(drivers: string[], supplier: string | null): string[] {
  return [...new Set([...(supplier ? [supplier] : []), ...drivers])];
}

export const pickupPicLabel = (supplier: string | null) => (v: string): string =>
  v === supplier ? `${v} (Supplier)` : v;

export function PickupTrackingFields({ c, patch }: { c: Row; patch: (body: Record<string, string | null>) => Promise<void> }) {
  const drivers = usePickupPicDrivers();
  const supplier = c.creditor_name || c.supplier || null;
  return (
    <>
      <InlineEdit
        label="Pickup Status"
        value={c.pickup_status}
        options={PICKUP_STATUS_OPTIONS}
        optionLabel={pickupTrackingLabel}
        onSave={(v) => patch({ pickup_status: v })}
      />
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        <InlineEdit
          label="Scheduled Pickup Date (ETA)"
          type="date"
          value={c.customer_pickup_at}
          onSave={(v) => patch({ customer_pickup_at: v })}
        />
        <InlineEdit
          label="Actual Pickup Date"
          type="date"
          value={c.actual_pickup_at}
          onSave={(v) => patch({ actual_pickup_at: v })}
        />
      </div>
      <InlineEdit
        label="Pickup PIC"
        value={c.pickup_pic}
        options={pickupPicChoices(drivers, supplier)}
        optionLabel={pickupPicLabel(supplier)}
        onSave={(v) => patch({ pickup_pic: v })}
      />
      <InlineEdit
        label="Current Item Location"
        value={c.item_location}
        options={ITEM_LOCATION_OPTIONS}
        optionLabel={pickupTrackingLabel}
        onSave={(v) => patch({ item_location: v })}
      />
    </>
  );
}
