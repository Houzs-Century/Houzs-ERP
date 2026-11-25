#!/usr/bin/env node
/* Tidy the payment terms and banks typed on suppliers, now that the supplier
   forms pick both from a list (owner 2026-11-24: 「改，连旧资料一起整理」). Every
   company, or COMPANY_ID=<id> for one.

   WHAT IT CHANGES (the rules: lib/supplier-pick-tidy.mjs):
     · a term — "30 DAYS" / "30 days" / "30 terms" → NET 30, "60 DAYS" → NET 60
       (only a NET n the list has), a list term spelled another way → the list's
       spelling, a phone number typed as a term → cleared;
     · a bank — "HLBB" → HONG LEONG BANK, "PUBLIC BANK BERHAD" → PUBLIC BANK:
       the list's bank in upper case, as the database stores a supplier's bank.
   A value no rule knows is left as typed (it stays the form's Custom / Other
   text) and named.

   SET_TERM="400-T002=NET 30[,CODE=TERM…]" also sets the term picked for a
   supplier (owner 2026-11-25: T.H.L. SOFA 「30 days」), in each company that
   has that code; the term must be on the list, and a code no company has is
   refused. The Actions log is public: supplier codes and values, no
   names, and a phone number is never printed.

   MODE=plan (default) prints every change and the plan's PLAN_ID, and writes
   nothing. MODE=apply needs CONFIRM="I HAVE REVIEWED THE SUPPLIER TIDY PLAN"
   and PLAN_ID=<the id the plan printed>, so it writes exactly the list that was
   reviewed: one transaction, each row by its id AND its company, and only while
   it still holds the reviewed value. Then a FRESH connection re-reads every
   supplier and checks the shape: each changed value is the planned one, no
   term is a phone number, and no term or bank is off the list except those the
   plan left as typed.

   RE-RUN: inert once applied. A changed value is a list entry, which no rule
   changes again, and a SET_TERM supplier already holds its term, so a second
   plan lists nothing to change.

   Run: Actions → "Run a backend script on production" (tsx: the rules import
   the shared list, src/scm/shared/pick-lists.ts). */
import './lib/public-log-guard.mjs';
import { createHash } from 'node:crypto';
import postgres from 'postgres';
import { bankIsOnList, looksLikePhone, parseSetTerms, planFor, shown, termIsOnList } from './lib/supplier-pick-tidy.mjs';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'I HAVE REVIEWED THE SUPPLIER TIDY PLAN';
const ONLY = process.env.COMPANY_ID ? Number(process.env.COMPANY_ID) : null;

const say = (m) => console.log(m);
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}
if (ONLY !== null && !(Number.isInteger(ONLY) && ONLY > 0)) {
  bad(`COMPANY_ID must be a company id, not "${process.env.COMPANY_ID}"`);
  process.exit(2);
}
let SET_TERMS;
try { SET_TERMS = parseSetTerms(process.env.SET_TERM); } catch (e) { bad(e.message); process.exit(2); }

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });

const companiesOf = async (client) => (await client`SELECT id::int AS id FROM public.companies ORDER BY id`)
  .map((r) => r.id).filter((id) => ONLY === null || id === ONLY);

const suppliersOf = (client, co) => client`
  SELECT id::text AS id, code, payment_terms, bank_name
    FROM scm.suppliers WHERE company_id = ${co} ORDER BY code, id`;

/** The plan's id: the same changes on the same rows give the same id. */
const planId = (changes) => createHash('sha256')
  .update(changes.map((c) => [c.companyId, c.id, c.field, c.from ?? '', c.to ?? ''].join('|')).sort().join('\n'))
  .digest('hex').slice(0, 12);

/** What is wrong with one company's suppliers as re-read: a planned change that
 *  did not land, a phone number in the terms, a term or bank off the list that
 *  the plan did not leave as typed. */
function shapeProblems(rows, changes, leftAsTyped) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const kept = new Set(leftAsTyped.map((l) => `${l.id}|${l.field}`));
  const out = [];
  for (const c of changes) {
    const now = byId.get(c.id)?.[c.field] ?? null;
    if (now !== c.to) out.push(`${c.code} ${c.field} is ${shown(now)}, planned ${shown(c.to)}`);
  }
  for (const r of rows) {
    const t = r.payment_terms;
    if (typeof t === 'string' && t.trim()) {
      if (looksLikePhone(t.trim())) out.push(`${r.code} payment_terms is still a phone number`);
      else if (!termIsOnList(t) && !kept.has(`${r.id}|payment_terms`)) out.push(`${r.code} payment_terms ${shown(t)} is off the list`);
    }
    const b = r.bank_name;
    if (typeof b === 'string' && b.trim() && !bankIsOnList(b) && !kept.has(`${r.id}|bank_name`)) out.push(`${r.code} bank_name ${shown(b)} is off the list`);
  }
  return out;
}

