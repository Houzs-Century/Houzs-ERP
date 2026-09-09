#!/usr/bin/env node
/* Stamp the goods-receipt LINE each migrated purchase-invoice line billed.
 * ---------------------------------------------------------------------------
 * THE DEFECT, MEASURED. Runs 34268495385 / 34263816266 on `main`: PURCHASE
 * INVOICES 53 differ — the largest number left before go-live. docs/bugs/0730
 * names two columns behind 47 of them, and this repairs ONE of them:
 * `scm.purchase_invoice_items.grn_item_id` is NULL, so the chain axis returns
 * `erp_link_missing` — the account book says the invoice line was raised from a
 * goods receipt and the ERP points at nothing
 * (scripts/lib/transfer-chain-verdict.mjs).
 *
 * THE OTHER COLUMN IS NOT TOUCHED HERE. `scm.grns.linked_ac_gr_docno` being
 * NULL produces `doc_differs` on a different set of lines, and stamping it
 * would ADD receipts to the goods-receipt comparison population
 * (`linked_ac_gr_docno IS NOT NULL` is that population's filter, in
 * lib/ac-reconcile-erp-sql.mjs). Worse, it is only safe where the receipt IS
 * the book's receipt; on an ERP-native one it would INVENT a link.
 * scripts/diag-pi-gr-links.mjs measures that split per document. Two causes,
 * two repairs, and this is the one whose evidence is already in.
 *
 * HOW THE LINE IS READ. scripts/lib/ac-pi-gr-line-match.mjs, which refuses
 * anything it cannot single out. AutoCount records the source DOCUMENT and
 * never the source LINE (`FromDocDtlKey` is NULL on all ~220,000 rows of all
 * six detail tables), so the line comes out of the two documents themselves —
 * the only line of its item code on that receipt, or the one line of several
 * whose build text is the same. NEVER by position: GR-000032 carries two
 * NK-1045 (Q) bed frames and PI-000654 bills the SECOND
 * (docs/bugs/0690, docs/bugs/0730). tests/acPiGrLineMatch.test.mjs pins that
 * case AND runs a position implementation against the same rows to show it
 * gets them wrong.
 *
 * IT DOES NOT MOVE STOCK, AND THAT IS CHECKED, NOT ASSUMED. The owner:
 * 「库存先不看」. One column is written, `grn_item_id`, and only where it IS
 * NULL. The apply step reads `pg_trigger` on the LIVE database and refuses if
 * anything fires on `scm.purchase_invoice_items` or on `scm.grn_items` — the
 * second because `grn_items.invoiced_qty` is the counter this edge reads, and a
 * pointer write that reached it through a trigger would be a quantity move
 * wearing a pointer's clothes. No quantity, no money, no status, no movement is
 * written by this script.
 *
 * PLAN -> APPLY, WITH THE PLAN COMMITTED.
 *   MODE=plan  (default) writes data/pi-gr-line-links-plan.json and prints its
 *              digest. Nothing is written to the database.
 *   MODE=apply recomputes the plan from live data, checks it against the
 *              COMMITTED file's digest, refuses on any drift, writes, and then
 *              re-reads on a FRESH connection asserting the SHAPE.
 *   CONFIRM="I HAVE REVIEWED THE DRY-RUN" is required to apply.
 *
 * RE-RUN: inert. Keyed on grn_item_id IS NULL, which a successful write clears,
 * so a second run finds nothing and reports the same refusals.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { matchPiLinesToGrLines } from "./lib/ac-pi-gr-line-match.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(here, "data");
const PLAN_FILE = path.join(DATA, "pi-gr-line-links-plan.json");
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

  /* Which goods receipt each invoice line was raised from. Only the chain
     snapshot carries FromDocNo for PI. */
  const piFrom = new Map();
  for (const r of edges.types.PI.lines) {
    piFrom.set(String(r[E.dtlKey]), {
      docNo: String(r[E.docNo]).trim(),
      itemKey: String(r[E.itemKey] ?? "").trim(),
      fromDocNo: String(r[E.fromDocNo] ?? "").trim(),
    });
  }
  /* The goods-receipt lines, and the build text on both sides. */
  const grLinesByDoc = new Map();
  for (const r of truth.types.GR.lines) {
    const d = String(r[T.docNo]).trim().toUpperCase();
    if (!grLinesByDoc.has(d)) grLinesByDoc.set(d, []);
    grLinesByDoc.get(d).push({
      dtlKey: String(r[T.dtlKey]), itemKey: String(r[T.itemKey] ?? "").trim(),
    });
  }
  const desc2 = new Map();
  for (const t of Object.keys(truth.types)) {
    for (const r of truth.types[t].desc2 ?? []) desc2.set(String(r[0]), r[1]);
  }
  /* The re-measurement lib/ac-transfer-chain-run.mjs makes every run, made
     again here: if AutoCount ever starts filling the source-line column, this
     whole derivation is the wrong tool and must not run. */
  const stated = edges.types.PI.lines.filter((r) => String(r[E.fromDocDtlKey] ?? "").trim()).length;
  if (stated > 0) {
    bad(`the book now states a source LINE on ${stated} purchase-invoice line(s) (PIDTL.FromDocDtlKey). ` +
        "Copy that key across instead of deriving it — this script is for a book that records none.");
  }
  note(`book: ${piFrom.size} invoice lines, ${grLinesByDoc.size} goods receipts, ${desc2.size} build texts; ` +
       "PIDTL.FromDocDtlKey is stated on 0 lines, as this derivation requires");
  return { piFrom, grLinesByDoc, desc2 };
}

