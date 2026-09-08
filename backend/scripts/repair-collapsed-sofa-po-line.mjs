#!/usr/bin/env node
// ----------------------------------------------------------------------------
// THE PURCHASE SIDE OF A SOFA COLLAPSED TO ONE PIECE, SO ITS SALES LINE CAN
// NEVER REACH READY AND ITS DELIVERY ORDER IS REFUSED. GIVE THE PURCHASE ROW
// THE COMPARTMENTS THE BOOK'S OWN TEXT STATES, AND DEDICATE EACH ONE.
//
// WHAT THE FLOOR SEES. Converting HC-SO-012565 to a delivery order answers 409
// `sofa_no_batch`: "No single production batch on hand can fulfil this whole
// sofa set ... 8030-2A(LHF), 8030-1A(RHF) have no live supplier PO linked".
// The goods are in the building - 「barang sudah ready」 - and the account book
// holds the whole chain: SO-012565 line 856506 -> PO-009435 line 859095
// (FromSODtlKey 856506, TransferedQty 1 of 1) -> GR-005256.
//
// WHY THE LINK IS NOT WRITABLE TODAY. `repair-po-so-link-sofa-compartments.mjs`
// pairs a book purchase line to its book sales line at COMPARTMENT grain, and
// refuses unless the two sides carry the same set of products (its gate 4). On
// these documents the ERP's SALES side is decomposed - `8030-2A(LHF)` +
// `8030-1A(RHF)` - while the ERP's PURCHASE side is a SINGLE row coded
// `8030-1S`. So the pair reads as a BUILD disagreement and stays refused, which
// is right for that tool: it may not invent a compartment.
//
// IT IS NOT A BUILD DISAGREEMENT. It is a stale decode on one side. The book's
// own Desc2 for that purchase line is
//
//     (3S)26inch/Col:BO315-31 / *Fully Cover to Floor / *Bottom wrap Nylon Fabric
//
// and today's decoder - `lib/parse-sofa.mjs`, the one the importer uses - reads
// it as `2A(LHF)+1A(RHF)` (the owner's standing rule: a 3S at any seat depth
// other than 24" splits). That is the sales side, piece for piece. The purchase
// row was written before the decoder could read that text; nothing about the
// sofa changed.
//
// SO THE WRITE IS A COPY, WITNESSED TWICE. The book says these two lines are one
// physical sofa (`PODTL.FromSODtlKey`). The book's PURCHASE text decodes to the
// build. The ERP's SALES rows - decoded separately, at import, from the book's
// SALES text - hold the SAME build. Only where all three agree is a row
// touched; anything else is refused and counted, never reconciled.
//
// WHAT IT IS NOT ALLOWED TO DO. It never relaxes the sofa batch guard
// (`src/scm/lib/sofa-batch-guard.ts`). That guard exists so a set cannot ship
// split across two dye lots, and an order that still refuses AFTER the link is
// right is the guard working - the owner's call, reported separately.
//
// SEVEN GATES, EVERY ONE A REFUSAL RATHER THAN A FALLBACK:
//
//   1  THE BOOK NAMES THE SOURCE LINE. `PODTL.FromSODtlKey`, the one edge the
//      book keys at line grain. No edge, no repair - a link would be INVENTED.
//   2  THE PURCHASE SIDE IS ONE UNLINKED ROW AND THE SALES SIDE IS SEVERAL.
//      Two purchase rows on one book line is somebody else's decomposition and
//      is left alone; a row that already names a sales line is never re-pointed.
//   3  THE PURCHASE ROW IS A COLLAPSED SINGLE and carries build text of its own.
//   4  THE PURCHASE ROW'S OWN TEXT DECODES TO EXACTLY THE SALES SIDE'S PIECES,
//      compared as a MULTISET (`lib/redecode-sofa-plan.mjs`), with every piece
//      code unique so the dedication is an identity match and never a choice.
//      A decode that is shorter, longer, mirrored or ambiguous is REFUSED - it
//      needs the drawing, which is the owner's, not a script's.
//   5  EVERY DECODED PIECE SKU IS MINTED in scm.mfg_products.
//   6  NOTHING DOWNSTREAM HAS MOVED. Any goods-receipt line against the
//      purchase row, or any delivery-order line against any of the sales rows,
//      and the build is reported and left alone.
//   7  THE TARGET SALES ROWS ARE STILL FREE. Asserted in the UPDATE's own
//      predicate too, so a link another lane writes between the plan and the
//      write can never be overwritten.
//
// THE MONEY DOES NOT MOVE BY ONE CENT. The re-coded row keeps every money
// column untouched and each inserted piece has every `_sen` column set to 0
// (`buildCloneInsert`, zeroSen). The purchase order's own total is summed
// before and after INSIDE the transaction and the build is rolled back if it
// moved. `paid_sen` and every other payment column are never named.
//
// NOTHING IS DELETED (owner: 不可以删只可以 cancel). The existing row is
// RE-CODED as the first piece and the rest are INSERTED beside it, so the row
// id - and anything already pointing at it - survives.
//
// CREATING A LINK MOVES READINESS AND THIS SCRIPT DOES NOT RECOMPUTE IT
// (docs/bugs/0675: a direct SQL write does not trigger the projection). It
// prints READY / PENDING / PARTIAL either side of its own write so the delta is
// on the record, and then tells you to dispatch "Recompute SO stock
// allocation".
//
// IT ENQUEUES NOTHING. No outbox row, no AutoCount call. Owner 2026-09-08:
// 「写回autocount的你不需要理了」.
//
//   MODE=plan (default)  read, classify, print every candidate and every
//                        refusal, write NOTHING. This is also the census: the
//                        blocked-shipping section is measured on every run, so
//                        the plan IS the before and the after.
//   MODE=apply           needs CONFIRM="I HAVE REVIEWED THE DRY-RUN".
//
//   DATABASE_URL           required
//   COMPANY_ID             default 1 (AED_HOUZS)
//   MAX_SNAPSHOT_AGE_DAYS  default 2 - refuses rather than write from a stale book
//   DOC                    optional: one sales-order or purchase-order number,
//                          to rehearse a single build
//   TOP                    max rows printed per list (default 80)
//
// PRIVACY: this repository and its Actions logs are PUBLIC. Document numbers,
// item codes, build text and statuses only - no customer, no address, no money.
//
// RE-RUN: idempotent. A repaired purchase row is no longer a single collapsed
// row, so the second run does not select it; a refused build is refused again
// for the same reason.
// ----------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

