import { describe, expect, it } from "vitest";
import { jobDone, outNotClosed } from "./logisticDone";
import type { PlanningOrder } from "../../vendor/scm/lib/delivery-planning-queries";
import type { JobProgress } from "../../vendor/scm/lib/delivery-job";

const so = (state: string, dos: string[]) => ({ row_type: "so", so_doc_no: "S", delivery_state: state, delivery_orders: dos.map((status, i) => ({ id: String(i), do_number: `D${i}`, status })) }) as unknown as PlanningOrder;
const job = (row_type: string, so_doc_no: string, delivery_state: string, extra: object) => ({ row_type, so_doc_no, delivery_state, delivery_orders: [], ...extra }) as unknown as PlanningOrder;
const done = (key: string): Map<string, JobProgress> => new Map([[key, { source_type: "", source_id: "", leg: "", departed_at: null, arrived_at: null, completed_at: "2026-11-07T03:00:00Z" }]]);

describe("a job is done only when it is really finished", () => {
  it("a sales order whose delivery order is only loaded is out, not done (W2's 18)", () => {
    expect(jobDone(so("DELIVERED", ["LOADED"]), new Map())).toBe(false);
    expect(outNotClosed(so("DELIVERED", ["LOADED"]))).toBe(true);
  });
  it("every live delivery order closed as delivered makes it done; a cancelled one does not count", () => {
    expect(jobDone(so("DELIVERED", ["DELIVERED", "SIGNED", "CANCELLED"]), new Map())).toBe(true);
    expect(jobDone(so("DELIVERED", ["DELIVERED", "IN_TRANSIT"]), new Map())).toBe(false);
  });
  it("an event set-up is done when the crew completed it, not when its day passes", () => {
    const leg = job("project", "PRJ:10#SETUP", "DELIVERED", {});
    expect(jobDone(leg, new Map())).toBe(false);
    expect(jobDone(leg, done("project:10:SETUP"))).toBe(true);
  });
  it("a supplier pickup the crew completed is done", () => {
    expect(jobDone(job("dp", "DP:5", "DELIVERED", { dp_job_type: "SUPPLIER_PICKUP" }), new Map())).toBe(true);
    expect(jobDone(job("dp", "DP:5", "PENDING_DELIVERY", { dp_job_type: "SUPPLIER_PICKUP" }), done("dp:5:SUPPLIER_PICKUP"))).toBe(true);
  });
});
