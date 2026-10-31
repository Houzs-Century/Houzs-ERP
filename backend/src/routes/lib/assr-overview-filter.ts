/* Quality Overview filters (owner 2026-11-01: "该能做的 Filter 都要做上来"):
   supplier, issue category and company, read from the query string and added
   to the caller's visibility predicate, so every read on the page (summary,
   metrics, drill, quality overview) narrows the same way. Each filter only
   narrows: the visibility and allowed-company predicates stay in front of it. */

export type OverviewFilter = { supplier: string | null; category: string | null; company: string | null };

type Scope = (prefix?: string) => { sql: string; binds: string[] };

/** The page's filters from `?fSupplier=&fCategory=&fCompany=`; blank means all. */
export function overviewFilter(c: { req: { query(k: string): string | undefined } }): OverviewFilter {
  const v = (k: string) => (c.req.query(k) ?? "").trim() || null;
  const company = v("fCompany");
  return { supplier: v("fSupplier"), category: v("fCategory"), company: company && /^\d+$/.test(company) ? company : null };
}

export function overviewFilterSql(f: OverviewFilter, prefix: string): { sql: string; binds: string[] } {
  const sql: string[] = [];
  const binds: string[] = [];
  if (f.supplier) { sql.push(` AND ${prefix}creditor_code = ?`); binds.push(f.supplier); }
  if (f.category) { sql.push(` AND ${prefix}issue_category = ?`); binds.push(f.category); }
  if (f.company) { sql.push(` AND ${prefix}company_id = ?`); binds.push(f.company); }
  return { sql: sql.join(""), binds };
}

/** The visibility scope with the page's filters after it, same shape, so a call site swaps one line. */
export function withOverviewFilter(scope: Scope, f: OverviewFilter): Scope {
  return (prefix = "c.") => {
    const a = scope(prefix);
    const b = overviewFilterSql(f, prefix);
    return { sql: a.sql + b.sql, binds: [...a.binds, ...b.binds] };
  };
}
