/* Which finished events are missing a line every settled fair carries
   (routes/projectDataGaps.ts). Amounts are RM as project_finance_lines keeps
   them; soSen is the Sales Orders opened at the event, in sen. */
export interface GapProject {
  id: number; code: string; name: string; brand: string | null; end_date: string | null;
  income: number; cogs: number; commission: number; cost: number; soSen: number;
}

const pick = (p: GapProject) => ({ id: p.id, code: p.code, name: p.name, brand: p.brand, endDate: (p.end_date ?? "").slice(0, 10), income: p.income, cost: p.cost, soSen: p.soSen });

export function classifyProjectGaps(projects: GapProject[]) {
  const noSales = projects.filter((p) => !(p.income > 0)).sort((a, b) => b.soSen - a.soSen || b.cost - a.cost);
  const noCogs = projects.filter((p) => p.income > 0 && !(p.cogs > 0)).sort((a, b) => b.income - a.income);
  const noCommission = projects.filter((p) => p.income > 0 && !(p.commission > 0)).sort((a, b) => b.income - a.income);
  const months = new Map<string, { month: string; ended: number; withSales: number }>();
  for (const p of projects) {
    const m = (p.end_date ?? "").slice(0, 7);
    if (!m) continue;
    const row = months.get(m) ?? { month: m, ended: 0, withSales: 0 };
    row.ended += 1;
    if (p.income > 0) row.withSales += 1;
    months.set(m, row);
  }
  return {
    ended: projects.length,
    noSales: { count: noSales.length, costBooked: noSales.reduce((a, p) => a + p.cost, 0), soSen: noSales.reduce((a, p) => a + p.soSen, 0), rows: noSales.slice(0, 300).map(pick) },
    noCogs: { count: noCogs.length, salesAffected: noCogs.reduce((a, p) => a + p.income, 0), rows: noCogs.slice(0, 300).map(pick) },
    noCommission: { count: noCommission.length, salesAffected: noCommission.reduce((a, p) => a + p.income, 0), rows: noCommission.slice(0, 300).map(pick) },
    byMonth: [...months.values()].sort((a, b) => a.month.localeCompare(b.month)),
  };
}