async function main() {
  const companies = await companiesOf(sql);
  if (companies.length === 0) throw new Error(`no company${ONLY === null ? '' : ` ${ONLY}`} found`);
  note(`mode=${APPLY ? 'APPLY' : 'PLAN (writes nothing)'} companies=${companies.join(',')}${SET_TERMS.size ? ` set=${[...SET_TERMS].map(([c, t]) => `${c}=${t}`).join(',')}` : ''}`);

  const plans = [];
  for (const co of companies) {
    const rows = await suppliersOf(sql, co);
    const plan = planFor(co, rows, SET_TERMS);
    plans.push({ co, ...plan });
    say(`\n=== company ${co}: ${rows.length} suppliers, ${rows.filter((r) => String(r.payment_terms ?? '').trim()).length} with a term, ${rows.filter((r) => String(r.bank_name ?? '').trim()).length} with a bank ===`);
    for (const c of plan.changes) say(`  ${String(c.code).padEnd(10)} ${c.field.padEnd(13)} ${shown(c.from)} -> ${shown(c.to)}   (${c.why})`);
    if (plan.changes.length === 0) say('  nothing to change');
    for (const l of plan.leftAsTyped) say(`  ${String(l.code).padEnd(10)} ${l.field.padEnd(13)} ${shown(l.value)} LEFT AS TYPED (no rule; stays Custom / Other)`);
  }
  const found = new Set(plans.flatMap((p) => p.setFound));
  const missing = [...SET_TERMS.keys()].filter((c) => !found.has(c));
  if (missing.length) {
    bad(`SET_TERM names a code no company has: ${missing.join(', ')}. Nothing written.`);
    await sql.end({ timeout: 5 });
    process.exit(1);
  }
  const changes = plans.flatMap((p) => p.changes);
  const leftAsTyped = plans.flatMap((p) => p.leftAsTyped);
  const id = planId(changes);
  note(`changes: ${changes.length}   left as typed: ${leftAsTyped.length}   PLAN_ID=${id}`);

  if (changes.length === 0) { note('Nothing to tidy.'); await sql.end({ timeout: 5 }); return; }
  if (!APPLY) {
    note(`PLAN ONLY: nothing written. To apply: MODE=apply CONFIRM="${CONFIRM_PHRASE}" PLAN_ID=${id}`);
    await sql.end({ timeout: 5 });
    return;
  }
  if (process.env.PLAN_ID !== id) {
    bad(`PLAN_ID=${process.env.PLAN_ID ?? '(unset)'} is not this plan (${id}): the suppliers changed since the reviewed plan, or PLAN_ID is missing. Nothing written.`);
    await sql.end({ timeout: 5 });
    process.exit(1);
  }

  note(`\n=== WRITING ${changes.length} VALUE(S), one transaction ===`);
  await sql.begin(async (tx) => {
    for (const c of changes) {
      const back = c.field === 'payment_terms'
        ? await tx`UPDATE scm.suppliers SET payment_terms = ${c.to}, updated_at = now()
                    WHERE id = ${c.id} AND company_id = ${c.companyId} AND payment_terms IS NOT DISTINCT FROM ${c.from}
                    RETURNING id::text AS id`
        : await tx`UPDATE scm.suppliers SET bank_name = ${c.to}, updated_at = now()
                    WHERE id = ${c.id} AND company_id = ${c.companyId} AND bank_name IS NOT DISTINCT FROM ${c.from}
                    RETURNING id::text AS id`;
      if (back.length !== 1) throw new Error(`company ${c.companyId} ${c.code} ${c.field} no longer holds the reviewed value; rolled back, nothing written`);
      say(`  OK company ${c.companyId} ${c.code} ${c.field} -> ${shown(c.to)}`);
    }
  });
  await sql.end({ timeout: 5 });

  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  try {
    note(`\n=== VERIFIED ON A FRESH CONNECTION ===`);
    let problems = 0;
    for (const p of plans) {
      const rows = await suppliersOf(check, p.co);
      const found = shapeProblems(rows, p.changes, p.leftAsTyped);
      for (const f of found) bad(`  company ${p.co}: ${f}`);
      problems += found.length;
      const terms = rows.filter((r) => typeof r.payment_terms === 'string' && r.payment_terms.trim());
      const banks = rows.filter((r) => typeof r.bank_name === 'string' && r.bank_name.trim());
      say(`  company ${p.co}: terms ${terms.filter((r) => termIsOnList(r.payment_terms)).length} of ${terms.length} on the list; banks ${banks.filter((r) => bankIsOnList(r.bank_name)).length} of ${banks.length} on the list; ${p.changes.length} change(s) read back as planned: ${found.length === 0 ? 'yes' : 'NO'}`);
    }
    if (problems > 0) { bad(`${problems} problem(s) after the write`); process.exitCode = 1; }
    else note('Every change reads back as planned; no term or bank is off the list except those left as typed.');
  } finally {
    await check.end({ timeout: 5 });
  }
}

main().catch(async (e) => {
  bad(e.message);
  try { await sql.end({ timeout: 5 }); } catch { /* already closed */ }
  process.exit(1);
});
