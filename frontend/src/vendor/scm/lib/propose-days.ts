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
