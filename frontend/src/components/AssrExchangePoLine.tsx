import { Fragment } from "react";
import { assrOrderPoHref, assrExchangePos } from "../vendor/scm/lib/assr/case-fields";

/* Read-only "Exchange PO" line on the desktop case detail: the REAL purchase
   orders raised FROM this case for a one-to-one exchange
   (scm.purchase_orders.assr_case_id). Distinct from the SO-derived "Order PO"
   (AssrOrderPoLine) and the number-only "PO No" (po_no) — these are real
   documents, the entry into PO -> GRN -> purchase return / purchase invoice.
   Each number opens its purchase order in a new window seeded with the CASE's
   company (assrOrderPoHref), the same as Order PO. */
export function AssrExchangePoLine({ row }: { row: { company_id?: number | string | null; exchange_pos?: unknown } }) {
  const pos = assrExchangePos(row);
  if (pos.length === 0) return null;
  const companyId = row.company_id == null ? null : Number(row.company_id);
  return (
    <div className="mb-2">
      <div
        className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-muted"
        title="Real purchase orders raised from this case for a one-to-one exchange. Receive, return and bill them in the Purchase Order / GRN / Purchase Return / Purchase Invoice modules."
      >
        Exchange PO
      </div>
      <div className="font-mono text-[12px] text-ink">
        {pos.map((p, i) => (
          <Fragment key={p.id}>
            {i > 0 && " · "}
            <a href={assrOrderPoHref(p, companyId)} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
              {p.po_number}
            </a>
            {p.status && <span className="ml-1 text-[10px] text-ink-muted">({p.status})</span>}
          </Fragment>
        ))}
      </div>
    </div>
  );
}
