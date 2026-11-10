#!/usr/bin/env node
// check-bank-recon-hard.mjs — READ ONLY (one READ ONLY transaction; mode=apply refused).
//
// Owner 2026-11-10 「为何我感觉现在的bank recon 很难对账啊？」
// Every bank month of each company, read through the app's own handlers
// (GET /bank/months and GET /bank/months/:account/:month, through pgrest-shim),
// each line sorted into the six tabs exactly as BankLineTabs.bankLineTab does
// (To match · To choose · No entry found ‖ Not on the bank yet ‖ Matched · Set
// aside), and each open line given the reason it sits where it does.
//
// Env: DATABASE_URL, COMPANY_IDS (default "1,2"), SAMPLES (default 6),
//      ALL_MONTHS=1 to include locked months.
import postgres from 'postgres';
import { Hono } from 'hono';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { bankMonths, bankMonthDetail } from '../src/scm/routes/accounting-bank-months.ts';
import { namesAgree, ENTRY_MATCH_WINDOW_DAYS } from '../src/acc/bank-match.ts';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
if ((process.env.MODE || 'plan') !== 'plan') { console.error('check-bank-recon-hard.mjs is read-only: run it with mode=plan.'); process.exit(1); }

const COS = String(process.env.COMPANY_IDS || '1,2').split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
const SAMPLES = Number(process.env.SAMPLES || 6);
const ALL = process.env.ALL_MONTHS === '1';
const sql = postgres(process.env.DATABASE_URL, {
  max: 1, prepare: false,
  types: { date: { to: 1082, from: [1082], serialize: (x) => x, parse: (x) => x } },
});
const rm = (sen) => (Number(sen ?? 0) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const d10 = (v) => (v instanceof Date ? v.toISOString() : String(v ?? '')).slice(0, 10);
const row = (...parts) => console.log(`ROW|${parts.join('|')}`);
const head = (t) => console.log(`\n=== ${t}`);
const DAY = 86_400_000;
const gap = (a, b) => Math.round(Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY);
const short = (s, n = 70) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/* BankLineTabs.bankLineTab, with BankStatementTab.certainAllocation (no "Not this" presses). */
const certain = (l) => {
  if (l.state !== 'OPEN' || l.kind !== 'PAYOUT' || l.matched_batch_id == null || Number(l.amount_sen) <= 0) return null;
  const b = (l.candidates ?? []).find((x) => Number(x.id) === Number(l.matched_batch_id));
  return b && Number(b.outstandingSen) === Number(l.amount_sen) ? b : null;
};
const tabOf = (l) => {
  if (l.state === 'POSTED') return 'matched';
  if (l.state === 'IGNORED') return 'set-aside';
  if (l.kind === 'QR') return l.qr_sales?.ready ? 'to-match' : 'to-choose';
  if (certain(l)) return 'to-match';
  const ec = l.entryCandidates ?? [];
  const bc = l.candidates ?? [];
  if (l.kind === 'OTHER' && ec.length === 1) return 'to-match';
  if ((l.kind === 'OTHER' || l.kind === 'PAYOUT_NO_BATCH') && ec.length === 0 && bc.length === 0) return 'no-entry';
  return 'to-choose';
};
const TABS = ['to-match', 'to-choose', 'no-entry', 'not-on-bank', 'matched', 'set-aside'];

const PATTERNS = [
  ['own company / inter-company transfer', /HOUZS|2990 ?HOME|CA to CA|SA to CA/i],
  ['card / merchant money', /MERCHAN|CARD SALES|PBB-PBCS|GHL|DMS A3|SETTLEMENT|IPAY88|BOOST|GRAB|SHOPEE|ATOME/i],
  ['bank charge / fee', /S\/?CHRG|CHARGE|CHRG|\bFEE\b|COMMISSION|STAMP DUTY|SERVICE TAX|HANDLING/i],
  ['interest / profit', /INTEREST|HIBAH|PROFIT PAID|DIVIDEND/i],
  ['cheque', /\bCHQ|CHEQUE|CLEARING/i],
  ['bill / statutory', /JOMPAY|TENAGA|\bTNB\b|AIR SELANGOR|SYABAS|INDAH WATER|\bIWK\b|UNIFI|TELEKOM|MAXIS|CELCOM|\bDIGI\b|UMOBILE|U MOBILE|KWSP|\bEPF\b|PERKESO|SOCSO|LHDN|HASIL/i],
  ['salary', /SALARY|GAJI|PAYROLL/i],
];
const patternOf = (l) => {
  const text = `${l.description ?? ''} ${l.reference ?? ''}`;
  for (const [name, re] of PATTERNS) if (re.test(text)) return name;
  return Number(l.amount_sen) > 0 ? 'money in, nothing keyed for it' : 'money out, no voucher for it';
};

try {
  await sql.begin('read only', async (tx) => {
    const sb = pgrestShim(tx, 'scm');
    const grand = new Map();
    const bump = (m, k, sen) => { const at = m.get(k) ?? { n: 0, sen: 0 }; at.n += 1; at.sen += Math.abs(Number(sen ?? 0)); m.set(k, at); };

    for (const CO of COS) {
      const app = new Hono();
      app.use('*', async (c, next) => {
        c.set('supabase', sb);
        c.set('companyId', CO);
        c.set('houzsUser', { name: 'read-only check', permissions_set: ['scm.payment_voucher.post'] });
        c.set('allowedCompanyIds', [CO]);
        await next();
      });
      app.get('/bank/months', bankMonths);
      app.get('/bank/months/:accountCode/:month', bankMonthDetail);

      /* The books side for the searches below: every bank-account entry of the company, one per (entry, account). */
      const glRows = await tx`
        SELECT je_no, entry_date::text AS d, account_code, source_type, source_doc_no, party_name,
               debit_sen, credit_sen, reversed, reversed_by_je
          FROM scm.v_gl_entries WHERE company_id = ${CO} AND account_code LIKE '310-%'`;
      const byKey = new Map();
      for (const r of glRows) {
        if (r.reversed === true || r.reversed_by_je != null) continue;
        const k = `${r.je_no}|${r.account_code}`;
        const at = byKey.get(k) ?? { jeNo: r.je_no, d: r.d, account: r.account_code, type: r.source_type, doc: r.source_doc_no, party: r.party_name, net: 0 };
        at.net += Number(r.debit_sen ?? 0) - Number(r.credit_sen ?? 0);
        byKey.set(k, at);
      }
      const gl = [...byKey.values()];
      const posted = await tx`SELECT l.id, l.posted_je_no FROM scm.acc_bank_statement_lines l WHERE l.company_id = ${CO} AND l.state = 'POSTED'`;
      const matchRows = await tx`
        SELECT m.je_no FROM scm.acc_bank_statement_matches m JOIN scm.acc_bank_statement_lines l ON l.id = m.bank_line_id
         WHERE m.company_id = ${CO} AND l.state = 'POSTED'`;
      const held = new Set([
        ...posted.flatMap((p) => String(p.posted_je_no ?? '').split(',').map((s) => s.trim()).filter(Boolean)),
        ...matchRows.map((m) => m.je_no),
      ]);
      const firstFrom = new Map();
      for (const s of await tx`SELECT account_code, min(period_from)::text AS f, max(period_to)::text AS t, count(*)::int AS n FROM scm.acc_bank_statements WHERE company_id = ${CO} GROUP BY account_code`) {
        firstFrom.set(s.account_code, s.f);
        row('ACCOUNT', `co${CO}`, s.account_code, `files ${s.n}`, `${s.f}..${s.t}`);
      }
      const openLines = await tx`
        SELECT l.id, s.account_code, l.booked_on::text AS d, l.amount_sen FROM scm.acc_bank_statement_lines l
          JOIN scm.acc_bank_statements s ON s.id = l.statement_id WHERE l.company_id = ${CO} AND l.state = 'OPEN'`;

      const listRes = await app.request('/bank/months');
      const list = await listRes.json();
      if (listRes.status !== 200) { row('REFUSED', `co${CO}`, listRes.status, JSON.stringify(list).slice(0, 300)); continue; }
      head(`company ${CO}: months (newest first)`);
      for (const m of list.months) {
        row('MONTH', `co${CO}`, m.accountCode, m.month, `lines ${m.lineCount}`, `open ${m.openCount}`, m.complete ? 'complete' : `gaps ${m.gapCount}`, m.locked ? `LOCKED by ${m.locked.lockedBy}` : 'open month');
      }

      const latestOfAccount = new Map();
      for (const m of list.months) if (!latestOfAccount.has(m.accountCode)) latestOfAccount.set(m.accountCode, m.month);

      for (const m of [...list.months].reverse()) {
        if (m.locked && !ALL) continue;
        const res = await app.request(`/bank/months/${encodeURIComponent(m.accountCode)}/${m.month}`);
        const body = await res.json();
        if (res.status !== 200) { row('REFUSED', `co${CO}`, m.accountCode, m.month, res.status, JSON.stringify(body).slice(0, 300)); continue; }
        const where = `co${CO} ${m.accountCode} ${m.month}`;
        head(where);
        const counts = Object.fromEntries(TABS.map((t) => [t, 0]));
        const reasons = new Map();
        const samples = new Map();
        const matchedBy = new Map();
        const note = (tab, reason, l, detail) => {
          bump(reasons, `${tab}|${reason}`, l.amount_sen);
          bump(grand, `co${CO}|${tab}|${reason}`, l.amount_sen);
          const list2 = samples.get(`${tab}|${reason}`) ?? [];
          if (list2.length < SAMPLES) list2.push(`${d10(l.booked_on)} ${rm(l.amount_sen)} | ${short(l.description, 45)} / ${short(l.reference, 60)}${detail ? ` | ${detail}` : ''}`);
          samples.set(`${tab}|${reason}`, list2);
        };

        for (const l of body.lines) {
          const tab = tabOf(l);
          counts[tab] += 1;
          const text = `${l.description ?? ''} ${l.reference ?? ''}`;
          if (tab === 'matched') {
            const why = l.matches?.[0]?.match_reason ?? (l.posted_je_no ? 'posted from the line (Money received / Record journal)' : 'posted');
            bump(matchedBy, why, l.amount_sen);
            continue;
          }
          if (tab === 'set-aside') { note(tab, short(l.note, 40) || 'set aside', l, ''); continue; }
          if (tab === 'to-match') {
            if (l.kind === 'QR') { note(tab, 'QR money, its sales ready', l, ''); continue; }
            if (certain(l)) { note(tab, 'card payout, a report owes exactly this', l, ''); continue; }
            const e = l.entryCandidates[0];
            const agreeAuto = namesAgree(text, e.partyName ?? e.notes ?? null);
            const agreeShown = namesAgree(text, e.who ?? null);
            const reason = agreeAuto
              ? 'one entry, names agree — not there (or not alone) when the file was uploaded'
              : (e.partyName == null && agreeShown)
                ? `one entry (${e.sourceType}) — the name shown agrees, but the entry itself carries no name`
                : (e.partyName == null)
                  ? `one entry (${e.sourceType}) — no name on the entry, the shown name differs too`
                  : 'one entry — the bank names someone else';
            note(tab, reason, l, `${e.jeNo} ${e.sourceType ?? ''} ${short(e.reference ?? e.sourceDocNo, 30)} who=${short(e.who ?? e.partyName, 30)} ${e.daysApart}d`);
            continue;
          }
          if (tab === 'to-choose') {
            const ec = l.entryCandidates ?? [];
            const bc = l.candidates ?? [];
            let reason;
            if (l.kind === 'QR') reason = 'QR money, a sale still to key or link';
            else if (String(l.kind).startsWith('PAYOUT')) {
              reason = bc.length === 0 ? `card-like credit (${l.kind}), ${ec.length} same-amount entries`
                : l.matched_batch_id == null ? `card payout (${l.kind}), no report decided for it`
                  : `card payout (${l.kind}), the report owes a different amount`;
            } else if (ec.length >= 2) {
              const shownAgree = ec.filter((e) => namesAgree(text, e.who ?? e.partyName ?? null)).length;
              reason = `several same-amount entries within ${ENTRY_MATCH_WINDOW_DAYS} days (${shownAgree === 1 ? 'one of them names the payer' : shownAgree === 0 ? 'none names the payer' : 'several name the payer'})`;
            } else reason = `other (${l.kind}, ${ec.length} entries, ${bc.length} reports)`;
            note(tab, reason, l, ec.slice(0, 3).map((e) => `${e.jeNo} ${short(e.who ?? e.partyName, 20)} ${e.daysApart}d`).join(' ; '));
            continue;
          }
          /* No entry found: look for it in the books beyond what the screen offers. */
          const amt = Number(l.amount_sen);
          const on = d10(l.booked_on);
          const acct = m.accountCode;
          const unheld = gl.filter((g) => g.net === amt && !held.has(g.jeNo) && g.d >= (firstFrom.get(g.account) ?? '0000'));
          const far = unheld.filter((g) => g.account === acct && gap(g.d, on) > ENTRY_MATCH_WINDOW_DAYS).sort((a, b) => gap(a.d, on) - gap(b.d, on));
          const other = unheld.filter((g) => g.account !== acct && gap(g.d, on) <= ENTRY_MATCH_WINDOW_DAYS);
          const otherAny = gl.filter((g) => g.net === amt && g.account !== acct && gap(g.d, on) <= ENTRY_MATCH_WINDOW_DAYS);
          const taken = gl.filter((g) => g.net === amt && g.account === acct && held.has(g.jeNo) && gap(g.d, on) <= ENTRY_MATCH_WINDOW_DAYS);
          if (far.length > 0) note(tab, 'in the books, but dated more than 7 days away', l, far.slice(0, 2).map((g) => `${g.jeNo} ${g.type} ${short(g.doc, 22)} ${g.d} (${gap(g.d, on)}d) ${short(g.party, 24)}`).join(' ; '));
          else if (other.length > 0) note(tab, 'in the books, on another bank account', l, other.slice(0, 2).map((g) => `${g.account} ${g.jeNo} ${g.type} ${g.d} ${short(g.party, 24)}`).join(' ; '));
          else if (taken.length > 0) note(tab, 'the same-amount entry is already matched to another line', l, taken.slice(0, 2).map((g) => `${g.jeNo} ${g.type} ${g.d}`).join(' ; '));
          else if (otherAny.length > 0) note(tab, `${patternOf(l)} (a same-amount entry sits on another account, already matched)`, l, otherAny.slice(0, 2).map((g) => `${g.account} ${g.jeNo} ${g.d}`).join(' ; '));
          else note(tab, patternOf(l), l, '');
        }

        /* Not on the bank yet: the screen's own list. */
        const entries = body.unmatchedEntries ?? [];
        counts['not-on-bank'] = entries.length;
        const isLatest = latestOfAccount.get(m.accountCode) === m.month;
        const openOffered = new Set(body.lines.filter((l) => l.state === 'OPEN').flatMap((l) => (l.entryCandidates ?? []).map((e) => e.jeNo)));
        for (const e of entries) {
          const net = Number(e.debitSen) - Number(e.creditSen);
          let reason;
          if (openOffered.has(e.jeNo)) reason = 'offered under an open line';
          else {
            const sameFar = openLines.filter((o) => o.account_code === m.accountCode && Number(o.amount_sen) === net);
            const otherBank = openLines.filter((o) => o.account_code !== m.accountCode && Number(o.amount_sen) === net && gap(o.d, e.entryDate) <= ENTRY_MATCH_WINDOW_DAYS);
            reason = sameFar.length > 0 ? `an open line of this amount sits ${Math.min(...sameFar.map((o) => gap(o.d, e.entryDate)))}+ days away`
              : otherBank.length > 0 ? 'an open line of this amount sits on another bank account'
                : 'no bank line of this amount yet';
          }
          const key = `not-on-bank|${e.carried ? 'earlier month' : 'this month'} · ${e.sourceType ?? '?'} · ${reason}`;
          bump(reasons, key, net);
          if (isLatest) bump(grand, `co${CO}|${key}`, net);
          const list2 = samples.get(key) ?? [];
          if (list2.length < Math.min(SAMPLES, 3)) list2.push(`${e.entryDate} ${rm(net)} | ${e.jeNo} ${short(e.reference ?? e.sourceDocNo, 28)} | ${short(e.who ?? e.partyName ?? e.notes, 40)}`);
          samples.set(key, list2);
        }

        const r = body.reconciliation ?? {};
        row('TABS', where, ...TABS.map((t) => `${t} ${counts[t]}`), `difference ${r.differenceSen == null ? 'n/a' : rm(r.differenceSen)}`, body.assembly?.complete ? 'balances complete' : `gaps: ${(body.assembly?.gaps ?? []).map((g) => short(g, 90)).join(' / ')}`, body.lock ? 'LOCKED' : '', isLatest ? 'LATEST' : '');
        row('MATCHED_BY', where, [...matchedBy.entries()].map(([k, v]) => `${k}: ${v.n}`).join(' · ') || '—');
        for (const [k, v] of [...reasons.entries()].sort((a, b) => b[1].n - a[1].n)) {
          row('REASON', where, k, v.n, `RM ${rm(v.sen)}`);
          for (const s of samples.get(k) ?? []) row('  e.g.', s);
        }
      }
    }

    head('TOTALS over open months (Not on the bank yet: latest month of each account only)');
    for (const [k, v] of [...grand.entries()].sort((a, b) => a[0].localeCompare(b[0]))) row('TOTAL', k, v.n, `RM ${rm(v.sen)}`);
  });
  console.log('\nRead-only: nothing was written.');
} finally {
  await sql.end();
}
