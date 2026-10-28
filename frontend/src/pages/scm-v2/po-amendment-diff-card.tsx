// ----------------------------------------------------------------------------
// po-amendment-diff-card — one PO amendment line as WAS / REQUESTING, the card
// the PO amendment job card (PoAmendmentDetailV2) renders per line. Its own
// module for the same reason as so-amendment-diff-card: the PO queue's quick
// view shows the same card, without the job card's PDF generator.
// ----------------------------------------------------------------------------

import { fmtMoneySen } from "@2990s/shared";
import { amendmentVariantSummaries } from "../../vendor/scm/lib/so-amendment-line-diff";
import { poLineFieldKinds, type PoAmendmentLine } from "../../vendor/scm/lib/po-amendment-queries";
import { RowRoutingChips } from "../../vendor/scm/components/AmendmentRouting";
import { cn, formatDate } from "../../lib/utils";

/* PO amendment prices are stored in centi (1/100 MYR). */
const fmtSen = (centi: number | null | undefined): string => fmtMoneySen(centi);

const changeTypeLabel = (t: string): string =>
  t === "SPEC" ? "Spec change" :
  t === "QTY" ? "Quantity change" :
  t === "PRICE" ? "Cost change" :
  t === "DELIVERY" ? "Delivery change" :
  t === "ADD" ? "Added line" :
  t === "REMOVE" ? "Removed line" : t;

/* Read the old_snapshot blob a PO amendment line records. */
type PoOldSnapshot = {
  item_code?: string | null;
  material_name?: string | null;
  qty?: number | null;
  unit_price_sen?: number | null;
  delivery_date?: string | null;
  // Spec fields — the follow-up preview records these so the card can show what a
  // SPEC change moved (variant summary), rendered via amendmentVariantSummaries.
  variants?: unknown;
  item_group?: string | null;
  description2?: string | null;
};
const oldOf = (l: PoAmendmentLine): PoOldSnapshot =>
  (l.old_snapshot as PoOldSnapshot | null) ?? {};

