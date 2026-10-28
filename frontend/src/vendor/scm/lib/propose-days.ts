// ----------------------------------------------------------------------------
// propose-days — the DAY-grouped view of the auto-propose result (owner spec
// 2026-08-07/08: dates first, lorries later, never lump-sum).
//
// The backend packer (/delivery-zones/propose) still reasons in lorry-days —
// that is how it knows how many orders fit a day — but the Delivery Date
// Arrangement page must present the proposal as DAY -> orders only: the lorry
// dimension belongs to Delivery Time Arrangement, and a lorry name on the date
// page would promise an assignment nothing has made yet. This pure helper
// folds the wire proposals into per-(date, zone-group) cards with sets/revenue
// as summary numbers and NO lorry field at all, so the page cannot leak one.
//
// Pinned by propose-days.test.ts.
// ----------------------------------------------------------------------------
import type { PackProposal } from './delivery-zones-queries';

export type ProposalDayOrder = {
  ref: string;
  debtorName: string | null;
  zone: string;
  sets: number;
  revenueSen: number;
};

export type ProposalDay = {
  date: string;
  /** The packer's zone group — 'KLANG_VALLEY' (mixed) or a dedicated far zone. */
  group: string;
  orders: ProposalDayOrder[];
  sets: number;
  revenueSen: number;
};

/** Fold the packer's proposals into DAY (+ zone group) cards — deliberately
 *  dropping the lorry fields on the floor. Days sort ascending, groups A->Z
 *  within a day, orders keep the packer's order. */
export function groupProposalsByDay(proposals: PackProposal[]): ProposalDay[] {
  const byKey = new Map<string, ProposalDay>();
  for (const p of proposals) {
    const key = `${p.deliveryDate}\0${p.group}`;
    let day = byKey.get(key);
    if (!day) {
      day = { date: p.deliveryDate, group: p.group, orders: [], sets: 0, revenueSen: 0 };
      byKey.set(key, day);
    }
    day.orders.push({
      ref: p.ref,
      debtorName: p.debtorName ?? null,
      zone: p.zone,
      sets: p.sets,
      revenueSen: p.revenueSen,
    });
    day.sets += p.sets;
    day.revenueSen += p.revenueSen;
  }
  return [...byKey.values()].sort(
    (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.group.localeCompare(b.group)),
  );
}
