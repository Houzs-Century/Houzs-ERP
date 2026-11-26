
import { fmtMoneySen } from "@2990s/shared";
import type { AmendmentLine } from "../../vendor/scm/lib/so-amendment-queries";
import {
  amendmentLineChangedFields,
  amendmentLineFieldKinds,
  amendmentOldSnapshot,
  amendmentUnrenderedAxes,
  amendmentVariantSummaries,
} from "../../vendor/scm/lib/so-amendment-line-diff";
import { RowRoutingChips } from "../../vendor/scm/components/AmendmentRouting";
import { cn } from "../../lib/utils";

const fmtSen = (sen: number | null | undefined): string => fmtMoneySen(sen);

const changeTypeLabel = (t: string): string =>
  t === "SPEC" ? "Spec change" :
  t === "QTY" ? "Quantity change" :
  t === "ADD" ? "Added line" :
  t === "REMOVE" ? "Removed line" : t;

const oldOf = amendmentOldSnapshot;

/* Owner 2026-07-16 — WAS / REQUESTING used to be two plain columns you had to
   diff character-by-character. The changed field is now emphasised on the
   Requesting side and struck through on the Was side: the SAME idiom the header
   diff rows above already use, so the card gains a signal, not a redesign.
   Unchanged fields stay muted on both sides — they are context, not the ask. */
const wasCls = (changed: boolean, base: string): string =>
  cn(base, changed && "line-through decoration-ink-muted/60");
/* Owner 2026-07-27 — the changed value on the Requesting side is now RED (was
   petrol) so the approver's eye lands on exactly what the customer is asking to
   change. Unchanged fields stay muted context on both sides. */
const nowCls = (changed: boolean, base: string): string =>
  cn(base, changed ? "font-semibold text-err" : "text-ink-muted");

export function SoAmendmentDiffCard({ line }: { line: AmendmentLine }) {
  const old = oldOf(line);
  const { to: newSummary, from: oldSummary } = amendmentVariantSummaries(line);
  const changed = amendmentLineChangedFields(line);
  const isAdd = line.change_type === "ADD";
  const isRemove = line.change_type === "REMOVE";
  const unrendered = amendmentUnrenderedAxes(line);
  const unrenderedAll = [...new Set([...unrendered.from, ...unrendered.to])];

  return (
    <div className="overflow-hidden rounded-md border border-border">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border-subtle bg-surface-2 px-3 py-1.5">
        <span className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-secondary">
          {changeTypeLabel(line.change_type)}
        </span>
        <RowRoutingChips kinds={amendmentLineFieldKinds(line)} />
      </div>
      <div className="grid grid-cols-2 divide-x divide-border-subtle">
        <div className="p-3">
          <div className="font-mono text-[9px] font-semibold uppercase tracking-brand text-ink-muted">
            Was
          </div>
          {isAdd ? (
            <div className="mt-1 text-[12px] text-ink-muted">New line — nothing before</div>
          ) : (
            <>
              <div className={wasCls(changed.itemCode, "mt-1 font-mono text-[13px] font-semibold text-ink")}>
                {old.itemCode ?? "—"}
              </div>
              <div className="mt-0.5 font-money text-[11.5px] text-ink-muted">
                <span className={wasCls(changed.qty, "")}>Qty {old.qty ?? "—"}</span>
                {typeof old.unitPriceSen === "number" ? (
                  <>
                    {" · "}
                    <span className={wasCls(changed.unitPrice, "")}>{fmtSen(old.unitPriceSen)}</span>
                  </>
                ) : ""}
              </div>
              {oldSummary && (
                <div className={wasCls(changed.variants, "mt-1.5 text-[11px] font-semibold text-ink-secondary")}>
                  {oldSummary}
                </div>
              )}
              {changed.remark && (old.remark ?? "").trim() && (
                <div className={wasCls(true, "mt-1.5 text-[11px] italic text-ink-secondary")}>
                  “{old.remark}”
                </div>
              )}
              {changed.discount && (
                <div className={wasCls(true, "mt-1 font-money text-[11.5px]")}>
                  Discount {fmtSen(old.discountSen ?? 0)}
                </div>
              )}
            </>
          )}
        </div>
        <div className="p-3">
          <div className="font-mono text-[9px] font-semibold uppercase tracking-brand text-ink-muted">
            Requesting
          </div>
          {isRemove ? (
            <div className="mt-1 text-[12px] font-semibold text-err">Removed</div>
          ) : (
            <>
              <div className={nowCls(changed.itemCode, "mt-1 font-mono text-[13px]")}>
                {line.new_item_code ?? old.itemCode ?? "—"}
              </div>
              <div className="mt-0.5 font-money text-[11.5px]">
                <span className={nowCls(changed.qty, "")}>Qty {line.new_qty ?? old.qty ?? "—"}</span>
                {typeof (line.new_unit_price_sen ?? old.unitPriceSen) === "number" ? (
                  <>
                    <span className="text-ink-muted">{" · "}</span>
                    <span className={nowCls(changed.unitPrice, "")}>{fmtSen((line.new_unit_price_sen ?? old.unitPriceSen) as number)}</span>
                  </>
                ) : ""}
              </div>
              {newSummary && (
                <div className={nowCls(changed.variants, "mt-1.5 text-[11px]")}>
                  {newSummary}
                </div>
              )}
              {changed.remark && (
                <div className={nowCls(true, "mt-1.5 text-[11px] italic")}>
                  {(line.new_remark ?? "").trim() ? `“${line.new_remark}”` : "Remark cleared"}
                </div>
              )}
              {changed.discount && (
                <div className={nowCls(true, "mt-1 font-money text-[11.5px]")}>
                  {Math.round(line.new_discount_sen ?? 0) > 0
                    ? `Discount ${fmtSen(line.new_discount_sen ?? 0)}`
                    : "Discount cleared"}
                </div>
              )}
            </>
          )}
        </div>
      </div>
      {unrenderedAll.length > 0 && (
        <div className="border-t border-border-subtle bg-warn/10 px-3 py-2 text-[11.5px] text-ink">
          This line also carries {unrenderedAll.join(", ")}, which the summary above
          cannot display. Open the Sales Order to check the full specification before approving.
        </div>
      )}
    </div>
  );
}
