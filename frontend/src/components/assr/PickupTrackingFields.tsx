// Pickup / Return step tracking (HC-0129): status, scheduled (ETA) + actual
// pickup date side by side, PIC, and where the item is now. The scheduled date
// IS customer_pickup_at (the date the board / HC sheet already plan on), so it
// is relabelled here rather than duplicated. Kept out of ServiceCases.tsx,
// which is at its size ceiling.
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
};

export function PickupTrackingFields({ c, patch }: { c: Row; patch: (body: Record<string, string | null>) => Promise<void> }) {
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
        placeholder="Driver / Supplier / Logistics"
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
