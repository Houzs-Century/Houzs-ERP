import { Fragment } from "react";
import { assrOrderPoHref, assrOrderPos } from "../vendor/scm/lib/assr/case-fields";

/* Read-only "Order PO" line on the desktop case detail, above the editable
   PO No (the case's own service PO). Each number opens its purchase order in a
   new window seeded with the CASE's company — see assrOrderPoHref. */
export function AssrOrderPoLine({ row }: { row: { company_id?: number | string | null; order_pos?: unknown } }) {
  const pos = assrOrderPos(row);
  const companyId = row.company_id == null ? null : Number(row.company_id);
  return (
    <div className="mb-2">
      <div
        className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-muted"
        title="Supplier purchase orders raised from this case's sales order. Read-only."
      >
        Order PO
      </div>
      <div className="font-mono text-[12px] text-ink">
        {pos.length === 0
          ? "—"
          : pos.map((p, i) => (
              <Fragment key={p.id}>
                {i > 0 && " · "}
                <a href={assrOrderPoHref(p, companyId)} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
                  {p.po_number}
                </a>
              </Fragment>
            ))}
      </div>
    </div>
  );
}
