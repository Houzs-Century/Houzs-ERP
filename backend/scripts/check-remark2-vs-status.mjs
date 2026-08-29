#!/usr/bin/env node
// The owner's closing question of the 2026-08-28 re-import round: once the
// data is aligned, the system's COMPUTED stock status should agree with what
// staff hand-wrote in the book's Remark2 (READY / MATTRESS/ACC / ...). This
// check MEASURES that agreement instead of asserting it.
//
// Read-only. For every imported company-1 order it compares:
//   the staff CLAIM  — remark2 (imported byte-for-byte from the book), classed
//                      READY / READY-PARTIAL / CATEGORY (MATTRESS/ACC/BEDFRAME
//                      combos = "that part is ready") / OTHER free text
//   the system VIEW  — its non-service lines' computed stock_status rollup:
//                      ALL-READY / SOME-READY / NONE-READY
// and prints the matrix plus the actionable list: orders where staff wrote
// READY but the system covers nothing — either a real stock discrepancy or a
// matching gap, and each doc number is checkable by hand.
//
// A disagreement is a FINDING to read, not an error: staff notes age, stock
// moves, and the computed side only lit up after the allocation recompute.
// Exit 0 for every verdict; non-zero only for an unreachable DB.
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const norm = (s) => (s || "").trim().toUpperCase().replace(/\s+/g, " ");

function classifyClaim(r) {
  const s = (r || "").trim().toUpperCase();
  if (!s) return null;
  if (s === "READY") return "READY";
  if (/^READY\s*\(PARTIAL\)/.test(s)) return "READY-PARTIAL";
  if (/^(MATTRESS|BEDFRAME|ACC)([/ ]+(MATTRESS|BEDFRAME|ACC))*$/.test(s.replace(/\s+/g, ""))) return "CATEGORY";
  return "OTHER";
}

