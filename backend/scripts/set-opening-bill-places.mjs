#!/usr/bin/env node
/* Set where payments of the opening bills read in the Cash Flow (owner
   2026-11-25, 「要，做 A」): Finance's choices per supplier and per bill, the
   same ones the Cash Flow's "Opening bills" dialog keeps, for a list agreed
   with the owner. COMPANY_ID=<id> is required.

   INPUT (the Actions log is public: codes only, never a name or an amount):
     SUPPLIERS="<supplier code>><place>,…"        e.g. 400-A001>601-0001,405-B002>@cf:ops:exh
     BILLS="<opening bill number>><place>,…"      e.g. HC-API-2608-001>900-M001
   A place is an account code, @<Cash Flow category id>, or - to clear the choice.

   MODE=plan (default) checks every code against the company — a supplier with
   no opening bill, a bill that is not one of its opening bills, an account it
   does not have or a bank account, a category its Cash Flow does not print
   refuse the plan — prints each change from -> to and the plan's PLAN_ID, and
   writes nothing. MODE=apply needs CONFIRM="I HAVE REVIEWED THE OPENING BILL
   PLACES" and PLAN_ID=<the id the plan printed>: one transaction, each row by
   its company and only while it still holds the reviewed value. Then a FRESH
   connection re-reads every choice of the company and checks the shape: each
   target holds the planned place, every row exactly one of an account or a
   category, each account one of the company's.

   RE-RUN: inert once applied. A target that already holds the asked place is
   no change, so a second plan lists nothing.

   Run: Actions → "Run a backend script on production". */
import './lib/public-log-guard.mjs';
import { createHash } from 'node:crypto';
import postgres from 'postgres';
import { parsePairs, placeText, planFor, shapeProblems, visibleCategories } from './lib/opening-bill-places-plan.mjs';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'I HAVE REVIEWED THE OPENING BILL PLACES';
const CO = Number(process.env.COMPANY_ID);
const WHO = 'script:set-opening-bill-places';

const say = (m) => console.log(m);
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}
if (!(Number.isInteger(CO) && CO > 0)) {
  bad(`COMPANY_ID must be a company id, not "${process.env.COMPANY_ID ?? ''}"`);
  process.exit(2);
}
const suppliersAsked = parsePairs(process.env.SUPPLIERS, 'SUPPLIERS');
const billsAsked = parsePairs(process.env.BILLS, 'BILLS');
for (const r of [suppliersAsked, billsAsked]) if (!r.ok) { bad(r.message); process.exit(2); }

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });

const placeMap = (rows, key) => new Map(rows.map((r) => [String(r[key]), { account: r.account_code ?? null, category: r.account_code ? null : (r.category_id ?? null) }]));
const readPlaces = async (client) => ({
  suppliers: placeMap(await client`SELECT supplier_id::text AS supplier_id, account_code, category_id FROM scm.acc_opening_supplier_places WHERE company_id = ${CO}`, 'supplier_id'),
  bills: placeMap(await client`SELECT ap_invoice_id::text AS ap_invoice_id, account_code, category_id FROM scm.acc_opening_bill_places WHERE company_id = ${CO}`, 'ap_invoice_id'),
});

async function factsOf(client) {
  /* A supplier is named by its code, or by its id where the code names more than one. */
  const supplierKeys = suppliersAsked.pairs.map((p) => p.key);
  const billNumbers = billsAsked.pairs.map((p) => p.key);
  const suppliers = supplierKeys.length === 0 ? [] : await client`
    SELECT DISTINCT s.code, s.id::text AS id
      FROM scm.suppliers s JOIN scm.ap_invoices a ON a.supplier_id = s.id AND a.company_id = s.company_id AND a.opening
     WHERE s.company_id = ${CO} AND (s.code = ANY(${supplierKeys}) OR s.id::text = ANY(${supplierKeys}))`;
  const bills = billNumbers.length === 0 ? [] : await client`
    SELECT invoice_number, id::text AS id FROM scm.ap_invoices
     WHERE company_id = ${CO} AND opening AND invoice_number = ANY(${billNumbers})`;
  const accounts = await client`SELECT account_code, acc_money, is_active FROM scm.accounts WHERE company_id = ${CO}`;
  const [layout] = await client`SELECT tree FROM scm.acc_report_layouts WHERE report = 'rp'`;
  const places = await readPlaces(client);
  const asked = new Set(supplierKeys);
  const codeCount = new Map();
  for (const s of suppliers) if (asked.has(s.code)) codeCount.set(s.code, (codeCount.get(s.code) ?? 0) + 1);
  const twice = [...codeCount].filter(([, k]) => k > 1).map(([code]) => code);
  if (twice.length > 0) throw new Error(`supplier code(s) ${twice.join(', ')} name more than one supplier of company ${CO}: name those by id; nothing planned`);
  const supplierIdOf = new Map();
  for (const s of suppliers) {
    if (asked.has(s.code)) supplierIdOf.set(s.code, s.id);
    if (asked.has(s.id)) supplierIdOf.set(s.id, s.id);
  }
  return {
    supplierIdOf,
    billIdOf: new Map(bills.map((b) => [b.invoice_number, b.id])),
    accounts: new Map(accounts.map((a) => [a.account_code, { money: a.acc_money === true, active: a.is_active === true }])),
    categories: visibleCategories(layout?.tree ?? null, CO),
    supplierPlaces: places.suppliers,
    billPlaces: places.bills,
  };
}

