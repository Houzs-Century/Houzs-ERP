// ----------------------------------------------------------------------------
// acc/masters-company — the ONE place that decides which company's ACCOUNTING
// MASTERS (chart of accounts, account roles, acquirers) a posting reads.
//
// WHY THIS FILE EXISTS. The decision was written THREE times, as three
// hand-copied ternaries, and all three silently substituted company 1:
//
//   engine.ts:94    checkAccounts  — `companyId == null ? 1 : Number(companyId)`
//   rules.ts:93     resolveRoles   — the same expression, inline in the filter
//   payments.ts:51  transitFor     — the same expression again
//
// Three copies of one rule is this repo's recorded repeat offender, and here it
// had a second problem on top: `engine.ts` uses `companyId == null` to mean TWO
// DIFFERENT THINGS inside one call. The WRITE path treats null as "stamp no
// company" (`:208` `companyId != null ? { company_id: companyId } : {}`); the
// LOOKUP path treated the same null as "company 1". So an entry whose company
// could not be resolved was validated against company 1's chart, took company
// 1's role codes and company 1's acquirer mapping, and was then written with no
// company at all.
//
// WHAT THIS DOES NOT DO, and why. It does not refuse. `requireActiveCompanyId`
// (scm/lib/companyScope.ts:114) is the repo's stated rule for a WRITE — "Never
// degrades, never defaults" — and posting a journal entry is unambiguously a
// write, so the substitution contradicts the house rule. But null is REACHABLE
// from real rows, not just from a degraded request: `accounting.ts:295`,
// `payment-vouchers.ts:694` and `:1409` all pass the DOCUMENT's own nullable
// `company_id`. Refusing today would stop those documents posting, and whether
// any exist is a question about production data, not about this file. So the
// behaviour is preserved EXACTLY and the substitution is made loud instead of
// silent — flipping it to a refusal is then one line, here, once the population
// is known.
//
// The owner decision and the measurement it needs are recorded in
// docs/bugs/0615-the-accounting-masters-fell-back-to-company-1-in-silence.md.
// ----------------------------------------------------------------------------

/** The company whose masters a posting falls back to when the entry carries no
 *  company of its own. It is the base company by construction, not a magic
 *  number: `companyScope.ts` mints bare document numbers for the same one. */
export const ACC_MASTERS_FALLBACK_COMPANY_ID = 1;

/**
 * Which company's accounting masters to read for this entry.
 *
 * `companyId` is REQUIRED and `| null` rather than optional — CLAUDE.md's rule
 * for a parameter that DECIDES something. A caller with no company must type
 * the null and thereby say so.
 *
 * `where` names the call site and appears in the log, so a substitution can be
 * traced to the read that made it rather than to "somewhere in accounting".
 */
export function accMastersCompanyId(companyId: number | null | undefined, where: string): number {
  if (companyId != null) return Number(companyId);
  /* Loud on every substitution. This used to be silent, which is why an entry
     validated against another company's chart looked exactly like one validated
     against its own. eslint-disable-next-line no-console */
  // eslint-disable-next-line no-console
  console.error(
    `[acc/masters] ${where}: entry carries NO company_id — reading company ${ACC_MASTERS_FALLBACK_COMPANY_ID}'s masters. ` +
      `The entry itself will be written with no company (engine.ts companyCol), so these two disagree by construction.`,
  );
  return ACC_MASTERS_FALLBACK_COMPANY_ID;
}
