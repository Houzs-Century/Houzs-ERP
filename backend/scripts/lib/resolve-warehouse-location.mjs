/* resolve-warehouse-location.mjs — the ONE rule that maps a Sales Order's
   free-text `sales_location` snapshot onto a canonical `scm.warehouses.id`,
   CODE first then NAME, within the SAME company, and ONLY when the match is
   unambiguous.

   This is the tested SPEC of the backfill in migration
   `..._so_header_warehouse_id_backfill.sql`. The migration performs the same
   resolution in SQL (correlated subqueries over scm.warehouses scoped by
   company_id); this pure function pins the RULE so it can be unit-tested on a
   bare checkout, and so a future reader can see the decision table without
   reading Postgres. If the two ever disagree, the SQL is the one that ran
   against prod — fix whichever is wrong, but they must stay identical.

   NO SHEBANG — imported by backend/tests/resolveWarehouseLocation.test.mjs; see
   the shebang trap in CLAUDE.md.

   The rule (matches the census + the migration exactly):
     1. trim the location; empty / null => unresolved.
     2. CODE: warehouses in the same company whose `code` equals the location.
        exactly one  => resolved by code.
        more than one => ambiguous (do NOT guess) => unresolved.
        zero          => fall through to NAME.
     3. NAME: warehouses in the same company whose `name` equals the location.
        exactly one  => resolved by name.
        otherwise    => unresolved (zero, or ambiguous).
   Matching is case-sensitive equality, mirroring the SQL `=` and the fact that
   `sales_location` is written by warehouseLabel() which emits the code verbatim.
*/

const trimOrNull = (v) => {
  const s = (v ?? "").toString().trim();
  return s === "" ? null : s;
};

/**
 * @param {string|null|undefined} salesLocation the SO header free-text snapshot
 * @param {Array<{id: string, code?: string|null, name?: string|null}>} warehouses
 *        the candidate warehouses ALREADY scoped to the SO's company
 * @returns {{ id: string|null, matchedBy: 'code'|'name'|null,
 *             reason: 'resolved'|'empty'|'ambiguous_code'|'ambiguous_name'|'no_match' }}
 */
export function resolveWarehouseLocation(salesLocation, warehouses) {
  const loc = trimOrNull(salesLocation);
  if (loc === null) return { id: null, matchedBy: null, reason: "empty" };

  const list = Array.isArray(warehouses) ? warehouses : [];

  const codeHits = list.filter((w) => trimOrNull(w.code) === loc);
  if (codeHits.length === 1) return { id: codeHits[0].id, matchedBy: "code", reason: "resolved" };
  if (codeHits.length > 1) return { id: null, matchedBy: null, reason: "ambiguous_code" };

  const nameHits = list.filter((w) => trimOrNull(w.name) === loc);
  if (nameHits.length === 1) return { id: nameHits[0].id, matchedBy: "name", reason: "resolved" };
  if (nameHits.length > 1) return { id: null, matchedBy: null, reason: "ambiguous_name" };

  return { id: null, matchedBy: null, reason: "no_match" };
}
