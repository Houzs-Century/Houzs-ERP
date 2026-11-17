#!/usr/bin/env node
/* apply-fair-pnl-2026-decisions.mjs — the owner's decisions of 2026-11-16 after checking every
   2026 fair against FAIR PNL Y'2026 (January to August; the file counts up to August only).

   THE SHAPE, AND WHAT IS DONE (lib/fair-pnl-2026-decisions.mjs holds the fairs and figures):
   1. #2006 is a second copy of #119, AKEMI REX @ PAVILION BUKIT JALIL 30 Jan - 2 Feb: the same
      Sales again with no COGS, so February read the fair twice. Its lines are archived and it is
      cancelled; its rental (the fair's February half) moves to #119 and its setup (the March
      HOMELOVE @ PEX fair's) to #2254, as new typed lines.
   2. #2038 ZANOTTI BIGHOME @ STADIUM BUKIT JALIL, April: Sales typed into the Total Sales box by
      the 27 July import, with no order, no bill, no COGS and none in the file. Its Sales line is
      archived (and any auto line it drove).
   3. #107, #123, #124, #105 ran across two months and hold the first month's rental only (the file
      splits a fair's rental by days). One typed line adds the other month's part.
   4. #2254 and #2005 take the file's dates; #2219 takes the file's venue.
   Each fair is changed only while it is exactly in the shape the check found; anything else is
   left alone and printed with why. One activity row per change. project_finance's cached figures
   of the fairs whose lines changed are rebuilt as the app's own syncFinanceRollup does, so the Total
   Sales box no longer carries the archived Sales.

   MODE=plan (default) does all of it inside one transaction that is rolled back: nothing is
   written. MODE=apply with CONFIRM="APPLY FAIR PNL 2026 DECISIONS" keeps it, then re-reads on a
   fresh connection: #2006 cancelled with no live line and an empty box; #119's Sales as before and
   its rental the two halves; #2254's setup the moved one; #2038 with no Sales and an empty box, its
   costs as before; each rental fair's rental its two parts, the added line there once, its Sales
   and COGS as before; the dates and venue as the file has them. Prints fair ids and yes / no only
   (the Actions log is public); with PUBKEY the figures go out ENCRYPTED (RSA-OAEP-256 + AES-256-GCM).

   RE-RUN: inert — a fair already in its decided shape is left alone ("already done").
   Env: DATABASE_URL, COMPANY_ID (default 1), PUBKEY (optional). */
import './lib/public-log-guard.mjs';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import postgres from 'postgres';
import {
  DECISION_IDS, DUPLICATE, NO_SALES, RENTAL_MOVED_DESCRIPTION, RENTAL_PARTS, SETUP_MOVED_DESCRIPTION, planDecisions, typed,
} from './lib/fair-pnl-2026-decisions.mjs';
import { pgIdArray } from './lib/pg-id-list.mjs';

const PHRASE = 'APPLY FAIR PNL 2026 DECISIONS';
const MODE = String(process.env.MODE || 'plan').trim().toLowerCase();
const APPLY = MODE === 'apply';
if (APPLY && (process.env.CONFIRM ?? '').trim() !== PHRASE) {
  console.error(`MODE=apply requires CONFIRM="${PHRASE}" — refusing, nothing was written.`);
  process.exit(2);
}
const CO = Number(process.env.COMPANY_ID || 1);
const OWNER = 'Owner 2026-11-16, after checking the fairs against FAIR PNL Y2026.';
const COGS = ['cogs', 'cogs_matt_sofa', 'cogs_bedframe', 'cogs_accessories'];
const say = (s) => console.log(s);
class Rollback extends Error {}

