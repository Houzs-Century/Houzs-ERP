/* The board's per-leg status dropdown for a Service Case (owner 2026-11-06):
   Delivered / Cancelled / — (pending). Each writes type:'assr' + assrLegStatus;
   the backend stamps the leg's actual_* (delivered) or cancelled_* (cancelled)
   marker and records it, WITHOUT closing the case. n/a for SO / DP / project rows. */
import { describe, expect, test, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MarkDeliveredCell, type MarkDeliveredSchedule } from "./MarkDeliveredCell";
import type { PlanningOrder } from "../lib/delivery-planning-queries";

const assrLeg = (o: Partial<PlanningOrder> = {}): PlanningOrder =>
  ({ row_type: "assr", assr_id: 123, job_kind: "delivery", delivery_state: "PENDING_DELIVERY", ...o }) as unknown as PlanningOrder;

describe("MarkDeliveredCell (leg status dropdown)", () => {
  test("a pending leg defaults to — and can be set Delivered", () => {
    const onSchedule = vi.fn();
    render(<MarkDeliveredCell order={assrLeg()} onSchedule={onSchedule as unknown as MarkDeliveredSchedule} />);
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect(select.value).toBe("pending");
    fireEvent.change(select, { target: { value: "delivered" } });
    expect(onSchedule).toHaveBeenCalledWith(
      expect.objectContaining({ type: "assr", id: "123", jobKind: "delivery", assrLegStatus: "delivered" }),
    );
  });

  test("a leg can be Cancelled from the dropdown", () => {
    const onSchedule = vi.fn();
    render(<MarkDeliveredCell order={assrLeg()} onSchedule={onSchedule as unknown as MarkDeliveredSchedule} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "cancelled" } });
    expect(onSchedule).toHaveBeenCalledWith(expect.objectContaining({ assrLegStatus: "cancelled" }));
  });

  test("a delivered leg shows Delivered selected", () => {
    render(<MarkDeliveredCell order={assrLeg({ delivery_state: "DELIVERED" })} onSchedule={vi.fn() as unknown as MarkDeliveredSchedule} />);
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("delivered");
  });

  test("is not actionable on an SO row", () => {
    render(<MarkDeliveredCell order={assrLeg({ row_type: "so" })} onSchedule={vi.fn() as unknown as MarkDeliveredSchedule} />);
    expect(screen.queryByRole("combobox")).toBeNull();
  });
});
