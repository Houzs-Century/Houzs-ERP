// The owner's decisions of 2026-11-16 on checking FAIR PNL Y'2026 against the Project
// Overview, fair by fair (the file counts up to August only: 「我的文件只拿到8月就好，往后的
// 不要」). Pure — apply-fair-pnl-2026-decisions.mjs reads, this decides.
//
//   1. #2006 is a second copy of #119, AKEMI REX @ PAVILION BUKIT JALIL 30 Jan - 2 Feb: the
//      same Sales again, with no COGS. Its rental (the fair's February half) moves to #119,
//      its setup (the March HOMELOVE @ PEX fair's) to #2254, its lines are archived and it is
//      cancelled (「可以」).
//   2. #2038 ZANOTTI BIGHOME @ STADIUM BUKIT JALIL, 9-12 April: Sales typed into the box by
//      the 27 July import, with no order, no bill and no COGS, and none in the file. Archived
//      (「那就当做没有」).
//   3. Four fairs that ran across two months hold only the first month's rental; the file
//      splits each fair's rental by days. The other month's part is added (「补 4 场」).
//   4. Two fairs' dates and one fair's venue as the file has them (「只改日期场地」).

export const DUPLICATE = {
  duplicateId: 2006, realId: 119, setupToId: 2254, brand: "AKEMI", venue: "PAVILION BUKIT JALIL",
  realStart: "2026-01-30", sales: 77598, rental: 16000, setup: 3447,
};
export const RENTAL_MOVED_DESCRIPTION = "Rental (February half, moved from duplicate #2006; FAIR PNL Y2026)";
export const SETUP_MOVED_DESCRIPTION = "setup (moved from duplicate #2006; FAIR PNL Y2026 March, HOMELOVE @ PEX)";

export const NO_SALES = { projectId: 2038, brand: "ZANOTTI", venue: "STADIUM BUKIT JALIL", start: "2026-04-09", sales: 21490 };

export const RENTAL_PARTS = [
  { projectId: 107, brand: "ERGOTEX", venue: "PAVILION BUKIT JALIL", start: "2026-01-30", has: 12000, add: 12000, part: "February" },
  { projectId: 123, brand: "AKEMI", venue: "MID VALLEY", start: "2026-02-27", has: 27200, add: 13600, part: "March" },
  { projectId: 124, brand: "ERGOTEX", venue: "MID VALLEY", start: "2026-02-27", has: 22000, add: 11000, part: "March" },
  { projectId: 105, brand: "ZANOTTI", venue: "MID VALLEY", start: "2026-02-27", has: 20000, add: 10000, part: "March" },
];
export const rentalPartDescription = (part) => `Rental (${part} part, FAIR PNL Y2026)`;

export const DATE_FIXES = [
  { projectId: 2254, brand: "AKEMI", venue: "PAVILION BUKIT JALIL", from: { start: "2026-03-26", end: "2026-03-28" }, to: { start: "2026-03-06", end: "2026-03-08" } },
  { projectId: 2005, brand: "ZANOTTI", venue: "IOIGECC", from: { start: "2026-02-28", end: "2026-02-28" }, to: { start: "2026-01-30", end: "2026-02-02" } },
];
export const VENUE_FIXES = [{ projectId: 2219, brand: "ZANOTTI", start: "2026-08-28", from: "IOI MALL PUTRAJAYA", to: "IOIGECC" }];

/** Every fair the decisions read. */
export const DECISION_IDS = [...new Set([
  DUPLICATE.duplicateId, DUPLICATE.realId, DUPLICATE.setupToId, NO_SALES.projectId,
  ...RENTAL_PARTS.map((r) => r.projectId), ...DATE_FIXES.map((d) => d.projectId), ...VENUE_FIXES.map((v) => v.projectId),
])];

const COGS = ["cogs", "cogs_matt_sofa", "cogs_bedframe", "cogs_accessories"];
const sen = (rm) => Math.round(Number(rm ?? 0) * 100);
const norm = (s) => String(s ?? "").trim().toUpperCase();
const day = (s) => String(s ?? "").slice(0, 10);

/** RM of a fair's live typed (not auto) lines of a kind and categories. */
export function typed(fair, kind, categories) {
  return fair.lines
    .filter((l) => !l.auto && l.kind === kind && categories.includes(String(l.category ?? "").trim()))
    .reduce((s, l) => s + Number(l.amount ?? 0), 0);
}
const hasLine = (fair, description) => fair.lines.some((l) => l.description === description);

/** Why a fair is not the one a decision names, or null when it is. */
function notTheFair(f, want, companyId) {
  if (!f) return "not found";
  if (Number(f.companyId) !== companyId) return "another company's";
  if (want.brand && norm(f.brand) !== want.brand) return `the brand is not ${want.brand}`;
  if (want.venue && norm(f.venue) !== want.venue) return `the venue is not ${want.venue}`;
  if (want.start && day(f.start) !== want.start) return `it does not start on ${want.start}`;
  return null;
}

/**
 * What to do, from what the system holds now. Each fair is changed only while it is still
 * exactly in the shape the check found; anything else is left alone, with why.
 * @param {ReadonlyArray<{ projectId: number, companyId: number, brand: string | null, venue: string | null,
 *   start: string | null, end: string | null, status: string | null, bills: number, orders: number,
 *   rentalInBooks: number, lines: ReadonlyArray<{ id: number, kind: string, category: string | null,
 *   description: string | null, amount: number, auto: boolean }> }>} now
 * @param {number} companyId
 */
