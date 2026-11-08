/* Logistic Overview · on-time delivery (owner 2026-11-08). The page renders the
   server's figures as they come (backend/tests/onTimeDelivery.test.ts pins the rules):
   the rate, the four counts, per lorry / driver / region, and a figure opens its orders. */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, test } from "vitest";
import { LogisticOnTimeSection } from "./LogisticOnTimeSection";
import type { OnTimeData, OnTimeGroup } from "../../vendor/scm/lib/on-time-queries";

const g = (key: string, x: Partial<OnTimeGroup>): OnTimeGroup => ({ key, lorryId: null, delivered: 0, onTime: 0, early: 0, late: 0, lateOpen: 0, ratePct: null, ...x });
const data: OnTimeData = {
  today: "2026-11-08", from: "2026-11-01", to: "2026-11-30",
  delivered: 3, onTime: 1, early: 1, late: 1, lateOpen: 1, ratePct: 66.7,
  byLorry: [g("WXX 1", { lorryId: "l1", delivered: 2, onTime: 1, early: 1, ratePct: 100 }), g("WXX 2", { lorryId: "l2", delivered: 1, late: 1, ratePct: 0 })],
  byDriver: [g("Ali", { delivered: 3, onTime: 1, early: 1, late: 1, lateOpen: 1, ratePct: 66.7 })],
  byRegion: [g("KL / Selangor", { delivered: 3, onTime: 1, early: 1, late: 1, lateOpen: 1, ratePct: 66.7 })],
  excluded: { offPeninsula: 2, noPromise: 0, noDeliveryTime: 1 },
  orders: [
    { soDocNo: "SO-4", customer: "Dan", promised: "2026-11-04", delivered: null, daysLate: 4, result: "LATE_OPEN", region: "KL / Selangor", lorryId: "l1", lorry: "WXX 1", driver: "Ali" },
    { soDocNo: "SO-3", customer: "Cat", promised: "2026-11-03", delivered: "2026-11-05", daysLate: 2, result: "LATE", region: "KL / Selangor", lorryId: "l2", lorry: "WXX 2", driver: "Ali" },
    { soDocNo: "SO-2", customer: "Ben", promised: "2026-11-03", delivered: "2026-11-02", daysLate: -1, result: "EARLY", region: "KL / Selangor", lorryId: "l1", lorry: "WXX 1", driver: "Ali" },
    { soDocNo: "SO-1", customer: "Amy", promised: "2026-11-03", delivered: "2026-11-03", daysLate: 0, result: "ON_TIME", region: "KL / Selangor", lorryId: "l1", lorry: "WXX 1", driver: "Ali" },
  ],
};

const renderIt = () => render(<MemoryRouter><LogisticOnTimeSection data={data} loading={false} error={null} /></MemoryRouter>);

describe("on-time delivery section", () => {
  test("shows the rate, the counts and what was left out", () => {
    renderIt();
    expect(screen.getAllByText("66.7%").length).toBe(3);
    expect(screen.getByText("2 of 3 delivered")).toBeTruthy();
    expect(screen.getByText(/2 East Malaysia \/ Singapore · 1 closed with no delivery time/)).toBeTruthy();
    expect(screen.getByText("WXX 2")).toBeTruthy();
    expect(screen.getByText("0%")).toBeTruthy();
  });

  test("the Late tile opens the late orders with promised, delivered and days late", () => {
    renderIt();
    fireEvent.click(screen.getByText("after the promised date"));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("SO-3")).toBeTruthy();
    expect(within(dialog).getByText("2 late")).toBeTruthy();
    expect(within(dialog).queryByText("SO-1")).toBeNull();
  });

  test("a lorry row opens that lorry's orders", () => {
    renderIt();
    fireEvent.click(screen.getByText("WXX 1"));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("SO-1")).toBeTruthy();
    expect(within(dialog).getByText("SO-4")).toBeTruthy();
    expect(within(dialog).queryByText("SO-3")).toBeNull();
  });
});