async function main() {
  const rows = await sql`
    SELECT h.doc_no, h.remark2, h.status::text AS so_status, to_char(h.processing_date, 'YYYY-MM-DD') AS pdate,
           i.id, i.item_code, i.item_group, i.stock_status, i.qty,
           i.warehouse_id, w.name AS wh_name, COALESCE(i.stock_qty_ready, 0) AS qty_ready,
           (i.variants IS NOT NULL AND i.variants::text NOT IN ('null', '{}')) AS has_variants,
           COALESCE(del.dq, 0) AS delivered,
           COALESCE(ded.n, 0) AS dedicated_po_lines,
           COALESCE(ded.recv, 0) AS recv
    FROM scm.mfg_sales_orders h
    JOIN scm.mfg_sales_order_items i ON i.doc_no = h.doc_no AND i.cancelled = false
    LEFT JOIN scm.warehouses w ON w.id = i.warehouse_id
    LEFT JOIN (
      SELECT d.so_item_id, SUM(d.qty) AS dq
      FROM scm.delivery_order_items d
      JOIN scm.delivery_orders dh ON dh.id = d.delivery_order_id
      WHERE COALESCE(dh.status::text, '') NOT ILIKE '%cancel%'
      GROUP BY d.so_item_id
    ) del ON del.so_item_id = i.id
    LEFT JOIN (
      SELECT so_item_id, COUNT(*) AS n, COALESCE(SUM(received_qty), 0) AS recv
      FROM scm.purchase_order_items
      WHERE so_item_id IS NOT NULL GROUP BY so_item_id
    ) ded ON ded.so_item_id = i.id
    WHERE h.company_id = 1 AND h.linked_ac_docno IS NOT NULL
      AND UPPER(h.status::text) NOT IN ('CANCELLED', 'COMPLETED')`;

  const byDoc = new Map();
  for (const r of rows) {
    if (!byDoc.has(r.doc_no)) byDoc.set(r.doc_no, { remark2: r.remark2, lines: [] });
    byDoc.get(r.doc_no).lines.push(r);
  }
  log(`imported live orders measured: ${byDoc.size}`);
  {
    /* Verdict probe for the engine's balance read: mattresses light ONLY via
       the pooled bucket (no bound path), and the repo's own sofa module
       measured that PostgREST's in.(...) silently returns zero rows for codes
       containing parentheses. If that read is blind, no parenthesized mattress
       can ever be READY while paren-free ones are. */
    const m = { parenReady: 0, parenPending: 0, plainReady: 0, plainPending: 0 };
    for (const r of rows) {
      if ((r.item_group || "").toLowerCase() !== "mattress") continue;
      const paren = (r.item_code || "").includes("(");
      const ready = r.stock_status === "READY";
      if (paren && ready) m.parenReady++;
      else if (paren) m.parenPending++;
      else if (ready) m.plainReady++;
      else m.plainPending++;
    }
    log(`MATTRESS PAREN PROBE — with '(': READY ${m.parenReady} / other ${m.parenPending}; without: READY ${m.plainReady} / other ${m.plainPending}`);
  }

  /* Bucket leftovers — the FIFO-exhaustion cause. A short pooled line is
     LEGITIMATELY unlit when older lines drained its (warehouse, item) bucket:
     the handwriting was optimistic, the allocator obeyed first-come-first-
     served. Only a bucket with units left over AFTER every lit line's claim is
     evidence the allocator owed this line a light. Blank-variant migrated
     stock pools under variant_key '', which is what the balance rows carry. */
  const balRows = await sql`SELECT warehouse_id, item_code, COALESCE(variant_key, '') AS vk, SUM(qty) AS q
    FROM scm.inventory_balances WHERE company_id = 1 GROUP BY 1, 2, 3`;
  const bucketQty = new Map();       // all variant keys summed
  const blankBucketQty = new Map();  // the '' bucket the allocator matches variant-less lines against
  for (const b of balRows) {
    const k = `${b.warehouse_id}|${norm(b.item_code)}`;
    bucketQty.set(k, (bucketQty.get(k) ?? 0) + Number(b.q));
    if ((b.vk ?? '') === '') blankBucketQty.set(k, (blankBucketQty.get(k) ?? 0) + Number(b.q));
  }
  for (const r of rows) {
    if (Number(r.qty_ready) > 0) {
      const k = `${r.warehouse_id}|${norm(r.item_code)}`;
      if (bucketQty.has(k)) bucketQty.set(k, bucketQty.get(k) - Number(r.qty_ready));
      if (blankBucketQty.has(k)) blankBucketQty.set(k, blankBucketQty.get(k) - Number(r.qty_ready));
    }
  }
  const leftover = (l) => bucketQty.get(`${l.warehouse_id}|${norm(l.item_code)}`) ?? 0;
  const blankLeftover = (l) => blankBucketQty.get(`${l.warehouse_id}|${norm(l.item_code)}`) ?? 0;
  /* The allocator buckets by the RAW item_code string. A line and its stock
     that differ by an invisible space or case match under norm() and never in
     the engine. rawLeftover uses the exact string; when it reads 0 while
     blankKeyLeftover is positive, the conviction is a code-string drift and
     the suspect print quotes both spellings. */
  const rawBlank = new Map();
  const stockSpellings = new Map(); // normed -> Set of raw spellings seen in stock
  for (const b of balRows) {
    if ((b.vk ?? '') !== '') continue;
    rawBlank.set(`${b.warehouse_id}|${b.item_code}`, (rawBlank.get(`${b.warehouse_id}|${b.item_code}`) ?? 0) + Number(b.q));
    const nk = norm(b.item_code);
    if (!stockSpellings.has(nk)) stockSpellings.set(nk, new Set());
    stockSpellings.get(nk).add(b.item_code);
  }
  for (const r of rows) {
    if (Number(r.qty_ready) > 0) {
      const k = `${r.warehouse_id}|${r.item_code}`;
      if (rawBlank.has(k)) rawBlank.set(k, rawBlank.get(k) - Number(r.qty_ready));
    }
  }
  const rawLeftover = (l) => rawBlank.get(`${l.warehouse_id}|${l.item_code}`) ?? 0;
  const spellings = (l) => [...(stockSpellings.get(norm(l.item_code)) ?? [])].map((x) => JSON.stringify(x)).join(" / ");

  /* The owner's 2026-08-29 protocol (「甲」): the system's computed status is
     the truth; a difference from the hand-written Remark2 is only an ALGORITHM
     defect after three legitimate causes are excluded —
       DELIVERED-STALE  every short line is already delivered; the handwriting
                        aged (delivery moves in the book daily; measured 40
                        delivery-date edits in one day)
       NO-OWN-PO        the short lines are bedframe/sofa with NO dedicated PO:
                        under hard binding they NEVER light from pooled old
                        stock, by his explicit ruling
       GRANULARITY      the main pieces (bedframe/sofa/mattress) are all READY
                        and only accessories/services are short — staff's READY
                        speaks of the main pieces
     What remains is ALGO-SUSPECT and MUST BE ZERO. */
  const MAIN = new Set(["bedframe", "sofa", "mattress"]);
  const BOUND = new Set(["bedframe", "sofa"]);
  const matrix = new Map();
  const classes = { "DELIVERED-STALE": [], "NO-OWN-PO": [], GRANULARITY: [], "GATED-NO-PDATE": [], "ALGO-SUSPECT": [] };
  let claimed = 0, agree = 0;
  for (const [doc, o] of byDoc) {
    const claim = classifyClaim(o.remark2);
    if (!claim) continue;
    claimed++;
    const stock = o.lines.filter((l) => (l.item_group || "") !== "service");
    const nReady = stock.filter((l) => l.stock_status === "READY").length;
    const view = stock.length === 0 ? "NO-STOCK-LINES" : nReady === 0 ? "NONE-READY" : nReady === stock.length ? "ALL-READY" : "SOME-READY";
    matrix.set(`${claim} | ${view}`, (matrix.get(`${claim} | ${view}`) || 0) + 1);

    const disagrees = (claim === "READY" && view !== "ALL-READY" && view !== "NO-STOCK-LINES");
    if (!disagrees) { agree++; continue; }
    /* PER-LINE attribution (2026-08-29 second cut): the first version classed
       the whole ORDER by one cause and pushed every mixed order (one line
       delivered + one line PO-less) into ALGO-SUSPECT — 57 of them, most
       explained line by line. A short line is LEGITIMATELY unlit when it is
       already delivered, or it is a bound-group line with no dedicated PO
       (the owner's hard-binding scope), or it is not a main piece (staff's
       READY speaks of bedframe/sofa/mattress). An order is ALGO-SUSPECT only
       if at least one short line has NONE of those causes — and that line is
       named, so the trace starts at the line, not the order. */
    /* the allocator skips whole orders without a processing date (its own
       gate, by design — MRP runs on processed orders). Dark lines on such an
       order are the gate speaking, not the algorithm failing. */
    if (!o.lines[0].pdate) { classes["GATED-NO-PDATE"].push(doc); continue; }
    const short = stock.filter((l) => l.stock_status !== "READY");
    const suspects = short.filter((l) => {
      const g = (l.item_group || "").toLowerCase();
      if (Number(l.delivered) >= Number(l.qty)) return false;          // delivered
      if (!MAIN.has(g)) return false;                                   // granularity
      if (BOUND.has(g)) {
        /* hard binding: a bedframe/sofa line lights ONLY from its own PO's
           receipts. No PO, or PO not yet received = legitimate dark. The
           received-but-dark case is the reconcile lens's must-be-zero list,
           counted there — here it still flags as suspect. */
        return Number(l.dedicated_po_lines) > 0 && Number(l.recv) > Number(l.qty_ready);
      }
      /* pooled (mattress/acc): dark is legitimate while the bucket is drained
         by older lines; suspect only when units are LEFT OVER unclaimed */
      return leftover(l) > 0;
    });
    if (suspects.length === 0) {
      const allDelivered = short.every((l) => Number(l.delivered) >= Number(l.qty));
      const allNoPo = short.every((l) => BOUND.has((l.item_group || "").toLowerCase()) && Number(l.dedicated_po_lines) === 0);
      classes[allDelivered ? "DELIVERED-STALE" : allNoPo ? "NO-OWN-PO" : "GRANULARITY"].push(doc);
    } else {
      classes["ALGO-SUSPECT"].push(`${doc} [${o.lines[0].so_status}] <- ${suspects.map((l) => `${l.item_code}[${l.item_group}]${l.stock_status} wh=${l.wh_name ?? l.warehouse_id ?? "NULL"} variants=${l.has_variants ? "YES" : "no"} leftover=${leftover(l)} blankKeyLeftover=${blankLeftover(l)} rawKeyLeftover=${rawLeftover(l)} line=${JSON.stringify(l.item_code)} stock=${spellings(l)}`).slice(0, 3).join(" | ")}`);
    }
  }
  /* BIDIRECTIONAL category matrix (owner 2026-08-29): not only "the book
     claims READY and the system is short", but the reverse — categories the
     system has fully READY that the book's Remark2 never mentions. */
  {
    const GROUPS = ["mattress", "bedframe", "sofa", "accessory", "others"];
    const claimSet = (r) => {
      const c = classifyClaim(r);
      if (c === "READY") return new Set(GROUPS);
      if (c === "READY-PARTIAL") return null; // not falsifiable per category
      if (c === "CATEGORY") {
        const set = new Set();
        const t = (r || "").toUpperCase();
        if (/MATTRESS/.test(t)) set.add("mattress");
        if (/BEDFRAME/.test(t)) set.add("bedframe");
        if (/ACC/.test(t)) set.add("accessory");
        return set;
      }
      return c ? null : new Set();
    };
    let bothAgree = 0, acMore = 0, erpMore = 0, mixed = 0;
    const acMoreByGroup = {}, erpMoreByGroup = {};
    const erpMoreDocs = [];
    /* WHY is the book behind where we are ahead? Compare the remark we
       imported (21:59 snapshot, byte-equal in the DB) against the LIVE book
       remark exported 23:27 the same night (committed ac-live-so-remark2):
       if the live book has since stamped a status, the gap was TIMING — the
       detector runs after us; if the live book is still blank, the detector
       simply does not cover that order (its gap, not ours). */
    for (const [doc, o] of byDoc) {
      const cs = claimSet(o.remark2);
      if (cs === null) continue;
      const ready = new Set();
      for (const g of GROUPS) {
        const ls = o.lines.filter((l) => (l.item_group || "").toLowerCase() === g);
        if (ls.length && ls.every((l) => l.stock_status === "READY" || Number(l.delivered) >= Number(l.qty))) ready.add(g);
      }
      const acOnly = [...cs].filter((g) => !ready.has(g) && o.lines.some((l) => (l.item_group || "").toLowerCase() === g));
      const erpOnly = [...ready].filter((g) => !cs.has(g));
      if (!acOnly.length && !erpOnly.length) bothAgree++;
      else if (acOnly.length && erpOnly.length) mixed++;
      else if (acOnly.length) { acMore++; for (const g of acOnly) acMoreByGroup[g] = (acMoreByGroup[g] || 0) + 1; }
      else { erpMore++; for (const g of erpOnly) erpMoreByGroup[g] = (erpMoreByGroup[g] || 0) + 1; erpMoreDocs.push({ doc, erpOnly, imported: o.remark2 ?? "" }); }
    }
    log(`BIDIRECTIONAL category matrix (orders with a parseable claim incl. blank): agree ${bothAgree}; book-claims-more ${acMore}; ERP-ready-more ${erpMore}; both-directions ${mixed}`);
    log(`  book-claims-more by category: ${JSON.stringify(acMoreByGroup)}`);
    log(`  ERP-ready-more by category: ${JSON.stringify(erpMoreByGroup)}`);
    {
      const fs2 = await import("node:fs");
      const zlib2 = await import("node:zlib");
      const path2 = await import("node:path");
      const url2 = await import("node:url");
      const here2 = path2.dirname(url2.fileURLToPath(import.meta.url));
      const live = new Map(JSON.parse(zlib2.gunzipSync(fs2.readFileSync(path2.join(here2, "data", "ac-live-so-remark2.json.gz"))).toString("utf8")).map((r) => [String(r.DocNo).trim(), (r.Remark2 || "").trim()]));
      const buckets = { "BOOK-CAUGHT-UP": [], "BOOK-STILL-BLANK": [], "BOOK-SAYS-OTHER": [], "NOT-IN-LIVE": [] };
      for (const e of erpMoreDocs) {
        const ac = e.doc.replace(/^HC-/, "");
        if (!live.has(ac)) { buckets["NOT-IN-LIVE"].push(e.doc); continue; }
        const now = live.get(ac);
        const then = (e.imported || "").trim();
        if (now && now !== then) buckets["BOOK-CAUGHT-UP"].push(`${e.doc} now=${JSON.stringify(now)}`);
        else if (!now) buckets["BOOK-STILL-BLANK"].push(`${e.doc} erp-ready:{${e.erpOnly.join(",")}}`);
        else buckets["BOOK-SAYS-OTHER"].push(`${e.doc} book=${JSON.stringify(now)} erp-extra:{${e.erpOnly.join(",")}}`);
      }
      for (const [k, v] of Object.entries(buckets)) {
        log(`  ERP-ahead cause ${k}: ${v.length}`);
        for (const x of v.slice(0, 6)) log(`     ${x}`);
      }
    }
  }
  log(`orders where staff wrote a status: ${claimed}`);
  for (const [k, n] of [...matrix.entries()].sort((a, b) => b[1] - a[1])) log(`  ${k.padEnd(34)} ${n}`);
  log(`READY claims that disagree, classified per the owner's protocol:`);
  for (const [cls, docs] of Object.entries(classes)) {
    log(`  ${cls.padEnd(16)} ${docs.length}${cls === "ALGO-SUSPECT" ? "   <-- MUST BE ZERO" : ""}`);
    for (const d of docs.slice(0, cls === "ALGO-SUSPECT" ? 40 : 6)) log(`     ${d}`);
    if (docs.length > (cls === "ALGO-SUSPECT" ? 30 : 6)) log(`     ... and ${docs.length - (cls === "ALGO-SUSPECT" ? 30 : 6)} more`);
  }
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
