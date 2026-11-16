// A fair's typed "sales" line that repeats its bills (2026-11-16): which lines
// archive-duplicate-fair-sales-lines.mjs archives, and which it leaves alone and
// why. Pure — the script reads the rows, this decides.
//
// Eight June 2026 fairs carry their sales twice: their bills (sales_entries,
// imported 2026-07-01) and one typed project_finance_lines row (income / sales)
// written 2026-07-28 by the align-figures pass of #1397, of exactly the same
// amount. Only that shape is a duplicate: the align pass's own line, the fair's
// only typed sales line, equal to the cent to the bills that are not void.

export const ALIGN_DESCRIPTION = "sales (FAIR PNL v8 align)";

/**
 * @typedef {{ lineId: number, projectId: number, companyId: number | null, projectCompanyId: number,
 *   description: string | null, amount: number, bills: number, billsSum: number, typedSalesLines: number }} SalesLineRow
 * @param {readonly SalesLineRow[]} rows  live typed income / sales lines of fairs that have bills
 * @param {number} companyId              the company the run is scoped to
 * @returns {{ archive: SalesLineRow[], left: Array<SalesLineRow & { why: string }> }}
 */
export function pickDuplicateSalesLines(rows, companyId) {
  const archive = [];
  const left = [];
  for (const r of rows) {
    const why = whyNot(r, companyId);
    if (why) left.push({ ...r, why });
    else archive.push(r);
  }
  return { archive, left };
}

/** Why a line is not the duplicate to archive, or null when it is. */
function whyNot(r, companyId) {
  if (Number(r.projectCompanyId) !== companyId) return "the fair is another company's";
  if (r.companyId != null && Number(r.companyId) !== companyId) return "the line is stamped with another company";
  if (r.description !== ALIGN_DESCRIPTION) return "not the align pass's line";
  if (!(Number(r.bills) > 0)) return "the fair has no bills";
  if (Math.round(Number(r.amount) * 100) !== Math.round(Number(r.billsSum) * 100)) return "its amount is not the bills' total";
  if (Number(r.typedSalesLines) !== 1) return "the fair has more than one typed sales line";
  return null;
}
