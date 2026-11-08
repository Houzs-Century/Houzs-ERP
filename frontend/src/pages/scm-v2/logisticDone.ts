// When a job on Delivery Planning is really done (owner 2026-11-07: "every task completed
// or delivered"). The board calls an order Delivered once its delivery orders cover it,
// which includes a DO only loaded on the lorry; here a sales order is done only when each
// of its live delivery orders is closed as delivered. A set-up, dismantle, supplier
// pickup, transfer or service job is done when the crew completed it.
import { DO_DELIVERED_STATUSES } from "../../vendor/scm/lib/delivery-stop-status";
import { jobKey, jobRefOf, type JobProgress } from "../../vendor/scm/lib/delivery-job";
import type { PlanningOrder } from "../../vendor/scm/lib/delivery-planning-queries";

export type Progress = ReadonlyMap<string, JobProgress>;

/** Every live delivery order of the order is closed as delivered. */
export function dosClosed(o: PlanningOrder): boolean {
  const live = o.delivery_orders.filter((d) => d.status !== "CANCELLED");
  return live.length > 0 && live.every((d) => DO_DELIVERED_STATUSES.includes(d.status));
}

export function jobDone(o: PlanningOrder, progress: Progress): boolean {
  if (o.row_type === "so") return o.delivery_state === "DELIVERED" && dosClosed(o);
  const ref = jobRefOf(o);
  const completed = ref != null && progress.get(jobKey(ref))?.completed_at != null;
  /* An event leg has no delivered state of its own: only the crew's Complete closes it. */
  if (o.row_type === "project") return completed;
  return completed || o.delivery_state === "DELIVERED";
}

/** On the board as Delivered, but a delivery order is not closed yet. */
export const outNotClosed = (o: PlanningOrder): boolean => o.row_type === "so" && o.delivery_state === "DELIVERED" && !dosClosed(o);
