#!/usr/bin/env node
/* archive-duplicate-fair-sales-lines.mjs — a fair's sales counted twice (owner 2026-11-16:
   「帮我检查，为什么两边不一样」 — a fair's page read RM 250,535, the Project Overview RM 501,070).

   THE SHAPE. Eight June 2026 fairs carry their sales twice: their bills, keyed as
   sales_entries (imported 2026-07-01), and one typed project_finance_lines row
   (income / sales, "sales (FAIR PNL v8 align)", written 2026-07-28 by the
   align-figures pass of #1397) of exactly the same amount. The event P&L
   (services/eventPnlBatch.ts) and the event page add the bills to the typed lines,
   so By Total Sales — and every % row worked on it — read double.

   THE REPAIR. Archive that typed line where the fair's bills (not void, not
   archived) add up to exactly its amount and it is the fair's only typed sales
   line; every other line is left alone and listed (lib/duplicate-fair-sales.mjs).
   One activity row per fair says why. Nothing else is touched: the auto cost lines
   keep today's amounts (they were worked on the same sales) and project_finance's
   cached Total Sales already reads the bills. The same PR makes the auto-cost
   engine count the bills, so a later ledger edit on these fairs no longer purges
   their auto lines.

   MODE=plan (default) does all of it inside one transaction that is rolled back:
   nothing is written. MODE=apply with CONFIRM="ARCHIVE DUPLICATE FAIR SALES LINES"
   keeps it, then re-reads on a fresh connection: each line archived; its fair with
   no live typed sales line and its bills as they were; Total Sales (typed lines +
   bills) equal to the bills; the auto cost lines as they were; the cached Total
   Sales equal to the bills. Prints fair ids, line ids and yes / no only (the
   Actions log is public); with PUBKEY the figures go out ENCRYPTED
   (RSA-OAEP-256 + AES-256-GCM).

   RE-RUN: inert — an archived line is no longer read, so a second run archives nothing.
   Env: DATABASE_URL, COMPANY_ID (default 1), PROJECT_IDS (optional, e.g. 70,99), PUBKEY (optional). */
import './lib/public-log-guard.mjs';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import postgres from 'postgres';
import { pickDuplicateSalesLines } from './lib/duplicate-fair-sales.mjs';

const PHRASE = 'ARCHIVE DUPLICATE FAIR SALES LINES';
const MODE = String(process.env.MODE || 'plan').trim().toLowerCase();
const APPLY = MODE === 'apply';
if (APPLY && (process.env.CONFIRM ?? '').trim() !== PHRASE) {
  console.error(`MODE=apply requires CONFIRM="${PHRASE}" — refusing, nothing was written.`);
  process.exit(2);
}
const CO = Number(process.env.COMPANY_ID || 1);
const ONLY = String(process.env.PROJECT_IDS ?? '').split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
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

/** The live typed sales lines of the company's fairs that have bills — locked when `lock`. */
const readCandidates = (db, lock) => db`
  SELECT l.id::int AS "lineId", l.project_id::int AS "projectId", l.company_id::int AS "companyId", p.company_id::int AS "projectCompanyId",
         l.description, l.amount::float8 AS amount,
         (SELECT COUNT(*)::int FROM sales_entries s WHERE s.project_id = l.project_id AND s.archived_at IS NULL AND s.status <> 'void') AS bills,
         (SELECT COALESCE(SUM(s.amount), 0)::float8 FROM sales_entries s WHERE s.project_id = l.project_id AND s.archived_at IS NULL AND s.status <> 'void') AS "billsSum",
         (SELECT COUNT(*)::int FROM project_finance_lines x WHERE x.project_id = l.project_id AND x.archived_at IS NULL
             AND x.kind = 'income' AND x.category = 'sales' AND x.auto_source IS NULL) AS "typedSalesLines"
    FROM project_finance_lines l
    JOIN projects p ON p.id = l.project_id
   WHERE p.company_id = ${CO}
     AND l.archived_at IS NULL AND l.kind = 'income' AND l.category = 'sales' AND l.auto_source IS NULL
     AND EXISTS (SELECT 1 FROM sales_entries s WHERE s.project_id = l.project_id AND s.archived_at IS NULL AND s.status <> 'void')
     ${ONLY.length ? db`AND l.project_id = ANY(${db.array(ONLY)})` : db``}
   ORDER BY l.project_id, l.id
   ${lock ? db`FOR UPDATE OF l` : db``}`;

/** What must not move, and what must come out, per fair: its bills, its auto cost lines, its cached Total Sales, its live typed sales. */
const readFairs = async (db, ids) => {
  const rows = await db`
    SELECT p.id::int AS id,
           (SELECT COALESCE(SUM(s.amount), 0)::float8 FROM sales_entries s WHERE s.project_id = p.id AND s.archived_at IS NULL AND s.status <> 'void') AS "billsSum",
           (SELECT COALESCE(SUM(x.amount), 0)::float8 FROM project_finance_lines x WHERE x.project_id = p.id AND x.archived_at IS NULL
               AND x.kind = 'income' AND x.category = 'sales' AND x.auto_source IS NULL) AS "typedSales",
           (SELECT COALESCE(json_agg(json_build_object('id', a.id, 'src', a.auto_source, 'amount', a.amount, 'live', a.archived_at IS NULL) ORDER BY a.id), '[]'::json)
              FROM project_finance_lines a WHERE a.project_id = p.id AND a.auto_source IS NOT NULL) AS auto,
           (SELECT pf.total_sales::float8 FROM project_finance pf WHERE pf.project_id = p.id) AS "cachedTotal"
      FROM projects p
     WHERE p.company_id = ${CO} AND p.id = ANY(${db.array(ids)})
     ORDER BY p.id`;
  return new Map(rows.map((r) => [r.id, r]));
};
const sen = (rm) => Math.round(Number(rm ?? 0) * 100);

