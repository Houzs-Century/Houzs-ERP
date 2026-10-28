#!/usr/bin/env node
// ---------------------------------------------------------------------------
// repair-invoice-item-from-parent.mjs — put a migrated invoice line back on the
// item code its parent states, where the parent moved and the invoice did not.
//
// THE SYMPTOM. probe-link-identity.mjs counts, on the two invoice chains, links
// that are FILLED, do not dangle, and name a DIFFERENT PRODUCT. Run 34178911176
// (2026-09-08 10:08 local) reports 2 of 183 sales-invoice lines and 2 of 276
// purchase-invoice lines. Nobody saw it, which is the finding: a foreign key
// pointing at a real row of another product violates no constraint and lowers
// no coverage count. It is docs/bugs/0672's class, key-without-identity.
//
// WHAT THE BOOK SAYS, AND IT IS THE ARBITER (memory: migration-copy-never-
// compute). Read against the AutoCount re-cut committed at 08:03-08:07 today
// (data/ac-reconcile-truth.json.gz, exported_at 2026-09-08T00:03:44Z), all four
// are the same shape and the book is not silent on any of them:
//
//   IV I-000745     <- DO-000542   RDS-5526 SOFA, one line, Desc2 "(1 ELT / T + NA +2ER) (28")"
//   IV I-2412-0065  <- DO-002158   THL-2379,      one line, Desc2 "2R(60cm) / Guardian - 05"
//   PI PI-007551    <- GR-005068   AMN-SF9058 SOFA, one line, Desc2 identical on both sides
//   PI PI-007920    <- GR-005277   DSL-8030 SOFA,   one line, Desc2 identical on both sides
//
// On every one the book carries ONE line on the parent, ONE line on the
// invoice, the SAME item code and the SAME Desc2 on both, and states the
// transfer explicitly (PIDTL.FromDocType='GR', IVDTL.FromDocType='DO').
// ac-invoice-refs.json.gz agrees document for document. So the LINK is not
// choosable and is not wrong — there is no other line it could mean, and this
// script never touches it. What disagrees is the ERP's item_code on ONE side.
//
// WHICH SIDE, AND WHY IT IS FORCED RATHER THAN CHOSEN. A migrated invoice line
// is a SNAPSHOT: create-migrated-invoices.mjs copies `l._row.item_code` off the
// parent row at :305 and :345 and never forms an opinion of its own. The parent
// then MOVED — apply-sofa-compartment-corrections.mjs rewrites a sofa that
// reached the ERP as a bare `-1S` placeholder into the owner-approved
// compartments, and carries the new code onto purchase_order_items, grn_items
// and delivery_order_items. It did not carry it onto the two invoice tables.
// All four documents above are named in an owner-approved corrections file
// (HC-SO-000814, HC-SO-003295, HC-PO-009260 in the 2026-09 round; HC-PO-009597
// in the 2026-08 round), and all four invoice lines still say `-1S`. The
// invoice is quoting a parent that has since changed. docs/bugs/0687.
//
// The site itself is fixed in the same PR, so a future correction carries. This
// script is the retro half for the rows already in that state.
//
// THE DECISION IS PURE AND TESTED — scripts/lib/invoice-snapshot-repair.mjs
// (planInvoiceSnapshotRepair), unit-tested in tests/invoiceSnapshotRepair.test.mjs
// with the four live rows and five refusals. A repair is offered only when it
// is FORCED: the invoice is migrated paperwork, the parent document holds
// exactly ONE line, and the two codes are two compartments of ONE sofa model.
// A different MODEL is REFUSED and listed — that is a wrong LINK, not a stale
// compartment, and rewriting the code would erase the evidence.
//
// WHAT IT NEVER TOUCHES. qty, unit_price_sen, discount_sen, line_total_sen, the
// link column, the parent row, any header total. The money on an invoice line
// is the invoice's own; every one of the four already matches the book's own
// net total to the sen. It also leaves `variants` alone: the colour comparison
// on these rows is measured separately and 0672 records that comparison as
// currently INVALID (colourId on one side against colourLabel on the other), so
// repairing it here would be repairing something whose correctness has not been
// established.
//
// NO ALLOCATION RECOMPUTE IS IMPLIED. docs/bugs/0675 notes a direct SQL write
// does not trigger one. Nothing here is read by allocation: readiness reads
// purchase_order_items.so_item_id and grn_items.received_qty, and an invoice
// never moves stock in this ERP.
//
//   DATABASE_URL   required
//   MODE           plan (default) | apply
//   CONFIRM        on apply, must equal repair-invoice-item-from-parent
//   COMPANY        default 1
//
// RE-RUN: idempotent. A second run finds no disagreement left on the rows it
// repaired and plans nothing; it never re-writes a row it has already put on
// its parent's code, because agreement is not a candidate.
// ---------------------------------------------------------------------------
import postgres from 'postgres';
import { planInvoiceSnapshotRepair } from './lib/invoice-snapshot-repair.mjs';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const MODE = (process.env.MODE || 'plan').trim();
const APPLY = MODE === 'apply';
const CONFIRM = (process.env.CONFIRM || '').trim();
const PHRASE = 'repair-invoice-item-from-parent';
const CO = Number(process.env.COMPANY || 1);

