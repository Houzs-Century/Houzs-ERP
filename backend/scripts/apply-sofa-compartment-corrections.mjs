#!/usr/bin/env node
// Write the owner-approved compartment + seat-size answers onto the live sofa
// documents.
//
// Source of truth: EVERY file in data/ named by scripts/lib/sofa-corrections-
// source.mjs — today sofa-compartment-corrections-2026-08.json (35 builds, the
// cutover round) and sofa-compartment-corrections-2026-09.json (15 builds, the
// -1S placeholder round). The 2026-08 file is NOT replaced: it is still the
// record of the builds already written, and re-running is inert on them only
// while it is still loaded. Each build names the SO and the PO raised from it
// (corrected together so the pair cannot drift), the target piece list left to
// right, the seat depth, and how the answer was reached.
//
// ── WHAT THIS TOUCHES, AND WHAT IT REFUSES TO ───────────────────────────────
// A build is one AutoCount sofa line = several ERP rows, one per compartment.
// Correcting it changes the ROW COUNT, which is why this is a gated script and
// not a UI edit.
//
//   MATCH FIRST, THEN UPDATE IN PLACE. Existing rows are paired to target
//   pieces by code; a pair is UPDATEd, never dropped and re-inserted, so the
//   row id survives — and with it the purchase_order_items.so_item_id
//   dedication that bound-mode readiness reads. repair-leaked-sofa-lines.mjs
//   set that precedent for exactly this reason.
//
//   TWO IDENTICAL LINES ARE TWO SOFAS. A document can carry the same Desc2
//   twice because the customer ordered two of the same sofa. Both take the
//   build; dealing them out as if they were two compartments of one build made
//   one sofa out of two, silently. scripts/lib/sofa-build-plan.mjs splits them
//   and has the test.
//
//   DELETE ONLY GENUINE SURPLUS, AND ONLY IF NOTHING POINTS AT IT. A surplus SO
//   line with a PO line or a DO line hanging off it, or a surplus PO line with
//   a GRN line hanging off it, is REFUSED and reported — never silently cut.
//
//   REFUSE A BUILD WHOSE DOWNSTREAM ACTUALLY MOVED STOCK. These documents are
//   migrated paperwork (`migrated_no_stock`), so correcting the code on a GRN
//   or DO line changes what the paper says and nothing else. A GRN or DO that
//   is NOT migrated, or any inventory_movements row naming the document, means
//   real stock moved under the old code and re-labelling it is not a paperwork
//   fix. Measured on prod 2026-09-04 for the 2026-09 round: every GRN and DO
//   involved is migrated_no_stock = true and there are zero movements.
//
//   THE MONEY DOES NOT MOVE, AND NOTHING IS RECOMPUTED. The importer put the
//   whole build's price on its first piece and 0 on the rest. The lead piece
//   keeps the lead row's own unit_price_sen and its own total column verbatim;
//   every other piece is 0 in both. BOTH columns are asserted per sofa, because
//   scm.purchase_order_items.line_total_sen is 0 on all 289 company-1 sofa
//   lines while unit_price_sen carries the price — a check on the total column
//   alone passed vacuously there AND refused correct work.
//
// DRY-RUN by default; APPLY=1 writes, and APPLY=1 additionally needs
// CONFIRM="I HAVE REVIEWED THE DRY-RUN" — the house gate this script was
// grandfathered out of (release-discipline-grandfathered.json) and which
// docs/bugs/0700 records a sibling workflow failing to pass. Every build is its
// own transaction, and the run ends by re-reading every corrected document on a
// FRESH connection and asserting the piece MULTISET, not a row count.
//
// RE-RUN: inert on a build already written. Rows are MATCHED to target pieces
// and updated in place, so a second run re-states the same codes, the same
// money and the same seat on the same row ids; nothing is inserted, nothing is
// deleted and no downstream row moves. That is what makes it safe to leave the
// 2026-08 file loaded beside the 2026-09 one. A build whose target piece SKU is
// not minted, or whose surplus row is referenced downstream, is REFUSED on
// every run rather than half-applied.
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

import { selectBuildRows } from "./lib/sofa-desc2-match.mjs";
import { loadCorrections } from "./lib/sofa-corrections-source.mjs";
import { planDownstreamParity } from "./lib/sofa-downstream-parity.mjs";
import {
  K,
  compartmentOf,
  moneyOfRows,
  pairRowsToPieces,
  planCopyMoney,
  seatHeightToWrite,
  splitBuildCopies,
  supersededBy,
} from "./lib/sofa-build-plan.mjs";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
/* A build changes the ROW COUNT of a live sales order and carries the change
   down onto the purchase order, the receipt, the delivery note and the invoices
   raised from them. APPLY=1 alone is one character; the phrase has to be typed
   on purpose. Refused loudly, never downgraded to a dry-run — an operator who
   asked for a write and got a plan reads the plan as the write. */
const CONFIRM_PHRASE = "I HAVE REVIEWED THE DRY-RUN";
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`REFUSED: APPLY=1 needs CONFIRM="${CONFIRM_PHRASE}". Nothing was written.`);
  process.exit(2);
}
const CO = Number(process.env.COMPANY || 1);
const ONLY = (process.env.DOC || "").trim();
/* Which round to plan. Blank = every file. "2026-09" plans that round alone,
   which is how a new round is applied without re-opening the previous one. */
const FILE = (process.env.FILE || "").trim();
const here = path.dirname(fileURLToPath(import.meta.url));
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const newSql = () => postgres(DST, { ssl: "require", prepare: false, max: 1 });
const sql = newSql();
const modelOf = (code) => { const c = K(code); const d = c.indexOf("-"); return d < 0 ? c : c.slice(0, d); };

const DATA = loadCorrections(path.join(here, "data"), FILE);

/** Everything downstream that would follow this build, and whether any of it
 *  moved real stock rather than migrated paperwork. */
async function downstreamMovedStock(doc, isPo, rowIds) {
  const reasons = [];
  const mv = await sql`SELECT count(*)::int n FROM scm.inventory_movements
                        WHERE company_id = ${CO} AND source_doc_no = ${doc}`;
  if (mv[0].n) reasons.push(`${mv[0].n} inventory movement(s) name ${doc}`);
  if (!rowIds.length) return { reasons, grns: 0, dos: 0 };

  const grns = isPo
    ? await sql`SELECT DISTINCT g.grn_number, g.migrated_no_stock FROM scm.grn_items gi
                  JOIN scm.grns g ON g.id = gi.grn_id
                 WHERE gi.purchase_order_item_id = ANY(${rowIds})`
    : await sql`SELECT DISTINCT g.grn_number, g.migrated_no_stock FROM scm.grn_items gi
                  JOIN scm.grns g ON g.id = gi.grn_id
                  JOIN scm.purchase_order_items pi ON pi.id = gi.purchase_order_item_id
                 WHERE pi.so_item_id = ANY(${rowIds})`;
  const dos = isPo ? [] : await sql`SELECT DISTINCT d.do_number, d.migrated_no_stock
                  FROM scm.delivery_order_items di
                  JOIN scm.delivery_orders d ON d.id = di.delivery_order_id
                 WHERE di.so_item_id = ANY(${rowIds})`;
  for (const g of grns) if (g.migrated_no_stock !== true) reasons.push(`${g.grn_number} is not migrated paperwork — it moved stock`);
  for (const d of dos) if (d.migrated_no_stock !== true) reasons.push(`${d.do_number} is not migrated paperwork — it moved stock`);
  return { reasons, grns: grns.length, dos: dos.length };
}

/* The invoice raised from a migrated receipt or delivery note took the SAME
   snapshot the GRN and DO lines took — create-migrated-invoices.mjs copies
   `l._row.item_code` and `l._row.variants` straight off the parent row, at :305
   for a purchase invoice and :345 for a sales one. So it has to follow this
   correction for exactly the reason they do, and leaving it behind is what put
   four invoice lines in production on a `-1S` placeholder their parent had
   already left (docs/bugs/0687).

   A typed invoice is NOT touched. `migrated_no_stock` is the same assertion the
   GRN and DO carry rest on; an invoice that fails it is somebody's own
   statement about what was billed, and it is reported by number rather than
   overwritten. An invoice never moves stock in this ERP, so this is paperwork
   only — the same standing the block below rests on. */
