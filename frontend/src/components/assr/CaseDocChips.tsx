// The Customer card's document chips on the desktop case detail: SO No, Ref No.,
// and the order's DO No + Delivery Date (owner 2026-09-28). Mobile renders the
// same four from the same reader (vendor/scm/lib/assr/order-delivery.ts).
import { formatDate } from "../../lib/utils";
import { orderDeliveryOf } from "../../vendor/scm/lib/assr/order-delivery";

function Chip({ label, value, accent }: { label: string; value: string | null | undefined; accent?: boolean }) {
  return (
    <div className="rounded-md border border-border-subtle bg-bg/60 px-2.5 py-2">
      <div className="font-mono text-[9px] font-semibold uppercase tracking-wider text-ink-muted">{label}</div>
      <div
        className={`mt-1 truncate font-mono text-[13px] font-semibold ${accent ? "text-primary-ink" : "text-ink"}`}
        title={value || undefined}
      >
        {value || "—"}
      </div>
    </div>
  );
}

const text = (v: unknown) => (v == null || v === "" ? null : String(v));

export function CaseDocChips({ c: row }: { c: object }) {
  const c = row as Record<string, unknown>;
  const { doNo, deliveryDate } = orderDeliveryOf(c);
  return (
    <div className="grid grid-cols-2 gap-2">
      <Chip label="SO No" value={text(c.doc_no)} accent />
      <Chip label="Ref No." value={text(c.ref_no)} />
      <Chip label="DO No" value={doNo} />
      <Chip label="Delivery Date" value={deliveryDate ? formatDate(deliveryDate) : null} />
    </div>
  );
}