import { SOFA_MODEL_ALIAS, parseSofa } from "./lib/parse-sofa.mjs";
import { buildFabricColourIndex, isPendingColour } from "./lib/fabric-colour-match.mjs";
import {
  buildCloneInsert, canonicaliser, compartmentOf, compartmentOfVerbatim,
  mergeVariants, modelOf, multiset, pieceCodes, planRow,
} from "./lib/redecode-sofa-plan.mjs";

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("DATABASE_URL required"); process.exit(2); }
const CO = Number(process.env.COMPANY_ID || 1);
const MAX_AGE_DAYS = Number(process.env.MAX_SNAPSHOT_AGE_DAYS || 2);
const APPLY = (process.env.MODE || "plan").toLowerCase() === "apply";
const CONFIRM_PHRASE = "I HAVE REVIEWED THE DRY-RUN";
const ONLY = (process.env.DOC || "").trim().toUpperCase();
const TOP = Number(process.env.TOP || 80);
const STAMP = new Date().toISOString().slice(0, 10);
const here = path.dirname(fileURLToPath(import.meta.url));

const out = (m = "") => console.log(m);
const log = (m = "") => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m = "") => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);
const K = (s) => String(s ?? "").trim().toUpperCase();
const oneLine = (s) => String(s ?? "").replace(/\r/g, "").replace(/\n/g, "\\n").replace(/[ \t]+/g, " ").trim();

/* An order that no longer creates demand. Mirrors SO_TERMINAL_STATES in
   src/scm/shared/so-terminal-states.ts. */
const TERMINAL = new Set(["CANCELLED", "CLOSED", "SHIPPED", "DELIVERED", "INVOICED", "DRAFT"]);

/* isHardBoundLine, src/scm/lib/so-stock-allocation.ts, in SQL-free form - the
   same shape probe-staff-reported-flow.mjs carries, and for the same reason:
   two copies of this predicate drift and the readiness answer drifts with them. */
const HARD_BOUND_GROUPS = new Set(["bedframe", "sofa"]);
const isHardBound = (group, code) => {
  const g = (group ?? "").toLowerCase();
  if (HARD_BOUND_GROUPS.has(g)) return true;
  return g === "mattress" && /\(SP\)\s*$/i.test(code ?? "");
};

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`REFUSED: MODE=apply needs CONFIRM="${CONFIRM_PHRASE}". Run the plan first and read every `
    + "build it prints; this write changes which sales orders can be delivered.");
  process.exit(2);
}

/* ── the book ────────────────────────────────────────────────────────────── */
const SNAP = path.join(here, "data", "ac-reconcile-truth.json.gz");
if (!fs.existsSync(SNAP)) {
  console.error(`REFUSED: ${SNAP} is not present. The edge this repair copies is the BOOK's assertion, `
    + "and without the book there is nothing to copy.");
  process.exit(2);
}
const snap = JSON.parse(zlib.gunzipSync(fs.readFileSync(SNAP)).toString("utf8"));
const ageDays = (Date.now() - new Date(snap.exported_at).getTime()) / 86400000;
if (!(ageDays <= MAX_AGE_DAYS)) {
  console.error(`REFUSED: the AutoCount snapshot is ${ageDays.toFixed(2)} days old (limit ${MAX_AGE_DAYS}). `
    + "A stale book would name edges that have since been cancelled.");
  process.exit(2);
}