async function carryToPurchaseInvoice(grnItemIds, t) {
  if (!grnItemIds.length) return { moved: 0, held: [] };
  const held = await sql`SELECT DISTINCT h.invoice_number FROM scm.purchase_invoice_items l
                           JOIN scm.purchase_invoices h ON h.id = l.purchase_invoice_id
                          WHERE l.grn_item_id = ANY(${grnItemIds})
                            AND h.migrated_no_stock IS DISTINCT FROM true`;
  const moved = await sql`UPDATE scm.purchase_invoice_items l
                             SET item_code = ${t.code}, variants = ${sql.json(t.v)}
                            FROM scm.purchase_invoices h
                           WHERE h.id = l.purchase_invoice_id
                             AND l.grn_item_id = ANY(${grnItemIds})
                             AND h.migrated_no_stock = true
                       RETURNING l.id`;
  return { moved: moved.length, held: held.map((r) => r.invoice_number) };
}

async function carryToSalesInvoice(doItemIds, t) {
  if (!doItemIds.length) return { moved: 0, held: [] };
  const held = await sql`SELECT DISTINCT h.invoice_number FROM scm.sales_invoice_items l
                           JOIN scm.sales_invoices h ON h.id = l.sales_invoice_id
                          WHERE l.do_item_id = ANY(${doItemIds})
                            AND h.migrated_no_stock IS DISTINCT FROM true`;
  const moved = await sql`UPDATE scm.sales_invoice_items l
                             SET item_code = ${t.code}, variants = ${sql.json(t.v)}
                            FROM scm.sales_invoices h
                           WHERE h.id = l.sales_invoice_id
                             AND l.do_item_id = ANY(${doItemIds})
                             AND h.migrated_no_stock = true
                       RETURNING l.id`;
  return { moved: moved.length, held: held.map((r) => r.invoice_number) };
}

/* ── THE DOWNSTREAM DOCUMENTS, AND WHY THEY ARE NAMED IN AN ENTRY ────────────
   A build's rows are UPDATED on the receipt, the delivery note and the invoices
   by the carry block at the bottom of the loop — and that carry can only move
   rows that already exist. The pieces a correction ADDS have no row there, so a
   sofa the order states in three lines stays one line on the receipt that
   received it. Measured on prod, probe run 34316985562: HC-SO-000814's sofa is
   3 rows on the order and 3 on the purchase order, and ONE row on HC-GR-000287,
   HC-DO-000542 and HC-I-000745 each.

   Naming those documents in the entry's `docs` brings them to the same shape in
   the SAME run, which is what this file's own rule already asks for: a build
   written on one side and not the other leaves the rest holding the lead piece
   alone (docs/bugs/0719). It is also what makes the reconcile able to answer
   them — `lib/sofa-rulings.mjs` looks a ruling up by DOCUMENT NUMBER of any
   type, and RULED requires the ERP to hold the owner's answer as an exact
   multiset.

   THE STOCK QUESTION IS ANSWERED BY MEASUREMENT, NOT BY THE HEADER FLAG.
   「库存先不看」. Every document here is asserted `migrated_no_stock` and free of
   inventory movements before anything is written, and `pg_trigger` on
   production was read before this code existed (same probe run): scm.grn_items,
   scm.sales_invoice_items and scm.purchase_invoice_items carry ZERO non-internal
   triggers, and scm.delivery_order_items carries exactly one —
   `trg_do_line_integrity_lock`, `AFTER DELETE OR UPDATE OF delivery_order_id`,
   which an INSERT does not fire. So an added compartment row reaches no
   inventory path at all. The guard below re-checks the trigger set on every run
   and REFUSES on anything it has not been shown, because "no trigger" is a fact
   about the database on the day it was read. */
const DOWNSTREAM = {
  GR: {
    what: "goods receipt",
    table: "scm.grn_items",
    owner: "grn_id",
    head: (doc) => sql`SELECT g.id, COALESCE(g.migrated_no_stock, false) AS migrated
                         FROM scm.grns g WHERE g.company_id = ${CO} AND g.grn_number = ${doc}`,
    rows: (id, conn = sql) => conn`SELECT i.id, i.item_code AS code, i.variants, i.description2, i.linked_ac_dtlkey,
                             i.purchase_order_item_id AS parent_id
                        FROM scm.grn_items i WHERE i.grn_id = ${id} ORDER BY i.id`,
    link: "purchase_order_item_id",
    /* The parent row for a piece: the SAME purchase order, the SAME account-book
       line, the piece's own code. Resolved, never guessed — 0 or 2 candidates
       leaves the link NULL and says so, which is `reshape-migrated-grns.mjs`'s
       ruling 「跟 autocount 一样」 for an attribution the book does not record. */
    parentOf: (templateParentId, code) => sql`
      SELECT i.id FROM scm.purchase_order_items i
       WHERE i.purchase_order_id = (SELECT p.purchase_order_id FROM scm.purchase_order_items p WHERE p.id = ${templateParentId})
         AND i.linked_ac_dtlkey IS NOT DISTINCT FROM (SELECT p.linked_ac_dtlkey FROM scm.purchase_order_items p WHERE p.id = ${templateParentId})
         AND upper(i.item_code) = ${code}`,
  },
  DO: {
    what: "delivery order",
    table: "scm.delivery_order_items",
    owner: "delivery_order_id",
    head: (doc) => sql`SELECT d.id, COALESCE(d.migrated_no_stock, false) AS migrated
                         FROM scm.delivery_orders d WHERE d.company_id = ${CO} AND d.do_number = ${doc}`,
    rows: (id, conn = sql) => conn`SELECT i.id, i.item_code AS code, i.variants, i.description2, i.linked_ac_dtlkey,
                             i.so_item_id AS parent_id
                        FROM scm.delivery_order_items i WHERE i.delivery_order_id = ${id} ORDER BY i.line_no NULLS FIRST, i.id`,
    link: "so_item_id",
    parentOf: (templateParentId, code) => sql`
      SELECT i.id FROM scm.mfg_sales_order_items i
       WHERE i.doc_no = (SELECT s.doc_no FROM scm.mfg_sales_order_items s WHERE s.id = ${templateParentId})
         AND i.linked_ac_dtlkey IS NOT DISTINCT FROM (SELECT s.linked_ac_dtlkey FROM scm.mfg_sales_order_items s WHERE s.id = ${templateParentId})
         AND upper(i.item_code) = ${code}`,
  },
  SI: {
    what: "sales invoice",
    table: "scm.sales_invoice_items",
    owner: "sales_invoice_id",
    head: (doc) => sql`SELECT h.id, COALESCE(h.migrated_no_stock, false) AS migrated
                         FROM scm.sales_invoices h WHERE h.company_id = ${CO} AND h.invoice_number = ${doc}`,
    rows: (id, conn = sql) => conn`SELECT i.id, i.item_code AS code, i.variants, i.description2, i.linked_ac_dtlkey,
                             i.do_item_id AS parent_id
                        FROM scm.sales_invoice_items i WHERE i.sales_invoice_id = ${id} ORDER BY i.line_no NULLS FIRST, i.id`,
    link: "do_item_id",
    parentOf: (templateParentId, code) => sql`
      SELECT i.id FROM scm.delivery_order_items i
       WHERE i.delivery_order_id = (SELECT d.delivery_order_id FROM scm.delivery_order_items d WHERE d.id = ${templateParentId})
         AND i.linked_ac_dtlkey IS NOT DISTINCT FROM (SELECT d.linked_ac_dtlkey FROM scm.delivery_order_items d WHERE d.id = ${templateParentId})
         AND upper(i.item_code) = ${code}`,
  },
  PI: {
    what: "purchase invoice",
    table: "scm.purchase_invoice_items",
    owner: "purchase_invoice_id",
    head: (doc) => sql`SELECT h.id, COALESCE(h.migrated_no_stock, false) AS migrated
                         FROM scm.purchase_invoices h WHERE h.company_id = ${CO} AND h.invoice_number = ${doc}`,
    rows: (id, conn = sql) => conn`SELECT i.id, i.item_code AS code, i.variants, i.description2, i.linked_ac_dtlkey,
                             i.grn_item_id AS parent_id
                        FROM scm.purchase_invoice_items i WHERE i.purchase_invoice_id = ${id} ORDER BY i.id`,
    link: "grn_item_id",
    parentOf: (templateParentId, code) => sql`
      SELECT i.id FROM scm.grn_items i
       WHERE i.grn_id = (SELECT g.grn_id FROM scm.grn_items g WHERE g.id = ${templateParentId})
         AND i.linked_ac_dtlkey IS NOT DISTINCT FROM (SELECT g.linked_ac_dtlkey FROM scm.grn_items g WHERE g.id = ${templateParentId})
         AND upper(i.item_code) = ${code}`,
  },
};

