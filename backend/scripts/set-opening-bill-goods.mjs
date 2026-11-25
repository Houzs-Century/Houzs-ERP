#!/usr/bin/env node
/* Read what each opening bill bought, by product group, from AutoCount's own
   purchase-invoice lines, so the Cash Flow reads a payment of the bill as sofa,
   bed frames, mattresses… (owner 2026-11-25, 「如果系统可以分得出purchase of
   sofa 和purchase of bedding 更加好」, 「可以做回最好」). COMPANY_ID=<id> is
   required.

   SOURCE: the read-only AutoCount export committed at
   scripts/data/ac-listing-lines.json.gz (every PI line dated 2026 on, with its
   product group and value), or SOURCE=<another file of the same shape>. An
   opening bill names its AutoCount invoice in its text ("AUTOCOUNT PI-007884");
   a bill reads that invoice's lines when the source has it, it is not
   cancelled, and the bill is not more than it (a bill carries what was still
   owed at go-live). A bill the source lacks keeps what it holds. The Actions
   log is public: codes, counts and shares only, never a name or an amount.

   MODE=plan (default) prints, per supplier code, the bills read, not in the
   source and skipped with the share of each product group, then the changes
   and the plan's PLAN_ID, and writes nothing. MODE=apply needs CONFIRM="I HAVE
   REVIEWED THE OPENING BILL GOODS" and PLAN_ID=<the id the plan printed>: one
   transaction, each bill by its company and only while it still holds the
   reviewed rows. Then a FRESH connection re-reads every row of the company and
   checks the shape: each changed bill holds the planned groups and values,
   every row is an opening bill of the company, every group in the ERP's words.

   RE-RUN: inert once applied. A bill that already holds its invoice's groups
   is no change, so a second plan lists nothing.

   Run: Actions → "Run a backend script on production". */
import './lib/public-log-guard.mjs';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import postgres from 'postgres';
import { goodsText, invoicesOf, planFor, shapeProblems, summaryOf } from './lib/opening-bill-goods-plan.mjs';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'I HAVE REVIEWED THE OPENING BILL GOODS';
const CO = Number(process.env.COMPANY_ID);
const WHO = 'script:set-opening-bill-goods';
const SOURCE = process.env.SOURCE || new URL('./data/ac-listing-lines.json.gz', import.meta.url).pathname;

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

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });

/** The company's rows: bill id → Map(group → sen). */
async function readGoods(client) {
  const rows = await client`SELECT ap_invoice_id::text AS id, group_code, myr_sen FROM scm.acc_opening_bill_goods WHERE company_id = ${CO}`;
  const out = new Map();
  for (const r of rows) out.set(r.id, (out.get(r.id) ?? new Map()).set(r.group_code, Number(r.myr_sen)));
  return out;
}

/** The company's opening bills that are real bills (neither a draft nor cancelled), with their supplier's code. */
async function openingBills(client) {
  const rows = await client`
    SELECT a.id::text AS id, a.invoice_number, a.notes, a.total_sen, a.currency, a.exchange_rate, s.code AS supplier_code
      FROM scm.ap_invoices a JOIN scm.suppliers s ON s.id = a.supplier_id AND s.company_id = a.company_id
     WHERE a.company_id = ${CO} AND a.opening AND coalesce(a.status, '') NOT IN ('DRAFT', 'CANCELLED')`;
  return rows.map((r) => ({
    id: r.id, number: r.invoice_number, notes: r.notes, supplierCode: String(r.supplier_code ?? ''),
    totalSen: Number(r.total_sen ?? 0), currency: r.currency ?? null, rate: Number(r.exchange_rate ?? 1),
  }));
}

/** The plan's id: the same changes on the same rows give the same id. */
const planId = (changes) => createHash('sha256')
  .update(changes.map((c) => [CO, c.id, goodsText(c.from), goodsText(c.to)].join('|')).sort().join('\n'))
  .digest('hex').slice(0, 12);

/* One bill, only while it still holds the reviewed rows: they are read under lock and compared,
   then replaced. Each statement names the company. */
