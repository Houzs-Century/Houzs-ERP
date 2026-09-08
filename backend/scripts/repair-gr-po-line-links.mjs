#!/usr/bin/env node
/* Stamp the purchase-order LINE each migrated goods-receipt line received.
 * ---------------------------------------------------------------------------
 * THE DEFECT, MEASURED. Run 34263816266 on `main`: GOODS RECEIPTS 26 differ, 22
 * of them on 单据转换链 and every one of those 22 on a PROCEEDED order. The
 * reconcile names the cause per line — `erp_link_missing`, 28 lines: the
 * account book says the receipt line was raised from a purchase order and
 * `scm.grn_items.purchase_order_item_id` is NULL, so the ERP points at nothing.
 *
 * HOW THE LINE IS READ. scripts/lib/ac-gr-po-line-match.mjs, which refuses
 * anything it cannot single out. AutoCount records the source DOCUMENT and
 * never the source LINE (`FromDocDtlKey` is NULL on all ~220,000 rows of all
 * six detail tables), so the line comes out of the two documents themselves —
 * the only line of its item code on that order, or the one line of several
 * whose build text is the same. NEVER by position: PO-009081 orders the same
 * bed frame twice and the first receipt line belongs to the SECOND order line
 * (docs/bugs/0690). tests/acGrPoLineMatch.test.mjs pins that case and was run
 * RED against a position implementation before the matcher existed.
 *
 * IT DOES NOT MOVE STOCK, AND THAT IS CHECKED, NOT ASSUMED. The owner:
 * 「库存先不看」. One column is written, `purchase_order_item_id`, and only
 * where it IS NULL. A receipt's inventory IN is written off the receipt's own
 * lines whether or not this pointer is set — src/scm/lib/grn-unlinked-po-lines
 * .ts states that as the reason the over-receipt guard has to exist — and
 * `received_qty` is recomputed by routes/grns.ts on a receipt POST, never by a
 * trigger. The apply step asserts that from pg_trigger on the live database
 * before it writes a row, and refuses if anything fires on scm.grn_items.
 * No quantity, no money, no status, no movement is touched.
 *
 * PLAN -> APPLY, WITH THE PLAN COMMITTED.
 *   MODE=plan  (default) writes data/gr-po-line-links-plan.json and prints its
 *              digest. Nothing is written to the database.
 *   MODE=apply recomputes the plan from live data, checks it against the
 *              COMMITTED file's digest, refuses on any drift, writes, and then
 *              re-reads on a FRESH connection asserting the SHAPE.
 *   CONFIRM="I HAVE REVIEWED THE DRY-RUN" is required to apply.
 *
 * RE-RUN: inert. Keyed on purchase_order_item_id IS NULL, which a successful
 * write clears, so a second run finds nothing and reports the same refusals.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { matchGrLinesToPoLines } from "./lib/ac-gr-po-line-match.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(here, "data");
const PLAN_FILE = path.join(DATA, "gr-po-line-links-plan.json");
const CONFIRM_PHRASE = "I HAVE REVIEWED THE DRY-RUN";

const DSN = process.env.DATABASE_URL;
const APPLY = (process.env.MODE || "plan").toLowerCase() === "apply";
const CO = Number(process.env.COMPANY_ID || 1);
const MAX_AGE_DAYS = Number(process.env.MAX_SNAPSHOT_AGE_DAYS || 2);

const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const say = (m) => console.log(m);
const bad = (m) => {
  console.error(process.env.GITHUB_ACTIONS ? `::error::${m}` : m);
  process.exit(2);
};

if (!DSN) bad("need DATABASE_URL");
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}" — run MODE=plan first and read it.`);
}

/* ── THE TWO BOOK SNAPSHOTS ─────────────────────────────────────────────────
 * Both are checked against the SAME age limit the reconcile refuses at. A
 * chain read against a stale book reads as coverage we do not have. */
function loadSnapshot(file, label) {
  const p = path.join(DATA, file);
  if (!fs.existsSync(p)) bad(`${file} is not in the tree. Refresh it on a machine that can reach the office network.`);
  const snap = JSON.parse(zlib.gunzipSync(fs.readFileSync(p)));
  const ageDays = (Date.now() - Date.parse(snap.exported_at)) / 86400000;
  if (!(ageDays <= MAX_AGE_DAYS)) {
    bad(`${file} is ${ageDays.toFixed(2)} days old (limit ${MAX_AGE_DAYS}). ` +
        "Re-export it before repairing anything against it.");
  }
  note(`${label}: exported ${snap.exported_at} (${ageDays.toFixed(2)} days old)`);
  return snap;
}