/** Invoice lines the ERP holds with no link to a receipt line. */
const unlinkedLines = (client) => client`
  SELECT pii.id::text AS id, pii.linked_ac_dtlkey::text AS pi_dtlkey, pii.item_code,
         h.invoice_number, h.linked_ac_docno AS pi_doc
    FROM scm.purchase_invoice_items pii
    JOIN scm.purchase_invoices h ON h.id = pii.purchase_invoice_id
   WHERE h.company_id = ${CO} AND h.linked_ac_docno IS NOT NULL
     AND pii.grn_item_id IS NULL
     AND pii.linked_ac_dtlkey IS NOT NULL
   ORDER BY h.linked_ac_docno, pii.linked_ac_dtlkey, pii.id`;

/** Our receipt lines on the receipts those invoices name. */
const receiptLines = (client, docs) => client`
  SELECT gi.id::text AS id, gi.linked_ac_dtlkey::text AS gr_dtlkey,
         upper(g.linked_ac_gr_docno) AS gr_doc, gi.item_code
    FROM scm.grn_items gi
    JOIN scm.grns g ON g.id = gi.grn_id
   WHERE g.company_id = ${CO} AND g.status <> 'CANCELLED'
     AND upper(g.linked_ac_gr_docno) = ANY(${docs})
     AND gi.linked_ac_dtlkey IS NOT NULL`;

const digestOf = (writes) =>
  crypto.createHash("sha256")
    .update(JSON.stringify(writes.map((w) => [w.piItemId, w.grnItemId]).sort()))
    .digest("hex");

async function buildPlan(client, book) {
  const rows = await unlinkedLines(client);
  note(`${rows.length} invoice line row(s) in the ERP carry no receipt-line link`);
  if (rows.length === 0) return { writes: [], refusals: [], rows };

  /* One BOOK line can be several ERP rows — a sofa is one DtlKey and one row
     per compartment — so the match is made once per book line and applied to
     every ERP row that carries that key. */
  const byKey = new Map();
  for (const r of rows) {
    if (!byKey.has(r.pi_dtlkey)) byKey.set(r.pi_dtlkey, []);
    byKey.get(r.pi_dtlkey).push(r);
  }

  const piLines = [];
  const refusals = [];
  for (const [key, group] of byKey) {
    const bl = book.piFrom.get(key);
    if (!bl) {
      refusals.push({ piDtlKey: key, erp: group[0].invoice_number, why: "this line key is not in the book snapshot" });
      continue;
    }
    piLines.push({ docNo: bl.docNo, dtlKey: key, itemKey: bl.itemKey, fromDocNo: bl.fromDocNo });
  }

  const { pairs, refused } = matchPiLinesToGrLines({
    piLines, grLinesByDoc: book.grLinesByDoc, desc2: book.desc2,
  });
  for (const r of refused) {
    refusals.push({ piDtlKey: r.piDtlKey, erp: byKey.get(r.piDtlKey)?.[0]?.invoice_number ?? null,
      piDocNo: r.piDocNo, grDocNo: r.grDocNo, why: r.why });
  }

  const grDocs = [...new Set(pairs.map((p) => p.grDocNo))];
  const ours = grDocs.length ? await receiptLines(client, grDocs) : [];
  const oursByKey = new Map();
  for (const o of ours) {
    const k = `${o.gr_doc}|${o.gr_dtlkey}`;
    if (!oursByKey.has(k)) oursByKey.set(k, []);
    oursByKey.get(k).push(o);
  }

  const writes = [];
  for (const p of pairs) {
    const group = byKey.get(p.piDtlKey) ?? [];
    const mine = oursByKey.get(`${p.grDocNo}|${p.grDtlKey}`) ?? [];
    if (mine.length === 0) {
      refusals.push({ piDtlKey: p.piDtlKey, erp: group[0]?.invoice_number ?? null, grDocNo: p.grDocNo,
        why: `the ERP holds no receipt line carrying the book's key ${p.grDtlKey} on ${p.grDocNo}` });
      continue;
    }
    /* SEVERAL of our rows on one book receipt line is the sofa decomposition —
       one book line, one ERP row per compartment. Which compartment this
       invoice billed is a stock question and stock is DEFERRED (「库存先不看」),
       so this refuses rather than picking one. */
    if (mine.length > 1) {
      refusals.push({ piDtlKey: p.piDtlKey, erp: group[0]?.invoice_number ?? null, grDocNo: p.grDocNo,
        why: `the ERP splits the book's receipt line ${p.grDtlKey} into ${mine.length} rows (a sofa build); ` +
             "which one this invoice billed is a stock question, and stock is deferred" });
      continue;
    }
    for (const g of group) {
      writes.push({
        piItemId: g.id, grnItemId: mine[0].id, invoiceNumber: g.invoice_number, itemCode: g.item_code,
        piDocNo: g.pi_doc, piDtlKey: p.piDtlKey, grDocNo: p.grDocNo, grDtlKey: p.grDtlKey, how: p.how,
      });
    }
  }
  return { writes, refusals, rows };
}