/* THE SNAPSHOT'S ROWS ARE ARRAYS, NOT OBJECTS (docs/bugs/0674) - reading
   r.dtlKey off one returns undefined and the empty result reads exactly like
   "there is nothing to repair". Assert the field positions. */
const L = Object.fromEntries(snap.line_fields.map((n, i) => [n, i]));
for (const f of ["docNo", "dtlKey", "itemKey", "qty", "transferedQty", "fromSoDtlKey"]) {
  if (L[f] == null) { console.error(`REFUSED: the snapshot's line_fields has no "${f}".`); process.exit(2); }
}
const H = Object.fromEntries(snap.header_fields.map((n, i) => [n, i]));
const poCancelled = new Map(snap.types.PO.headers.map((r) => [String(r[H.docNo]), String(r[H.cancelled]) === "T"]));

/** book PO line key -> { docNo, itemKey, fromSoDtlKey, qty, moved, cancelled } */
const bookPoByKey = new Map();
/** book SO line key -> [book PO line] (live purchase orders only) */
const bookPoBySoKey = new Map();
for (const r of snap.types.PO.lines) {
  const rec = {
    docNo: String(r[L.docNo]), dtlKey: String(r[L.dtlKey]), itemKey: String(r[L.itemKey] ?? ""),
    fromSoDtlKey: String(r[L.fromSoDtlKey] ?? ""),
    qty: Number(r[L.qty] ?? 0), moved: Number(r[L.transferedQty] ?? 0),
    cancelled: poCancelled.get(String(r[L.docNo])) === true,
  };
  bookPoByKey.set(rec.dtlKey, rec);
  if (!rec.fromSoDtlKey || rec.cancelled) continue;
  if (!bookPoBySoKey.has(rec.fromSoDtlKey)) bookPoBySoKey.set(rec.fromSoDtlKey, []);
  bookPoBySoKey.get(rec.fromSoDtlKey).push(rec);
}
const bookSoByKey = new Map(snap.types.SO.lines.map((r) => [
  String(r[L.dtlKey]), { docNo: String(r[L.docNo]), itemKey: String(r[L.itemKey] ?? "") },
]));

const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1 });

/** Every column of an scm table a clone may write into: generated and identity
 *  columns are the server's to fill. The same reader
 *  redecode-collapsed-sofa-lines.mjs uses, so the two write the same shape. */
async function insertableColumns(client, table) {
  const rows = await client`
    SELECT column_name, is_generated, identity_generation
      FROM information_schema.columns
     WHERE table_schema = 'scm' AND table_name = ${table}
     ORDER BY ordinal_position`;
  if (!rows.length) throw new Error(`scm.${table} has no columns in information_schema - wrong database?`);
  return rows.filter((r) => r.is_generated !== "ALWAYS" && r.identity_generation === null)
    .map((r) => r.column_name);
}

async function readAllocationCounts(client) {
  const r = await client`
    SELECT count(*) FILTER (WHERE i.stock_status = 'READY')::int   AS ready,
           count(*) FILTER (WHERE i.stock_status = 'PENDING')::int AS pending,
           count(*) FILTER (WHERE i.stock_status = 'PARTIAL')::int AS partial
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no AND h.company_id = ${CO}`;
  return r[0];
}

/** The variants block the importer WOULD have written for this decode. */
function decodedVariants(ps, findColour) {
  const colour = isPendingColour(ps.color) ? null : ps.color;
  const fc = colour ? findColour(colour) : null;
  return {
    variants: {
      seatHeight: ps.size ?? null,
      fabricId: fc ? fc.fabric_id : null, colourId: fc ? fc.colour_id : null,
      fabricCode: fc ? fc.colour_id : null, colourLabel: fc ? fc.label : (colour || null),
      fabricLabel: fc ? fc.fabric_id : null, specials: ps.specials,
    },
    colourResolved: Boolean(fc),
  };
}

