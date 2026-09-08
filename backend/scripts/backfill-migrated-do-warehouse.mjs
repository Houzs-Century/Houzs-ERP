#!/usr/bin/env node
/* Stamp the AutoCount delivery location onto the migrated Delivery Order HEADER.
   ---------------------------------------------------------------------------
   THE GAP. Every migrated delivery order was written by
   lib/migrated-do-writer.mjs, which names eleven header columns and NONE of the
   location ones. So `scm.delivery_orders.warehouse_id` and `sales_location` are
   both NULL across the whole migrated corpus: the ERP holds the delivery but
   cannot say which branch shipped it, while AutoCount has known all along.

   That is not cosmetic. `resolveDoLineWarehouses` (delivery-orders-mfg.ts:645)
   resolves a line's ship-from warehouse as (1) the linked SO line's warehouse,
   (2) THE DO HEADER'S warehouse, (3) the company default. A migrated line with
   no so_item_id — exactly the shape the substitution ruling introduces — falls
   through (2) to a company-blind default. Stock is not at risk on these
   documents (migrated_no_stock: they write no movements at all), but the
   DISPLAYED warehouse is wrong, and step (2) is the one meant to answer.

   HEADER, NOT PER LINE (owner ruling 2026-09-07, "记在单头就好"). Measured on
   data/ac-fidelity-do-*.json.gz before asking: the line's Location equals its
   header's SalesLocation on 46,182 of 46,194 non-blank book lines, and only
   2 of 11,134 documents span two locations (DO-000140 PG+HQ, DO-000153
   KL+SUNWAY — both named in the output below). A per-line column would carry
   46,194 values to express 11,134 facts.

   WHERE THE LOCATION COMES FROM, in order, never guessed:
     1. data/ac-fidelity-do-headers.json.gz — the book's own header field.
        Covers 11,134 documents.
     2. line Locations, and ONLY when every line of that document agrees — from
        data/ac-fidelity-do-lines.json.gz (the whole book, 11,134 documents),
        data/ac-partial-dos.json.gz (the cutover cut, 84), and — since
        2026-09-08 — data/ac-reconcile-truth.json.gz, whose line projection
        grew a `location` column. The header snapshot runs behind the book, so
        19 of the cut's 84 have no header row; all 19 are unanimous on their
        lines, and where BOTH sources exist they agree on 65 of 65.

        THE THIRD FEED IS WHY THIS RUN CAN ANSWER AT ALL. On 2026-09-08, 89 of
        171 migrated documents resolved to NOTHING because every one was a
        DO-0114xx/DO-0115xx raised after both older snapshots were taken. The
        fresh truth cut carries 163 documents in that range, all 163 unanimous,
        and ZERO of them appear in either fidelity file. It is a third feed into
        the SAME unanimity rule, not a new source: it reproduces the two known
        mixed documents (DO-000140 PG+HQ, DO-000153 KL+SUNWAY) exactly.
     3. nothing — the document is REPORTED and left alone. They are named, not
        defaulted; a snapshot refresh is what fills them.

   ONE RULE, NOT A SECOND COPY. The order above, the map and the resolution all
   live in lib/ac-do-location.mjs, shared with create-migrated-documents.mjs so
   a document stamped AS IT IS WRITTEN and one stamped LATER cannot land on
   different branches. That library uses the shared SALESLOC from
   lib/ac-stock-compare.mjs — the same map the PO importer's whId() uses — and
   resolves through lib/resolve-warehouse-location.mjs, the tested spec of
   migration 0309's backfill: CODE first, then NAME, company-scoped, and ONLY
   when the match is unambiguous. Its rule is pinned by
   backend/tests/acDoLocation.test.mjs.

   WHAT IT WILL NOT DO. It writes two columns on rows where `warehouse_id IS
   NULL`, and every UPDATE re-asserts that, so a value a person set is never
   overwritten. It touches no line, no quantity, no money, no status, and writes
   no inventory movement.

   MODE=plan (default) prints every proposed stamp and writes nothing.
   MODE=apply needs CONFIRM="I HAVE REVIEWED THE DRY-RUN".

   RE-RUN: inert. Keyed on warehouse_id IS NULL, which a successful write
   clears, so a second run finds nothing to do and reports the same unresolved
   documents. */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { mixedLocationDocs, resolveAcDeliveryLocation } from './lib/ac-do-location.mjs';
import { decodeSnapshot } from './lib/ac-scope.mjs';

const DSN = process.env.DATABASE_URL;
const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'I HAVE REVIEWED THE DRY-RUN';
const CO = Number(process.env.COMPANY_ID || 1);
const here = path.dirname(fileURLToPath(import.meta.url));

const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => { console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : m); process.exit(1); };
if (!DSN) bad('need DATABASE_URL');
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}" — run MODE=plan first and read it.`);
}
const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
const gz = (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(here, 'data', f))).toString('utf8').replace(/^﻿/, ''));