function encryptToHex(obj) {
  const pub = crypto.createPublicKey({ key: Buffer.from(String(process.env.PUBKEY), 'base64'), format: 'der', type: 'spki' });
  const plain = zlib.gzipSync(Buffer.from(JSON.stringify(obj)));
  const key = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  const ek = crypto.publicEncrypt({ key: pub, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, key);
  const len = Buffer.alloc(2);
  len.writeUInt16BE(ek.length);
  return Buffer.concat([len, ek, iv, cipher.getAuthTag(), ct]).toString('hex');
}

/** Each fair the decisions name, as the system holds it. */
const readFairs = (db, lock) => db`
  SELECT p.id::int AS "projectId", p.company_id::int AS "companyId", p.brand, p.venue, p.start_date AS start, p.end_date AS "end", p.status,
         (SELECT COUNT(*)::int FROM sales_entries s WHERE s.project_id = p.id AND s.archived_at IS NULL AND s.status <> 'void') AS bills,
         (SELECT COUNT(*)::int FROM scm.mfg_sales_orders o WHERE o.project_id = p.id AND o.company_id = ${CO} AND o.status <> 'CANCELLED') AS orders,
         (SELECT COUNT(*)::int FROM scm.journal_entry_lines jl
            JOIN scm.journal_entries je ON je.id = jl.journal_entry_id
            JOIN scm.accounts a ON a.company_id = jl.company_id AND a.account_code = jl.account_code
           WHERE jl.project_id = p.id AND jl.company_id = ${CO} AND a.pms_row = 'rental'
             AND je.posted = true AND COALESCE(je.reversed, false) = false AND je.reversed_by_je IS NULL
             AND COALESCE(jl.debit_sen, 0) - COALESCE(jl.credit_sen, 0) > 0) AS "rentalInBooks",
         (SELECT pf.total_sales::float8 FROM project_finance pf WHERE pf.project_id = p.id LIMIT 1) AS box,
         (SELECT COALESCE(json_agg(json_build_object('id', l.id, 'kind', l.kind, 'category', l.category, 'description', l.description,
                   'amount', l.amount, 'auto', (l.auto_source IS NOT NULL AND l.auto_source <> '')) ORDER BY l.id), '[]'::json)
            FROM project_finance_lines l WHERE l.project_id = p.id AND l.archived_at IS NULL) AS lines
    FROM projects p
   WHERE p.company_id = ${CO} AND p.id = ANY(${pgIdArray(DECISION_IDS)}::bigint[]) AND p.archived_at IS NULL
   ORDER BY p.id
   ${lock ? db`FOR UPDATE OF p` : db``}`;

const sen = (rm) => Math.round(Number(rm ?? 0) * 100);
const day = (s) => String(s ?? '').slice(0, 10);
const costsBut = (f, skip) => JSON.stringify(f.lines.filter((l) => !l.auto && l.kind === 'cost' && !skip.includes(String(l.category ?? '').trim()))
  .map((l) => [l.category, sen(l.amount)]));

async function activity(tx, projectId, action, from, to, note, stamp) {
  await tx`
    INSERT INTO project_activity (project_id, action, from_value, to_value, note, user_id, company_id, created_at)
    SELECT p.id, ${action}, ${from}, ${to}, ${note}, NULL, p.company_id, ${stamp}
      FROM projects p WHERE p.id = ${projectId} AND p.company_id = ${CO}`;
}

async function archiveLine(tx, projectId, lineId, note, stamp) {
  const gone = await tx`
    UPDATE project_finance_lines l SET archived_at = ${stamp}, updated_at = ${stamp}
     WHERE l.id = ${lineId} AND l.project_id = ${projectId} AND l.archived_at IS NULL
       AND EXISTS (SELECT 1 FROM projects p WHERE p.id = l.project_id AND p.company_id = ${CO})
    RETURNING l.id`;
  if (gone.length !== 1) throw new Error(`fair ${projectId}: line ${lineId} could not be archived — nothing was kept`);
  await activity(tx, projectId, 'finance_line_remove', String(lineId), null, note, stamp);
}

async function addLine(tx, projectId, category, description, amount, occurredAt, note, stamp) {
  const ins = await tx`
    INSERT INTO project_finance_lines (project_id, kind, category, description, amount, occurred_at, company_id, created_at, updated_at)
    SELECT p.id, 'cost', ${category}, ${description}, ${amount}, ${occurredAt}, p.company_id, ${stamp}, ${stamp}
      FROM projects p WHERE p.id = ${projectId} AND p.company_id = ${CO}
    RETURNING id::int AS id`;
  if (ins.length !== 1) throw new Error(`fair ${projectId}: the ${category} line could not be added — nothing was kept`);
  await activity(tx, projectId, 'finance_line_add', null, String(ins[0].id), note, stamp);
  return ins[0].id;
}

/* project_finance is the cache the app rebuilds after every ledger write (services/projects.ts
   syncFinanceRollup): the same sums, so a list that reads it agrees with the lines. */
async function rollup(tx, ids, stamp) {
  if (ids.length === 0) return;
  await tx`
    UPDATE project_finance pf SET
      rental = s.rental, contractor_cost = s.contractor, license_fee = s.license, deposit_paid = s.deposit,
      deposit_refund = s.refund, misc_cost = s.misc,
      total_sales = CASE WHEN s.keep_lump THEN pf.total_sales ELSE s.sales END,
      updated_at = ${stamp}
    FROM (
      SELECT p.id AS project_id,
        COALESCE((SELECT SUM(l.amount) FROM project_finance_lines l WHERE l.project_id = p.id AND l.archived_at IS NULL AND l.kind = 'cost' AND l.category = 'rental'), 0) AS rental,
        COALESCE((SELECT SUM(l.amount) FROM project_finance_lines l WHERE l.project_id = p.id AND l.archived_at IS NULL AND l.kind = 'cost' AND l.category = 'contractor'), 0) AS contractor,
        COALESCE((SELECT SUM(l.amount) FROM project_finance_lines l WHERE l.project_id = p.id AND l.archived_at IS NULL AND l.kind = 'cost' AND l.category = 'license'), 0) AS license,
        COALESCE((SELECT SUM(l.amount) FROM project_finance_lines l WHERE l.project_id = p.id AND l.archived_at IS NULL AND l.kind = 'cost' AND l.category = 'deposit'), 0) AS deposit,
        COALESCE((SELECT SUM(l.amount) FROM project_finance_lines l WHERE l.project_id = p.id AND l.archived_at IS NULL AND l.kind = 'cost'
                   AND COALESCE(l.category, '') NOT IN ('rental', 'contractor', 'license', 'deposit')), 0) AS misc,
        COALESCE((SELECT SUM(l.amount) FROM project_finance_lines l WHERE l.project_id = p.id AND l.archived_at IS NULL AND l.kind = 'income' AND l.category = 'deposit_refund'), 0) AS refund,
        (CASE WHEN COALESCE((SELECT SUM(r.sales_amount) FROM project_sales_reports r WHERE r.project_id = p.id AND r.archived_at IS NULL), 0) > 0
              THEN GREATEST(COALESCE((SELECT SUM(l.amount) FROM project_finance_lines l WHERE l.project_id = p.id AND l.archived_at IS NULL AND l.kind = 'income'
                                        AND COALESCE(l.category, '') <> 'deposit_refund'), 0),
                            COALESCE((SELECT SUM(r.sales_amount) FROM project_sales_reports r WHERE r.project_id = p.id AND r.archived_at IS NULL), 0))
              ELSE COALESCE((SELECT SUM(l.amount) FROM project_finance_lines l WHERE l.project_id = p.id AND l.archived_at IS NULL AND l.kind = 'income'
                               AND COALESCE(l.category, '') <> 'deposit_refund'), 0) END)
          + COALESCE((SELECT SUM(e.amount) FROM sales_entries e WHERE e.project_id = p.id AND e.archived_at IS NULL AND e.status <> 'void'), 0) AS sales,
        (NOT EXISTS (SELECT 1 FROM project_finance_lines l WHERE l.project_id = p.id AND l.kind = 'income' AND l.category <> 'deposit_refund')
          AND NOT EXISTS (SELECT 1 FROM project_sales_reports r WHERE r.project_id = p.id)
          AND NOT EXISTS (SELECT 1 FROM sales_entries e WHERE e.project_id = p.id)) AS keep_lump
        FROM projects p WHERE p.company_id = ${CO} AND p.id = ANY(${pgIdArray(ids)}::bigint[])
    ) s
    WHERE pf.project_id = s.project_id`;
}

/** Each done step after, against before: yes / no each. */
function judge(before, afterRows, steps) {
  const after = new Map(afterRows.map((f) => [f.projectId, f]));
  const out = [];
  for (const st of steps) {
    const b = before.get(st.projectId);
    const a = after.get(st.projectId);
    if (st.kind === 'duplicate') {
      const rb = before.get(DUPLICATE.realId); const ra = after.get(DUPLICATE.realId);
      const sb = before.get(DUPLICATE.setupToId); const sa = after.get(DUPLICATE.setupToId);
      out.push({ id: st.projectId, kind: st.kind, checks: {
        'cancelled with no live line': a != null && String(a.status ?? '').toLowerCase() === 'cancelled' && a.lines.length === 0,
        'its box empty': a != null && sen(a.box) === 0,
        [`#${DUPLICATE.realId} Sales as before`]: ra != null && sen(typed(ra, 'income', ['sales'])) === sen(typed(rb, 'income', ['sales'])),
        [`#${DUPLICATE.realId} rental = both halves`]: ra != null && sen(typed(ra, 'cost', ['rental'])) === sen(typed(rb, 'cost', ['rental'])) + sen(DUPLICATE.rental)
          && ra.lines.filter((l) => l.description === RENTAL_MOVED_DESCRIPTION).length === 1,
        [`#${DUPLICATE.realId} COGS as before`]: ra != null && sen(typed(ra, 'cost', COGS)) === sen(typed(rb, 'cost', COGS)),
        [`#${DUPLICATE.setupToId} setup = the moved one`]: sa != null && sen(typed(sa, 'cost', ['setup'])) === sen(DUPLICATE.setup)
          && sa.lines.filter((l) => l.description === SETUP_MOVED_DESCRIPTION).length === 1,
        [`#${DUPLICATE.setupToId} rental as before`]: sa != null && sen(typed(sa, 'cost', ['rental'])) === sen(typed(sb, 'cost', ['rental'])),
      } });
    } else if (st.kind === 'noSales') {
      out.push({ id: st.projectId, kind: st.kind, checks: {
        'no Sales left': a != null && sen(typed(a, 'income', ['sales'])) === 0,
        'its box empty': a != null && sen(a.box) === 0,
        'no auto line left': a != null && !a.lines.some((l) => l.auto),
        'its costs as before': a != null && costsBut(a, []) === costsBut(b, []),
      } });
    } else if (st.kind === 'rental') {
      const want = RENTAL_PARTS.find((r) => r.projectId === st.projectId);
      out.push({ id: st.projectId, kind: st.kind, checks: {
        'rental = both parts': a != null && sen(typed(a, 'cost', ['rental'])) === sen(want.has) + sen(want.add),
        'added line once': a != null && a.lines.filter((l) => l.description === st.description).length === 1,
        'Sales as before': a != null && sen(typed(a, 'income', ['sales'])) === sen(typed(b, 'income', ['sales'])),
        'COGS and other costs as before': a != null && costsBut(a, ['rental']) === costsBut(b, ['rental']),
      } });
    } else if (st.kind === 'dates') {
      out.push({ id: st.projectId, kind: st.kind, checks: {
        'dates as the file': a != null && day(a.start) === st.to.start && day(a.end) === st.to.end,
      } });
    } else if (st.kind === 'venue') {
      out.push({ id: st.projectId, kind: st.kind, checks: {
        'venue as the file': a != null && String(a.venue ?? '').trim().toUpperCase() === st.to,
      } });
    }
  }
  return { ok: out.every((o) => Object.values(o.checks).every(Boolean)), fairs: out };
}
const printJudged = (j) => {
  for (const f of j.fairs) say(`   fair ${f.id} (${f.kind}): ${Object.entries(f.checks).map(([k, v]) => `${k} ${v ? 'yes' : 'NO'}`).join(' · ')}`);
};

async function main() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
  const detail = { at: new Date().toISOString(), company: CO, steps: [], left: [], before: {}, after: {} };
  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  let steps = [];
  let before = null;
  /* Set once the apply's transaction is kept: a failure after it is the re-read's, not the write's. */
  let written = false;
  try {
    say(`apply-fair-pnl-2026-decisions   company ${CO}   mode ${APPLY ? 'APPLY' : 'PLAN'}`);
    try {
      await sql.begin(async (tx) => {
        const rows = await readFairs(tx, true);
        before = new Map(rows.map((f) => [f.projectId, f]));
        for (const f of rows) detail.before[f.projectId] = f;
        const plan = planDecisions(rows, CO);
        say(`   ${DECISION_IDS.length} fair(s) read: ${plan.steps.length} change(s) to make, ${plan.left.length} left alone`);
        for (const l of plan.left) {
          say(`      fair ${l.projectId} (${l.decision}): left — ${l.why}`);
          detail.left.push(l);
        }
        if (plan.steps.length === 0) { say('\nNothing to do — nothing written.'); throw new Rollback(); }
        const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
        const touched = new Set();
        for (const st of plan.steps) {
          if (st.kind === 'duplicate') {
            const note = `Second copy of #${DUPLICATE.realId} (the same fair, AKEMI REX @ PAVILION BUKIT JALIL 30 Jan - 2 Feb, with the same sales): line archived. ${OWNER}`;
            for (const id of st.archive) await archiveLine(tx, st.projectId, id, note, stamp);
            const rentalLine = await addLine(tx, DUPLICATE.realId, 'rental', RENTAL_MOVED_DESCRIPTION, DUPLICATE.rental, '2026-02-02',
              `The fair's February half of the rental moved here from #${DUPLICATE.duplicateId}, its duplicate; the rental is now the January and February halves, as the file splits it. ${OWNER}`, stamp);
            const setupLine = await addLine(tx, DUPLICATE.setupToId, 'setup', SETUP_MOVED_DESCRIPTION, DUPLICATE.setup, '2026-03-08',
              `This fair's setup moved here from #${DUPLICATE.duplicateId}, where the 29 July import had put it. ${OWNER}`, stamp);
            const cancelled = await tx`
              UPDATE projects p SET status = 'cancelled', updated_at = ${stamp}
               WHERE p.id = ${st.projectId} AND p.company_id = ${CO} AND COALESCE(p.status, '') <> 'cancelled'
              RETURNING p.id`;
            if (cancelled.length !== 1) throw new Error(`fair ${st.projectId}: could not be cancelled — nothing was kept`);
            await activity(tx, st.projectId, 'note', before.get(st.projectId).status ?? null, 'cancelled',
              `Cancelled: a second copy of #${DUPLICATE.realId}; its rental moved to #${DUPLICATE.realId} and its setup to #${DUPLICATE.setupToId}. ${OWNER}`, stamp);
            [st.projectId, DUPLICATE.realId, DUPLICATE.setupToId].forEach((id) => touched.add(id));
            detail.steps.push({ ...st, rentalLine, setupLine });
            say(`      fair ${st.projectId}: ${st.archive.length} line(s) archived, rental moved to #${DUPLICATE.realId}, setup moved to #${DUPLICATE.setupToId}, cancelled`);
          } else if (st.kind === 'noSales') {
            const note = `Sales typed into Total Sales by the 27 July import, with no order, no bill and no COGS, and none in FAIR PNL Y2026: archived. ${OWNER}`;
            for (const id of st.archive) await archiveLine(tx, st.projectId, id, note, stamp);
            touched.add(st.projectId);
            detail.steps.push(st);
            say(`      fair ${st.projectId}: ${st.archive.length} line(s) archived`);
          } else if (st.kind === 'rental') {
            const want = RENTAL_PARTS.find((r) => r.projectId === st.projectId);
            const line = await addLine(tx, st.projectId, 'rental', st.description, st.amount, want.part === 'February' ? '2026-02-02' : '2026-03-01',
              `The rental's ${want.part} part added: the fair ran across two months and the file splits its rental by days; only the first month's part was in. ${OWNER}`, stamp);
            touched.add(st.projectId);
            detail.steps.push({ ...st, line });
            say(`      fair ${st.projectId}: rental's ${want.part} part added`);
          } else if (st.kind === 'dates') {
            const moved = await tx`
              UPDATE projects p SET start_date = ${st.to.start}, end_date = ${st.to.end}, updated_at = ${stamp}
               WHERE p.id = ${st.projectId} AND p.company_id = ${CO}
                 AND left(p.start_date, 10) = ${st.from.start} AND left(COALESCE(p.end_date, ''), 10) = ${st.from.end}
              RETURNING p.id`;
            if (moved.length !== 1) throw new Error(`fair ${st.projectId}: dates could not be set — nothing was kept`);
            await activity(tx, st.projectId, 'note', `${st.from.start} ~ ${st.from.end}`, `${st.to.start} ~ ${st.to.end}`, `Dates as FAIR PNL Y2026 has them. ${OWNER}`, stamp);
            detail.steps.push(st);
            say(`      fair ${st.projectId}: dates set`);
          } else if (st.kind === 'venue') {
            const moved = await tx`
              UPDATE projects p SET venue = ${st.to}, updated_at = ${stamp}
               WHERE p.id = ${st.projectId} AND p.company_id = ${CO} AND p.venue = ${st.from}
              RETURNING p.id`;
            if (moved.length !== 1) throw new Error(`fair ${st.projectId}: venue could not be set — nothing was kept`);
            await activity(tx, st.projectId, 'note', st.from, st.to, `Venue as FAIR PNL Y2026 has it (and as the fair's own name says). ${OWNER}`, stamp);
            detail.steps.push(st);
            say(`      fair ${st.projectId}: venue set`);
          }
        }
        await rollup(tx, [...touched], stamp);
        steps = plan.steps;
        const afterRows = await readFairs(tx, false);
        for (const f of afterRows) detail.after[f.projectId] = f;
        const j = judge(before, afterRows, steps);
        printJudged(j);
        if (!j.ok) throw new Error('the read-back is not what was meant');
        if (!APPLY) throw new Rollback();
      });
    } catch (e) {
      if (!(e instanceof Rollback)) throw e;
      if (steps.length > 0) say(`\nRehearsal passed and was rolled back — nothing written. To write: MODE=apply CONFIRM="${PHRASE}"`);
      return;
    }
    written = true;
    say(`\n   completed: ${steps.length} change(s)`);
    const check = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
    try {
      const afterRows = await readFairs(check, false);
      for (const f of afterRows) detail.after[f.projectId] = f;
      const j = judge(before, afterRows, steps);
      say('Verified on a fresh connection:');
      printJudged(j);
      if (!j.ok) process.exitCode = 1;
    } finally { await check.end(); }
  } catch (e) {
    console.error(`${String(e?.message ?? e).slice(0, 300)} — ${written ? 'the change IS written; only the re-read failed: check the rows by hand' : 'nothing was kept'}.`);
    process.exitCode = 1;
  } finally {
    await sql.end();
    if (process.env.PUBKEY) {
      const hex = encryptToHex(detail);
      for (let i = 0; i < hex.length; i += 160) console.log(`ENC|${hex.slice(i, i + 160)}`);
    }
  }
}
main().catch((e) => { console.error(String(e?.message ?? e).slice(0, 300)); process.exit(1); });