const log = (m = '') => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);


/* One statement per chain. Both select the invoice line, its parent line, and
   the number of lines on the parent DOCUMENT — the cardinality that makes the
   link forced is read, never assumed. */
const SI = `
  SELECT sii.id::text            AS id,
         'SI'                    AS chain,
         si.invoice_number       AS "invoiceNo",
         si.migrated_no_stock    AS "invoiceMigrated",
         sii.item_code           AS "lineCode",
         doi.item_code           AS "parentCode",
         pdo.do_number           AS "parentDocNo",
         (SELECT count(*)::int FROM scm.delivery_order_items x
           WHERE x.delivery_order_id = pdo.id) AS "parentLineCount"
    FROM scm.sales_invoice_items  sii
    JOIN scm.sales_invoices       si  ON si.id  = sii.sales_invoice_id
    JOIN scm.delivery_order_items doi ON doi.id = sii.do_item_id
    JOIN scm.delivery_orders      pdo ON pdo.id = doi.delivery_order_id
   WHERE sii.company_id = $1
     AND upper(regexp_replace(btrim(coalesce(sii.item_code, '')), '\\s+', ' ', 'g'))
      <> upper(regexp_replace(btrim(coalesce(doi.item_code, '')), '\\s+', ' ', 'g'))
   ORDER BY si.invoice_number, sii.line_no`;

const PI = `
  SELECT pii.id::text            AS id,
         'PI'                    AS chain,
         pi.invoice_number       AS "invoiceNo",
         pi.migrated_no_stock    AS "invoiceMigrated",
         pii.item_code           AS "lineCode",
         gi.item_code            AS "parentCode",
         g.grn_number            AS "parentDocNo",
         (SELECT count(*)::int FROM scm.grn_items x WHERE x.grn_id = g.id) AS "parentLineCount"
    FROM scm.purchase_invoice_items pii
    JOIN scm.purchase_invoices      pi ON pi.id = pii.purchase_invoice_id
    JOIN scm.grn_items              gi ON gi.id = pii.grn_item_id
    JOIN scm.grns                   g  ON g.id  = gi.grn_id
   WHERE pii.company_id = $1
     AND upper(regexp_replace(btrim(coalesce(pii.item_code, '')), '\\s+', ' ', 'g'))
      <> upper(regexp_replace(btrim(coalesce(gi.item_code, '')), '\\s+', ' ', 'g'))
   ORDER BY pi.invoice_number, pii.id`;

