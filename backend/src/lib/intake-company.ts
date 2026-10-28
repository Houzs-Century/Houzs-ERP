/**
 * Resolve a company CODE to its id for a pre-auth (shared-secret) route.
 *
 * Google's servers call the intake / sheet-sync endpoints: there is no session
 * and no X-Company-Id, so `companyContext` never runs. The rule since
 * 2026-08-18 is that each shared SECRET carries its own company, and the id is
 * read from the master rather than hard-coded so a renamed or re-seeded company
 * breaks loudly instead of silently exporting the wrong tenant.
 *
 *  · `{ master: false }` — the companies master is not readable AT ALL
 *    (pre-migration / the D1 test mirror). The install is single-company, there
 *    is no second tenant to leak to, so a caller MAY degrade to no predicate —
 *    the same three-state contract as scm/lib/companyScope.ts.
 *  · `{ master: true, id: null }` — the master IS readable and has no row for
 *    this code. That is a MISCONFIGURATION, not a legacy state, and the caller
 *    must refuse: falling back to "no predicate" here would re-open the exact
 *    hole on the day someone renames a company code.
 */
export async function intakeCompany(
  db: D1Database,
  code: string,
): Promise<{ master: boolean; id: number | null }> {
  try {
    const row = await db
      .prepare(`SELECT id FROM companies WHERE code = ? LIMIT 1`)
      .bind(code)
      .first<{ id: number | string }>();
    return { master: true, id: row?.id != null ? Number(row.id) : null };
  } catch {
    return { master: false, id: null };
  }
}
