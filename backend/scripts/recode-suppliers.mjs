#!/usr/bin/env node
/* Change supplier codes WITH their history: the change-code tool the supplier
   screen points to once a supplier has documents or ledger lines
   (scm/lib/supplier-finance.ts, "waits for the change-code tool").

   Why (owner 2026-11-20): Houzs books goods suppliers on 400- codes and every
   other creditor (transport, rental, booth set-up, subscriptions) on 405-.
   Thirteen creditors were opened on 400- and one goods supplier on 405-; the
   owner chose to move them as if they had always carried the right code
   (「A：连旧账一起搬」), the way migration 0349 moved the first 405 bill.

   What one run changes, for each OLD:NEW pair in MAP, inside COMPANY only:
     • scm.suppliers.code;
     • scm.journal_entry_lines of party SUPPLIER: party_code, and, when the
       prefix changes the creditor control (400-0000 <-> 405-0000), the account
       of the supplier's lines on the old control;
     • scm.acc_credit_notes.party_code of the supplier's own notes;
     • public.assr_cases / assr_supplier_returns / assr_supplier_tokens
       creditor_code (after-sales returns name the supplier by code);
     • scm.payment_voucher_lines that debit the old control for this supplier,
       so a draft voucher still posts (wrong_ap_control) and a posted one
       reads like its journal;
     • one scm.entity_audit_log row per supplier (SUPPLIER, code from -> to).
   Nothing else moves: amounts, dates, other accounts, names.

   Refused before any write: a pair whose old code is not exactly one supplier
   of COMPANY, a new code already in use there, a target control missing from
   the chart, and a MAP that chains or swaps codes (lib/supplier-recode.mjs).

   MODE=plan (default) prints, per code, how many rows each step touches and
   writes nothing. MODE=apply needs CONFIRM="MOVE SUPPLIER CODES WITH THEIR
   HISTORY" and writes every pair in ONE transaction. The public log never
   shows money: balances are compared, not printed.

   RE-RUN: convergent. After an apply the old codes no longer exist, so a second
   run with the same MAP refuses at the first pair and writes nothing.

   Verification re-reads on a FRESH connection and asserts the shape: each
   supplier now carries its new code; no ledger line, credit note, after-sales
   row or voucher line still carries the old code or the old control; each
   supplier's ledger balance sits whole on its new control; and the two
   creditor controls together hold exactly what they held before.

   Env: DATABASE_URL, COMPANY (default 1), MAP="400-B005:405-B005,405-N001:400-N006". */
import './lib/public-log-guard.mjs';
import postgres from 'postgres';
import { parseRecodeMap, creditorControls, controlMove } from './lib/supplier-recode.mjs';

const MODE = (process.env.MODE || 'plan').toLowerCase();
const APPLY = MODE === 'apply';
const CONFIRM_PHRASE = 'MOVE SUPPLIER CODES WITH THEIR HISTORY';
const DSN = process.env.DATABASE_URL;
const CO = Number(process.env.COMPANY || 1);

const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);
const refuse = (m) => { bad(m); process.exit(2); };