async function main() {
  if (APPLY && CONFIRM !== PHRASE) {
    console.error(`MODE=apply needs CONFIRM=${PHRASE}; got "${CONFIRM}". Nothing written.`);
    process.exit(2);
  }
  const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  log(`mode=${MODE} company=${CO}`);

  const rows = [...await sql.unsafe(SI, [CO]), ...await sql.unsafe(PI, [CO])];
  log(`${rows.length} invoice line(s) disagree with the line they were raised from.`);
  const { repair, refused } = planInvoiceSnapshotRepair(rows);

  for (const r of repair) {
    log(`  REPAIR ${r.chain} ${r.invoiceNo}: ${r.from} -> ${r.to}   (its parent ${r.parentDocNo} holds one line, model ${r.model})`);
  }
  for (const r of refused) {
    log(`  REFUSED ${r.invoiceNo}: ${r.from} vs ${r.to} — ${r.why}`);
  }
  log('');
  log(`plan: repair ${repair.length}, refuse ${refused.length}, of ${rows.length} disagreeing`);

  if (!APPLY) {
    log('PLAN ONLY — set MODE=apply with the CONFIRM phrase to write.');
    await sql.end({ timeout: 5 });
    return;
  }

  const si = repair.filter((r) => r.chain === 'SI');
  const pi = repair.filter((r) => r.chain === 'PI');
  await sql.begin(async (tx) => {
    for (const r of si) {
      await tx`UPDATE scm.sales_invoice_items SET item_code = ${r.to}
                WHERE id = ${r.id} AND company_id = ${CO}`;
    }
    for (const r of pi) {
      await tx`UPDATE scm.purchase_invoice_items SET item_code = ${r.to}
                WHERE id = ${r.id} AND company_id = ${CO}`;
    }
  });
  log(`APPLIED ${si.length} sales-invoice line(s) and ${pi.length} purchase-invoice line(s).`);
  await sql.end({ timeout: 5 });

  await verifyOnFreshConnection(repair);
}

/* SHAPE, not a row count. A count of updated rows is true of a statement that
   wrote the wrong value; what is asserted here is that each repaired line now
   reads exactly its parent's code, that its MONEY is untouched, and that the
   two chains carry no disagreement left at all. */
async function verifyOnFreshConnection(repair) {
  /* A SECOND client, opened after the write. The session that wrote is the
     worst witness that the write landed. */
  const v = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  try {
    const left = [...await v.unsafe(SI, [CO]), ...await v.unsafe(PI, [CO])];
    const stillWrong = left.filter((r) => repair.some((x) => x.id === r.id));
    if (stillWrong.length) {
      throw new Error(`post-apply verify FAILED — ${stillWrong.length} repaired line(s) still disagree: ${stillWrong.map((r) => r.invoiceNo).join(', ')}`);
    }
    const ids = repair.map((r) => r.id);
    if (ids.length) {
      const money = await v`
        SELECT 'SI' AS chain, l.id::text AS id, l.item_code, l.qty::text AS qty,
               l.unit_price_sen::text AS unit, l.line_total_sen::text AS total, l.do_item_id::text AS link
          FROM scm.sales_invoice_items l WHERE l.id::text = ANY(${ids})
        UNION ALL
        SELECT 'PI', l.id::text, l.item_code, l.qty::text,
               l.unit_price_sen::text, l.line_total_sen::text, l.grn_item_id::text
          FROM scm.purchase_invoice_items l WHERE l.id::text = ANY(${ids})`;
      if (money.length !== repair.length) {
        throw new Error(`post-apply verify FAILED — read back ${money.length} of ${repair.length} repaired rows`);
      }
      for (const m of money) {
        const want = repair.find((r) => r.id === m.id);
        if (String(m.item_code).toUpperCase() !== want.to.toUpperCase()) {
          throw new Error(`post-apply verify FAILED — ${want.invoiceNo} reads ${m.item_code}, expected ${want.to}`);
        }
        if (!m.link) throw new Error(`post-apply verify FAILED — ${want.invoiceNo} lost its link to its parent`);
        log(`  VERIFIED ${want.invoiceNo} ${m.item_code}  qty ${m.qty}  unit ${m.unit}  total ${m.total}  link intact`);
      }
    }
    log(`Verified on a fresh connection: ${repair.length} line(s) now read their parent's code, money and link untouched; ${left.length} disagreement(s) remain on the two chains.`);
  } finally {
    await v.end({ timeout: 5 });
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