export function PoAmendmentDiffCard({ line }: { line: PoAmendmentLine }) {
  const old = oldOf(line);
  const isAdd = line.change_type === "ADD";
  const isRemove = line.change_type === "REMOVE";

  const oldCode = old.item_code ?? null;
  const oldName = old.material_name ?? null;
  const newCode = line.new_item_code ?? oldCode;
  const newName = line.new_material_name ?? oldName;

  const codeChanged = !isAdd && !isRemove && line.new_item_code != null && line.new_item_code !== oldCode;
  const qtyChanged = !isAdd && !isRemove && line.new_qty != null && line.new_qty !== (old.qty ?? null);
  const priceChanged = !isAdd && !isRemove && line.new_unit_price_sen != null && line.new_unit_price_sen !== (old.unit_price_sen ?? null);
  const deliveryChanged = !isAdd && !isRemove && line.new_delivery_date != null && line.new_delivery_date !== (old.delivery_date ?? null);

  /* The variant SUMMARY each side renders — a colour/fabric/special change (the
     common SO-driven follow-up) moves no item_code, so it only shows here.
     Group-aware via the shared SO helper so a bedframe line reads its own axes.
     Guarded on new_variants so a QTY row's null blob never reads as a cleared spec. */
  const spec = amendmentVariantSummaries({
    change_type: line.change_type,
    new_variants: line.new_variants,
    old_snapshot: line.old_snapshot,
  });
  const specChanged = !isAdd && !isRemove && line.new_variants != null && spec.from !== spec.to;

  const wasCls = (changed: boolean, base: string): string =>
    cn(base, changed && "line-through decoration-ink-muted/60");
  const nowCls = (changed: boolean, base: string): string =>
    cn(base, changed ? "font-semibold text-primary-ink" : "text-ink-muted");

  return (
    <div className="overflow-hidden rounded-md border border-border">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border-subtle bg-surface-2 px-3 py-1.5">
        <span className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-secondary">
          {changeTypeLabel(line.change_type)}
        </span>
        <RowRoutingChips kinds={poLineFieldKinds(line)} />
      </div>
      <div className="grid grid-cols-2 divide-x divide-border-subtle">
        {/* Before */}
        <div className="p-3">
          <div className="font-mono text-[9px] font-semibold uppercase tracking-brand text-ink-muted">
            Was
          </div>
          {isAdd ? (
            <div className="mt-1 text-[12px] text-ink-muted">New line — nothing before</div>
          ) : (
            <>
              <div className={wasCls(codeChanged, "mt-1 font-mono text-[13px] font-semibold text-ink")}>
                {oldCode ?? "—"}
              </div>
              {oldName && (
                <div className={wasCls(codeChanged, "mt-0.5 text-[11px] text-ink-secondary")}>{oldName}</div>
              )}
              <div className="mt-0.5 font-money text-[11.5px] text-ink-muted">
                <span className={wasCls(qtyChanged, "")}>Qty {old.qty ?? "—"}</span>
                {typeof old.unit_price_sen === "number" ? (
                  <>
                    {" · "}
                    <span className={wasCls(priceChanged, "")}>{fmtSen(old.unit_price_sen)}</span>
                  </>
                ) : ""}
              </div>
              {old.delivery_date && (
                <div className={wasCls(deliveryChanged, "mt-1 text-[11px] text-ink-secondary")}>
                  Delivery {formatDate(old.delivery_date)}
                </div>
              )}
              {specChanged && (
                <div className={wasCls(specChanged, "mt-1 text-[11px] text-ink-secondary")}>{spec.from || "—"}</div>
              )}
            </>
          )}
        </div>
        {/* After */}
        <div className="p-3">
          <div className="font-mono text-[9px] font-semibold uppercase tracking-brand text-ink-muted">
            Requesting
          </div>
          {isRemove ? (
            <div className="mt-1 text-[12px] font-semibold text-err">Removed</div>
          ) : (
            <>
              <div className={nowCls(codeChanged, "mt-1 font-mono text-[13px]")}>
                {newCode ?? "—"}
              </div>
              {newName && (
                <div className={nowCls(codeChanged, "mt-0.5 text-[11px]")}>{newName}</div>
              )}
              <div className="mt-0.5 font-money text-[11.5px]">
                <span className={nowCls(qtyChanged, "")}>Qty {line.new_qty ?? old.qty ?? "—"}</span>
                {typeof line.new_unit_price_sen === "number" ? (
                  <>
                    <span className="text-ink-muted">{" · "}</span>
                    <span className={nowCls(priceChanged, "")}>{fmtSen(line.new_unit_price_sen)}</span>
                  </>
                ) : ""}
              </div>
              {line.new_delivery_date && (
                <div className={nowCls(deliveryChanged, "mt-1 text-[11px]")}>
                  Delivery {formatDate(line.new_delivery_date)}
                </div>
              )}
              {specChanged && (
                <div className={nowCls(specChanged, "mt-1 text-[11px]")}>{spec.to || "—"}</div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* Header change labels — the AMENDABLE_HEADER trust boundary keys. */
const HEADER_LABEL: Record<string, string> = {
  supplier_id: "Supplier",
  expected_at: "Delivery date",
  notes: "Notes",
};
const headerValueDisplay = (key: string, v: string | null): string => {
  if (v == null || v === "") return "—";
  if (key === "expected_at") return formatDate(v);
  return v;
};

export type PoAmendmentHeaderDiffRow = { key: string; label: string; from: string; to: string };

/** The PO amendment's HEADER half as before -> after rows (supplier / delivery
 *  date / notes), for the job card and the queue's quick view alike. */
export function poAmendmentHeaderDiffRows(
  changes: Record<string, string | null> | null | undefined,
  oldSnap: Record<string, string | null> | null | undefined,
): PoAmendmentHeaderDiffRow[] {
  if (!changes) return [];
  return Object.keys(changes).map((k) => ({
    key: k,
    label: HEADER_LABEL[k] ?? k,
    from: headerValueDisplay(k, oldSnap?.[k] ?? null),
    to: headerValueDisplay(k, changes[k] ?? null),
  }));
}
