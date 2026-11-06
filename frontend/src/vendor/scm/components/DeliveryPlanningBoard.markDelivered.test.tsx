/* The board's per-leg "Mark Delivered" for a Service Case (owner 2026-11-06).
   Marking a leg Delivered writes type:'assr' + deliveryState='DELIVERED' (the
   backend stamps the leg's actual_* date and records it, WITHOUT closing the
   case); clicking a Delivered leg reopens it (PENDING_DELIVERY). It is n/a for
   SO / DP / project rows, which derive their own delivered state. */
import { describe, expect, test, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MarkDeliveredCell } from "./DeliveryPlanningBoard";
import type { PlanningOrder } from "../lib/delivery-planning-queries";

const assrLeg = (o: Partial<PlanningOrder> = {}): PlanningOrder =>
  ({ row_type: "assr", assr_id: 123, job_kind: "delivery", delivery_state: "PENDING_DELIVERY", ...o }) as unknown as PlanningOrder;

describe("MarkDeliveredCell", () => {
  test("marks an un-delivered service leg Delivered (does not close the case)", () => {
    const onSchedule = vi.fn();
    render(<MarkDeliveredCell order={assrLeg()} onSchedule={onSchedule as never} />);
    fireEvent.click(screen.getByRole("button", { name: "Mark delivered" }));
    expect(onSchedule).toHaveBeenCalledWith(
      expect.objectContaining({ type: "assr", id: "123", jobKind: "delivery", deliveryState: "DELIVERED" }),
    );
  });

  test("a Delivered leg reopens to PENDING_DELIVERY", () => {
    const onSchedule = vi.fn();
    render(<MarkDeliveredCell order={assrLeg({ delivery_state: "DELIVERED" })} onSchedule={onSchedule as never} />);
    fireEvent.click(screen.getByRole("button", { name: "Delivered" }));
    expect(onSchedule).toHaveBeenCalledWith(expect.objectContaining({ deliveryState: "PENDING_DELIVERY" }));
  });

  test("is not actionable on an SO row", () => {
    render(<MarkDeliveredCell order={assrLeg({ row_type: "so" })} onSchedule={vi.fn() as never} />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
