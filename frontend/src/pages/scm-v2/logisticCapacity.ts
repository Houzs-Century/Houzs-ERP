// Lorry Capacity on the Logistic Overview's own rules (owner 2026-11-07: "用同一套算法").
// Trips, delivery trips, orders, set-ups, stock moves, services, days and revenue come
// from the overview's lorry figures (KL, Southern and Northern; a run under 3 orders is
// half a trip); the lorry list, its type, the in-house flag, GPS km and running cost come
// from the capacity read, which the overview does not carry.
import type { LorryCapacityRow, LorryCapacityTotals } from "../../vendor/scm/lib/lorry-capacity-queries";
import type { LorryRow } from "./LogisticDailySection";

const key = (plate: string) => plate.replace(/[^A-Z0-9]/gi, "").toUpperCase();
const div = (a: number, b: number) => (b > 0 ? a / b : null);

export function capacityFromOverview(cap: readonly LorryCapacityRow[], overview: readonly LorryRow[]): LorryCapacityRow[] {
  const byPlate = new Map(overview.map((l) => [key(l.lorry), l]));
  return cap.map((c) => {
    const o = byPlate.get(key(c.plate));
    if (!o) {
      return { ...c, work_days: 0, total_trips: 0, delivery_days: 0, deliveries: 0, orders_per_trip: null, setup_dismantle: 0, pickups: 0, services: 0,
        delivery_revenue_sen: 0, revenue_per_order_sen: null, revenue_per_trip_sen: null, utilisation: c.available_days > 0 ? 0 : null };
    }
    return {
      ...c,
      work_days: o.usedDays,
      repair_days: o.downDays,
      available_days: o.workingDays,
      utilisation: o.occupancyPct == null ? null : o.occupancyPct / 100,
      total_trips: o.trips,
      delivery_days: o.daysOut,
      deliveries: o.doOrders,
      orders_per_trip: div(o.doOrders, o.daysOut),
      setup_dismantle: o.fairTrips,
      pickups: Math.round(o.stockTrips * 2),
      services: o.serviceOrders,
      delivery_revenue_sen: o.amountSen,
      revenue_per_order_sen: div(o.amountSen, o.doOrders),
      revenue_per_trip_sen: o.perDayOutSen,
    };
  });
}

/** The tiles over the table, from the rows shown. */
export function capacityTotals(rows: readonly LorryCapacityRow[]): LorryCapacityTotals {
  const sum = (f: (r: LorryCapacityRow) => number) => rows.reduce((a, r) => a + f(r), 0);
  const trips = sum((r) => r.total_trips), deliveryTrips = sum((r) => r.delivery_days), orders = sum((r) => r.deliveries);
  const revenue = sum((r) => r.delivery_revenue_sen), available = sum((r) => r.available_days);
  return {
    lorries: rows.length,
    total_trips: trips,
    available_days: available,
    utilisation: div(trips, available),
    orders_per_delivery_trip: div(orders, deliveryTrips),
    delivery_revenue_sen: revenue,
    revenue_per_order_sen: div(revenue, orders),
    revenue_per_trip_sen: div(revenue, deliveryTrips),
  };
}

/** A trip count as read: a half trip shows as .5, never rounded to a whole. */
export const tripsText = (n: number | null | undefined): string => (n == null || !Number.isFinite(n) ? "—" : n % 1 === 0 ? String(n) : n.toFixed(1));