export function planDecisions(now, companyId) {
  const byId = new Map(now.map((f) => [Number(f.projectId), f]));
  const steps = [];
  const left = [];

  /* 1. The duplicate. */
  {
    const d = byId.get(DUPLICATE.duplicateId);
    const r = byId.get(DUPLICATE.realId);
    const s = byId.get(DUPLICATE.setupToId);
    const why = notTheFair(d, DUPLICATE, companyId)
      ?? (norm(d.status) === "CANCELLED" && d.lines.length === 0 ? "already done" : null)
      ?? (norm(d.status) === "CANCELLED" ? "it is cancelled but still holds lines" : null)
      ?? (Number(d.bills) > 0 ? "it has bills keyed" : null)
      ?? (Number(d.orders) > 0 ? "it has orders" : null)
      ?? (sen(typed(d, "income", ["sales"])) !== sen(DUPLICATE.sales) ? "its sales are not the duplicated ones" : null)
      ?? (sen(typed(d, "cost", ["rental"])) !== sen(DUPLICATE.rental) ? "its rental is not the fair's February half" : null)
      ?? (sen(typed(d, "cost", ["setup"])) !== sen(DUPLICATE.setup) ? "its setup is not the March fair's" : null)
      ?? (d.lines.some((l) => !l.auto && !["sales", "rental", "setup"].includes(String(l.category ?? "").trim())) ? "it holds other typed lines" : null)
      ?? (notTheFair(r, { brand: DUPLICATE.brand, venue: DUPLICATE.venue, start: DUPLICATE.realStart }, companyId) ? `#${DUPLICATE.realId}: ${notTheFair(r, { brand: DUPLICATE.brand, venue: DUPLICATE.venue, start: DUPLICATE.realStart }, companyId)}` : null)
      ?? (sen(typed(r, "income", ["sales"])) !== sen(DUPLICATE.sales) ? `#${DUPLICATE.realId}'s sales are not the same, so it is not a duplicate` : null)
      ?? (sen(typed(r, "cost", ["rental"])) !== sen(DUPLICATE.rental) ? `#${DUPLICATE.realId}'s rental is not its January half` : null)
      ?? (hasLine(r, RENTAL_MOVED_DESCRIPTION) ? `#${DUPLICATE.realId} already has the moved rental` : null)
      ?? (notTheFair(s, { brand: DUPLICATE.brand, venue: DUPLICATE.venue }, companyId) ? `#${DUPLICATE.setupToId}: ${notTheFair(s, { brand: DUPLICATE.brand, venue: DUPLICATE.venue }, companyId)}` : null)
      ?? (sen(typed(s, "cost", ["setup"])) !== 0 ? `#${DUPLICATE.setupToId} already has setup` : null)
      ?? (sen(typed(s, "income", ["sales"])) !== 0 ? `#${DUPLICATE.setupToId} has sales` : null);
    if (why) left.push({ projectId: DUPLICATE.duplicateId, decision: "duplicate", why });
    else steps.push({ kind: "duplicate", projectId: DUPLICATE.duplicateId, archive: d.lines.map((l) => Number(l.id)) });
  }

  /* 2. The April sales with nothing behind them. */
  {
    const f = byId.get(NO_SALES.projectId);
    const why = notTheFair(f, NO_SALES, companyId)
      ?? (sen(typed(f, "income", ["sales"])) === 0 ? "already done" : null)
      ?? (Number(f.bills) > 0 ? "it has bills keyed" : null)
      ?? (Number(f.orders) > 0 ? "it has orders" : null)
      ?? (sen(typed(f, "income", ["sales"])) !== sen(NO_SALES.sales) ? "its sales are not the import's box figure" : null)
      ?? (sen(typed(f, "cost", COGS)) !== 0 ? "it has COGS" : null);
    if (why) left.push({ projectId: NO_SALES.projectId, decision: "no sales", why });
    else {
      const archive = f.lines
        .filter((l) => (!l.auto && l.kind === "income" && String(l.category ?? "").trim() === "sales") || l.auto)
        .map((l) => Number(l.id));
      steps.push({ kind: "noSales", projectId: NO_SALES.projectId, archive });
    }
  }

  /* 3. The other month's rental. */
  for (const want of RENTAL_PARTS) {
    const f = byId.get(want.projectId);
    const description = rentalPartDescription(want.part);
    const why = notTheFair(f, want, companyId)
      ?? (hasLine(f, description) ? "already done" : null)
      ?? (Number(f.rentalInBooks) > 0 ? "its rental is in the books" : null)
      ?? (sen(typed(f, "cost", ["rental"])) !== sen(want.has) ? "its rental is not the first month's part" : null);
    if (why) left.push({ projectId: want.projectId, decision: "rental part", why });
    else steps.push({ kind: "rental", projectId: want.projectId, amount: want.add, description });
  }

  /* 4. Dates and venue. */
  for (const want of DATE_FIXES) {
    const f = byId.get(want.projectId);
    const at = f ? { start: day(f.start), end: day(f.end) } : null;
    const why = notTheFair(f, { brand: want.brand, venue: want.venue }, companyId)
      ?? (at.start === want.to.start && at.end === want.to.end ? "already done" : null)
      ?? (at.start !== want.from.start || at.end !== want.from.end ? "its dates are not the ones to fix" : null);
    if (why) left.push({ projectId: want.projectId, decision: "dates", why });
    else steps.push({ kind: "dates", projectId: want.projectId, from: want.from, to: want.to });
  }
  for (const want of VENUE_FIXES) {
    const f = byId.get(want.projectId);
    const why = notTheFair(f, { brand: want.brand, start: want.start }, companyId)
      ?? (norm(f.venue) === want.to ? "already done" : null)
      ?? (norm(f.venue) !== want.from ? "its venue is not the one to fix" : null);
    if (why) left.push({ projectId: want.projectId, decision: "venue", why });
    else steps.push({ kind: "venue", projectId: want.projectId, from: f.venue, to: want.to });
  }

  return { steps, left };
}
