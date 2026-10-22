// auto-derive-flag-decision — who may hold the auto-derive switch, and for whom.
//
// scm.app_config's PRIMARY KEY is (key) ALONE while the table carries a
// company_id column. One key therefore holds ONE row for the whole database,
// and whoever writes it owns it. That is the shape behind the 2026-09-16
// incident: a Houzs (company 1) GO wrote the single row, and the reader had no
// company predicate, so the switch reached company 2's catalogue too.
//
// The flag is now a SINGLE GLOBAL SWITCH (owner 2026-09-25: both companies must
// behave the same; autoDeriveEnabled reads the one (key) row regardless of
// company). Retail is defended where it is WRITTEN — every derive path merges
// through mergeRetailOntoDerivedSeatGrid, and company 2 carries the DB trigger
// trg_mfg_products_retail_price_lock — so arming company 2 can no longer blank a
// retail price, and it is no longer forbidden. The WRITE side still refuses to
// re-point the existing row at a different company, which would move the switch
// out from under its current owner without saying so.
//
// Pure so the refusal is provable without a database.

/** Companies whose catalogue this mechanism may never be armed over. Empty since
 *  2026-09-25: the switch is global and retail is protected at write time. */
export const DERIVE_FORBIDDEN_COMPANY_IDS = [];

/**
 * @param {{ key: string, companyId: number, desired: string,
 *           existing: { value: string, company_id: number } | null }} input
 * @returns {{ ok: true, action: 'insert' | 'update', from: string | null }
 *          | { ok: false, reason: string }}
 */
export function decideFlagWrite({ key, companyId, desired, existing }) {
  if (!Number.isInteger(companyId) || companyId <= 0) {
    return { ok: false, reason: `COMPANY_ID must be a positive integer (got ${JSON.stringify(companyId)}).` };
  }
  if (!['on', 'off'].includes(desired)) {
    return { ok: false, reason: `DERIVE must be on|off (got ${JSON.stringify(desired)}).` };
  }
  if (desired === 'on' && DERIVE_FORBIDDEN_COMPANY_IDS.includes(companyId)) {
    return {
      ok: false,
      reason:
        `refusing to arm ${key} over company ${companyId}: their retail prices are authored only by ` +
        '2990\'s POS SKU Master and must never be derived from our supplier prices.',
    };
  }
  if (existing && Number(existing.company_id) !== companyId) {
    return {
      ok: false,
      reason:
        `${key} already exists and belongs to company ${existing.company_id}, not ${companyId}. ` +
        'The primary key is (key) alone, so writing it here would move the switch out from under its ' +
        'owner. Decide who owns this flag before running this.',
    };
  }
  return { ok: true, action: existing ? 'update' : 'insert', from: existing ? String(existing.value) : null };
}
