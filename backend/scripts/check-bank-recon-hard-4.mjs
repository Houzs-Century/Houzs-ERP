#!/usr/bin/env node
// check-bank-recon-hard-4.mjs — READ ONLY (one READ ONLY transaction; mode=apply refused).
// Owner 2026-11-10 「为何我感觉现在的bank recon 很难对账啊？」 — a back-test of a stricter-but-
// wider automatic rule before proposing it: among the same-amount entries within 7 days on
// the bank account, match only when EXACTLY ONE names the payer — by the entry's own party
// or notes (today's rule), or by the customer of the order a customer payment belongs to
// (the name the screen already shows). Run over
//  A. every line already matched to one entry (by hand or automatically): would the rule
//     have picked the same entry (right), another one (WRONG), or left it to a person?
//  B. every OPEN line today: what the rule would match now.
// Env: DATABASE_URL, COMPANY_IDS (default "1,2"), SHOW_WRONG (default 20).
import postgres from 'postgres';
import { namesAgree, nameTokens, ENTRY_MATCH_WINDOW_DAYS } from '../src/acc/bank-match.ts';

/* STRICT: two words of the name in the bank's words (a surname alone names half of Malaysia),
   or the whole name when it is one word. Same word test as namesAgree. */
const sharedWords = (text, name) => { const bank = nameTokens(text); return nameTokens(name ?? '').filter((p) => bank.some((b) => b === p || (p.length >= 5 && b.length >= 5 && (b.startsWith(p) || p.startsWith(b))))); };
const strictAgree = (text, name) => { const all = nameTokens(name ?? ''); const got = sharedWords(text, name); return all.length > 0 && (got.length >= 2 || (all.length === 1 && got.length === 1)); };
/* FULL: every word of the customer's name is in the bank's words (two words at least, or a one-word name). */
const fullAgree = (text, name) => { const all = nameTokens(name ?? ''); const got = sharedWords(text, name); return all.length > 0 && got.length === all.length && (all.length >= 2 || got.length === 1); };
const MODE_NAME = ['strict', 'full'].includes(process.env.NAME_RULE) ? process.env.NAME_RULE : 'loose';
const agree = (text, name) => (MODE_NAME === 'strict' ? strictAgree(text, name) : MODE_NAME === 'full' ? fullAgree(text, name) : namesAgree(text, name));

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
if ((process.env.MODE || 'plan') !== 'plan') { console.error('read-only: run it with mode=plan.'); process.exit(1); }
const COS = String(process.env.COMPANY_IDS || '1,2').split(',').map((s) => Number(s.trim())).filter((n) => n > 0);
const SHOW = Number(process.env.SHOW_WRONG || 20);
const sql = postgres(process.env.DATABASE_URL, {
  max: 1, prepare: false,
  types: { date: { to: 1082, from: [1082], serialize: (x) => x, parse: (x) => x } },
});
const rm = (sen) => (Number(sen ?? 0) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const row = (...parts) => console.log(`ROW|${parts.join('|')}`);
const head = (t) => console.log(`\n=== ${t}`);
const gap = (a, b) => Math.round(Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);
const short = (s, n = 40) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

try {
  await sql.begin('read only', async (tx) => {
    for (const CO of COS) {
      const lines = await tx`
        SELECT l.id, s.account_code, l.booked_on::text AS d, to_char(l.booked_on, 'YYYY-MM') AS m, l.amount_sen,
               l.description, l.reference, l.state, l.kind,
               (SELECT string_agg(x.je_no, ',') FROM scm.acc_bank_statement_matches x WHERE x.bank_line_id = l.id) AS jes,
               (SELECT max(x.match_reason) FROM scm.acc_bank_statement_matches x WHERE x.bank_line_id = l.id) AS why
          FROM scm.acc_bank_statement_lines l JOIN scm.acc_bank_statements s ON s.id = l.statement_id
         WHERE l.company_id = ${CO} AND l.kind = 'OTHER' AND l.state IN ('POSTED', 'OPEN')`;
      const accounts = [...new Set(lines.map((l) => l.account_code))];
      if (accounts.length === 0) continue;
      const gl = await tx`
        SELECT g.je_no, g.account_code, min(g.entry_date)::text AS d, sum(g.debit_sen - g.credit_sen)::bigint AS net,
               max(g.source_type) AS type, max(g.source_doc_no) AS doc, max(g.party_name) AS party, max(g.notes) AS notes
          FROM scm.v_gl_entries g
         WHERE g.company_id = ${CO} AND g.account_code IN ${tx(accounts)}
           AND NOT (coalesce(g.reversed, false) OR g.reversed_by_je IS NOT NULL)
         GROUP BY g.je_no, g.account_code`;
      const payIds = gl.filter((g) => g.type === 'SOPAY' && /^[0-9a-f-]{36}$/i.test(String(g.doc ?? ''))).map((g) => g.doc);
      const pays = payIds.length === 0 ? [] : await tx`
        SELECT p.id::text AS id, o.debtor_name FROM scm.mfg_sales_order_payments p
          LEFT JOIN scm.mfg_sales_orders o ON o.doc_no = p.so_doc_no WHERE p.id::text IN ${tx(payIds)}`;
      const customerOf = new Map(pays.map((p) => [p.id, p.debtor_name]));
      const held = new Set(lines.filter((l) => l.state === 'POSTED').flatMap((l) => String(l.jes ?? '').split(',').filter(Boolean)));
      const names = (g) => namesAgree.length >= 0 && [g.party ?? g.notes ?? null, g.type === 'SOPAY' ? customerOf.get(String(g.doc)) ?? null : null];
      const namesPayer = (text, g) => { const [own, customer] = names(g); return (own != null && namesAgree(text, own)) || (customer != null && agree(text, customer)); };
      const todayRule = (text, cands) => cands.length === 1 && namesAgree(text, cands[0].party ?? cands[0].notes ?? null) ? cands[0] : null;
      const newRule = (text, cands) => { const n = cands.filter((g) => namesPayer(text, g)); return n.length === 1 ? n[0] : null; };

      head(`[${MODE_NAME}] A. company ${CO}: lines already matched to one entry — would the rule have picked it?`);
      const tally = new Map();
      const add = (k) => tally.set(k, (tally.get(k) ?? 0) + 1);
      let shown = 0;
      for (const l of lines.filter((x) => x.state === 'POSTED' && x.jes && !String(x.jes).includes(','))) {
        const text = `${l.description ?? ''} ${l.reference ?? ''}`;
        const cands = gl.filter((g) => g.account_code === l.account_code && Number(g.net) === Number(l.amount_sen) && gap(g.d, l.d) <= ENTRY_MATCH_WINDOW_DAYS);
        const pick = newRule(text, cands);
        const old = todayRule(text, cands);
        const how = l.why === 'amount+name' ? 'auto today' : 'by hand';
        const verdict = pick == null ? 'left to a person' : pick.je_no === l.jes ? 'right' : 'WRONG';
        add(`${l.account_code}|${how}|${verdict}${pick != null && old == null && verdict === 'right' ? ' (new)' : ''}`);
        if (verdict === 'WRONG' && shown < SHOW) {
          shown += 1;
          const was = gl.find((g) => g.je_no === l.jes && g.account_code === l.account_code);
          row('  wrong', l.d, rm(l.amount_sen), short(text, 60), `picked ${pick.je_no} ${pick.d} ${short(names(pick)[1] ?? names(pick)[0], 30)}`, `was ${l.jes} ${was?.d ?? ''} ${short(was ? (names(was)[1] ?? names(was)[0]) : '?', 30)}`);
        }
      }
      for (const [k, n] of [...tally.entries()].sort()) row('BACKTEST', `co${CO}`, k, n);

      head(`B. company ${CO}: OPEN lines the rule would match now`);
      const now = new Map();
      for (const l of lines.filter((x) => x.state === 'OPEN')) {
        const text = `${l.description ?? ''} ${l.reference ?? ''}`;
        const cands = gl.filter((g) => !held.has(g.je_no) && g.account_code === l.account_code && Number(g.net) === Number(l.amount_sen) && gap(g.d, l.d) <= ENTRY_MATCH_WINDOW_DAYS);
        const pick = newRule(text, cands);
        if (!pick) continue;
        now.set(l.account_code, (now.get(l.account_code) ?? 0) + 1);
        row('NOW', `co${CO}`, l.account_code, l.d, rm(l.amount_sen), short(text, 60), `${pick.je_no} ${pick.type} ${short(names(pick).filter(Boolean).join('/'), 30)}`, `${cands.length} same-amount`);
      }
      for (const [k, n] of now) row('NOW_TOTAL', `co${CO}`, k, n);
    }
  });
  console.log('\nRead-only: nothing was written.');
} finally {
  await sql.end();
}