function report({ writes, refusals }) {
  say("\n── LINKS TO WRITE — the receipt line each invoice line billed");
  for (const w of writes) {
    say(`   ${String(w.invoiceNumber).padEnd(26)} ${String(w.itemCode).slice(0, 26).padEnd(28)} ` +
        `${w.piDocNo} line ${w.piDtlKey} -> ${w.grDocNo} line ${w.grDtlKey}`);
    say(`      ${w.how}`);
  }
  if (refusals.length) {
    say("\n── LEFT BLANK ON PURPOSE — the evidence does not single out one receipt line");
    for (const r of refusals) say(`   ${String(r.erp ?? r.piDocNo ?? "?").padEnd(26)} line ${r.piDtlKey}: ${r.why}`);
  }
  const docs = new Set(writes.map((w) => w.piDocNo));
  say(`\n${writes.length} link(s) on ${docs.size} invoice(s) · ${refusals.length} line(s) left blank`);
}

/* ── THE ASSERTION THAT STANDS IN FOR 「库存先不看」 ────────────────────────
 * Not "the migrations show no trigger" — what the live database says right now.
 * `scm.grn_items` is checked as well as the table being written, because
 * `grn_items.invoiced_qty` is the counter this edge reads and a pointer write
 * that reached it through a trigger would be a quantity move in disguise. */
async function assertNothingFires(client) {
  for (const tbl of ["scm.purchase_invoice_items", "scm.grn_items"]) {
    const rows = await client`
      SELECT t.tgname FROM pg_trigger t
       WHERE t.tgrelid = ${tbl}::regclass AND NOT t.tgisinternal`;
    if (rows.length) {
      bad(`${tbl} carries ${rows.length} trigger(s) (${rows.map((r) => r.tgname).join(", ")}). ` +
          "A pointer write could move a quantity through one. Refusing — stock is deferred.");
    }
  }
  note("verified on the live database: nothing fires on scm.purchase_invoice_items or scm.grn_items, " +
       "so this write cannot move a quantity");
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
         hand, and their answer wins over this one. Both ids are read back as
         ::text so the plan file is plain JSON; the casts put them back to uuid
         rather than letting the driver bind text against a uuid column, which
         errors (docs/bugs/0731). */
      const res = await sql`
        UPDATE scm.purchase_invoice_items SET grn_item_id = ${w.grnItemId}::uuid
         WHERE id = ${w.piItemId}::uuid AND grn_item_id IS NULL`;
      written += res.count;
    }
    note(`wrote ${written} link(s) of ${plan.writes.length} planned`);

    /* ── INDEPENDENT READ-BACK, ON A FRESH CONNECTION ────────────────────────
       It asserts the SHAPE, not a count: every line just linked must point at a
       receipt line that exists, carries the same item code, and sits on a
       receipt of the company this repair ran for. */
    const check = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
    try {
      const ids = plan.writes.map((w) => w.piItemId);
      const [shape] = await check`
        SELECT COUNT(*)::int AS linked,
               COUNT(*) FILTER (WHERE gi.id IS NULL)::int                              AS dangling,
               COUNT(*) FILTER (WHERE g.company_id IS DISTINCT FROM ${CO})::int         AS wrong_company,
               COUNT(*) FILTER (WHERE gi.item_code IS DISTINCT FROM pii.item_code)::int AS wrong_item
          FROM scm.purchase_invoice_items pii
          LEFT JOIN scm.grn_items gi ON gi.id = pii.grn_item_id
          LEFT JOIN scm.grns g ON g.id = gi.grn_id
         WHERE pii.id = ANY(${ids}::uuid[]) AND pii.grn_item_id IS NOT NULL`;
      note(`verify (fresh connection): linked ${shape.linked}/${ids.length} · dangling ${shape.dangling} ` +
           `· wrong company ${shape.wrong_company} · wrong item ${shape.wrong_item}`);
      if (shape.dangling || shape.wrong_company || shape.wrong_item) {
        bad("VERIFY FAILED: a link points at another company's receipt or at another item.");
      }
      if (shape.linked !== ids.length) bad(`VERIFY FAILED: expected ${ids.length} linked, read back ${shape.linked}.`);
      note("verify OK — every new link resolves to a line of the same item on this company's own receipt.");
    } finally {
      await check.end({ timeout: 5 });
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
