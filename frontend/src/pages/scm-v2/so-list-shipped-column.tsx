/* The "Delivered" column — how much of an order has LEFT.
   Its sibling "Stock Status" answers ARRIVAL; the two were one column until
   2026-09-02, so an order with everything arrived and half shipped read plain
   READY and the shortfall was on no screen (owner: 「partialy delivery 该怎么办
   呢」). Full rule in docs/modules/sales-order.md §0.4b.

   A MODULE and not twenty lines in the list page, for two reasons: the page is
   over its file-size ceiling, and a column descriptor that lives beside its
   renderer is the shape a second list can reuse without copying the sort rule. */
import type { Column } from "../../components/DataTable";
import { ShippedProgressPill } from "../../components/ShippedProgressPill";
import {
  shippedProgressOf,
  shippedProgressLabel,
  type ShippedProgressFields,
} from "../../vendor/scm/lib/shipped-progress";

/* Re-exported so a surface that renders the CELL (the drill-down line) and
   the COLUMN (the list row) takes one import, not two. */
export { ShippedProgressPill };

export function shippedProgressColumn<R extends ShippedProgressFields>(): Column<R> {
  return {
    key: "shipped_progress",
    group: "Logistics",
    label: "Delivered",
    width: "120px",
    defaultHidden: true,
    disableSort: true,
    getValue: (r) => {
      const p = shippedProgressOf(r);
      return p.state === "unknown" ? "" : (shippedProgressLabel(p) ?? "");
    },
    /* Least-complete first, so the orders still owing goods sort to the top.
       `unknown` sorts LAST — it is not a small number, it is no number, and
       heading the list with rows that say nothing helps nobody. */
    sortValue: (r) => {
      const p = shippedProgressOf(r);
      if (p.state === "unknown") return 2;
      return p.deliverable > 0 ? p.shipped / p.deliverable : 1;
    },
    render: (r) => <ShippedProgressPill row={r} />,
  };
}