/** The shape after the repair, fair by fair, against the shape before: yes / no each. */
function judge(before, after, archivedIds, lineIds) {
  const out = [];
  for (const [id, b] of before) {
    const a = after.get(id);
    out.push({
      id,
      noTypedSales: a != null && sen(a.typedSales) === 0,
      billsKept: a != null && sen(a.billsSum) === sen(b.billsSum),
      totalIsBills: a != null && sen(a.typedSales) + sen(a.billsSum) === sen(b.billsSum),
      autoKept: a != null && JSON.stringify(a.auto) === JSON.stringify(b.auto),
      cachedIsBills: a != null && sen(a.cachedTotal) === sen(a.billsSum),
    });
  }
  const linesArchived = lineIds.every((l) => archivedIds.has(l));
  const ok = linesArchived && out.every((f) => f.noTypedSales && f.billsKept && f.totalIsBills && f.autoKept && f.cachedIsBills);
  return { ok, linesArchived, fairs: out };
}
const printJudged = (j) => {
  for (const f of j.fairs) {
    say(`   fair ${f.id}: no typed sales left ${f.noTypedSales ? 'yes' : 'NO'} · bills kept ${f.billsKept ? 'yes' : 'NO'} · Total Sales = bills ${f.totalIsBills ? 'yes' : 'NO'}`
      + ` · auto cost lines kept ${f.autoKept ? 'yes' : 'NO'} · cached Total Sales = bills ${f.cachedIsBills ? 'yes' : 'NO'}`);
  }
  say(`   every line archived ${j.linesArchived ? 'yes' : 'NO'}`);
};

async function main() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
  const detail = { at: new Date().toISOString(), company: CO, archived: [], left: [] };
  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  let picked = [];
  let before = null;
  try {
    say(`archive-duplicate-fair-sales-lines   company ${CO}   mode ${APPLY ? 'APPLY' : 'PLAN'}${ONLY.length ? `   fairs ${ONLY.join(',')}` : ''}`);
    try {
      await sql.begin(async (tx) => {
        const rows = await readCandidates(tx, true);
        const { archive, left } = pickDuplicateSalesLines(rows, CO);
        picked = archive;
        say(`   ${rows.length} typed sales line(s) on fairs with bills: ${archive.length} to archive, ${left.length} left alone`);
        for (const r of left) {
          say(`      fair ${r.projectId} line ${r.lineId}: left — ${r.why}`);
          detail.left.push(r);
        }
        if (archive.length === 0) { say('\nNothing to archive — nothing written.'); throw new Rollback(); }
        before = await readFairs(tx, archive.map((r) => r.projectId));
        const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
        for (const r of archive) {
          const done = await tx`
            UPDATE project_finance_lines l SET archived_at = ${stamp}, updated_at = ${stamp}
             WHERE l.id = ${r.lineId} AND l.project_id = ${r.projectId} AND l.archived_at IS NULL
               AND l.kind = 'income' AND l.category = 'sales' AND l.auto_source IS NULL
               AND EXISTS (SELECT 1 FROM projects p WHERE p.id = l.project_id AND p.company_id = ${CO})
            RETURNING l.id`;
          if (done.length !== 1) throw new Error(`line ${r.lineId} on fair ${r.projectId} could not be archived — nothing was kept`);
          await tx`
            INSERT INTO project_activity (project_id, action, from_value, to_value, note, user_id, company_id, created_at)
            VALUES (${r.projectId}, 'finance_line_remove', ${String(r.lineId)}, NULL,
                    ${`Typed sales line #${r.lineId} archived: the fair's bills already carry the same sales (FAIR PNL v8 align on top of its sales entries), so its Total Sales read double.`},
                    NULL, ${CO}, ${stamp})`;
          detail.archived.push({ projectId: r.projectId, lineId: r.lineId, amount: r.amount, bills: r.bills, billsSum: r.billsSum });
          say(`      fair ${r.projectId} line ${r.lineId}: archived`);
        }
        /* Read back inside the transaction, as the fresh connection will after it. */
        const after = await readFairs(tx, archive.map((r) => r.projectId));
        const gone = await tx`SELECT id::int AS id FROM project_finance_lines WHERE id = ANY(${tx.array(archive.map((r) => r.lineId))}) AND archived_at IS NOT NULL`;
        const j = judge(before, after, new Set(gone.map((g) => g.id)), archive.map((r) => r.lineId));
        printJudged(j);
        if (!j.ok) throw new Error('the read-back is not what was meant');
        if (!APPLY) throw new Rollback();
      });
    } catch (e) {
      if (!(e instanceof Rollback)) throw e;
      if (picked.length > 0) say(`\nRehearsal passed and was rolled back — nothing written. To write: MODE=apply CONFIRM="${PHRASE}"`);
      return;
    }
    say(`\n   archived: ${picked.length} line(s)`);
    const check = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
    try {
      const after = await readFairs(check, picked.map((r) => r.projectId));
      const gone = await check`SELECT id::int AS id FROM project_finance_lines WHERE id = ANY(${check.array(picked.map((r) => r.lineId))}) AND archived_at IS NOT NULL`;
      const j = judge(before, after, new Set(gone.map((g) => g.id)), picked.map((r) => r.lineId));
      say('Verified on a fresh connection:');
      printJudged(j);
      if (!j.ok) process.exitCode = 1;
    } finally { await check.end(); }
  } catch (e) {
    console.error(`${String(e?.message ?? e).slice(0, 300)} — nothing was kept.`);
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