const cols = (snap) => Object.fromEntries(snap.line_fields.map((f, i) => [f, i]));

function readBook() {
  const edges = loadSnapshot("ac-convert-edges.json.gz", "chain snapshot");
  const truth = loadSnapshot("ac-reconcile-truth.json.gz", "book snapshot");
  const E = cols(edges);
  const T = cols(truth);

  /* Which purchase order each receipt line was raised from. Only the chain
     snapshot carries FromDocNo for GR. */
  const grFrom = new Map();
  for (const r of edges.types.GR.lines) {
    grFrom.set(String(r[E.dtlKey]), {
      docNo: String(r[E.docNo]).trim(),
      itemKey: String(r[E.itemKey] ?? "").trim(),
      fromDocNo: String(r[E.fromDocNo] ?? "").trim(),
    });
  }
  /* The purchase-order lines, and the build text on both sides. */
  const poLinesByDoc = new Map();
  for (const r of truth.types.PO.lines) {
    const d = String(r[T.docNo]).trim().toUpperCase();
    if (!poLinesByDoc.has(d)) poLinesByDoc.set(d, []);
    poLinesByDoc.get(d).push({
      dtlKey: String(r[T.dtlKey]), itemKey: String(r[T.itemKey] ?? "").trim(),
      qty: r[T.qty], unitPrice: r[T.unitPrice],
    });
  }
  const desc2 = new Map();
  for (const t of Object.keys(truth.types)) {
    for (const r of truth.types[t].desc2 ?? []) desc2.set(String(r[0]), r[1]);
  }
  /* The re-measurement lib/ac-transfer-chain-run.mjs makes every run, made
     again here: if AutoCount ever starts filling the source-line column, this
     whole derivation is the wrong tool and must not run. */
  const stated = edges.types.GR.lines.filter((r) => String(r[E.fromDocDtlKey] ?? "").trim()).length;
  if (stated > 0) {
    bad(`the book now states a source LINE on ${stated} goods-receipt line(s) (GRDTL.FromDocDtlKey). ` +
        "Copy that key across instead of deriving it — this script is for a book that records none.");
  }
  note(`book: ${grFrom.size} receipt lines, ${poLinesByDoc.size} purchase orders, ${desc2.size} build texts; ` +
       "GRDTL.FromDocDtlKey is stated on 0 lines, as this derivation requires");
  return { grFrom, poLinesByDoc, desc2 };
}

/** Receipt lines the ERP holds with no link to an order line. */
const unlinkedLines = (client) => client`
  SELECT gi.id::text AS id, gi.linked_ac_dtlkey::text AS gr_dtlkey, gi.item_code,
         g.grn_number, g.linked_ac_gr_docno AS gr_doc,
         p.linked_ac_docno AS header_po_doc
    FROM scm.grn_items gi
    JOIN scm.grns g ON g.id = gi.grn_id
    JOIN scm.purchase_orders p ON p.id = g.purchase_order_id
   WHERE g.company_id = ${CO} AND g.status <> 'CANCELLED'
     AND g.linked_ac_gr_docno IS NOT NULL AND p.linked_ac_docno IS NOT NULL
     AND gi.purchase_order_item_id IS NULL
     AND gi.linked_ac_dtlkey IS NOT NULL
   ORDER BY g.linked_ac_gr_docno, gi.linked_ac_dtlkey, gi.id`;

/** Our order lines on the orders those receipts name. */
const orderLines = (client, docs) => client`
  SELECT poi.id::text AS id, poi.linked_ac_dtlkey::text AS po_dtlkey,
         upper(po.linked_ac_docno) AS po_doc, poi.item_code
    FROM scm.purchase_order_items poi
    JOIN scm.purchase_orders po ON po.id = poi.purchase_order_id
   WHERE po.company_id = ${CO} AND upper(po.linked_ac_docno) = ANY(${docs})
     AND poi.linked_ac_dtlkey IS NOT NULL`;

const digestOf = (writes) =>
  crypto.createHash("sha256")
    .update(JSON.stringify(writes.map((w) => [w.grnItemId, w.poItemId]).sort()))
    .digest("hex");

