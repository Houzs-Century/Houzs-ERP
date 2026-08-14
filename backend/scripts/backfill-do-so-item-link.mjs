#!/usr/bin/env node
/* Re-link Delivery Order lines to the Sales Order lines they shipped.
   ---------------------------------------------------------------------------
   THE DEFECT. delivery_order_items.so_item_id is written from the request body
   and nowhere else — all three insert paths in delivery-orders-mfg.ts do
   `so_item_id: (it.soItemId) ?? null`, with no derivation and no guard. A
   client that omits the field writes a delivery the system can never attribute,
   silently and permanently. PR #1395 (2026-07-29) fixed the DO-create page to
   send it; lines created as late as 2026-08-06 are still unlinked, so the fix
   was not the whole leak.

   WHAT IT COSTS. Everything that asks "how much of this order is still to
   fulfil" resolves on so_item_id — the remaining-qty guard, the sofa batch
   guard, the SO header's status flip, and MRP's delivered-netting
   (soDeliverableRemaining does `.in('so_item_id', ...)` and skips a null). So a
   fully shipped order reads as entirely undelivered: MRP re-reports its lines
   as demand and tells purchasing to buy the goods a second time. Measured
   2026-08-14 on prod: 24 unlinked lines across 11 open sales orders, including
   2990-SO-2606-025 whose delivery order is DELIVERED while its header still
   says CONFIRMED.

   HOW THE LINK IS RECOVERED, AND WHEN IT IS NOT. Pairing happens only WITHIN
   the sales order the DO already names, only between lines of the same
   item_code, and — where a code appears twice — only on a variant identity
   that is unique on both sides. scripts/lib/do-so-item-pairing.mjs owns that
   logic and tests/doSoItemPairing.node.mjs pins its refusals. Anything it
   cannot read one-to-one is REPORTED AND LEFT ALONE: a wrong link credits one
   line's shipment against another and is indistinguishable from a fact
   afterwards, while a missing link stays visible as the shortage it causes.

   WHAT IT WILL NOT DO. It writes one column, so_item_id, and only where that
   column IS NULL — every UPDATE re-asserts that, so a link a person stated is
   never overwritten. It touches no quantity, money, status or movement.

   MODE=plan (default) prints every proposed pair and writes nothing.
   MODE=apply needs CONFIRM="I HAVE REVIEWED THE DRY-RUN".

   RE-RUN: inert. Keyed on so_item_id IS NULL, which a successful write clears,
   so a second run finds nothing to do and reports the same unresolved rows. */
import postgres from 'postgres';
import { pairDoLinesToSoLines } from './lib/do-so-item-pairing.mjs';

const DSN = process.env.DATABASE_URL;
const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'I HAVE REVIEWED THE DRY-RUN';
const CO = process.env.COMPANY ? Number(process.env.COMPANY) : null;

const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => { console.error(process.env.GITHUB_ACTIONS ? `::error::${m}` : m); process.exit(2); };

if (!DSN) bad('need DATABASE_URL');
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}" — run MODE=plan first and read it.`);
}

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });

/** Unlinked DO lines on live delivery orders, with the fields pairing reads. */
async function loadUnlinked(client) {
  return client`
    SELECT di.id, di.item_code, di.qty, di.variants, di.description2,
           d.so_doc_no, d.do_number, d.status AS do_status
      FROM scm.delivery_order_items di
      JOIN scm.delivery_orders d ON d.id = di.delivery_order_id
     WHERE di.so_item_id IS NULL
       AND d.status <> 'CANCELLED'
       AND d.so_doc_no IS NOT NULL
       ${CO === null ? client`` : client`AND d.company_id = ${CO}`}
     ORDER BY d.do_number, di.item_code, di.id`;
}

async function main() {
  note(`mode=${APPLY ? 'APPLY' : 'PLAN (writes nothing)'} company=${CO ?? 'all'}`);

  const unlinked = await loadUnlinked(sql);
  if (unlinked.length === 0) { note('Nothing unlinked. Done.'); return; }
  note(`${unlinked.length} unlinked DO line(s) on ${new Set(unlinked.map((r) => r.do_number)).size} delivery order(s)`);

  const soDocNos = [...new Set(unlinked.map((r) => r.so_doc_no))];
  const soLines = await sql`
    SELECT id, doc_no, item_code, qty, variants, description2
      FROM scm.mfg_sales_order_items
     WHERE doc_no = ANY(${soDocNos}) AND cancelled = false`;

  const { pairs, unresolved } = pairDoLinesToSoLines(unlinked, soLines);
  const doByIdN = new Map(unlinked.map((r) => [r.id, r]));

  note('\n── PROPOSED LINKS');
  for (const p of pairs) {
    const d = doByIdN.get(p.doItemId);
    note(`   ${d.do_number} ${p.item_code.padEnd(28)} -> ${p.soItemId}  (${p.how})`);
  }
  if (unresolved.length) {
    note('\n── LEFT ALONE (cannot be read one-to-one)');
    for (const u of unresolved) {
      note(`   ${u.so_doc_no} ${u.item_code}: ${u.reason} (DO ${u.doCount} / SO ${u.soCount})`);
    }
  }
  note(`\n${pairs.length} to link, ${unlinked.length - pairs.length} left alone`);

  if (!APPLY) {
    note(`\nPLAN ONLY: nothing written. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}".`);
    return;
  }

  let written = 0;
  for (const p of pairs) {
    /* IS NULL is re-asserted in the UPDATE itself, not just in the SELECT that
       built the plan: between plan and apply a person may have linked the line
       by hand, and their answer wins over this one. */
    const res = await sql`
      UPDATE scm.delivery_order_items
         SET so_item_id = ${p.soItemId}
       WHERE id = ${p.doItemId} AND so_item_id IS NULL`;
    written += res.count;
  }
  note(`\nwrote ${written} link(s)`);

  /* ── INDEPENDENT READ-BACK ────────────────────────────────────────────────
     A fresh connection, and it asserts the SHAPE rather than a row count: every
     line just linked must now point at an SO line that (a) exists, (b) belongs
     to the DO's own sales order, and (c) carries the same item code. A count of
     24 proves nothing about what those 24 now say. */
  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  try {
    const ids = pairs.map((p) => p.doItemId);
    const [shape] = await check`
      SELECT COUNT(*)::int AS linked,
             COUNT(*) FILTER (WHERE si.id IS NULL)::int              AS dangling,
             COUNT(*) FILTER (WHERE si.doc_no <> d.so_doc_no)::int   AS wrong_order,
             COUNT(*) FILTER (WHERE si.item_code <> di.item_code)::int AS wrong_item
        FROM scm.delivery_order_items di
        JOIN scm.delivery_orders d ON d.id = di.delivery_order_id
        LEFT JOIN scm.mfg_sales_order_items si ON si.id = di.so_item_id
       WHERE di.id = ANY(${ids}) AND di.so_item_id IS NOT NULL`;
    note(`verify (fresh connection): linked ${shape.linked}/${ids.length}` +
         ` · dangling ${shape.dangling} · wrong order ${shape.wrong_order} · wrong item ${shape.wrong_item}`);
    if (shape.dangling || shape.wrong_order || shape.wrong_item) {
      bad('VERIFY FAILED: a link points outside its own sales order or at another item. Investigate before trusting MRP.');
    }
    if (shape.linked !== ids.length) {
      bad(`VERIFY FAILED: expected ${ids.length} linked, read back ${shape.linked}.`);
    }
    note('verify OK — every new link resolves to a line of the same item on the same sales order.');
  } finally {
    await check.end({ timeout: 5 });
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => sql.end({ timeout: 5 }));