/** Which kind of document a number names. `HC-PI-` is tested before `HC-I-`
 *  because the shorter prefix is a substring of neither but the sales-invoice
 *  test is written as "starts with HC-I-" and a purchase invoice must not fall
 *  into it. Anything else is a sales order, which is the pre-existing default. */
function kindOf(doc) {
  if (/^HC-PO-/.test(doc)) return "PO";
  if (/^HC-GR-/.test(doc)) return "GR";
  if (/^HC-DO-/.test(doc)) return "DO";
  if (/^HC-PI-/.test(doc)) return "PI";
  if (/^HC-(SI|I)-/.test(doc)) return "SI";
  return "SO";
}

/* The triggers this code was written against, read from production before it
   existed. A trigger this list does not name STOPS the run: an INSERT that
   reaches an inventory path is precisely what 「库存先不看」 forbids, and the way
   to be sure is to look, every time, rather than to remember. */
const KNOWN_TRIGGERS = {
  "scm.grn_items": [],
  "scm.delivery_order_items": ["trg_do_line_integrity_lock"],
  "scm.sales_invoice_items": [],
  "scm.purchase_invoice_items": [],
};

/** Every non-internal trigger on the four downstream line tables, now. */
async function unknownDownstreamTriggers() {
  const names = Object.keys(KNOWN_TRIGGERS).map((t) => t.split(".")[1]);
  const rows = await sql`SELECT c.relname::text AS tbl, t.tgname::text AS trg
                           FROM pg_trigger t
                           JOIN pg_class c ON c.oid = t.tgrelid
                           JOIN pg_namespace n ON n.oid = c.relnamespace
                          WHERE NOT t.tgisinternal AND n.nspname = 'scm' AND c.relname = ANY(${names})`;
  return rows
    .filter((r) => !(KNOWN_TRIGGERS[`scm.${r.tbl}`] ?? []).includes(r.trg))
    .map((r) => `scm.${r.tbl}.${r.trg}`);
}

/** A quoted SQL identifier, refusing anything that is not one. */
function ident(name) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(String(name))) throw new Error(`refusing to build SQL around identifier ${JSON.stringify(name)}`);
  return `"${name}"`;
}

/**
 * CLONE a row of `table` and override the named columns.
 *
 * The column list is read from `information_schema` rather than typed out.
 * `split-collapsed-sofa-lines.mjs` states the reason and this repository has
 * paid for it: "enumerating columns would silently drop whatever this script
 * has not heard of — and these tables carry columns no migration in this
 * repository declares". A hand-written list is a list that goes stale in
 * silence; a cloned row carries the document's warehouse, unit, dates, notes
 * and account-book line key whether or not anyone here knew about them.
 *
 * Identifiers come from `information_schema` and from the fixed `DOWNSTREAM`
 * map, never from a caller, and every VALUE is a bound parameter. `::text::jsonb`
 * on a jsonb override is load-bearing — without it postgres.js stringifies an
 * already-stringified value and the row lands as a jsonb STRING that reads as
 * empty to every consumer (docs/jsonb-double-encoding-coe.md).
 */
async function cloneRow(tx, table, srcId, overrides, jsonCols) {
  const [schema, name] = table.split(".");
  const cols = await tx`SELECT column_name FROM information_schema.columns
                         WHERE table_schema = ${schema} AND table_name = ${name}
                           AND is_generated = 'NEVER' AND is_identity = 'NO'
                         ORDER BY ordinal_position`;
  const names = cols.map((c) => c.column_name).filter((c) => c !== "id");
  if (!names.length) throw new Error(`${table} has no writable columns — information_schema returned nothing`);
  const params = [srcId];
  const select = names.map((c) => {
    if (!Object.prototype.hasOwnProperty.call(overrides, c)) return `x.${ident(c)}`;
    params.push(overrides[c]);
    return jsonCols.includes(c) ? `$${params.length}::text::jsonb` : `$${params.length}`;
  });
  const q = `INSERT INTO ${schema}.${ident(name)} (${names.map(ident).join(", ")})
             SELECT ${select.join(", ")} FROM ${schema}.${ident(name)} x WHERE x.id = $1 RETURNING id`;
  return tx.unsafe(q, params);
}

/** Every money column of a table — the ones an added piece is zero in. */
async function moneyColumns(table) {
  const [schema, name] = table.split(".");
  const cols = await sql`SELECT column_name FROM information_schema.columns
                          WHERE table_schema = ${schema} AND table_name = ${name}
                            AND column_name LIKE '%\\_sen' ORDER BY ordinal_position`;
  return cols.map((c) => c.column_name);
}

/** The minted piece SKUs of this company, filled once by main() and read by both
 *  the parent path and the downstream one so neither can target a code the other
 *  would refuse. */
let codeSet = new Set();

/** The piece SKUs this correction needs, fully qualified. Shared by the parent
 *  path and the downstream one so they cannot target different codes. */
function targetPieces(c, fallbackCode) {
  const model = K(c.model || modelOf(fallbackCode));
  return { model, want: c.pieces.map((p) => (K(p).startsWith(model + "-") ? K(p) : `${model}-${K(p)}`)) };
}

/**
 * Bring ONE downstream document to the shape of the build.
 *
 * Everything here is a refusal or a copy. It decides no code, no price and no
 * quantity: the codes come from the correction, the money is zero on every
 * added piece by construction, and every other column is cloned off the row the
 * document already holds for this build.
 */