async function buildPlan(client, book) {
  const rows = await unlinkedLines(client);
  note(`${rows.length} receipt line row(s) in the ERP carry no order-line link`);
  if (rows.length === 0) return { writes: [], refusals: [], rows };

  /* One BOOK line can be several ERP rows — a sofa is one DtlKey and one row
     per compartment — so the match is made once per book line and applied to
     every ERP row that carries that key. */
  const byKey = new Map();
  for (const r of rows) {
    if (!byKey.has(r.gr_dtlkey)) byKey.set(r.gr_dtlkey, []);
    byKey.get(r.gr_dtlkey).push(r);
  }

  const grLines = [];
  const refusals = [];
  for (const [key, group] of byKey) {
    const bl = book.grFrom.get(key);
    if (!bl) {
      refusals.push({ grDtlKey: key, erp: group[0].grn_number, why: "this line key is not in the book snapshot" });
      continue;
    }
    grLines.push({ docNo: bl.docNo, dtlKey: key, itemKey: bl.itemKey, fromDocNo: bl.fromDocNo });
  }

  const { pairs, refused } = matchGrLinesToPoLines({ grLines, poLinesByDoc: book.poLinesByDoc, desc2: book.desc2 });
  for (const r of refused) {
    refusals.push({ grDtlKey: r.grDtlKey, erp: byKey.get(r.grDtlKey)?.[0]?.grn_number ?? null,
      grDocNo: r.grDocNo, poDocNo: r.poDocNo, why: r.why });
  }

  const poDocs = [...new Set(pairs.map((p) => p.poDocNo))];
  const ours = poDocs.length ? await orderLines(client, poDocs) : [];
  const oursByKey = new Map();
  for (const o of ours) {
    const k = `${o.po_doc}|${o.po_dtlkey}`;
    if (!oursByKey.has(k)) oursByKey.set(k, []);
    oursByKey.get(k).push(o);
  }

  const writes = [];
  for (const p of pairs) {
    const group = byKey.get(p.grDtlKey) ?? [];
    const mine = oursByKey.get(`${p.poDocNo}|${p.poDtlKey}`) ?? [];
    if (mine.length === 0) {
      refusals.push({ grDtlKey: p.grDtlKey, erp: group[0]?.grn_number ?? null, poDocNo: p.poDocNo,
        why: `the ERP holds no order line carrying the book's key ${p.poDtlKey} on ${p.poDocNo}` });
      continue;
    }
    /* SEVERAL of our rows on one book order line is the sofa decomposition —
       one book line, one ERP row per compartment. Which compartment received
       what is a stock question and stock is DEFERRED (「库存先不看」), so this
       refuses rather than picking one. */
    if (mine.length > 1) {
      refusals.push({ grDtlKey: p.grDtlKey, erp: group[0]?.grn_number ?? null, poDocNo: p.poDocNo,
        why: `the ERP splits the book's order line ${p.poDtlKey} into ${mine.length} rows (a sofa build); ` +
             "which one this receipt filled is a stock question, and stock is deferred" });
      continue;
    }
    for (const g of group) {
      /* The pair grain the reconcile uses is (receipt x order); a receipt that
         draws on several orders is several ERP receipts, one per order. So the
         order the book names MUST be the one this ERP receipt already belongs
         to, and a link that crossed that boundary would be writing a receipt
         against an order it is not filed under. */
      if (String(g.header_po_doc ?? "").trim().toUpperCase() !== p.poDocNo) {
        refusals.push({ grDtlKey: p.grDtlKey, erp: g.grn_number, poDocNo: p.poDocNo,
          why: `the book raises this line from ${p.poDocNo} but the ERP receipt is filed under ${g.header_po_doc}` });
        continue;
      }
      writes.push({
        grnItemId: g.id, poItemId: mine[0].id, grnNumber: g.grn_number, itemCode: g.item_code,
        grDocNo: g.gr_doc, grDtlKey: p.grDtlKey, poDocNo: p.poDocNo, poDtlKey: p.poDtlKey, how: p.how,
      });
    }
  }
  return { writes, refusals, rows };
}

function report({ writes, refusals }) {
  say("\n── LINKS TO WRITE — the order line each receipt line filled");
  for (const w of writes) {
    say(`   ${String(w.grnNumber).padEnd(26)} ${String(w.itemCode).slice(0, 26).padEnd(28)} ` +
        `${w.grDocNo} line ${w.grDtlKey} -> ${w.poDocNo} line ${w.poDtlKey}`);
    say(`      ${w.how}`);
  }
  if (refusals.length) {
    say("\n── LEFT BLANK ON PURPOSE — the evidence does not single out one order line");
    for (const r of refusals) say(`   ${String(r.erp ?? r.grDocNo ?? "?").padEnd(26)} line ${r.grDtlKey}: ${r.why}`);
  }
  const docs = new Set(writes.map((w) => `${w.grDocNo}|${w.poDocNo}`));
  say(`\n${writes.length} link(s) on ${docs.size} (receipt x order) pair(s) · ${refusals.length} line(s) left blank`);
}

