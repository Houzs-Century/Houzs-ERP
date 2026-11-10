import type { Env } from "../types";
import { claimFromCounter, yymmFor } from "./documentRefs";

/**
 * Generates the next internal service PO number in format
 * APO/YYMM-NNN (Assr Purchase Order), month in MYT. The number comes from the
 * atomic counter (scm.next_doc_no_n) floored at the month's live max, so two
 * Generate PO presses on two cases cannot read the same max and print the
 * same number; without it (D1 mirror) max + 1.
 */
export async function nextServicePONumber(env: Env, nowMs = Date.now()): Promise<string> {
  const prefix = `APO/${yymmFor(nowMs)}`;
  const rows = await env.DB.prepare(`SELECT po_no FROM assr_cases WHERE po_no LIKE ?`)
    .bind(`${prefix}-%`)
    .all<{ po_no: string }>();
  const floor = maxSuffix(rows.results.map((r) => r.po_no), `${prefix}-`);
  const next = (await claimFromCounter(env, prefix, floor)) ?? floor + 1;
  return `${prefix}-${String(next).padStart(3, "0")}`;
}

/**
 * MAN-NNNN code for a supplier added by hand from a Service Case. It used to be
 * COUNT(MAN-%) + 1, which re-issues an existing code the moment one code is
 * missing from the run (count 3 over MAN-0001/0002/0004 gives MAN-0004 again)
 * and every later add then fails as a duplicate.
 */
export async function nextManualCreditorCode(env: Env): Promise<string> {
  const rows = await env.DB.prepare(
    `SELECT creditor_code FROM creditors WHERE creditor_code LIKE 'MAN-%'`
  ).all<{ creditor_code: string }>();
  const floor = maxSuffix(rows.results.map((r) => r.creditor_code), "MAN-");
  const next = (await claimFromCounter(env, "MAN", floor)) ?? floor + 1;
  return `MAN-${String(next).padStart(4, "0")}`;
}

// Numeric max, not text max: text order puts -999 above -1000.
function maxSuffix(codes: string[], prefix: string): number {
  let max = 0;
  for (const code of codes) {
    if (!code.startsWith(prefix)) continue;
    const n = Number(code.slice(prefix.length));
    if (Number.isInteger(n) && n > max) max = n;
  }
  return max;
}

/** Stamps a fresh APO number on a case that has none. `po_no IS NULL` on the
 *  write: a second press racing the first must not overwrite the number the
 *  first already returned. On a lost race, the number now stored. */
export async function assignServicePoNumber(
  env: Env,
  caseId: number,
): Promise<{ ok: true; poNo: string } | { ok: false; poNo: string | null }> {
  const poNo = await nextServicePONumber(env);
  const claimed = await env.DB.prepare(
    `UPDATE assr_cases SET po_no = ?, updated_at = datetime('now') WHERE id = ? AND po_no IS NULL`
  )
    .bind(poNo, caseId)
    .run();
  if (claimed.meta.changes) return { ok: true, poNo };
  const now = await env.DB.prepare(`SELECT po_no FROM assr_cases WHERE id = ?`)
    .bind(caseId)
    .first<{ po_no: string | null }>();
  return { ok: false, poNo: now?.po_no ?? null };
}