async function main() {
  out(`mode=${APPLY ? "APPLY" : "PLAN"}  company=${CO}  snapshot exported_at=${snap.exported_at} `
    + `(${ageDays.toFixed(2)} days old)${ONLY ? `  DOC=${ONLY}` : ""}`);
  out(`book: ${bookPoByKey.size} purchase-order lines, ${bookSoByKey.size} sales-order lines`);

  /* ── masters ──────────────────────────────────────────────────────────── */
  const prods = await sql`SELECT code, name FROM scm.mfg_products WHERE company_id = ${CO}`;
  const nameOf = new Map(prods.map((p) => [K(p.code), p.name]));
  const codeSet = new Set(prods.map((p) => K(p.code)));
  const canonical = canonicaliser(prods.map((p) => p.code));
  const RECL = ["-1S(R)", "-1A(R)(LHF)", "-1A(P)(LHF)", "-1S(P)"];
  const reclOf = (m) => RECL.some((s) => codeSet.has(K(m + s)));
  const fcRows = await sql`SELECT fabric_id, colour_id, label FROM scm.fabric_colours WHERE company_id = ${CO}`;
  const { findColour } = buildFabricColourIndex(fcRows);
  /* Exactly the predicate import-ac-outstanding-so.mjs hands the decoder.
     Without it a colour-first Desc2 reads its own fabric code as an unknown
     structure token and the whole build dies. */
  const knownColour = (c) => { const h = findColour(c); return h ? h.colour_id : null; };
  out(`masters: ${codeSet.size} product codes, ${fcRows.length} fabric colours`);

  /* ── the ERP ──────────────────────────────────────────────────────────── */
  const poRows = await sql`
    SELECT i.id::text AS id, p.id::text AS po_id, p.po_number AS doc,
           i.item_code AS code, i.item_group, i.description2 AS d2, i.notes,
           i.variants, i.supplier_sku, i.so_item_id::text AS so_item_id,
           i.linked_ac_dtlkey::text AS dtl, i.qty, i.received_qty,
           UPPER(COALESCE(p.status::text, '')) AS po_status
      FROM scm.purchase_order_items i
      JOIN scm.purchase_orders p ON p.id = i.purchase_order_id AND p.company_id = ${CO}
     WHERE i.linked_ac_dtlkey IS NOT NULL`;
  const soRows = await sql`
    SELECT s.id::text AS id, s.doc_no AS doc, s.item_code AS code, s.item_group,
           s.linked_ac_dtlkey::text AS dtl, s.stock_status, s.allocated_batch_no,
           s.qty, UPPER(COALESCE(o.status::text, '')) AS so_status
      FROM scm.mfg_sales_order_items s
      JOIN scm.mfg_sales_orders o ON o.doc_no = s.doc_no AND o.company_id = ${CO}
     WHERE s.company_id = ${CO} AND s.cancelled IS NOT TRUE`;
  /* Every sales row a purchase row already names, LINKED ROWS INCLUDED: a
     compartment somebody already dedicated still occupies its sales row, and
     leaving it out both under-counts the purchase side and hides the collision
     gate 7 exists to catch (lib/sofa-po-so-pair.mjs records what that cost). */
  const dedicated = new Set(poRows.filter((r) => r.so_item_id).map((r) => r.so_item_id));

  const erpPoByKey = new Map();
  for (const r of poRows) {
    if (K(r.po_status) === "CANCELLED") continue;
    if (!erpPoByKey.has(r.dtl)) erpPoByKey.set(r.dtl, []);
    erpPoByKey.get(r.dtl).push(r);
  }
  const erpSoByKey = new Map();
  for (const r of soRows) {
    if (!r.dtl) continue;
    if (TERMINAL.has(r.so_status)) continue;
    if (!erpSoByKey.has(r.dtl)) erpSoByKey.set(r.dtl, []);
    erpSoByKey.get(r.dtl).push(r);
  }

  /* ══ SECTION 1 - WHO CANNOT SHIP TODAY ═════════════════════════════════ */
  out("");
  out("==============================================================================");
  out("1.  THE SALES ORDERS THAT CANNOT SHIP - one list, whatever found them");
  out("==============================================================================");
  out("");
  out("  A company-1 bedframe / sofa / (SP) mattress line reads READY ONLY through its");
  out("  OWN dedicated purchase-order line (isHardBoundLine). No link, no readiness, no");
  out("  delivery - however much stock is on the floor. This counts the lines in that");
  out("  state FOR WHICH THE BOOK NAMES A PURCHASE ORDER, which is the half with a");
  out("  customer behind it; where the book has no purchase order either, the ERP");
  out("  agreeing with it is the system working.");
  out("");
  const blocked = [];
  for (const r of soRows) {
    if (!isHardBound(r.item_group, r.code)) continue;
    if (TERMINAL.has(r.so_status)) continue;
    if (dedicated.has(r.id)) continue;
    if (!r.dtl) continue;
    const pos = bookPoBySoKey.get(r.dtl);
    if (!pos || !pos.length) continue;
    blocked.push({ ...r, pos });
  }
  const blockedDocs = new Map();
  for (const b of blocked) {
    if (!blockedDocs.has(b.doc)) blockedDocs.set(b.doc, []);
    blockedDocs.get(b.doc).push(b);
  }
  out(`  ${blocked.length} hard-bound sales line(s) on ${blockedDocs.size} sales order(s) carry no dedicated`);
  out("  purchase line while the BOOK records one. Every one of them is a customer whose");
  out("  goods the account book already accounts for.");
  out("");

  /* ══ SECTION 2 - THE BUILDS ════════════════════════════════════════════ */
  const refused = { noBookRow: 0, bookHasNoSource: 0, bookPoCancelled: 0, poNotOne: 0,
    poLinked: 0, poNotCollapsed: 0, noText: 0, decodeUnreadable: 0, skuNotMinted: 0,
    soSideNotDecomposed: 0, multisetDiffers: 0, duplicatePiece: 0, soAlreadyTaken: 0,
    downstreamMoved: 0, notSofa: 0, soNotLive: 0 };
  const refusedDetail = [];
  const builds = [];

  for (const [dtl, rows] of erpPoByKey) {
    const bp = bookPoByKey.get(dtl);
    if (!bp) { refused.noBookRow++; continue; }
    if (bp.cancelled) { refused.bookPoCancelled++; continue; }
    if (!bp.fromSoDtlKey) { refused.bookHasNoSource++; continue; }
    const acSo = bookSoByKey.get(bp.fromSoDtlKey);
    if (!acSo) { refused.noBookRow++; continue; }
    const soSide = erpSoByKey.get(bp.fromSoDtlKey) ?? [];
    if (!soSide.length) { refused.soNotLive++; continue; }

    const poDoc = rows[0].doc;
    const soDoc = soSide[0].doc;
    if (ONLY && K(poDoc) !== ONLY && K(soDoc) !== ONLY) continue;
    const label = `${poDoc} <- ${soDoc}`;
    const note = (why) => refusedDetail.push(`${label}: ${why}`);

    /* Gate 2 - the shape this repair exists for, and nothing else. */
    if (rows.length !== 1) { refused.poNotOne++; continue; }
    const po = rows[0];
    if ((po.item_group ?? "").toLowerCase() !== "sofa") { refused.notSofa++; continue; }
    if (po.so_item_id) { refused.poLinked++; continue; }
    if (soSide.length < 2) { refused.soSideNotDecomposed++; continue; }

    const model = modelOf(po.code, SOFA_MODEL_ALIAS);
    /* Gate 3. A purchase row that is already several compartments is not
       collapsed; a single piece is the shape that cannot pair. */
    if (!/^1S$/i.test(compartmentOf(po.code))) {
      refused.poNotCollapsed++;
      note(`the purchase row is ${po.code}, not a collapsed single`);
      continue;
    }
    if (!String(po.d2 ?? "").trim()) {
      refused.noText++;
      note("the purchase row carries no build text at all - only a photograph can answer it");
      continue;
    }

    const ps = parseSofa(po.d2, model, reclOf(model), { knownColour });
    const target = pieceCodes(model, ps.pieces).map(canonical);
    if (!target.length || ps.conf === "low") {
      refused.decodeUnreadable++;
      note(`the purchase text does not decode (${JSON.stringify(oneLine(po.d2))})`);
      continue;
    }
    const missing = target.filter((c) => !codeSet.has(K(c)));
    if (missing.length) {
      refused.skuNotMinted++;
      note(`a decoded piece SKU is not minted: ${missing.join(", ")}`);
      continue;
    }

    /* Gate 4 - the sales side is the independent witness. Two texts the book
       typed separately, decoded at different times, have to agree piece for
       piece or this is a BUILD question and belongs to the owner. */
    const want = multiset(target);
    const got = multiset(soSide.map((r) => r.code));
    if (want !== got) {
      refused.multisetDiffers++;
      note(`the purchase text decodes to ${target.join("+")} and the sales side holds `
        + `${soSide.map((r) => r.code).join("+")} - a BUILD disagreement, not a link one; it needs the drawing`);
      continue;
    }
    const uniq = new Set(target.map(K));
    if (uniq.size !== target.length) {
      refused.duplicatePiece++;
      note(`${target.join("+")} repeats a compartment - which row is which is a coin flip`);
      continue;
    }
    const taken = soSide.filter((r) => dedicated.has(r.id));
    if (taken.length) {
      refused.soAlreadyTaken++;
      note(`${taken.map((r) => r.code).join(", ")} already carries a purchase line`);
      continue;
    }

    /* Gate 6 - downstream. Deliberately stricter than "posted": a draft
       delivery counts, and the log says which kind it was. */
    const grs = await sql`
      SELECT g.grn_number AS doc FROM scm.grn_items gi JOIN scm.grns g ON g.id = gi.grn_id
       WHERE gi.purchase_order_item_id = ${po.id}`;
    const dos = await sql`
      SELECT d.do_number AS doc, UPPER(COALESCE(d.status::text, '')) AS status
        FROM scm.delivery_order_items di JOIN scm.delivery_orders d ON d.id = di.delivery_order_id
       WHERE di.so_item_id = ANY(${soSide.map((r) => r.id)})`;
    if (grs.length || dos.length) {
      refused.downstreamMoved++;
      note(`downstream has moved - ${grs.length} goods-receipt line(s) (${grs.map((g) => g.doc).join(", ") || "-"}), `
        + `${dos.length} delivery line(s) (${dos.map((d) => `${d.doc} ${d.status}`).join(", ") || "-"})`);
      continue;
    }

    const plan = planRow({ currentCode: po.code, targetCodes: target });
    if (plan.kind !== "expand") { refused.poNotCollapsed++; continue; }
    const byCode = new Map(soSide.map((r) => [K(r.code), r]));
    const { variants, colourResolved } = decodedVariants(ps, findColour);
    builds.push({
      label, poDoc, soDoc, acPo: bp.docNo, acSo: acSo.docNo, soDtlKey: bp.fromSoDtlKey,
      po, soSide, model, ps, target, plan, variants, colourResolved,
      dedicate: target.map((c) => ({ code: c, so: byCode.get(K(c)) })),
      bookMoved: bp.moved, bookQty: bp.qty,
    });
  }

  out("==============================================================================");
  out("2.  THE COLLAPSED PURCHASE ROWS THE BOOK'S OWN TEXT CAN ANSWER");
  out("==============================================================================");
  out("");
  out(`  ${erpPoByKey.size} live company-${CO} purchase-order line key(s) read from the ERP`);
  out("  REFUSED, each for a reason the book or the pair gives:");
  out(`    the key names no line in the book                  ${String(refused.noBookRow).padStart(5)}`);
  out(`    the book's purchase order is CANCELLED             ${String(refused.bookPoCancelled).padStart(5)}`);
  out(`    the BOOK records no source order                   ${String(refused.bookHasNoSource).padStart(5)}  a link here would be INVENTED`);
  out(`    the source order is not live in the ERP            ${String(refused.soNotLive).padStart(5)}  not imported, or terminal`);
  out(`    the book line is several ERP purchase rows         ${String(refused.poNotOne).padStart(5)}  already decomposed`);
  out(`    the purchase row is not a sofa                     ${String(refused.notSofa).padStart(5)}`);
  out(`    the purchase row already names a sales line        ${String(refused.poLinked).padStart(5)}`);
  out(`    the sales side is a single row too                 ${String(refused.soSideNotDecomposed).padStart(5)}  1:1 - the other repair's job`);
  out(`    the purchase row is not a collapsed single         ${String(refused.poNotCollapsed).padStart(5)}  (gate 3)`);
  out(`    the purchase row carries no build text             ${String(refused.noText).padStart(5)}  photograph only`);
  out(`    the purchase text does not decode                  ${String(refused.decodeUnreadable).padStart(5)}`);
  out(`    a decoded piece SKU is not minted                  ${String(refused.skuNotMinted).padStart(5)}  a catalogue gap`);
  out(`    the two sides decode to DIFFERENT builds           ${String(refused.multisetDiffers).padStart(5)}  needs the drawing (gate 4)`);
  out(`    a compartment repeats - the pairing is a coin flip ${String(refused.duplicatePiece).padStart(5)}  (gate 4)`);
  out(`    a sales compartment is already dedicated           ${String(refused.soAlreadyTaken).padStart(5)}  (gate 7)`);
  out(`    downstream has already moved                       ${String(refused.downstreamMoved).padStart(5)}  (gate 6)`);
  out(`    PROVABLE - every gate passed                       ${String(builds.length).padStart(5)}`);
  out("");
  out("  THE PROVABLE BUILDS - the book's own edge, its own text, and the sales side");
  out("  agreeing piece for piece:");
  for (const b of builds) {
    out(`    ${b.label}  [${b.model}]  ${b.po.code} -> ${b.target.join(" + ")}`);
    out(`      book ${b.acPo} <- ${b.acSo}, SO line ${b.soDtlKey}; the book moved ${b.bookMoved} of ${b.bookQty}`);
    out(`      purchase text ${JSON.stringify(oneLine(b.po.d2))}`);
    if (b.ps.why.length) out(`      decoder notes: ${b.ps.why.join("; ")}`);
    out(`      ERP purchase row qty ${b.po.qty} received ${b.po.received_qty}`);
    for (const d of b.dedicate) {
      out(`      ${d.code === b.plan.update ? "re-code" : "insert "} ${String(d.code).padEnd(22)} -> ${d.so.doc} `
        + `[line ${d.so.stock_status}, batch ${d.so.allocated_batch_no ?? "(none)"}]`);
    }
  }
  if (refusedDetail.length) {
    out("");
    out("  THE BUILDS THAT STAY REFUSED, one line each:");
    for (const d of refusedDetail.slice(0, TOP)) out(`    ${d}`);
    if (refusedDetail.length > TOP) out(`    ... and ${refusedDetail.length - TOP} more - raise TOP`);
  }

  /* ── the census, split by what this repair can and cannot reach ───────── */
  const reachable = new Set(builds.flatMap((b) => b.soSide.map((r) => r.id)));
  out("");
  out("==============================================================================");
  out("3.  WHAT THIS REPAIR REACHES, AND WHAT IS LEFT");
  out("==============================================================================");
  out("");
  let willShip = 0;
  const stayDocs = new Map();
  for (const [doc, rs] of blockedDocs) {
    if (rs.every((r) => reachable.has(r.id))) { willShip++; continue; }
    stayDocs.set(doc, rs.filter((r) => !reachable.has(r.id)));
  }
  out(`  sales orders whose every blocked line this repair links   ${String(willShip).padStart(4)}`);
  out(`  sales orders it cannot finish                             ${String(stayDocs.size).padStart(4)}`);
  out("");
  let shown = 0;
  for (const [doc, rs] of stayDocs) {
    if (shown++ >= TOP) { out(`    ... and ${stayDocs.size - shown} more - raise TOP`); break; }
    for (const r of rs) {
      out(`    ${doc}  ${String(r.code).padEnd(22)} ${String(r.item_group).padEnd(9)} ${String(r.stock_status).padEnd(8)}`
        + ` SO line ${r.dtl} -> the book raised ${[...new Set(r.pos.map((p) => p.docNo))].join(", ")}`);
    }
  }

  if (!APPLY) {
    out("");
    log(`PLAN: ${builds.length} collapsed purchase row(s) would be expanded and dedicated, unblocking `
      + `${willShip} sales order(s) of the ${blockedDocs.size} the book says are blocked. Nothing was written. `
      + `Re-run with MODE=apply and CONFIRM="${CONFIRM_PHRASE}".`);
    await sql.end({ timeout: 5 });
    return;
  }
  if (builds.length === 0) {
    log("APPLY: nothing to write - no collapsed purchase row passes every gate. This is the idempotent re-run.");
    await sql.end({ timeout: 5 });
    return;
  }

  /* ── apply, one transaction per build ─────────────────────────────────── */
  const poCols = await insertableColumns(sql, "purchase_order_items");
  const before = await readAllocationCounts(sql);
  out("");
  out(`allocation BEFORE the write: READY ${before.ready} | PENDING ${before.pending} | PARTIAL ${before.partial}`);
  out("");
  out(`=== APPLYING ${builds.length} BUILD(S) ===`);

  const ins = buildCloneInsert({
    table: "scm.purchase_order_items",
    columns: poCols,
    overrides: {
      item_code: null, material_name: null, supplier_sku: null,
      variants: "text::jsonb", notes: null, so_item_id: "uuid",
    },
  });
  const applied = [];
  for (const b of builds) {
    try {
      const receipt = await sql.begin(async (tx) => {
        const totalBefore = String((await tx`
          SELECT COALESCE(SUM(line_total_sen), 0)::bigint AS t
            FROM scm.purchase_order_items WHERE purchase_order_id = ${b.po.po_id}`)[0].t);

        const v = mergeVariants(b.po.variants, b.variants, { colourResolved: b.colourResolved });
        const notes = `${b.po.notes ? b.po.notes + " | " : ""}sofa: compartments re-decoded from the AutoCount text ${STAMP}`;
        const skuOf = (code) => (b.po.supplier_sku ? `${b.po.supplier_sku} ${compartmentOfVerbatim(code)}` : null);
        const first = b.dedicate[0];
        /* so_item_id IS NULL in the predicate: another lane's link is never
           overwritten, and a row that moved between the plan and the write
           simply does not update - the build then rolls back and says so. */
        const upd = await tx`
          UPDATE scm.purchase_order_items
             SET item_code = ${first.code},
                 material_name = ${nameOf.get(K(first.code)) ?? first.code},
                 supplier_sku = ${skuOf(first.code)},
                 variants = ${JSON.stringify(v)}::text::jsonb,
                 notes = ${notes},
                 so_item_id = ${first.so.id}
           WHERE id = ${b.po.id} AND so_item_id IS NULL
       RETURNING id`;
        if (!upd.length) throw new Error("the purchase row gained a sales link between the plan and the write");

        for (const d of b.dedicate.slice(1)) {
          const bind = {
            item_code: d.code, material_name: nameOf.get(K(d.code)) ?? d.code,
            supplier_sku: skuOf(d.code), variants: JSON.stringify(v), notes, so_item_id: d.so.id,
          };
          await tx.unsafe(ins.text, [b.po.id, ...ins.params.map((p) => bind[p])]);
        }

        const totalAfter = String((await tx`
          SELECT COALESCE(SUM(line_total_sen), 0)::bigint AS t
            FROM scm.purchase_order_items WHERE purchase_order_id = ${b.po.po_id}`)[0].t);
        if (totalBefore !== totalAfter) throw new Error(`the purchase order total moved ${totalBefore} -> ${totalAfter}`);
        return { ...b, totalBefore };
      });
      applied.push(receipt);
      out(`  OK ${b.label} - ${b.target.join(" + ")}, purchase total held at ${receipt.totalBefore}`);
    } catch (e) {
      bad(`  ROLLED BACK ${b.label} - ${e.message}`);
    }
  }

  /* ── verification, on a connection that did none of the writing ───────── */
  await sql.end({ timeout: 5 });
  const verify = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
  try {
    out("");
    out("=== VERIFIED ON A FRESH CONNECTION - the SHAPE, never a row count ===");
    const problems = [];
    for (const b of applied) {
      const rows = await verify`
        SELECT i.id::text AS id, i.item_code AS code, jsonb_typeof(i.variants) AS vt,
               i.so_item_id::text AS so_item_id, s.item_code AS so_code, s.doc_no
          FROM scm.purchase_order_items i
          LEFT JOIN scm.mfg_sales_order_items s ON s.id = i.so_item_id
         WHERE i.purchase_order_id = ${b.po.po_id} AND i.linked_ac_dtlkey = ${b.po.dtl}::bigint`;
      const want = multiset(b.target);
      const got = multiset(rows.map((r) => r.code));
      if (got !== want) problems.push(`${b.label}: the purchase side reads ${got}, planned ${want}`);
      for (const r of rows) {
        if (r.vt !== "object") problems.push(`${b.label}: ${r.code} has a ${r.vt} variants block, not an object`);
        if (!r.so_item_id) { problems.push(`${b.label}: ${r.code} still carries no sales-order link`); continue; }
        if (K(r.code) !== K(r.so_code)) problems.push(`${b.label}: ${r.code} names ${r.doc_no} ${r.so_code} - DIFFERENT product`);
      }
      const dupes = await verify`
        SELECT so_item_id::text AS so_item_id, count(*)::int AS n
          FROM scm.purchase_order_items
         WHERE so_item_id = ANY(${b.soSide.map((r) => r.id)})
         GROUP BY so_item_id HAVING count(*) > 1`;
      for (const d of dupes) problems.push(`${b.label}: sales line ${d.so_item_id} is now named by ${d.n} purchase rows`);
      const total = String((await verify`
        SELECT COALESCE(SUM(line_total_sen), 0)::bigint AS t
          FROM scm.purchase_order_items WHERE purchase_order_id = ${b.po.po_id}`)[0].t);
      if (total !== b.totalBefore) problems.push(`${b.label}: the purchase total READS BACK ${total}, was ${b.totalBefore}`);
    }
    out(`  ${applied.length} of ${builds.length} build(s) applied; ${problems.length} wrong shape`);
    for (const p of problems) bad(`  ${p}`);
    if (problems.length) {
      console.error("REFUSED: the write did not produce the shape it planned. Every row above needs a human.");
      await verify.end({ timeout: 5 });
      process.exit(2);
    }
    const after = await readAllocationCounts(verify);
    out("");
    out(`allocation AFTER the write:  READY ${after.ready} | PENDING ${after.pending} | PARTIAL ${after.partial}`);
    out("  A DIRECT SQL WRITE DOES NOT RECOMPUTE THE ALLOCATION (docs/bugs/0675), so these two");
    out("  lines are expected to be IDENTICAL. They are printed so the delta is on the record.");
    out("  Dispatch Actions -> Recompute SO stock allocation to project the new links.");
    log(`APPLIED: ${applied.length} collapsed sofa purchase row(s) now carry the compartments the book's own `
      + "text states, each dedicated to the sales compartment of the same product. Verified on a fresh "
      + "connection: every pair names the same product, no sales line is named twice, and no purchase order "
      + `total moved. Allocation unchanged by this write (READY ${before.ready} -> ${after.ready}); run the `
      + "recompute next. No outbox row was written and no AutoCount call was made.");
    await verify.end({ timeout: 5 });
  } catch (e) {
    await verify.end({ timeout: 5 }).catch(() => {});
    throw e;
  }
}

main().catch(async (e) => {
  console.error(e);
  await sql.end({ timeout: 5 }).catch(() => {});
  process.exit(2);
});
