// ----------------------------------------------------------------------------
// so-amendment-diff-card — one SO amendment line as WAS / REQUESTING, the card
// the amendment job card (AmendmentDetailV2) renders per line. Its own module so
// the queue's quick view (AmendmentQuickView) shows the SAME card rather than a
// second rendering of the same diff, and without pulling the job card's PDF
// generator into the list route.
// ----------------------------------------------------------------------------

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

/* Amendment prices are stored in sen (1/100 MYR). The amendment detail has no
   currency of its own, so the SO's home currency (MYR) is the honest default. */
const fmtSen = (sen: number | null | undefined): string => fmtMoneySen(sen);

/* change_type -> plain label (parity with the desktop AmendmentDiffModal +
   mobile AmendmentDiffSheet). */
const changeTypeLabel = (t: string): string =>
  t === "SPEC" ? "Spec change" :
  t === "QTY" ? "Quantity change" :
  t === "ADD" ? "Added line" :
  t === "REMOVE" ? "Removed line" : t;

/* old_snapshot reader — shared with the desktop modal + mobile sheet, so the
   three surfaces can never drift on what "before" means. */
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
  /* An axis this line carries that the summary above cannot show. Normally
     empty. When it is not, the spec strings are INCOMPLETE, and a short spec
     string on the Requesting side is precisely what reads as "the amendment
     deleted my divan height". Say it out loud instead. */
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
        {/* Before */}
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
              {/* mig 0280 — the line's REMARK before the request. Shown only when
                  the request touches it, so an untouched instruction does not add
                  noise to every card. */}
              {changed.remark && (old.remark ?? "").trim() && (
                <div className={wasCls(true, "mt-1.5 text-[11px] italic text-ink-secondary")}>
                  “{old.remark}”
                </div>
              )}
              {/* mig 0317 — the discount before the request. Shown only when the
                  request touches it, same rule as the remark above. */}
              {changed.discount && (
                <div className={wasCls(true, "mt-1 font-money text-[11.5px]")}>
                  Discount {fmtSen(old.discountSen ?? 0)}
                </div>
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
              <div className={nowCls(changed.itemCode, "mt-1 font-mono text-[13px]")}>
                {line.new_item_code ?? old.itemCode ?? "—"}
              </div>
              <div className="mt-0.5 font-money text-[11.5px]">
                <span className={nowCls(changed.qty, "")}>Qty {line.new_qty ?? old.qty ?? "—"}</span>
                {typeof line.new_unit_price_sen === "number" ? (
                  <>
                    <span className="text-ink-muted">{" · "}</span>
                    <span className={nowCls(changed.unitPrice, "")}>{fmtSen(line.new_unit_price_sen)}</span>
                  </>
                ) : ""}
              </div>
              {newSummary && (
                <div className={nowCls(changed.variants, "mt-1.5 text-[11px]")}>
                  {newSummary}
                </div>
              )}
              {/* mig 0280 — the REQUESTED remark. On a service line this text IS
                  the request ("Please take back Cody Bedframe (King Size) 2
                  units"), so an approver who cannot read it is approving a line
                  with no visible purpose. Empty string = a request to CLEAR the
                  remark, which must say so rather than render as nothing. */}
              {changed.remark && (
                <div className={nowCls(true, "mt-1.5 text-[11px] italic")}>
                  {(line.new_remark ?? "").trim() ? `“${line.new_remark}”` : "Remark cleared"}
                </div>
              )}
              {/* mig 0317 — the REQUESTED discount. On a delivery-fee line this
                  number IS the request (unit stays derived; the discount is the
                  sanctioned reduction), so an approver who cannot see it is
                  signing a money change blind. 0 = a request to clear it. */}
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