/** The plan's id: the same changes on the same rows give the same id. */
const planId = (changes) => createHash('sha256')
  .update(changes.map((c) => [CO, c.kind, c.id, placeText(c.from), placeText(c.to)].join('|')).sort().join('\n'))
  .digest('hex').slice(0, 12);

/* One change, only while the row still holds the reviewed choice: a new row only where none is,
   an edit or a clear only of the row as it was planned. Each statement names the company. */
async function write(tx, c) {
  const f = c.from;
  const t = c.to;
  if (c.kind === 'supplier') {
    if (f === null) {
      return tx`INSERT INTO scm.acc_opening_supplier_places (company_id, supplier_id, account_code, category_id, updated_at, updated_by)
                VALUES (${CO}, ${c.id}::uuid, ${t.account}, ${t.category}, now(), ${WHO}) ON CONFLICT DO NOTHING RETURNING 1 AS ok`;
    }
    if (t === null) {
      return tx`DELETE FROM scm.acc_opening_supplier_places
                 WHERE company_id = ${CO} AND supplier_id = ${c.id}::uuid
                   AND account_code IS NOT DISTINCT FROM ${f.account} AND category_id IS NOT DISTINCT FROM ${f.category} RETURNING 1 AS ok`;
    }
    return tx`UPDATE scm.acc_opening_supplier_places SET account_code = ${t.account}, category_id = ${t.category}, updated_at = now(), updated_by = ${WHO}
               WHERE company_id = ${CO} AND supplier_id = ${c.id}::uuid
                 AND account_code IS NOT DISTINCT FROM ${f.account} AND category_id IS NOT DISTINCT FROM ${f.category} RETURNING 1 AS ok`;
  }
  if (f === null) {
    return tx`INSERT INTO scm.acc_opening_bill_places (company_id, ap_invoice_id, account_code, category_id, updated_at, updated_by)
              VALUES (${CO}, ${c.id}::uuid, ${t.account}, ${t.category}, now(), ${WHO}) ON CONFLICT DO NOTHING RETURNING 1 AS ok`;
  }
  if (t === null) {
    return tx`DELETE FROM scm.acc_opening_bill_places
               WHERE company_id = ${CO} AND ap_invoice_id = ${c.id}::uuid
                 AND account_code IS NOT DISTINCT FROM ${f.account} AND category_id IS NOT DISTINCT FROM ${f.category} RETURNING 1 AS ok`;
  }
  return tx`UPDATE scm.acc_opening_bill_places SET account_code = ${t.account}, category_id = ${t.category}, updated_at = now(), updated_by = ${WHO}
             WHERE company_id = ${CO} AND ap_invoice_id = ${c.id}::uuid
               AND account_code IS NOT DISTINCT FROM ${f.account} AND category_id IS NOT DISTINCT FROM ${f.category} RETURNING 1 AS ok`;
}

async function main() {
  note(`mode=${APPLY ? 'APPLY' : 'PLAN (writes nothing)'} company=${CO} suppliers asked=${suppliersAsked.pairs.length} bills asked=${billsAsked.pairs.length}`);
  const facts = await factsOf(sql);
  const { refused, changes } = planFor({ suppliers: suppliersAsked.pairs, bills: billsAsked.pairs }, facts);
  for (const r of refused) bad(`  REFUSED ${r}`);
  if (refused.length > 0) { bad(`${refused.length} item(s) refused; nothing planned.`); await sql.end({ timeout: 5 }); process.exit(1); }
  say(`\n=== company ${CO}: ${changes.length} change(s) ===`);
  for (const c of changes) say(`  ${c.kind.padEnd(8)} ${String(c.key).padEnd(18)} ${placeText(c.from)} -> ${placeText(c.to)}`);
  const id = planId(changes);
  note(`changes: ${changes.length}   PLAN_ID=${id}`);
  if (changes.length === 0) { note('Nothing to change.'); await sql.end({ timeout: 5 }); return; }
  if (!APPLY) {
    note(`PLAN ONLY: nothing written. To apply: MODE=apply CONFIRM="${CONFIRM_PHRASE}" PLAN_ID=${id}`);
    await sql.end({ timeout: 5 });
    return;
  }
  if (process.env.PLAN_ID !== id) {
    bad(`PLAN_ID=${process.env.PLAN_ID ?? '(unset)'} is not this plan (${id}): the choices changed since the reviewed plan, or PLAN_ID is missing. Nothing written.`);
    await sql.end({ timeout: 5 });
    process.exit(1);
  }

  note(`\n=== WRITING ${changes.length} CHOICE(S), one transaction ===`);
  await sql.begin(async (tx) => {
    for (const c of changes) {
      const back = await write(tx, c);
      if (back.length !== 1) throw new Error(`${c.kind} ${c.key} no longer holds the reviewed choice; rolled back, nothing written`);
      say(`  OK ${c.kind} ${c.key} -> ${placeText(c.to)}`);
    }
  });
  await sql.end({ timeout: 5 });

  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  try {
    note(`\n=== VERIFIED ON A FRESH CONNECTION ===`);
    const now = await readPlaces(check);
    const found = shapeProblems(changes, now, facts);
    for (const f of found) bad(`  ${f}`);
    say(`  company ${CO}: ${now.suppliers.size} supplier choice(s), ${now.bills.size} bill choice(s); ${changes.length} change(s) read back as planned: ${found.length === 0 ? 'yes' : 'NO'}`);
    if (found.length > 0) process.exitCode = 1;
  } finally {
    await check.end({ timeout: 5 });
  }
}

main().catch(async (e) => {
  bad(e.message);
  try { await sql.end({ timeout: 5 }); } catch { /* already closed */ }
  process.exit(1);
});