async function main() {
  note(`mode=${APPLY ? 'APPLY' : 'PLAN (writes nothing)'} company=${CO}`);

  /* Source 1 — the book's own header field. */
  const hdrLoc = new Map();
  for (const h of gz('ac-fidelity-do-headers.json.gz')) {
    const v = (h.SalesLocation || '').trim();
    if (v) hdrLoc.set(h.DocNo, v);
  }
  /* Source 2 — the document's own lines, ONLY when unanimous.
     BOTH line snapshots, and that is the point: `ac-partial-dos` holds the
     cutover cut (84 documents) while `ac-fidelity-do-lines` holds the whole
     book (11,134). Reading only the cut made the mixed-location census below
     report ZERO — a census over 84 documents answering a question asked about
     11,134 — and the owner's ruling explicitly asks for the mixed ones to be
     NAMED. A count computed over the wrong corpus reads exactly like a clean
     result, which is the failure this repo keeps paying for. */
  const lineLocs = new Map();
  const addLineLoc = (doc, raw) => {
    const v = (raw || '').trim();
    if (!v) return;
    if (!lineLocs.has(doc)) lineLocs.set(doc, new Set());
    lineLocs.get(doc).add(v);
  };
  for (const l of gz('ac-fidelity-do-lines.json.gz')) addLineLoc(l.DocNo, l.Location);
  for (const r of gz('ac-partial-dos.json.gz')) addLineLoc(r.DoNo, r.Location);
  /* THE THIRD LINE SNAPSHOT, and the reason the other two were not enough.
     Both files above are cuts that stopped moving: `ac-fidelity-do-lines` is
     the fidelity round's whole-book cut and `ac-partial-dos` is the cutover
     cut, and on 2026-09-08 EIGHTY-NINE of 171 migrated delivery orders — every
     one a DO-0114xx/DO-0115xx raised after both were taken — had no row in
     either, so the rule could not answer and named them rather than guessing.
     `ac-reconcile-truth.json.gz` is the cut that IS refreshed, and its line
     projection grew `location` on 2026-09-08 for exactly this.

     It is a THIRD FEED into the same unanimity rule, not a fourth source: it
     goes into `lineLocs` beside the other two, so a document whose lines
     disagree still disagrees and is still refused. `decodeSnapshot` reads the
     field by NAME, so a truth snapshot cut before the column existed yields
     null on every line and this loop adds nothing — the backfill then behaves
     exactly as it did before, which is what makes the addition safe to land
     ahead of a cut. */
  let fromTruth = 0;
  try {
    const truth = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(here, 'data', 'ac-reconcile-truth.json.gz'))).toString('utf8'));
    const book = decodeSnapshot(truth);
    for (const ls of book.DO.lines.values()) {
      for (const l of ls) if (l.location) { addLineLoc(l.docNo, l.location); fromTruth++; }
    }
    note(`ac-reconcile-truth.json.gz cut ${truth.exported_at}: ${fromTruth} DO line location(s) read`);
    if (!fromTruth) note('   that snapshot carries NO line location — it predates the column; re-cut export-ac-reconcile-truth.mjs');
  } catch (e) {
    note(`ac-reconcile-truth.json.gz unreadable (${e.message}) — falling back to the two fidelity cuts alone`);
  }
  note(`book: ${hdrLoc.size} document header(s), ${lineLocs.size} document(s) with line locations`);

  /* The documents the book itself cannot answer with ONE location. Named rather
     than quietly flattened onto their header value (owner ruling). */
  const mixed = mixedLocationDocs(lineLocs);
  note(`documents whose lines span TWO locations: ${mixed.length}`);
  for (const m of mixed) {
    note(`   MIXED ${m.doc}: lines say ${m.locations.join(' + ')}; header says ${hdrLoc.get(m.doc) ?? '(no header row)'} — the header wins, and it is recorded here that it was not unanimous`);
  }

  const warehouses = await sql`SELECT id, code, name FROM scm.warehouses WHERE company_id = ${CO}`;
  note(`warehouses in company ${CO}: ${warehouses.length}`);

  const rows = await sql`SELECT id, do_number, linked_ac_docno, warehouse_id, sales_location
      FROM scm.delivery_orders
     WHERE company_id = ${CO} AND linked_ac_docno IS NOT NULL`;
  const open = rows.filter((r) => r.warehouse_id === null);
  note(`migrated delivery orders: ${rows.length}; already carry a warehouse: ${rows.length - open.length}; to stamp: ${open.length}`);

  const plan = [];
  const unresolved = [];
  let viaHeader = 0;
  let viaLines = 0;
  for (const r of open) {
    const ac = r.linked_ac_docno;
    /* lib/ac-do-location.mjs is the ONE rule, shared with the create path, so
       a document stamped as it is written and one stamped later cannot land on
       different branches. */
    const hit = resolveAcDeliveryLocation(ac, hdrLoc, lineLocs, warehouses);
    if (!hit.warehouseId) { unresolved.push({ ...r, why: hit.why }); continue; }
    if (hit.source === 'header') viaHeader++; else viaLines++;
    plan.push({ id: r.id, doNumber: r.do_number, ac, loc: hit.bookLocation, erpCode: hit.salesLocation, warehouseId: hit.warehouseId, src: hit.source === 'header' ? "the book's header" : 'its own lines (unanimous)' });
  }

  note('');
  note(`── to stamp: ${plan.length} of ${open.length} (${viaHeader} from the book's header, ${viaLines} from unanimous lines)`);
  const byLoc = new Map();
  for (const p of plan) byLoc.set(p.erpCode, (byLoc.get(p.erpCode) ?? 0) + 1);
  for (const [code, n] of [...byLoc].sort((a, b) => b[1] - a[1])) note(`      ${code}: ${n} document(s)`);
  for (const p of plan.slice(0, 10)) note(`      ${p.doNumber} <- ${p.ac}: "${p.loc}" -> ${p.erpCode} (from ${p.src})`);
  note('');
  note(`── NOT stamped, and NAMED rather than defaulted: ${unresolved.length}`);
  for (const u of unresolved) note(`      ${u.do_number} <- ${u.linked_ac_docno}: ${u.why}`);

  if (!APPLY) {
    note(`\nPLAN ONLY: nothing written. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}".`);
    return;
  }

  let written = 0;
  for (const p of plan) {
    /* IS NULL re-asserted in the UPDATE, not only in the SELECT that built the
       plan: between plan and apply a person may have set the warehouse by hand,
       and their answer wins over this one. `sales_location` is written from the
       SAME map, so the text and the id can never tell a reader different
       things. */
    const res = await sql`
      UPDATE scm.delivery_orders
         SET warehouse_id = ${p.warehouseId}, sales_location = ${p.erpCode}
       WHERE id = ${p.id} AND warehouse_id IS NULL`;
    written += res.count;
  }
  note(`\nwrote ${written} header warehouse binding(s)`);

  /* ── INDEPENDENT READ-BACK ────────────────────────────────────────────────
     A fresh connection, and it asserts the SHAPE rather than a row count. Every
     document just stamped must now point at a warehouse that (a) exists,
     (b) belongs to THIS company — a cross-company warehouse on a delivery
     header is how stock reads as another branch's — and (c) whose code matches
     the sales_location text written beside it. And it re-asserts what this
     entire family of documents rests on: still ZERO inventory movements. */
  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  try {
    const ids = plan.map((p) => p.id);
    const [shape] = await check`
      SELECT COUNT(*)::int AS stamped,
             COUNT(*) FILTER (WHERE w.id IS NULL)::int                             AS dangling,
             COUNT(*) FILTER (WHERE w.company_id <> d.company_id)::int             AS wrong_company,
             COUNT(*) FILTER (WHERE w.code IS DISTINCT FROM d.sales_location)::int AS text_id_disagree,
             COUNT(*) FILTER (WHERE d.migrated_no_stock IS NOT TRUE)::int          AS not_migrated
        FROM scm.delivery_orders d
        LEFT JOIN scm.warehouses w ON w.id = d.warehouse_id
       WHERE d.id = ANY(${ids}) AND d.warehouse_id IS NOT NULL`;
    const [mv] = await check`
      SELECT COUNT(*)::int AS movements
        FROM scm.inventory_movements m
       WHERE m.source_doc_type = 'DO' AND m.source_doc_id = ANY(${ids})`;
    note(`verify (fresh connection): stamped ${shape.stamped}/${ids.length}`
      + ` · dangling ${shape.dangling} · wrong company ${shape.wrong_company}`
      + ` · text/id disagree ${shape.text_id_disagree} · not migrated_no_stock ${shape.not_migrated}`
      + ` · inventory movements on these documents ${mv.movements}`);
    if (shape.dangling || shape.wrong_company || shape.text_id_disagree) {
      bad('VERIFY FAILED: a header points at a missing warehouse, at another company’s warehouse, or disagrees with its own sales_location text. Investigate before trusting any warehouse reading.');
    }
    if (mv.movements > 0) {
      bad(`VERIFY FAILED: ${mv.movements} inventory movement(s) exist on these migrated documents. They must have NONE — the balance snapshot already counts these units as delivered.`);
    }
    if (shape.stamped !== ids.length) {
      bad(`VERIFY FAILED: expected ${ids.length} stamped, read back ${shape.stamped}.`);
    }
    note('verify OK — every stamped header names one existing warehouse of its own company, its sales_location text agrees with it, and no inventory moved.');
  } finally {
    await check.end({ timeout: 5 });
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => sql.end({ timeout: 5 }));
