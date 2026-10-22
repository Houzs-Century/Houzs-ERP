/* Soft-delete sofa combos that have NO supplier binding behind them.

   THE RULE (owner 2026-09-25). A combo follows its supplier binding: the
   MASTER combo (supplier_id IS NULL) is the sales-side reference whose COST is
   meant to auto-derive from a supplier-scoped combo of the same scope. A master
   with NO supplier-scoped sibling derives nothing — "没有 binding 的就不见". This
   removes exactly those masters.

   SCOPE PAIRING is the app's own, not an ad-hoc SQL guess: a combo's scope is
   [base_model, comboSlotsKey(modules), tier, customer_id] (supplier_id
   EXCLUDED). A master is UNBOUND when no non-deleted supplier-scoped row shares
   that scope. comboSlotsKey is imported from the shared module the route uses,
   so this pairs master to supplier exactly as lookup does.

   CONSERVATIVE. "Has a binding" counts ANY non-deleted supplier-scoped row in
   the scope, whatever its effective_from — a future-dated supplier combo still
   spares the master. It deletes every non-deleted master row in an unbound
   scope (not only the latest), so an older history row cannot resurface at
   lookup.

   RETAIL. An unbound master may still carry a hand-entered selling price; the
   plan prints which do. Company 2 (2990) prices are the owner's, and he has
   asked for these gone. DELETE here is SOFT (deleted_at = now()), fully
   reversible.

   MODE=plan (default) lists every unbound master and writes nothing.
   MODE=apply needs CONFIRM="I HAVE REVIEWED THE DRY-RUN", soft-deletes one row
   at a time, then RE-READS on a FRESH connection and asserts the invariant "no
   non-deleted master remains in an unbound scope" (shape, not a row count).

   REVERSAL: UPDATE scm.sofa_combo_pricing SET deleted_at = NULL WHERE id IN
   (<the ids the apply prints>). The apply prints the full id list.

   Env: DATABASE_URL (required); COMPANY (optional, default = every company with
   combos); LIST_LIMIT (rows to print, default 80).

   RE-RUN: idempotent — a soft-deleted row is no longer non-deleted, so a second
   run finds 0 to delete. */
import postgres from 'postgres';
import { comboSlotsKey } from '../src/scm/shared/sofa-combo-pricing.ts';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'I HAVE REVIEWED THE DRY-RUN';
const ONLY_COMPANY = process.env.COMPANY ? Number(process.env.COMPANY) : null;
const LIST_LIMIT = Number(process.env.LIST_LIMIT) > 0 ? Number(process.env.LIST_LIMIT) : 80;

const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });

const scopeKeyOf = (r) =>
  JSON.stringify([r.base_model, comboSlotsKey(r.modules ?? []), r.tier, r.customer_id]);

const hasSelling = (v) =>
  v != null && !['null', '{}', '[]'].includes(String(typeof v === 'string' ? v : JSON.stringify(v)).trim());

/** Every non-deleted master row that sits in a scope with no supplier binding. */
async function planCompany(client, co) {
  const rows = await client`
    SELECT id, base_model, modules, tier, customer_id, supplier_id,
           selling_prices_by_height, prices_by_height, label, effective_from
    FROM scm.sofa_combo_pricing
    WHERE company_id = ${co} AND deleted_at IS NULL`;

  const supplierScopes = new Set();
  for (const r of rows) if (r.supplier_id != null) supplierScopes.add(scopeKeyOf(r));

  const unbound = rows.filter((r) => r.supplier_id == null && !supplierScopes.has(scopeKeyOf(r)));
  return { total: rows.length, unbound };
}

async function main() {
  const companies = ONLY_COMPANY != null
    ? [ONLY_COMPANY]
    : (await sql`SELECT DISTINCT company_id FROM scm.sofa_combo_pricing ORDER BY company_id`).map((r) => Number(r.company_id));

  let grandTotal = 0;
  const allIds = [];
  for (const co of companies) {
    const { total, unbound } = await planCompany(sql, co);
    const withSelling = unbound.filter((r) => hasSelling(r.selling_prices_by_height)).length;
    note(`===== Company ${co} =====`);
    note(`non-deleted combo rows: ${total}; UNBOUND master rows: ${unbound.length} (of which ${withSelling} carry a selling price)`);
    unbound.slice(0, LIST_LIMIT).forEach((r) =>
      note(`  ${r.base_model} | ${r.tier ?? '-'} | ${r.label ?? ''} | selling:${hasSelling(r.selling_prices_by_height) ? 'yes' : 'no'} | ${r.id}`));
    if (unbound.length > LIST_LIMIT) note(`  ... ${unbound.length - LIST_LIMIT} more.`);
    grandTotal += unbound.length;
    for (const r of unbound) allIds.push(r.id);

    if (APPLY) {
      for (const r of unbound) {
        await sql`UPDATE scm.sofa_combo_pricing SET deleted_at = now(), updated_at = now()
                  WHERE id = ${r.id} AND company_id = ${co} AND deleted_at IS NULL`;
      }
      if (unbound.length > 0) note(`APPLIED ${unbound.length} soft-deletes for company ${co}.`);
    }
  }

  if (!APPLY) {
    note(`DRY-RUN total: ${grandTotal} unbound master combo(s) would be soft-deleted across ${companies.length} company(ies). Nothing written.`);
    await sql.end();
    return;
  }

  note(`Soft-deleted ids (REVERSAL: UPDATE scm.sofa_combo_pricing SET deleted_at=NULL WHERE id IN (...)):`);
  allIds.forEach((id) => note(`  ${id}`));

  // Re-read on a FRESH connection and assert the invariant: no non-deleted
  // master remains in an unbound scope.
  await sql.end();
  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  let remaining = 0;
  for (const co of companies) {
    const { unbound } = await planCompany(check, co);
    if (unbound.length > 0) {
      bad(`INVARIANT FAILED: company ${co} still has ${unbound.length} unbound master combo(s) after apply.`);
      remaining += unbound.length;
    }
  }
  await check.end();
  if (remaining > 0) process.exit(1);
  note(`Invariant holds on a fresh connection: 0 unbound master combos remain.`);
}

main().catch((e) => { bad(e instanceof Error ? e.message : String(e)); process.exit(1); });
