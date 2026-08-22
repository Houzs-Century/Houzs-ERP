#!/usr/bin/env node
/* Merge the Delivery Order status SIGNED into DELIVERED.

   THE RULING (owner, 2026-08-21). Asked whether the two should stay separate,
   given that this system cannot tell them apart: 「这个整合」.

   WHY THEY ARE THE SAME THING HERE. SIGNED and DELIVERED agree on all three
   questions the system ever asks of a delivery order's status:
     · has the stock left?      both are in DO_STOCK_OUT_STATES
     · may it be invoiced?      both are in SI_TRANSFERABLE_DO_STATES
     · does it count delivered? both are outside DO_NOT_DELIVERED_STATES
   Nothing in the tree branches on one and not the other. Two words for one
   state is a question staff have to answer and the system never asks.

   WHAT THIS SCRIPT DOES, AND WHAT IT CANNOT DO. It rewrites the COLUMN. It
   cannot remove the label: Postgres has no DROP VALUE for an enum, so
   `SIGNED` stays in scm.do_status for ever. That is why the app keeps folding
   SIGNED into the delivered bucket and rendering it as "Delivered" — a row
   written by anything this repo does not control must still land somewhere.
   Read the tab and label decisions in docs/modules/delivery-order.md.

   NO SIDE EFFECTS BY CONSTRUCTION, and this is the reason a direct UPDATE is
   the right tool. SIGNED and DELIVERED are both shipped states, so:
     · the inventory OUT already fired on the FIRST entry into a shipped state
       and does not re-fire — deductInventoryForDo is idempotent on
       (source_doc_type, source_doc_id) and this write is not a status PATCH;
     · no AutoCount outbox row is enqueued (that happens in the route);
     · so-delivery-sync's rollup counts both as delivered, so no Sales Order
       status moves.
   Writing through SQL also skips the status guard, which is correct here: the
   guard's job is to refuse a HUMAN moving a document backwards, and this is
   neither backward nor human.

   MODE=dry-run (default) performs the real UPDATE inside a transaction and
   ROLLS BACK, so the plan you read is the plan that would run.
   MODE=apply requires CONFIRM="I HAVE REVIEWED THE DRY-RUN".

   RE-RUN: idempotent. The selection is `status = 'SIGNED'`, so a second run
   finds nothing and writes nothing. */
import postgres from 'postgres';

const DSN = process.env.DATABASE_URL;
const APPLY = (process.env.MODE || 'dry-run').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'I HAVE REVIEWED THE DRY-RUN';

const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);

if (!DSN) { bad('DATABASE_URL is not set'); process.exit(1); }
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(1);
}

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });

class ROLLBACK extends Error {}

async function main() {
  note(`=== merge-do-signed-into-delivered  mode=${APPLY ? 'APPLY' : 'DRY-RUN (everything rolls back)'} ===`);

  /* BOTH companies. The status is not company-specific and neither is the
     ruling; scoping this to one tenant would leave the other reading a word
     the UI no longer offers. */
  const targets = await sql`
    SELECT company_id, do_number, so_doc_no, do_date
      FROM scm.delivery_orders
     WHERE status = 'SIGNED'
     ORDER BY company_id, do_date, do_number`;

  const byCompany = new Map();
  for (const r of targets) {
    byCompany.set(Number(r.company_id ?? 0), (byCompany.get(Number(r.company_id ?? 0)) ?? 0) + 1);
  }

  note(`delivery orders currently SIGNED: ${targets.length}`);
  for (const [cid, n] of [...byCompany.entries()].sort((a, b) => a[0] - b[0])) {
    note(`  company ${cid}: ${n}`);
  }
  if (targets.length === 0) {
    note('nothing to move — SIGNED is already unused.');
    await sql.end({ timeout: 5 });
    return;
  }

  note(`\n=== PLAN — every one becomes DELIVERED ===`);
  for (const r of targets.slice(0, 40)) {
    note(`  ${String(r.do_number).padEnd(20)} co ${r.company_id}  SO ${r.so_doc_no ?? '(none)'}  ${String(r.do_date).slice(0, 10)}`);
  }
  if (targets.length > 40) note(`  ... and ${targets.length - 40} more`);

  let wrote = 0;
  await sql.begin(async (tx) => {
    const res = await tx`
      UPDATE scm.delivery_orders
         SET status = 'DELIVERED', updated_at = now()
       WHERE status = 'SIGNED'`;
    wrote = res.count;
    note(`\n${APPLY ? 'wrote' : 'would write'}: ${wrote} row(s)`);
    if (!APPLY) throw new ROLLBACK();
  }).catch((e) => { if (!(e instanceof ROLLBACK)) throw e; });

  if (!APPLY) {
    note('\nDRY-RUN — the transaction was rolled back. Nothing was written.');
    await sql.end({ timeout: 5 });
    return;
  }

  /* VERIFY ON A FRESH CONNECTION, ASSERTING THE SHAPE. Not "did N rows
     change" — that is true of an UPDATE that wrote the wrong value. Assert
     that no SIGNED row survives, that the documents named in the plan now read
     DELIVERED. */
  const before = targets.length;
  await sql.end({ timeout: 5 });

  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  try {
    const [left] = await check`SELECT count(*)::int AS n FROM scm.delivery_orders WHERE status = 'SIGNED'`;
    const moved = await check`
      SELECT do_number, status FROM scm.delivery_orders
       WHERE do_number = ANY(${targets.map((t) => t.do_number)})`;
    const notDelivered = moved.filter((r) => String(r.status) !== 'DELIVERED');

    note(`\n=== VERIFY (fresh connection, values re-read) ===`);
    note(`  rows still SIGNED                : ${left.n}   (must be 0)`);
    note(`  planned rows re-read             : ${moved.length} of ${before}`);
    note(`  planned rows NOT now DELIVERED   : ${notDelivered.length}   (must be 0)`);
    for (const r of notDelivered.slice(0, 10)) note(`    ${r.do_number} = ${r.status}`);

    const ok = left.n === 0 && moved.length === before && notDelivered.length === 0;
    if (!ok) { bad('VERIFICATION FAILED — read the numbers above before doing anything else.'); process.exit(1); }
    note('  VERIFIED.');
  } finally {
    await check.end({ timeout: 5 });
  }
}

main().catch(async (e) => {
  bad(e.message);
  try { await sql.end({ timeout: 5 }); } catch {}
  process.exit(1);
});