async function applyDownstreamDoc(doc, kind, c, verify) {
  const spec = DOWNSTREAM[kind];
  const none = { touched: false, keep: 0, add: 0, refused: false };
  const refuse = (why) => { log(`  ${doc}: REFUSED — ${why}`); return { ...none, refused: true }; };

  const [head] = await spec.head(doc);
  if (!head) { log(`  ${doc}: the ERP holds no such ${spec.what} — skipped`); return none; }

  /* 「库存先不看」, checked three ways before anything is written. */
  if (head.migrated !== true)
    return refuse(`this ${spec.what} is NOT migrated paperwork — it is somebody's own statement about goods that moved, and re-shaping it is not this script's to do`);
  const [{ n: moves }] = await sql`SELECT COUNT(*)::int n FROM scm.inventory_movements WHERE company_id = ${CO} AND source_doc_no = ${doc}`;
  if (moves) return refuse(`${moves} inventory movement(s) name ${doc} — real stock moved under the old code and re-labelling it is not a paperwork fix`);
  const strange = await unknownDownstreamTriggers();
  if (strange.length) return refuse(`a trigger this script has not been shown guards the downstream tables: ${strange.join(", ")}. An INSERT could reach an inventory path, and 「库存先不看」 makes that a stop rather than a risk`);

  const all = await spec.rows(head.id);
  const pick = (c.desc2Match || c.desc2Exclude || (Array.isArray(c.lineKeys) && c.lineKeys.length))
    ? selectBuildRows(all, c.desc2Match, undefined, { lineKeys: c.lineKeys, exclude: c.desc2Exclude })
    : { rows: all, verdict: "all", how: "the whole document" };
  if (pick.verdict === "ambiguous" || pick.verdict === "exclusion-missing")
    return refuse(`${pick.how || "the needle reaches more than one build on this document"} — writing this build without telling them apart would put it on both`);
  if (!pick.rows.length) { log(`  ${doc}: the build is not on this ${spec.what} — skipped`); return none; }

  const { want } = targetPieces(c, pick.rows[0].code);
  const missing = want.filter((w) => !codeSet.has(w));
  if (missing.length) return refuse(`piece SKU not minted: ${missing.join(", ")}`);

  const plan = planDownstreamParity(pick.rows, want);
  if (!plan.ok) return refuse(plan.why);

  const money = await moneyColumns(spec.table);
  if (!money.length) return refuse(`${spec.table} exposes no *_sen column, so "the money does not move" cannot be asserted on it`);

  log(`  ${doc}  [${c.source}]  ${spec.what}  ${pick.rows.map((r) => compartmentOf(r.code)).join("+") || "(no compartment)"}  ->  ${c.pieces.join("+")}   ${plan.how}`);
  for (const k of plan.keep) log(`      ${K(k.from) === K(k.to) ? "keep  " : "change"} ${compartmentOf(k.from) || k.from} -> ${compartmentOf(k.to)}`);
  for (const a of plan.add) log(`      add    ${compartmentOf(a.to)}  (cloned from this document's own row, zero in ${money.length} money column(s))`);

  const before = await sumMoney(sql, spec.table, pick.rows.map((r) => r.id), money);
  log(`      money now: ${money.map((m) => `${m}=${before[m]}`).join(" ")} — every added piece is 0 in all of them`);
  verify.push({ doc, kind, headId: head.id, needle: c.desc2Match, lineKeys: c.lineKeys, exclude: c.desc2Exclude,
    want, copies: 1, source: c.source, money: before, moneyCols: money });

  if (!APPLY) return { touched: true, keep: plan.keep.length, add: plan.add.length, refused: false };

  const seat = seatHeightToWrite(c.seat);
  const linkNotes = [];

  /* ── EVERY READ THIS WRITE NEEDS HAPPENS BEFORE THE TRANSACTION OPENS ──────
     `newSql()` builds the pool with `max: 1`, so the single connection is HELD
     for the whole of `sql.begin`. A helper that reaches for the module-level
     `sql` from inside that block waits for a connection the block itself is
     holding, and the process hangs — not an error, not a rollback, a stopped
     job. Measured: prod apply run 34320397321 sat in `node
     scripts/apply-sofa-compartment-corrections.mjs` with no further output and
     was cancelled; nothing was written, because the transaction never
     committed. So the label column and every parent link are resolved HERE, and
     the block below touches `tx` only. docs/bugs/0749. */
  const label = await labelColumnName(spec.table);
  const names = new Map();
  for (const code of [...plan.keep.map((k) => k.to), ...plan.add.map((a) => a.to)]) {
    if (names.has(code)) continue;
    const [row] = await sql`SELECT name FROM scm.mfg_products WHERE company_id = ${CO} AND upper(code) = ${code} LIMIT 1`;
    names.set(code, row?.name ?? code);
  }
  /* THE LINK IS RESOLVED OR LEFT NULL — never guessed. */
  const links = new Map();
  if (plan.template?.parent_id) {
    for (const a of plan.add) {
      const hits = await spec.parentOf(plan.template.parent_id, a.to);
      if (hits.length === 1) links.set(a.to, hits[0].id);
      else {
        links.set(a.to, null);
        linkNotes.push(`${compartmentOf(a.to)}: ${hits.length} candidate parent line(s), so ${spec.link} is left unset rather than guessed`);
      }
    }
  }

  await sql.begin(async (tx) => {
    for (const k of plan.keep) {
      const src = pick.rows.find((r) => String(r.id) === String(k.id));
      const v = { ...(src?.variants ?? {}) };
      if (seat.write) v.seatHeight = seat.value;
      const name = names.get(k.to);
      await tx.unsafe(
        `UPDATE ${spec.table} SET item_code = $1, variants = $2::text::jsonb${label ? `, ${ident(label)} = $4` : ""} WHERE id = $3`,
        label ? [k.to, JSON.stringify(v), k.id, name] : [k.to, JSON.stringify(v), k.id]);
    }
    for (const a of plan.add) {
      const v = { ...(plan.template?.variants ?? {}) };
      if (seat.write) v.seatHeight = seat.value;
      const over = { item_code: a.to, variants: JSON.stringify(v) };
      for (const m of money) over[m] = 0;
      if (links.has(a.to)) over[spec.link] = links.get(a.to);
      if (label) over[label] = names.get(a.to);
      const lineNo = await nextLineNo(tx, spec, head.id);
      if (lineNo !== null) over.line_no = lineNo;
      await cloneRow(tx, spec.table, plan.template.id, over, ["variants"]);
    }
  });
  for (const n of linkNotes) log(`      NOTE ${n}`);

  const after = await sumMoney(sql, spec.table, null, money, { spec, headId: head.id, needle: c.desc2Match, lineKeys: c.lineKeys, exclude: c.desc2Exclude });
  const moved = money.filter((m) => Number(before[m] ?? 0) !== Number(after[m] ?? 0));
  if (moved.length) {
    console.error(`  ${doc}: MONEY MOVED on ${moved.map((m) => `${m} ${before[m]} -> ${after[m]}`).join(", ")}`);
    process.exit(1);
  }
  log(`      money unchanged on all ${money.length} column(s): ${money.map((m) => `${m}=${after[m]}`).join(" ")}`);
  return { touched: true, keep: plan.keep.length, add: plan.add.length, refused: false };
}

/** `material_name` on the receipt tables, `description` on the rest; null when
 *  the table carries neither. Read from the table, never assumed. */
async function labelColumnName(table) {
  const [schema, name] = table.split(".");
  const cols = await sql`SELECT column_name FROM information_schema.columns
                          WHERE table_schema = ${schema} AND table_name = ${name}
                            AND column_name IN ('material_name', 'description')`;
  const have = cols.map((c) => c.column_name);
  return have.includes("material_name") ? "material_name" : (have.includes("description") ? "description" : null);
}

/** The next free `line_no` on this document, or null where the table has none
 *  or holds none. A clone would otherwise repeat the template's own number and
 *  two rows would share a position. */
async function nextLineNo(tx, spec, headId) {
  const [schema, name] = spec.table.split(".");
  const [col] = await tx`SELECT column_name FROM information_schema.columns
                          WHERE table_schema = ${schema} AND table_name = ${name} AND column_name = 'line_no'`;
  if (!col) return null;
  const [row] = await tx.unsafe(
    `SELECT MAX(line_no) AS m FROM ${schema}.${ident(name)} WHERE ${ident(spec.owner)} = $1`, [headId]);
  return row?.m == null ? null : Number(row.m) + 1;
}

/** Every money column summed over a set of rows, or over the build if `where`
 *  is given — the same narrowing the writer used, so the two cannot disagree. */
async function sumMoney(conn, table, ids, cols, where = null) {
  const [schema, name] = table.split(".");
  let rowIds = ids;
  if (!rowIds) {
    const all = await where.spec.rows(where.headId, conn);
    const pick = (where.needle || where.exclude || (Array.isArray(where.lineKeys) && where.lineKeys.length))
      ? selectBuildRows(all, where.needle, undefined, { lineKeys: where.lineKeys, exclude: where.exclude })
      : { rows: all };
    rowIds = pick.rows.map((r) => r.id);
  }
  if (!rowIds.length) return Object.fromEntries(cols.map((c) => [c, 0]));
  const sums = cols.map((c) => `COALESCE(SUM(${ident(c)}), 0)::bigint AS ${ident(c)}`).join(", ");
  const [row] = await conn.unsafe(`SELECT ${sums} FROM ${schema}.${ident(name)} WHERE id = ANY($1)`, [rowIds]);
  return row;
}