async function write(tx, c) {
  const held = await tx`SELECT group_code, myr_sen FROM scm.acc_opening_bill_goods WHERE company_id = ${CO} AND ap_invoice_id = ${c.id}::uuid FOR UPDATE`;
  const now = held.length === 0 ? null : new Map(held.map((r) => [r.group_code, Number(r.myr_sen)]));
  if (goodsText(now) !== goodsText(c.from)) return false;
  await tx`DELETE FROM scm.acc_opening_bill_goods WHERE company_id = ${CO} AND ap_invoice_id = ${c.id}::uuid`;
  for (const [group, myrSen] of c.to) {
    await tx`INSERT INTO scm.acc_opening_bill_goods (company_id, ap_invoice_id, group_code, myr_sen, ac_doc_no, updated_at, updated_by)
             VALUES (${CO}, ${c.id}::uuid, ${group}, ${myrSen}, ${c.doc}, now(), ${WHO})`;
  }
  return true;
}

async function main() {
  note(`mode=${APPLY ? 'APPLY' : 'PLAN (writes nothing)'} company=${CO}`);
  const source = JSON.parse(gunzipSync(readFileSync(SOURCE)).toString('utf8'));
  const invoices = invoicesOf(Array.isArray(source) ? source : []);
  const bills = await openingBills(sql);
  const plan = planFor(bills, invoices, await readGoods(sql));
  say(`\n=== company ${CO}: ${bills.length} opening bill(s); the source has ${invoices.size} AutoCount purchase invoice(s) ===`);
  for (const s of summaryOf(plan)) {
    say(`  ${s.code.padEnd(10)} read ${String(s.read).padStart(4)}  not in the source ${String(s.missing).padStart(4)}  skipped ${String(s.skipped).padStart(3)}  ${s.shares}`);
  }
  for (const k of plan.skipped) say(`  SKIPPED ${k.bill.number} (${k.doc}): ${k.why}`);
  const renamed = plan.read.filter((r) => r.otherParty).length;
  if (renamed > 0) say(`  ${renamed} bill(s) read from an invoice AutoCount keeps under another creditor code (a code changed since).`);
  say(`  read ${plan.read.length}, not in the source ${plan.missing.length}, skipped ${plan.skipped.length}`);
  const changes = plan.changes;
  const id = planId(changes);
  note(`changes: ${changes.length}   PLAN_ID=${id}`);
  if (changes.length === 0) { note('Nothing to change.'); await sql.end({ timeout: 5 }); return; }
  if (!APPLY) {
    note(`PLAN ONLY: nothing written. To apply: MODE=apply CONFIRM="${CONFIRM_PHRASE}" PLAN_ID=${id}`);
    await sql.end({ timeout: 5 });
    return;
  }
  if (process.env.PLAN_ID !== id) {
    bad(`PLAN_ID=${process.env.PLAN_ID ?? '(unset)'} is not this plan (${id}): the rows changed since the reviewed plan, or PLAN_ID is missing. Nothing written.`);
    await sql.end({ timeout: 5 });
    process.exit(1);
  }

  note(`\n=== WRITING ${changes.length} BILL(S), one transaction ===`);
  await sql.begin(async (tx) => {
    for (const c of changes) {
      if (!(await write(tx, c))) throw new Error(`bill ${c.number} no longer holds the reviewed rows; rolled back, nothing written`);
    }
  });
  say(`  OK ${changes.length} bill(s)`);
  await sql.end({ timeout: 5 });

  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  try {
    note(`\n=== VERIFIED ON A FRESH CONNECTION ===`);
    const now = await readGoods(check);
    const opening = new Set((await openingBills(check)).map((b) => b.id));
    const found = shapeProblems(changes, now, opening);
    for (const f of found) bad(`  ${f}`);
    say(`  company ${CO}: ${now.size} bill(s) carry their goods; ${changes.length} change(s) read back as planned: ${found.length === 0 ? 'yes' : 'NO'}`);
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
