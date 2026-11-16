#!/usr/bin/env node
/* add-august-part-split-fairs.mjs — the August half of the fairs of 27 July – 2 August 2026
   (owner 2026-11-16: 「我给你资料你核对」 with FAIR PNL Y'2026; 「这个只是我的预计算法，但要算」).

   THE SHAPE. Finance's FAIR PNL splits each of these seven fairs into a July row and an August
   row. The system holds their COGS, rental and setup for the whole fair, but their Sales only
   for July (the August Sales were never keyed), and on five of them a July-only typed
   commission line — which, typed, stops the brand's rate (eventPnl pctRow) from working the
   commission on the August half. So the Project Overview read them at COGS far above sales.

   THE REPAIR (lib/split-month-fairs.mjs holds the seven and their August Sales from the file):
   on each fair still exactly in that shape — company 1, its brand and venue, ending 2026-08-02,
   no bills, no August line yet, its typed Sales equal to the file's July row — add one typed
   Sales line "sales (FAIR PNL Y2026, August part)" for the August row, and archive its typed
   commission lines, so the commission is the brand's rate on the whole fair's Sales, as on
   every other fair of the month. One activity row per change. Nothing else is touched: COGS,
   rental and setup already hold the whole fair; transport and merchandise follow the Sales on
   the brand's rate; the auto cost lines and project_finance's cached figures are left as they
   are (the Overview reads neither).

   MODE=plan (default) does all of it inside one transaction that is rolled back: nothing is
   written. MODE=apply with CONFIRM="ADD AUGUST PART OF SPLIT FAIRS" keeps it, then re-reads on a
   fresh connection: each fair's typed Sales are its July + August rows; no typed commission line
   is left on it, and none in its books, so the rate works it; its COGS, rental and setup as they
   were; the August line there once. Prints fair ids and yes / no only (the Actions log is public);
   with PUBKEY the figures go out ENCRYPTED (RSA-OAEP-256 + AES-256-GCM).

   RE-RUN: inert — a fair whose August line is in is left alone.
   Env: DATABASE_URL, COMPANY_ID (default 1), PUBKEY (optional). */
import './lib/public-log-guard.mjs';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import postgres from 'postgres';
import { AUGUST_DESCRIPTION, SPLIT_FAIRS, planSplitFairs } from './lib/split-month-fairs.mjs';
import { pgIdArray } from './lib/pg-id-list.mjs';

const PHRASE = 'ADD AUGUST PART OF SPLIT FAIRS';
const MODE = String(process.env.MODE || 'plan').trim().toLowerCase();
const APPLY = MODE === 'apply';
if (APPLY && (process.env.CONFIRM ?? '').trim() !== PHRASE) {
  console.error(`MODE=apply requires CONFIRM="${PHRASE}" — refusing, nothing was written.`);
  process.exit(2);
}
const CO = Number(process.env.COMPANY_ID || 1);
const IDS = SPLIT_FAIRS.map((f) => f.projectId);
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

/** Each of the seven fairs as the system holds it: what decides the repair, and what must not move. */
const readFairs = (db, lock) => db`
  SELECT p.id::int AS "projectId", p.company_id::int AS "companyId", p.name, p.brand, p.end_date::text AS "endDate",
         (SELECT COALESCE(SUM(l.amount), 0)::float8 FROM project_finance_lines l WHERE l.project_id = p.id AND l.archived_at IS NULL
             AND l.auto_source IS NULL AND l.kind = 'income' AND l.category = 'sales') AS "typedSales",
         (SELECT COUNT(*)::int FROM sales_entries s WHERE s.project_id = p.id AND s.archived_at IS NULL AND s.status <> 'void') AS bills,
         (SELECT COUNT(*)::int FROM project_finance_lines l WHERE l.project_id = p.id AND l.archived_at IS NULL
             AND l.description = ${AUGUST_DESCRIPTION}) AS "augustLines",
         (SELECT COALESCE(json_agg(json_build_object('id', l.id, 'amount', l.amount) ORDER BY l.id), '[]'::json) FROM project_finance_lines l
           WHERE l.project_id = p.id AND l.archived_at IS NULL AND l.auto_source IS NULL AND l.category = 'commission') AS "commissionLines",
         (SELECT COALESCE(json_agg(json_build_object('c', l.category, 'a', l.amount) ORDER BY l.id), '[]'::json) FROM project_finance_lines l
           WHERE l.project_id = p.id AND l.archived_at IS NULL AND l.auto_source IS NULL AND l.kind = 'cost' AND l.category <> 'commission') AS "otherCosts",
         (SELECT COUNT(*)::int FROM scm.journal_entry_lines jl JOIN scm.accounts a ON a.company_id = jl.company_id AND a.account_code = jl.account_code
           WHERE jl.project_id = p.id AND a.pms_row = 'commission') AS "bookedCommission"
    FROM projects p
   WHERE p.company_id = ${CO} AND p.id = ANY(${pgIdArray(IDS)}::bigint[]) AND p.archived_at IS NULL
   ORDER BY p.id
   ${lock ? db`FOR UPDATE OF p` : db``}`;
const sen = (rm) => Math.round(Number(rm ?? 0) * 100);