async function main() {
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"} company=${CO}${ONLY ? ` DOC=${ONLY}` : ""}${FILE ? ` FILE~${FILE}` : ""}`);
  for (const f of DATA.files) log(`source: ${f}`);
  const prods = await sql`SELECT code FROM scm.mfg_products WHERE company_id = ${CO}`;
  codeSet = new Set(prods.map((p) => K(p.code)));

  let nBuilds = 0, nSofas = 0, nUpd = 0, nIns = 0, nDel = 0, nRefused = 0, nMissingSku = 0;
  let nDsDoc = 0, nDsKeep = 0, nDsAdd = 0, nDsRefused = 0;
  let nPo = 0, nGr = 0, nDo = 0, nAmbiguous = 0, nStock = 0, nNoSeat = 0;
  let nPi = 0, nSi = 0, nHeldInv = 0, nRel = 0;
  /** doc -> { isPo, needle, want, copies } — re-checked on a fresh connection. */
  const verify = [];

  for (const c of DATA.builds) {
    const docs = ONLY ? c.docs.filter((d) => d === ONLY) : c.docs;
    if (!docs.length) continue;

    for (const doc of docs) {
      const kind = kindOf(doc);
      if (DOWNSTREAM[kind]) {
        const r = await applyDownstreamDoc(doc, kind, c, verify);
        nDsDoc += r.touched ? 1 : 0;
        nDsKeep += r.keep; nDsAdd += r.add; nDsRefused += r.refused ? 1 : 0;
        continue;
      }
      const isPo = kind === "PO";
      /* Another session is renumbering the migrated POs so every number follows
         AutoCount (#1875), which stranded the po_numbers written into this data
         file. Resolve a PO by its number OR by the AutoCount document it links
         to - linked_ac_docno is the fact that survives a renumber. */
      let poId = null;
      if (isPo) {
        const ac = doc.replace(/^HC-/, "");
        let [hit] = await sql`SELECT id, po_number FROM scm.purchase_orders
          WHERE company_id = ${CO} AND (po_number = ${doc} OR linked_ac_docno = ${ac}) LIMIT 1`;
        /* Some of the numbers in this file were invented by the SO-linked PO
           import (HC-PO- plus its own running sequence) and no longer exist:
           the migrated POs have been renumbered so every number follows
           AutoCount. Neither the number nor the AutoCount link can find those.
           The AutoCount TEXT can - it is the same build either way, so fall
           back to the Desc2 this correction already carries. */
        if (!hit && c.desc2Match) {
          const [byText] = await sql`SELECT p.id, p.po_number FROM scm.purchase_orders p
            JOIN scm.purchase_order_items i ON i.purchase_order_id = p.id
           WHERE p.company_id = ${CO} AND i.item_group = 'sofa'
             AND i.description2 LIKE ${"%" + c.desc2Match + "%"}
           GROUP BY p.id, p.po_number LIMIT 2`;
          if (byText) { hit = byText; log(`  ${doc}: found as ${byText.po_number} by its AutoCount text`); }
        }
        if (!hit) { log(`  ${doc}: not in the ERP by number, by AutoCount link, or by its text — skipped`); continue; }
        poId = hit.id;
        if (hit.po_number !== doc && !String(hit.po_number).includes(ac)) { /* already reported above */ }
        else if (hit.po_number !== doc) log(`  ${doc}: found as ${hit.po_number} via linked_ac_docno`);
      }
      let rows = isPo
        ? await sql`SELECT i.id, i.item_code AS code, i.qty, i.unit_price_sen, i.line_total_sen AS total,
                           i.variants, i.description2, i.received_qty, i.so_item_id, i.linked_ac_dtlkey
                      FROM scm.purchase_order_items i
                     WHERE i.purchase_order_id = ${poId} AND i.item_group = 'sofa'
                     ORDER BY i.id`
        : await sql`SELECT i.id, i.item_code AS code, i.qty, i.unit_price_sen, i.total_sen AS total,
                           i.variants, i.description2, i.line_no, i.linked_ac_dtlkey
                      FROM scm.mfg_sales_order_items i
                      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
                     WHERE h.company_id = ${CO} AND i.doc_no = ${doc} AND i.item_group = 'sofa'
                     ORDER BY i.line_no`;
      /* A DOCUMENT can hold more than one sofa build. Narrow to the build this
         correction is about by its AutoCount text, or a second, perfectly good
         build looks like surplus and the script tries to delete it. Caught on
         HC-SO-011957, which holds a 1R+1NA+1R sofa AND a Stool. */
      /* The narrowing itself lives in scripts/lib/sofa-desc2-match.mjs, with
         its own test, because a plain `includes` here silently dropped seven
         owner-approved builds on 2026-09-02 (run 33657082664): the data file
         writes a line break as the two characters backslash-n and prod holds a
         real newline, so identical text did not compare equal. Read that
         module before widening anything further — and note that it REFUSES an
         ambiguous match rather than picking, which is the only reason a looser
         needle is safe on a document that holds two builds. */
      /* `lineKeys` — the account book's own DtlKey per line — DECIDES when it is
         given, because text cannot always tell two builds apart. HC-SO-012827's
         single chair carries a Desc2 that is a SUBSTRING of the three-seater's
         on the same document, so every possible needle reaches both and is
         refused as ambiguous, correctly. The key is identity; see the mode's
         reasoning and its tests in scripts/lib/sofa-desc2-match.mjs.

         `desc2Exclude` is the LAST resort, under the key, for a build whose
         rows are NOT keyed and whose text is a strict SUFFIX of its
         neighbour's. HC-SO-012025 is both at once: the book states the same
         text twice, once with a leading space and once without, and only the
         two LEAD rows carry a DtlKey — a correction that adds compartments
         inserts them with none. Rows carrying the exclusion are not this
         build. */
      if (c.desc2Match || c.desc2Exclude || (Array.isArray(c.lineKeys) && c.lineKeys.length)) {
        const pick = selectBuildRows(rows, c.desc2Match, undefined, { lineKeys: c.lineKeys, exclude: c.desc2Exclude });
        if (pick.verdict === "linekey")
          log(`  ${doc}: ${pick.how} — the two builds on this document cannot be told apart by their text`);
        if (pick.verdict === "exclusion-missing") {
          log(`  ${doc}: REFUSED — ${pick.how}. Writing this build without it would put it on BOTH sofas.`);
          nAmbiguous++; continue;
        }
        if (pick.verdict === "ambiguous") {
          log(`  ${doc}: REFUSED — "${c.desc2Match}" reaches ${pick.texts.length} DIFFERENT builds on this document, and telling them apart is the whole job of desc2Match: ${pick.texts.map((t) => JSON.stringify(t.slice(0, 56))).join("  vs  ")}`);
          nAmbiguous++; continue;
        }
        if (!pick.rows.length) {
          log(`  ${doc}: no line matches ${pick.verdict === "none" && Array.isArray(c.lineKeys) && c.lineKeys.length ? `line key(s) ${c.lineKeys.join(", ")}` : `"${c.desc2Match}"`}${c.desc2Exclude ? ` once ${JSON.stringify(c.desc2Exclude)} is excluded` : ""} (${pick.how}) — skipped, the build is not on this document`);
          continue;
        }
        if (pick.verdict === "normalised")
          log(`  ${doc}: ${pick.how} — the corrections file writes the line break as \\n, the document holds a real one`);
        if (pick.rows.length !== rows.length)
          log(`  ${doc}: ${rows.length} sofa lines on the document, ${pick.rows.length} belong to this build`);
        rows.length = 0; rows.push(...pick.rows);
      }
      if (!rows.length) {
        /* Say WHY, so a missing build is diagnosable instead of a shrug: does
           the document exist at all, and what groups are its lines in? */
        const probe = isPo
          ? await sql`SELECT i.item_group g, COUNT(*)::int n FROM scm.purchase_order_items i
                       WHERE i.purchase_order_id = ${poId} GROUP BY 1`
          : await sql`SELECT i.item_group g, COUNT(*)::int n FROM scm.mfg_sales_order_items i
                       WHERE i.company_id = ${CO} AND i.doc_no = ${doc} GROUP BY 1`;
        log(`  ${doc}: no sofa lines — ${probe.length ? probe.map((x) => `${x.g}:${x.n}`).join(", ") : "the document itself is not in the ERP"}`);
        continue;
      }

      const { model, want } = targetPieces(c, rows[0].code);
      const missing = want.filter((w) => !codeSet.has(w));
      if (missing.length) {
        log(`  ${doc}: REFUSED — piece SKU not minted: ${missing.join(", ")}`);
        nMissingSku++; continue;
      }

      /* TWO IDENTICAL LINES ARE TWO SOFAS. Split before pairing. */
      const split = splitBuildCopies(rows, want);
      if (!split.ok) { log(`  ${doc}: REFUSED — ${split.why}`); nRefused++; continue; }

      /* Nothing downstream may have moved real stock under the old code. */
      const down = await downstreamMovedStock(doc, isPo, rows.map((r) => r.id));
      if (down.reasons.length) {
        log(`  ${doc}: REFUSED — ${down.reasons.join("; ")}`);
        nStock++; continue;
      }

      const seat = seatHeightToWrite(c.seat);
      if (c.seat && !seat.write) { log(`  ${doc}: ${seat.why}`); nNoSeat++; }

      /* Plan every sofa of this build before writing any of it: one bad sofa
         refuses the whole build rather than half-applying it. */
      const sofas = [];
      let bad = null;
      for (const copyRows of split.copies) {
        const money = planCopyMoney(copyRows);
        if (!money.ok) { bad = money.why; break; }
        const { pairs, surplus } = pairRowsToPieces(copyRows, want);

        /* ── A COLLAPSE MAY RELEASE A DEDICATION, AND ONLY A DEDICATION ──────
           A build that goes from several rows to ONE leaves the dropped rows'
           purchase dedications pointing at rows that are about to disappear,
           and the guard below refused the whole build for it. That is
           HC-SO-011099 and docs/bugs/0719: his answer was never in doubt, our
           way of writing it was stuck, and writing only the purchase half —
           which DOES succeed — would have left the factory's document saying
           `2S` while the customer's still said `1A(LHF)+1A(RHF)`.

           The fix 0719 asks for is that the dedication be dealt with as part of
           the collapse. It is RELEASED (`so_item_id = NULL`), never re-pointed
           onto the surviving row: the dedication is one sales line to one
           purchase line, and pointing a second purchase line at the surviving
           row would read as two incoming units of one ordered piece — the same
           reason an inserted PO line never copies `so_item_id`. The released
           line is then surplus on the purchase side and the PO half of this
           same entry deletes it, which is why the conditions below refuse
           unless that half exists and can run.

           FIVE CONDITIONS, ALL OF THEM REFUSALS:
             1. sales-order side only — a GRN hanging off a PO line is goods,
                not paperwork, and is not this script's to move;
             2. the build collapses to ONE piece, so "which surviving row did
                this purchase line mean" has exactly one answer and needs no
                guess;
             3. the surplus row has NO delivery-order line — something already
                shipped against it, and 「已经出货了的就随便把」 says leave those
                alone rather than re-file them;
             4. every purchase line being released is itself free of goods
                receipts, so the PO half can really delete it;
             5. this entry NAMES the purchase order, so the half that cleans it
                up is going to run. Without that the release would leave an
                unbound purchase line stating the old build — worse than the
                refusal it replaced. */
        const releases = [];
        const blockers = [];
        for (const r of surplus) {
          if (isPo) {
            const [{ n }] = await sql`SELECT COUNT(*)::int n FROM scm.grn_items WHERE purchase_order_item_id = ${r.id}`;
            if (n) blockers.push(`${r.code}: ${n} GRN line(s)`);
            continue;
          }
          const poLines = await sql`SELECT i.id, i.item_code, p.po_number
                                      FROM scm.purchase_order_items i
                                      JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
                                     WHERE i.so_item_id = ${r.id}`;
          const [{ n: nDo }] = await sql`SELECT COUNT(*)::int n FROM scm.delivery_order_items WHERE so_item_id = ${r.id}`;
          if (!poLines.length && !nDo) continue;
          if (nDo) { blockers.push(`${r.code}: ${poLines.length} PO line(s), ${nDo} DO line(s) — something shipped against it`); continue; }
          if (pairs.length !== 1) {
            blockers.push(`${r.code}: ${poLines.length} PO line(s), and this build keeps ${pairs.length} pieces — which one the purchase line meant is not written down anywhere`);
            continue;
          }
          const poDocs = new Set(c.docs.filter((d) => /^HC-PO-/.test(d)));
          const notNamed = poLines.filter((x) => !poDocs.has(x.po_number) && !poDocs.has(`HC-${String(x.po_number).replace(/^HC-/, "")}`));
          if (notNamed.length) {
            blockers.push(`${r.code}: ${notNamed.map((x) => x.po_number).join(", ")} holds a line dedicated to it and this correction does not name that purchase order, so nothing would clean the line up`);
            continue;
          }
          let received = null;
          for (const x of poLines) {
            const [{ n }] = await sql`SELECT COUNT(*)::int n FROM scm.grn_items WHERE purchase_order_item_id = ${x.id}`;
            if (n) { received = `${x.po_number} ${x.item_code}: ${n} GRN line(s)`; break; }
          }
          if (received) { blockers.push(`${r.code}: the purchase line dedicated to it has received goods — ${received}`); continue; }
          releases.push({ soItemId: r.id, from: r.code, poLines });
        }
        if (blockers.length) { bad = `a surplus line is referenced downstream: ${blockers.join("; ")}`; break; }

        const plan = [];
        pairs.forEach((p, idx) => {
          const first = idx === 0;
          const v = { ...(p.row?.variants ?? {}) };
          if (seat.write) v.seatHeight = seat.value;
          if (c.colour && !v.colourLabel) v.colourLabel = c.colour;
          /* NOTHING IS RECOMPUTED: the lead keeps its own numbers, the rest 0. */
          const price = first ? money.price : 0;
          const tot = first ? money.total : 0;
          /* Each piece keeps its own qty — an existing row's, or the row an
             inserted piece is copied from. `charged` below multiplies by THAT,
             so a first piece whose qty differs from the lead's is caught by the
             assertion instead of quietly repricing the line. */
          const qty = Number((p.row ?? copyRows[0]).qty ?? 1) || 1;
          if (p.row) plan.push({ op: "update", id: p.row.id, from: p.row.code, to: p.want, price, tot, qty, v });
          else plan.push({ op: "insert", to: p.want, price, tot, qty, v, from: null });
        });
        /* The release goes in FRONT of the delete it exists for: same
           transaction, and the row cannot be cut from under a live pointer. */
        for (const rel of releases)
          plan.push({ op: "release", id: rel.soItemId, from: rel.from, poLines: rel.poLines });
        for (const r of surplus) plan.push({ op: "delete", id: r.id, from: r.code });

        /* The assertion, restated on the plan itself rather than on intent.
           Only the ops that LEAVE A PRICED ROW count — a delete removes one and
           a release touches no money column at all. Naming them positively
           rather than excluding `delete` is deliberate: the previous spelling
           would have summed `undefined` the moment a new op appeared and turned
           the whole assertion into NaN, which compares false against everything
           and would have refused every build with a money message that is not
           about money. */
        const after = plan.filter((p) => p.op === "update" || p.op === "insert")
          .reduce((s, p) => ({ total: s.total + p.tot, charged: s.charged + p.price * p.qty }), { total: 0, charged: 0 });
        if (after.total !== money.before.total || after.charged !== money.before.charged) {
          bad = `money would move (total ${money.before.total} -> ${after.total}, charged ${money.before.charged} -> ${after.charged})`;
          break;
        }
        sofas.push({ plan, src: copyRows[0], rows: copyRows });
      }
      if (bad) { log(`  ${doc}: REFUSED — ${bad}`); nRefused++; continue; }

      nBuilds++;
      nSofas += sofas.length;
      const before = moneyOfRows(rows);
      log(`  ${doc}  [${c.source}]  ${model}  ${rows.map((r) => compartmentOf(r.code)).join("+")}  ->  ${sofas.length > 1 ? `${sofas.length} x ` : ""}${c.pieces.join("+")}${seat.write ? `  @${seat.value}"` : ""}   money total ${before.total}, charged ${before.charged}${down.grns + down.dos ? `   downstream: ${down.grns} GRN, ${down.dos} DO (all migrated paperwork)` : ""}`);
      if (sofas.length > 1) log(`      ${split.how}`);
      for (const s of sofas) {
        if (sofas.length > 1) log(`      -- sofa ${sofas.indexOf(s) + 1} of ${sofas.length}`);
        for (const p of s.plan) {
          if (p.op === "update" && K(p.from) === K(p.to)) { log(`      keep   ${compartmentOf(p.to)}${seat.write ? ` (seat ${seat.value})` : ""}`); nUpd++; }
          else if (p.op === "update") { log(`      change ${compartmentOf(p.from)} -> ${compartmentOf(p.to)}`); nUpd++; }
          else if (p.op === "insert") { log(`      add    ${compartmentOf(p.to)}`); nIns++; }
          else if (p.op === "release") {
            log(`      release ${compartmentOf(p.from)} — ${p.poLines.map((x) => `${x.po_number} ${x.item_code}`).join(", ")} stops being dedicated to a row this collapse removes; the PO half of this entry deletes it`);
            nRel += p.poLines.length;
          }
          else { log(`      remove ${compartmentOf(p.from)}`); nDel++; }
        }
      }
      /* THE WHOLE ADDRESS TRAVELS WITH THE BUILD, not half of it. The verifier
         re-reads the WHOLE document and narrows to this build the same way the
         writer did; anything left behind here makes it compare one build's
         target against BOTH builds' rows and both builds' money. Measured
         twice, on the same defect at two different addressing modes: prod APPLY
         run 34245004498 wrote HC-SO-012025 correctly and completely - the
         document came out holding 1A(LHF)+1NA+CNR+1A(RHF) and a separate 1S,
         exactly the two sofas the owner ruled - and the check still reported
         `pieces are [1A(LHF) | 1A(RHF) | 1NA | 1S | CNR], expected [1S]` and
         failed the job, because `desc2Exclude` was not on the verify item. A
         verifier that narrows differently from the writer is not verifying the
         write; it is asking a different question. */
      verify.push({ doc, isPo, poId, needle: c.desc2Match, lineKeys: c.lineKeys, exclude: c.desc2Exclude, want, copies: sofas.length, money: before, source: c.source });

      if (!APPLY) continue;
      const touched = [];
      for (const s of sofas) {
        await sql.begin(async (tx) => {
          for (const p of s.plan) {
            if (p.op === "release") {
              /* Released, not re-pointed — see the plan-side note. The row it
                 pointed at is deleted two statements later, in THIS
                 transaction, so the pointer is never dangling and never
                 doubled. */
              await tx`UPDATE scm.purchase_order_items SET so_item_id = NULL WHERE so_item_id = ${p.id}`;
              continue;
            }
            if (p.op === "delete") {
              if (isPo) await tx`DELETE FROM scm.purchase_order_items WHERE id = ${p.id}`;
              else await tx`DELETE FROM scm.mfg_sales_order_items WHERE id = ${p.id}`;
              continue;
            }
            const name = (await tx`SELECT name FROM scm.mfg_products WHERE company_id = ${CO} AND upper(code) = ${p.to} LIMIT 1`)[0]?.name ?? p.to;
            if (p.op === "update") {
              if (isPo) await tx`UPDATE scm.purchase_order_items SET item_code = ${p.to}, material_name = ${name},
                                   unit_price_sen = ${p.price}, line_total_sen = ${p.tot}, variants = ${tx.json(p.v)} WHERE id = ${p.id}`;
              else await tx`UPDATE scm.mfg_sales_order_items SET item_code = ${p.to}, description = ${name},
                              unit_price_sen = ${p.price}, total_sen = ${p.tot}, balance_sen = ${p.tot},
                              variants = ${tx.json(p.v)} WHERE id = ${p.id}`;
              touched.push({ id: p.id, code: p.to, v: p.v });
            } else {
              const src = s.src;
              /* `description` and `delivery_date` are COPIED from the piece
                 this one is built from, for the same reason `description2` and
                 `warehouse_id` are. They were omitted, so every compartment
                 this script ever added carries NULL in both while the book
                 states a value on the line — the reconcile reads them as
                 "blank in the ERP where the book states one", and it reads them
                 on the SO side as filled because the SO branch below has always
                 set `description`. Both are the SAME book line's values; the
                 lead already holds them; copying is a copy, not a guess. */
              /* `linked_ac_dtlkey` IS THE BUILD'S IDENTITY, and it was omitted
                 here for the same reason `warehouse_id` and `description` were:
                 a column-by-column INSERT that does not name it. A sofa build is
                 ONE AutoCount line and one ERP row per compartment, and
                 src/scm/lib/autocount-line-keys.ts:155 states the invariant —
                 "Every ERP row behind this AutoCount line gets the SAME key ...
                 composeEdit later accepts the build only when all of them still
                 agree on it". A compartment added keyless therefore does not
                 just lack a key: it takes the WHOLE document's line identity
                 away, and the operator's next edit is refused with "The ERP
                 cannot tell which lines AutoCount already has"
                 (autocount-relink-lines.ts:8). The reconcile compares
                 compartments per DtlKey too, so a keyless one is invisible to
                 it — HC-SO-013475 held 1A(LHF)+1NA+1A(RHF) and reconcile run
                 34199937397 read it as "1A(LHF)+1A(RHF)". Copying the source
                 row's key is a copy of what the sibling already states, never a
                 guess; repair-sofa-added-compartment-line-key.mjs is the same
                 write for the rows earlier rounds already added. */
              if (isPo) await tx`INSERT INTO scm.purchase_order_items
                  (purchase_order_id, material_kind, item_code, material_name, item_group, description, description2,
                   qty, received_qty, unit_price_sen, line_total_sen, variants, warehouse_id, delivery_date, from_mrp, company_id,
                   linked_ac_dtlkey)
                  SELECT i.purchase_order_id, 'mfg_product', ${p.to}, ${name}, 'sofa', i.description, ${src.description2 ?? null},
                         i.qty, 0, ${p.price}, ${p.tot}, ${tx.json(p.v)}, i.warehouse_id, i.delivery_date, false, ${CO},
                         i.linked_ac_dtlkey
                    FROM scm.purchase_order_items i WHERE i.id = ${src.id}`;
              /* so_item_id is deliberately NOT copied onto an inserted PO line.
                 The dedication is one SO line to one PO line, and pointing a
                 second PO line at the same SO line would read as two incoming
                 units of one ordered piece. An added compartment has no SO line
                 of its own until the SO half of the same build is corrected. */
              /* warehouse_id IS NOT OPTIONAL HERE, and its absence is silent.
                 Stock allocation buckets by (warehouse, item, variant), so a line
                 that lands NULL can never match stock: it stays PENDING forever,
                 shows no incoming PO, and reads as "the system did not capture
                 it" even when the goods were received into the right bucket. The
                 PO branch above already copies `i.warehouse_id`; this branch
                 omitted the column entirely, and the 2026-08-11 run produced
                 seven such lines across six orders (repaired 2026-08-18). */
              /* `linked_ac_dtlkey` — see the note on the PO branch above. Same
                 omission, same consequence, same fix: the compartment belongs to
                 the SAME AutoCount line its source row does. */
              else await tx`INSERT INTO scm.mfg_sales_order_items
                  (doc_no, line_no, item_group, item_code, description, description2, uom, location, qty,
                   unit_price_sen, total_sen, balance_sen, company_id, variants, remark, photo_urls,
                   warehouse_id, linked_ac_dtlkey)
                  SELECT i.doc_no, (SELECT COALESCE(MAX(line_no),0)+1 FROM scm.mfg_sales_order_items WHERE doc_no = i.doc_no),
                         'sofa', ${p.to}, ${name}, i.description2, i.uom, i.location, i.qty,
                         ${p.price}, ${p.tot}, ${p.tot}, ${CO}, ${tx.json(p.v)},
                         'compartment corrected 2026-09-04', i.photo_urls,
                         i.warehouse_id, i.linked_ac_dtlkey
                    FROM scm.mfg_sales_order_items i WHERE i.id = ${src.id}`;
            }
          }
        });
      }

      /* Carry it down the chain. A PO line copies the SO line it is dedicated
         to; a GRN line copies the PO line it received; a DO line copies the SO
         line it delivered. All three took a SNAPSHOT of the code and variants
         when they were created (create-migrated-documents.mjs), so correcting
         the parent alone would leave them stating the old build. These
         documents carry migrated_no_stock — asserted above, not assumed — so
         this is paperwork only: no movement is written or implied. */
      for (const t of touched) {
        if (isPo) {
          const g = await sql`UPDATE scm.grn_items
            SET item_code = ${t.code}, variants = ${sql.json(t.v)}
            WHERE purchase_order_item_id = ${t.id} RETURNING id`;
          if (g.length) { nGr += g.length; log(`      -> ${g.length} GRN line(s) follow ${compartmentOf(t.code)}`); }
          const pi = await carryToPurchaseInvoice(g.map((r) => r.id), t);
          nPi += pi.moved;
          if (pi.moved) log(`      -> ${pi.moved} purchase invoice line(s) follow ${compartmentOf(t.code)}`);
          for (const n of pi.held) { nHeldInv++; log(`      HELD ${n} is not migrated paperwork — its item code is left as billed`); }
        } else {
          const po = await sql`UPDATE scm.purchase_order_items
            SET item_code = ${t.code}, variants = ${sql.json(t.v)}
            WHERE so_item_id = ${t.id} RETURNING id`;
          if (po.length) {
            nPo += po.length;
            log(`      -> ${po.length} PO line(s) follow ${compartmentOf(t.code)}`);
            for (const r of po) {
              const g = await sql`UPDATE scm.grn_items
                SET item_code = ${t.code}, variants = ${sql.json(t.v)}
                WHERE purchase_order_item_id = ${r.id} RETURNING id`;
              nGr += g.length;
              const pi = await carryToPurchaseInvoice(g.map((x) => x.id), t);
              nPi += pi.moved;
              for (const n of pi.held) { nHeldInv++; log(`      HELD ${n} is not migrated paperwork — its item code is left as billed`); }
            }
          }
          const d = await sql`UPDATE scm.delivery_order_items
            SET item_code = ${t.code}, variants = ${sql.json(t.v)}
            WHERE so_item_id = ${t.id} RETURNING id`;
          if (d.length) { nDo += d.length; log(`      -> ${d.length} DO line(s) follow ${compartmentOf(t.code)}`); }
          const si = await carryToSalesInvoice(d.map((r) => r.id), t);
          nSi += si.moved;
          if (si.moved) log(`      -> ${si.moved} sales invoice line(s) follow ${compartmentOf(t.code)}`);
          for (const n of si.held) { nHeldInv++; log(`      HELD ${n} is not migrated paperwork — its item code is left as billed`); }
        }
      }
    }
  }

  log("");
  log(`builds touched ${nBuilds} (${nSofas} sofa${nSofas === 1 ? "" : "s"}) · lines updated ${nUpd} · added ${nIns} · removed ${nDel}`);
  log(`downstream carried: PO lines ${nPo} · GRN lines ${nGr} · DO lines ${nDo}`);
  if (nRel) log(`purchase dedications RELEASED by a collapse: ${nRel} (each one's line is deleted by the PO half of the same entry — docs/bugs/0719)`);
  log(`downstream carried onto the invoices raised from them: purchase invoice lines ${nPi} · sales invoice lines ${nSi}${nHeldInv ? ` · ${nHeldInv} invoice(s) HELD because they are not migrated paperwork` : ""}`);
  log(`downstream documents NAMED by an entry and brought to the build's own shape: ${nDsDoc} document(s) · ${nDsKeep} row(s) already stood for a piece · ${nDsAdd} row(s) added · ${nDsRefused} refused`);
  log(`refused ${nRefused} (downstream reference, unreadable copies, or the money would move) · piece SKU not minted ${nMissingSku} · refused as ambiguous ${nAmbiguous} · refused for real stock movement ${nStock} · seat not written ${nNoSeat}`);
  /* `heldWhy` is the reason it is held; `why` is the owner's answer. The log
     printed only the answer, so a held build read as a build nobody had read —
     the opposite of the truth for every entry in the list. Both, always. */
  for (const h of DATA.held) log(`HELD ${h.docs.join(" / ")} [${h.source}] — ${h.why}${h.heldWhy ? `  ||  HELD BECAUSE: ${h.heldWhy}` : ""}`);
  await sql.end();

  if (!APPLY) { log("\nDRY-RUN — set APPLY=1 to write."); return; }
  await verifyOnFreshConnection(verify);
}

/**
 * Read every corrected document back on a NEW connection and assert the piece
 * MULTISET — not a row count, which is the check that passed while the pieces
 * were wrong.
 *
 * A LATER ENTRY SUPERSEDES AN EARLIER ONE WHERE THEY TOUCH THE SAME ROWS, and
 * only the survivor is asserted. `CORRECTION_FILES` is ordered oldest first on
 * purpose, so two files may rule on one build and the newer ruling is the
 * answer — `lib/sofa-rulings.mjs` already states that for the LOOKUP path with
 * `findLast` (docs/bugs/0722). This verify never learned it: it kept one
 * expectation per ENTRY and asserted every one of them, including the entry the
 * next file had just overruled.
 *
 * Measured, run 34301924900: `HC-SO-012929` was written correctly and reported
 *   FAIL HC-SO-012929: pieces are [9028-1A(LHF) | 9028-2A(RHF)],
 *                   expected [9028-1A(LHF) | 9028-1S | 9028-2A(RHF)]
 * — the 2026-08 entry's target, three lines above the 2026-09 entry's own OK on
 * the same document. 167 documents were right, and the run still exited 1.
 *
 * SUPERSEDING IS DECIDED ON ROW IDS, not on the selector text. The two entries
 * carry DIFFERENT `desc2Match` strings ("...Barley/Bottom wr" vs "...Barley"),
 * so any key built from the selector would have called them separate builds and
 * changed nothing. What makes them one build is that they select the same rows,
 * which is a fact of the document rather than of the file.
 */
async function verifyOnFreshConnection(items) {
  if (!items.length) return;
  const v = newSql();
  /* A downstream document is keyed by its own kind and header id. It has no
     `poId` and it is not a sales order, so the two-way key would have collapsed
     a receipt and a delivery note onto the same bucket the moment their numbers
     matched. */
  const docKey = (it) => (it.kind ? `${it.kind}:${it.headId}` : it.isPo ? `PO:${it.poId}` : `SO:${it.doc}`);
  const nDocs = new Set(items.map(docKey)).size;
  log(`\nVERIFY — re-reading ${nDocs} document(s) on a fresh connection`);

  /* One read per DOCUMENT, not per entry: the row set is what decides
     superseding, so every entry on a document has to be measured against the
     same read. */
  const rowsOf = new Map();
  for (const it of items) {
    const k = docKey(it);
    if (rowsOf.has(k)) continue;
    if (it.kind) { rowsOf.set(k, await DOWNSTREAM[it.kind].rows(it.headId, v)); continue; }
    rowsOf.set(k, it.isPo
      ? await v`SELECT i.id, i.item_code AS code, i.qty, i.unit_price_sen, i.line_total_sen AS total, i.description2, i.linked_ac_dtlkey
                  FROM scm.purchase_order_items i
                 WHERE i.purchase_order_id = ${it.poId} AND i.item_group = 'sofa' ORDER BY i.id`
      : await v`SELECT i.id, i.item_code AS code, i.qty, i.unit_price_sen, i.total_sen AS total, i.description2, i.linked_ac_dtlkey
                  FROM scm.mfg_sales_order_items i
                  JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
                 WHERE h.company_id = ${CO} AND i.doc_no = ${it.doc} AND i.item_group = 'sofa' ORDER BY i.line_no`);
  }

  /* Narrow the SAME way the apply did, line keys and exclusion included —
     verifying against every sofa row on a document that holds two builds would
     compare this build's target against both builds' rows and fail a correct
     write. */
  const selected = items.map((it) => {
    const rows = rowsOf.get(docKey(it));
    const hasKeys = Array.isArray(it.lineKeys) && it.lineKeys.length;
    return (it.needle || hasKeys || it.exclude)
      ? selectBuildRows(rows, it.needle, undefined, { lineKeys: it.lineKeys, exclude: it.exclude }).rows
      : rows;
  });

  /* A LATER entry on the same document that selects any of the same rows has
     already rewritten them; this entry's target is the stale one. Reported,
     never silent — an expectation that stops being asserted must still be
     visible, or a build could quietly go unverified. */
  const overruledBy = supersededBy(items.map(docKey), selected.map((rs) => rs.map((r) => r.id)));

  let bad = 0, superseded = 0;
  for (let n = 0; n < items.length; n++) {
    const it = items[n];
    const mine = selected[n];
    const by = overruledBy[n];
    if (by >= 0) {
      superseded++;
      log(`  SUPERSEDED ${it.doc} [${it.source}] — the same rows are ruled again by [${items[by].source}]; that entry is the one asserted`);
      continue;
    }
    const want = [];
    for (let i = 0; i < it.copies; i++) want.push(...it.want);
    const bag = (xs) => xs.map(K).sort().join(" | ");
    const okPieces = bag(mine.map((r) => r.code)) === bag(want);

    /* A downstream document's money is asserted over EVERY `*_sen` column the
       table carries, not over two named ones. The receipt, the delivery note and
       the invoices do not agree on which column holds a line's total — a check
       on one of them passes vacuously where the other is the live column, which
       is the failure the parent path's own comment records for
       `line_total_sen`. Summing all of them cannot be vacuous. */
    if (it.kind) {
      const now = await sumMoney(v, DOWNSTREAM[it.kind].table, mine.map((r) => r.id), it.moneyCols);
      const moved = it.moneyCols.filter((m) => Number(it.money[m] ?? 0) !== Number(now[m] ?? 0));
      if (okPieces && !moved.length) {
        log(`  OK  ${it.doc}  ${mine.map((r) => compartmentOf(r.code)).join("+")}  money unchanged on ${it.moneyCols.length} column(s): ${it.moneyCols.map((m) => `${m}=${now[m]}`).join(" ")}`);
        continue;
      }
      bad++;
      if (!okPieces) log(`  FAIL ${it.doc}: pieces are [${bag(mine.map((r) => r.code))}], expected [${bag(want)}]`);
      for (const m of moved) log(`  FAIL ${it.doc}: ${m} ${it.money[m]} -> ${now[m]}`);
      continue;
    }

    const money = moneyOfRows(mine);
    const okMoney = money.total === it.money.total && money.charged === it.money.charged;
    if (okPieces && okMoney) { log(`  OK  ${it.doc}  ${mine.map((r) => compartmentOf(r.code)).join("+")}  money ${money.total}/${money.charged}`); continue; }
    bad++;
    if (!okPieces) log(`  FAIL ${it.doc}: pieces are [${bag(mine.map((r) => r.code))}], expected [${bag(want)}]`);
    if (!okMoney) log(`  FAIL ${it.doc}: money ${it.money.total}/${it.money.charged} -> ${money.total}/${money.charged}`);
  }
  await v.end();
  if (bad) { console.error(`VERIFY FAILED on ${bad} document(s)`); process.exit(1); }
  log(`VERIFY OK — ${items.length - superseded} entr${items.length - superseded === 1 ? "y" : "ies"} over ${nDocs} document(s), piece multiset and both money columns${superseded ? ` · ${superseded} superseded by a later ruling` : ""}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