/* ── THE ASSERTION THAT STANDS IN FOR 「库存先不看」 ────────────────────────
 * Not "the migrations show no trigger" — what the live database says right now.
 * Anything firing on scm.grn_items could turn a pointer write into a quantity
 * move, and that is the one outcome this repair may not have. */
async function assertNothingFires(client) {
  const rows = await client`
    SELECT t.tgname FROM pg_trigger t
     WHERE t.tgrelid = 'scm.grn_items'::regclass AND NOT t.tgisinternal`;
  if (rows.length) {
    bad(`scm.grn_items carries ${rows.length} trigger(s) (${rows.map((r) => r.tgname).join(", ")}). ` +
        "A pointer write could move a quantity through one. Refusing — stock is deferred.");
  }
  note("verified on the live database: nothing fires on scm.grn_items, so this write cannot move stock");
}

async function main() {
  note(`mode=${APPLY ? "APPLY" : "PLAN (writes nothing)"} company=${CO}`);
  const book = readBook();
  const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
  try {
    const plan = await buildPlan(sql, book);
    report(plan);
    const digest = digestOf(plan.writes);
    note(`plan digest ${digest}`);

    if (!APPLY) {
      fs.writeFileSync(PLAN_FILE, `${JSON.stringify({
        built_at: new Date().toISOString(), company_id: CO, digest,
        writes: plan.writes, refusals: plan.refusals,
      }, null, 2)}\n`);
      note(`plan written to ${path.relative(path.join(here, "..", ".."), PLAN_FILE)} — commit it, then apply.`);
      return;
    }

    if (!fs.existsSync(PLAN_FILE)) bad("MODE=apply needs the committed plan file. Run MODE=plan and commit it first.");
    const committed = JSON.parse(fs.readFileSync(PLAN_FILE, "utf8"));
    if (committed.digest !== digest) {
      bad(`the plan has DRIFTED: committed digest ${committed.digest}, recomputed ${digest}. ` +
          "Something changed between plan and apply. Re-plan, read it, and commit the new one.");
    }
    note("plan digest matches the committed file — applying exactly what was reviewed");
    if (plan.writes.length === 0) { note("nothing to write."); return; }

    await assertNothingFires(sql);

    let written = 0;
    for (const w of plan.writes) {
      /* IS NULL is re-asserted in the UPDATE, not only in the SELECT that built
         the plan: between plan and apply a person may have linked the line by
         hand, and their answer wins over this one. */
      const res = await sql`
        UPDATE scm.grn_items SET purchase_order_item_id = ${w.poItemId}
         WHERE id = ${w.grnItemId} AND purchase_order_item_id IS NULL`;
      written += res.count;
    }
    note(`wrote ${written} link(s) of ${plan.writes.length} planned`);

    /* ── INDEPENDENT READ-BACK, ON A FRESH CONNECTION ────────────────────────
       It asserts the SHAPE, not a count: every line just linked must point at
       an order line that exists, carries the same item code, and sits on the
       purchase order the ERP receipt is filed under. */
    const check = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
    try {
      const ids = plan.writes.map((w) => w.grnItemId);
      const [shape] = await check`
        SELECT COUNT(*)::int AS linked,
               COUNT(*) FILTER (WHERE poi.id IS NULL)::int                        AS dangling,
               COUNT(*) FILTER (WHERE poi.purchase_order_id <> g.purchase_order_id)::int AS wrong_order,
               COUNT(*) FILTER (WHERE poi.item_code IS DISTINCT FROM gi.item_code)::int  AS wrong_item
          FROM scm.grn_items gi
          JOIN scm.grns g ON g.id = gi.grn_id
          LEFT JOIN scm.purchase_order_items poi ON poi.id = gi.purchase_order_item_id
         WHERE gi.id = ANY(${ids}::uuid[]) AND gi.purchase_order_item_id IS NOT NULL`;
      note(`verify (fresh connection): linked ${shape.linked}/${ids.length} · dangling ${shape.dangling} ` +
           `· wrong order ${shape.wrong_order} · wrong item ${shape.wrong_item}`);
      if (shape.dangling || shape.wrong_order || shape.wrong_item) {
        bad("VERIFY FAILED: a link points outside its own purchase order or at another item.");
      }
      if (shape.linked !== ids.length) bad(`VERIFY FAILED: expected ${ids.length} linked, read back ${shape.linked}.`);
      note("verify OK — every new link resolves to a line of the same item on the receipt's own purchase order.");
    } finally {
      await check.end({ timeout: 5 });
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