/** Each repaired fair after, against before: yes / no each. */
function judge(before, after, done) {
  const now = new Map(after.map((f) => [f.projectId, f]));
  const fairs = done.map((d) => {
    const b = before.get(d.projectId);
    const a = now.get(d.projectId);
    const want = SPLIT_FAIRS.find((f) => f.projectId === d.projectId);
    return {
      id: d.projectId,
      salesWholeFair: a != null && sen(a.typedSales) === sen(want.julySales) + sen(want.augustSales),
      augustOnce: a != null && Number(a.augustLines) === 1,
      noTypedCommission: a != null && a.commissionLines.length === 0,
      noBookedCommission: a != null && Number(a.bookedCommission) === 0,
      costsKept: a != null && b != null && JSON.stringify(a.otherCosts) === JSON.stringify(b.otherCosts),
    };
  });
  return { ok: fairs.every((f) => f.salesWholeFair && f.augustOnce && f.noTypedCommission && f.noBookedCommission && f.costsKept), fairs };
}
const printJudged = (j) => {
  for (const f of j.fairs) {
    say(`   fair ${f.id}: Sales = July + August rows ${f.salesWholeFair ? 'yes' : 'NO'} · August line once ${f.augustOnce ? 'yes' : 'NO'}`
      + ` · no typed commission left ${f.noTypedCommission ? 'yes' : 'NO'} · none in its books ${f.noBookedCommission ? 'yes' : 'NO'}`
      + ` · COGS / rental / setup kept ${f.costsKept ? 'yes' : 'NO'}`);
  }
};

async function main() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
  const detail = { at: new Date().toISOString(), company: CO, added: [], left: [] };
  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  let done = [];
  let before = null;
  /* Set once the apply's transaction is kept: a failure after it is the re-read's, not the write's. */
  let written = false;
  try {
    say(`add-august-part-split-fairs   company ${CO}   mode ${APPLY ? 'APPLY' : 'PLAN'}`);
    try {
      await sql.begin(async (tx) => {
        const rows = await readFairs(tx, true);
        before = new Map(rows.map((f) => [f.projectId, f]));
        const { add, left } = planSplitFairs(rows, CO);
        say(`   ${SPLIT_FAIRS.length} fair(s) in the file's split: ${add.length} to complete, ${left.length} left alone`);
        for (const l of left) {
          say(`      fair ${l.projectId}: left — ${l.why}`);
          detail.left.push(l);
        }
        if (add.length === 0) { say('\nNothing to add — nothing written.'); throw new Rollback(); }
        const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
        for (const a of add) {
          const ins = await tx`
            INSERT INTO project_finance_lines (project_id, kind, category, description, amount, occurred_at, company_id, created_at, updated_at)
            SELECT p.id, 'income', 'sales', ${AUGUST_DESCRIPTION}, ${a.augustSales}, '2026-08-02', p.company_id, ${stamp}, ${stamp}
              FROM projects p WHERE p.id = ${a.projectId} AND p.company_id = ${CO}
            RETURNING id::int AS id`;
          if (ins.length !== 1) throw new Error(`fair ${a.projectId}: the August line could not be added — nothing was kept`);
          await tx`
            INSERT INTO project_activity (project_id, action, from_value, to_value, note, user_id, company_id, created_at)
            VALUES (${a.projectId}, 'finance_line_add', NULL, ${String(ins[0].id)},
                    ${"Sales line for the fair's August part added from FAIR PNL Y'2026 (the fair ran 27 July – 2 August; only its July part was in)."},
                    NULL, ${CO}, ${stamp})`;
          for (const lineId of a.archiveCommission) {
            const gone = await tx`
              UPDATE project_finance_lines l SET archived_at = ${stamp}, updated_at = ${stamp}
               WHERE l.id = ${lineId} AND l.project_id = ${a.projectId} AND l.archived_at IS NULL
                 AND l.category = 'commission' AND l.auto_source IS NULL
                 AND EXISTS (SELECT 1 FROM projects p WHERE p.id = l.project_id AND p.company_id = ${CO})
              RETURNING l.id`;
            if (gone.length !== 1) throw new Error(`fair ${a.projectId}: commission line ${lineId} could not be archived — nothing was kept`);
            await tx`
              INSERT INTO project_activity (project_id, action, from_value, to_value, note, user_id, company_id, created_at)
              VALUES (${a.projectId}, 'finance_line_remove', ${String(lineId)}, NULL,
                      ${"Typed commission line (July part only) archived: the commission is the brand's rate on the whole fair's sales, July and August."},
                      NULL, ${CO}, ${stamp})`;
          }
          const b = before.get(a.projectId);
          detail.added.push({ projectId: a.projectId, augustLine: ins[0].id, augustSales: a.augustSales, julySales: b.typedSales, commissionArchived: b.commissionLines });
          say(`      fair ${a.projectId}: August line added · ${a.archiveCommission.length} typed commission line(s) archived`);
        }
        done = add;
        const j = judge(before, await readFairs(tx, false), done);
        printJudged(j);
        if (!j.ok) throw new Error('the read-back is not what was meant');
        if (!APPLY) throw new Rollback();
      });
    } catch (e) {
      if (!(e instanceof Rollback)) throw e;
      if (done.length > 0) say(`\nRehearsal passed and was rolled back — nothing written. To write: MODE=apply CONFIRM="${PHRASE}"`);
      return;
    }
    written = true;
    say(`\n   completed: ${done.length} fair(s)`);
    const check = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
    try {
      const j = judge(before, await readFairs(check, false), done);
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
