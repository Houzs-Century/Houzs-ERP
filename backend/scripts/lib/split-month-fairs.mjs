// The fairs of 27 July – 2 August 2026 that Finance's FAIR PNL Y'2026 splits into a
// July row and an August row (owner 2026-11-16: 「我给你资料你核对」, 「这个只是我的预计
// 算法，但要算」). The system holds their COGS, rental and setup for the whole fair
// (July + August) but their Sales only for July, and on five of them a July-only
// typed commission line that stops the brand's rate from working the commission
// on the rest. Pure — add-august-part-split-fairs.mjs reads, this decides.

/** Each fair: its July sales as the system holds them today, its August sales from the file. */
export const SPLIT_FAIRS = [
  { projectId: 469, brand: "AKEMI", venue: "SUNWAY KLUANG", julySales: 11428, augustSales: 47864 },
  { projectId: 2217, brand: "ZANOTTI", venue: "SUNWAY KLUANG", julySales: 0, augustSales: 7300 },
  { projectId: 391, brand: "AKEMI", venue: "AEON KOTA BHARU", julySales: 41176, augustSales: 37594 },
  { projectId: 2216, brand: "ZANOTTI", venue: "AEON KOTA BHARU", julySales: 0, augustSales: 21130 },
  { projectId: 232, brand: "AKEMI", venue: "SUNWAY PYRAMID", julySales: 47854, augustSales: 242887 },
  { projectId: 233, brand: "ZANOTTI", venue: "SUNWAY PYRAMID", julySales: 4180, augustSales: 49494 },
  { projectId: 397, brand: "ERGOTEX", venue: "SUNWAY PYRAMID", julySales: 3388, augustSales: 10888 },
];

export const AUGUST_DESCRIPTION = "sales (FAIR PNL Y2026, August part)";

const sen = (rm) => Math.round(Number(rm ?? 0) * 100);

/**
 * What to do on each fair, from what the system holds now.
 * @param {ReadonlyArray<{ projectId: number, companyId: number, name: string, brand: string | null, endDate: string | null,
 *   typedSales: number, bills: number, augustLines: number, commissionLines: ReadonlyArray<{ id: number, amount: number }> }>} now
 * @param {number} companyId
 * @returns {{ add: Array<{ projectId: number, augustSales: number, archiveCommission: number[] }>, left: Array<{ projectId: number, why: string }> }}
 */
export function planSplitFairs(now, companyId) {
  const byId = new Map(now.map((f) => [Number(f.projectId), f]));
  const add = [];
  const left = [];
  for (const want of SPLIT_FAIRS) {
    const f = byId.get(want.projectId);
    const why = !f ? "not found"
      : Number(f.companyId) !== companyId ? "another company's"
      : String(f.brand ?? "").trim().toUpperCase() !== want.brand ? `the brand is not ${want.brand}`
      : !String(f.name ?? "").toUpperCase().includes(want.venue) ? `the name does not say ${want.venue}`
      : String(f.endDate ?? "").slice(0, 10) !== "2026-08-02" ? "it does not end on 2026-08-02"
      : Number(f.augustLines) > 0 ? "its August part is already in"
      : Number(f.bills) > 0 ? "it has bills keyed"
      : sen(f.typedSales) !== sen(want.julySales) ? "its sales are not the July part the file shows"
      : null;
    if (why) left.push({ projectId: want.projectId, why });
    else add.push({ projectId: want.projectId, augustSales: want.augustSales, archiveCommission: f.commissionLines.map((l) => Number(l.id)) });
  }
  return { add, left };
}
