import { describe, expect, it } from "vitest";
import { capacityFromOverview, capacityTotals } from "./logisticCapacity";
import type { LorryCapacityRow } from "../../vendor/scm/lib/lorry-capacity-queries";
import type { LorryRow } from "./LogisticDailySection";

const cap = (plate: string, o: Partial<LorryCapacityRow> = {}): LorryCapacityRow => ({
  lorry_id: plate, plate, type: null, is_internal: true, work_days: 9, repair_days: 0, available_days: 25, utilisation: 0.1, total_trips: 9,
  delivery_days: 9, deliveries: 9, orders_per_trip: 1, setup_dismantle: 9, pickups: 9, services: 9, delivery_revenue_sen: 9,
  revenue_per_order_sen: 9, revenue_per_trip_sen: 9, km: 120, running_cost_sen: 13200, ...o,
});
const ov: LorryRow = { lorry: "VQE 9058", internal: true, daysOut: 5.5, fairTrips: 1, stockTrips: 0.5, usedDays: 6, trips: 7, otherTrips: 1.5,
  doOrders: 22, serviceOrders: 1, workingDays: 6, downDays: 0, occupancyPct: 116.7, orders: 23, amountSen: 110_000_00, perDayOutSen: 20_000_00 };

describe("Lorry Capacity on the overview's figures", () => {
  it("takes trips, orders, revenue and days from the overview, km and cost from capacity", () => {
    const [r] = capacityFromOverview([cap("VQE9058")], [ov]);
    expect(r).toMatchObject({ total_trips: 7, delivery_days: 5.5, deliveries: 22, setup_dismantle: 1, pickups: 1, services: 1,
      delivery_revenue_sen: 110_000_00, revenue_per_trip_sen: 20_000_00, work_days: 6, available_days: 6, utilisation: 1.167, km: 120, running_cost_sen: 13200 });
    expect(r!.orders_per_trip).toBeCloseTo(4, 0);
  });
  it("a lorry with no work in the period reads zero, not the capacity read's own count", () => {
    expect(capacityFromOverview([cap("PDR7734")], [ov])[0]).toMatchObject({ total_trips: 0, deliveries: 0, delivery_revenue_sen: 0 });
  });
  it("the tiles add up the rows shown", () => {
    const rows = capacityFromOverview([cap("VQE9058"), cap("PDR7734")], [ov]);
    expect(capacityTotals(rows)).toMatchObject({ lorries: 2, total_trips: 7, delivery_revenue_sen: 110_000_00, available_days: 31 });
  });
});