if (!DSN) refuse('need DATABASE_URL');
if (!Number.isInteger(CO) || CO <= 0) refuse(`COMPANY must be a company id, got "${process.env.COMPANY}"`);
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) refuse(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
const map = parseRecodeMap(process.env.MAP);
if (!map.ok) refuse(`MAP refused: ${map.reason}`);

/** Sen per account for one party code, over the creditor controls only. */
async function partyControlSums(db, code, controls) {
  const rows = await db`
    SELECT account_code, COALESCE(SUM(credit_sen - debit_sen), 0)::bigint AS net
      FROM scm.journal_entry_lines
     WHERE company_id = ${CO} AND party_type = 'SUPPLIER' AND party_code = ${code}
       AND account_code IN (${controls.AP}, ${controls.AP_OTHER})
     GROUP BY account_code`;
  const out = { [controls.AP]: 0n, [controls.AP_OTHER]: 0n };
  for (const r of rows) out[r.account_code] = BigInt(r.net);
  return out;
}

/** Sen on the two creditor controls for the whole company. */
async function controlTotals(db, controls) {
  const r = await db`
    SELECT COALESCE(SUM(credit_sen - debit_sen), 0)::bigint AS net, COUNT(*)::int AS n
      FROM scm.journal_entry_lines
     WHERE company_id = ${CO} AND account_code IN (${controls.AP}, ${controls.AP_OTHER})`;
  return { net: BigInt(r[0].net), n: r[0].n };
}

/** Everything a pair would touch, read without writing. */
async function survey(db, pair, controls) {
  const sup = await db`SELECT id, code FROM scm.suppliers WHERE company_id = ${CO} AND code = ${pair.oldCode}`;
  if (sup.length !== 1) return { ok: false, reason: `${pair.oldCode}: ${sup.length} suppliers of company ${CO} carry it, expected exactly 1` };
  const taken = await db`SELECT 1 FROM scm.suppliers WHERE company_id = ${CO} AND code = ${pair.newCode}`;
  if (taken.length) return { ok: false, reason: `${pair.newCode} is already a supplier code in company ${CO}` };
  const move = controlMove(pair.oldCode, pair.newCode, controls);
  if (move) {
    const acct = await db`SELECT 1 FROM scm.accounts WHERE company_id = ${CO} AND account_code = ${move.to}`;
    if (!acct.length) return { ok: false, reason: `${move.to} is not in company ${CO}'s chart` };
  }
  const id = sup[0].id;
  const [lines] = await db`
    SELECT COUNT(*)::int AS n,
           COUNT(*) FILTER (WHERE account_code = ${move ? move.from : ''})::int AS on_old
      FROM scm.journal_entry_lines
     WHERE company_id = ${CO} AND party_type = 'SUPPLIER' AND party_code = ${pair.oldCode}`;
  const [notes] = await db`
    SELECT COUNT(*)::int AS n FROM scm.acc_credit_notes
     WHERE company_id = ${CO} AND supplier_id = ${id} AND party_code = ${pair.oldCode}`;
  const [cases] = await db`
    SELECT COUNT(*)::int AS n FROM public.assr_cases WHERE company_id = ${CO} AND creditor_code = ${pair.oldCode}`;
  const [returns] = await db`
    SELECT COUNT(*)::int AS n FROM public.assr_supplier_returns r
      JOIN public.assr_cases a ON a.id = r.assr_id
     WHERE a.company_id = ${CO} AND r.creditor_code = ${pair.oldCode}`;
  const [tokens] = await db`
    SELECT COUNT(*)::int AS n FROM public.assr_supplier_tokens t
      JOIN public.assr_cases a ON a.id = t.assr_id
     WHERE a.company_id = ${CO} AND t.creditor_code = ${pair.oldCode}`;
  const [pvLines] = move ? await db`
    SELECT COUNT(*)::int AS n,
           COUNT(*) FILTER (WHERE UPPER(v.status::text) NOT IN ('POSTED', 'CANCELLED'))::int AS open
      FROM scm.payment_voucher_lines l
      JOIN scm.payment_vouchers v ON v.id = l.pv_id AND v.company_id = l.company_id
     WHERE v.company_id = ${CO} AND v.supplier_id = ${id} AND l.debit_account_code = ${move.from}` : [{ n: 0, open: 0 }];
  const sums = await partyControlSums(db, pair.oldCode, controls);
  return {
    ok: true, id, move, sums,
    counts: { lines: lines.n, onOld: lines.on_old, notes: notes.n, cases: cases.n, returns: returns.n, tokens: tokens.n, pvLines: pvLines.n, pvOpen: pvLines.open },
  };
}

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
let failed = false;
try {
  const roleRows = await sql`SELECT role, account_code FROM scm.acc_account_roles WHERE company_id = ${CO} AND role IN ('AP', 'AP_OTHER')`;
  const controls = creditorControls(roleRows);
  note(`company ${CO}: trade creditors ${controls.AP}, other creditors ${controls.AP_OTHER}; ${map.pairs.length} code(s) to move; MODE=${APPLY ? 'apply' : 'plan'}`);

  const plan = [];
  for (const pair of map.pairs) {
    const s = await survey(sql, pair, controls);
    if (!s.ok) refuse(`refused, nothing written: ${s.reason}`);
    plan.push({ ...pair, ...s });
  }
  for (const p of plan) {
    const c = p.counts;
    note(`${p.oldCode} -> ${p.newCode}: ${c.lines} ledger line(s), ${p.move ? `${c.onOld} move ${p.move.from} -> ${p.move.to}` : 'same control'}; credit notes ${c.notes}; after-sales cases ${c.cases}, returns ${c.returns}, links ${c.tokens}; voucher lines ${c.pvLines} (${c.pvOpen} on unposted vouchers)`);
  }
  const before = await controlTotals(sql, controls);

  if (!APPLY) {
    note(`plan only, nothing written. Apply with MODE=apply CONFIRM="${CONFIRM_PHRASE}" and the same MAP.`);
  } else {
    await sql.begin(async (tx) => {
      for (const p of plan) {
        const lock = await tx`SELECT code FROM scm.suppliers WHERE company_id = ${CO} AND id = ${p.id} FOR UPDATE`;
        if (lock.length !== 1 || lock[0].code !== p.oldCode) throw new Error(`${p.oldCode} changed since the survey`);
        await tx`UPDATE scm.suppliers SET code = ${p.newCode}, updated_at = now() WHERE company_id = ${CO} AND id = ${p.id} AND code = ${p.oldCode}`;
        if (p.move) {
          await tx`UPDATE scm.journal_entry_lines SET account_code = ${p.move.to}
                    WHERE company_id = ${CO} AND party_type = 'SUPPLIER' AND party_code = ${p.oldCode} AND account_code = ${p.move.from}`;
        }
        await tx`UPDATE scm.journal_entry_lines SET party_code = ${p.newCode}
                  WHERE company_id = ${CO} AND party_type = 'SUPPLIER' AND party_code = ${p.oldCode}`;
        await tx`UPDATE scm.acc_credit_notes SET party_code = ${p.newCode}
                  WHERE company_id = ${CO} AND supplier_id = ${p.id} AND party_code = ${p.oldCode}`;
        await tx`UPDATE public.assr_supplier_returns r SET creditor_code = ${p.newCode}
                   FROM public.assr_cases a WHERE a.id = r.assr_id AND a.company_id = ${CO} AND r.creditor_code = ${p.oldCode}`;
        await tx`UPDATE public.assr_supplier_tokens t SET creditor_code = ${p.newCode}
                   FROM public.assr_cases a WHERE a.id = t.assr_id AND a.company_id = ${CO} AND t.creditor_code = ${p.oldCode}`;
        await tx`UPDATE public.assr_cases SET creditor_code = ${p.newCode} WHERE company_id = ${CO} AND creditor_code = ${p.oldCode}`;
        if (p.move) {
          await tx`UPDATE scm.payment_voucher_lines l SET debit_account_code = ${p.move.to}
                     FROM scm.payment_vouchers v
                    WHERE v.id = l.pv_id AND v.company_id = ${CO} AND l.company_id = ${CO}
                      AND v.supplier_id = ${p.id} AND l.debit_account_code = ${p.move.from}`;
        }
        await tx`INSERT INTO scm.entity_audit_log (company_id, entity_type, entity_id, entity_doc_no, action, source, note, field_changes)
                 VALUES (${CO}, 'SUPPLIER', ${String(p.id)}, ${p.newCode}, 'UPDATE', 'script',
                         ${`recode-suppliers.mjs: ${p.counts.lines} ledger line(s) moved with the code${p.move ? `, control ${p.move.from} -> ${p.move.to}` : ''}`},
                         ${tx.json([{ field: 'code', from: p.oldCode, to: p.newCode }])})`;
      }
    });
    note('applied in one transaction; verifying on a fresh connection');

    const fresh = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
    try {
      const problems = [];
      for (const p of plan) {
        const [sup] = await fresh`SELECT code FROM scm.suppliers WHERE company_id = ${CO} AND id = ${p.id}`;
        if (!sup || sup.code !== p.newCode) problems.push(`${p.newCode}: the supplier reads "${sup?.code}"`);
        const [left] = await fresh`
          SELECT (SELECT COUNT(*) FROM scm.journal_entry_lines WHERE company_id = ${CO} AND party_type = 'SUPPLIER' AND party_code = ${p.oldCode})::int AS lines,
                 (SELECT COUNT(*) FROM scm.journal_entry_lines WHERE company_id = ${CO} AND party_type = 'SUPPLIER' AND party_code = ${p.newCode})::int AS moved,
                 (SELECT COUNT(*) FROM scm.acc_credit_notes WHERE company_id = ${CO} AND supplier_id = ${p.id} AND party_code IS DISTINCT FROM ${p.newCode})::int AS notes,
                 (SELECT COUNT(*) FROM public.assr_cases WHERE company_id = ${CO} AND creditor_code = ${p.oldCode})::int AS cases`;
        if (left.lines) problems.push(`${p.oldCode}: ${left.lines} ledger line(s) still carry the old code`);
        if (left.moved !== p.counts.lines) problems.push(`${p.newCode}: ${left.moved} ledger line(s) carry the new code, expected ${p.counts.lines}`);
        if (left.notes) problems.push(`${p.newCode}: ${left.notes} of its credit notes do not carry the new code`);
        if (left.cases) problems.push(`${p.oldCode}: ${left.cases} after-sales case(s) still name the old code`);
        const after = await partyControlSums(fresh, p.newCode, controls);
        const total = (o) => o[controls.AP] + o[controls.AP_OTHER];
        if (total(after) !== total(p.sums)) problems.push(`${p.newCode}: its ledger balance changed`);
        if (p.move && after[p.move.from] !== 0n) problems.push(`${p.newCode}: a balance is still on ${p.move.from}`);
        if (p.move) {
          const [pv] = await fresh`
            SELECT COUNT(*)::int AS n FROM scm.payment_voucher_lines l
              JOIN scm.payment_vouchers v ON v.id = l.pv_id AND v.company_id = l.company_id
             WHERE v.company_id = ${CO} AND v.supplier_id = ${p.id} AND l.debit_account_code = ${p.move.from}`;
          if (pv.n) problems.push(`${p.newCode}: ${pv.n} voucher line(s) still debit ${p.move.from}`);
        }
        const [audit] = await fresh`
          SELECT field_changes FROM scm.entity_audit_log
           WHERE company_id = ${CO} AND entity_type = 'SUPPLIER' AND entity_id = ${String(p.id)} AND entity_doc_no = ${p.newCode}
           ORDER BY created_at DESC LIMIT 1`;
        const fc = audit?.field_changes;
        if (!Array.isArray(fc) || fc[0]?.field !== 'code' || fc[0]?.from !== p.oldCode || fc[0]?.to !== p.newCode) {
          problems.push(`${p.newCode}: the audit row is missing or not an array of {field, from, to}`);
        }
        note(`${p.oldCode} -> ${p.newCode}: ${problems.some((m) => m.startsWith(p.oldCode) || m.startsWith(p.newCode)) ? 'CHECK FAILED' : 'verified'}`);
      }
      const after = await controlTotals(fresh, controls);
      if (after.net !== before.net || after.n !== before.n) problems.push('the two creditor controls together no longer hold what they held before');
      if (problems.length) {
        failed = true;
        for (const m of problems) bad(m);
      } else {
        note(`verified on a fresh connection: ${plan.length} code(s) moved with their history; the creditor controls hold the same total`);
      }
    } finally {
      await fresh.end();
    }
  }
} catch (err) {
  failed = true;
  bad(`stopped: ${err.message}`);
} finally {
  await sql.end();
}
process.exit(failed ? 1 : 0);
