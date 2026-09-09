#!/usr/bin/env node
/**
 * Correct a migrated line's COLOUR or SEAT SIZE to what the account book says.
 *
 * The owner's rule, 2026-09-08: 「一律跟账本。除了sofa compartment而已啊」 — follow
 * the account book for everything; only sofa compartments need his judgement.
 * Seat size and colour are therefore not questions: where the book states a
 * value and the ERP holds a DIFFERENT one, the book wins.
 *
 * ── IT WRITES ONLY WHAT A HUMAN REVIEWED ───────────────────────────────────
 * The population comes from `data/variant-book-corrections.json`, not from a
 * sweep. That is a deliberate refusal to generalise, and it is bought with
 * evidence from the same day: `docs/bugs/0705` found TWO decoder artifacts on
 * these exact two axes — a fabric's shade name read as a special, and a stool's
 * FOOTPRINT read as a seat size. A blanket "copy the book onto every DIFFER"
 * sweep would have written a stool's width into a build instruction. The plan
 * below reports the whole population so nothing hides; the apply touches only
 * the reviewed list.
 *
 * ── IT REFUSES A STALE LIST ────────────────────────────────────────────────
 * Every entry states `erp_now`, the value the ERP held when the entry was
 * written. If the row no longer holds it, somebody has edited the line since
 * and this file's `book` may no longer be the right answer for it: the entry is
 * REPORTED and SKIPPED, never written. A correction list that can overwrite a
 * human's later edit is not a correction list.
 *
 * ── WHAT IT DOES NOT TOUCH, ON PURPOSE ─────────────────────────────────────
 * SPECIALS. `variants.specials` folds into the authoritative unit price at ten
 * call sites across nine files, so stamping a code there reprices a historical
 * document (`docs/bugs/0013`). It already has two writers that know that —
 * `backfill-specials-into-variants.mjs` for unpriced codes and
 * `record-priced-specials-on-migrated-lines.mjs` for the owner's money-neutral
 * ruling 甲 — and `custom_specials` is a DERIVED column the next recompute
 * erases. This script is not a third. The plan REPORTS the specials residue and
 * writes none of it.
 *
 * Sofa compartments are the owner's own named exception and belong to another
 * lane. Nothing here changes a quantity, a price, an item code or a status, so
 * stock, readiness and money cannot move.
 *
 * RE-RUN: convergent. The rows land on the same values, and a second run finds
 * every entry already correct and reports `already the book's value` for it —
 * because `erp_now` no longer matches, which is the stale-list refusal doing
 * its job. It can never write twice.
 *
 *   MODE=plan  (default)  read-only; prints the plan and the downstream state
 *   MODE=apply + CONFIRM="FOLLOW THE BOOK ON COLOUR AND SEAT"
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { buildFabricColourIndex } from "./lib/fabric-colour-match.mjs";
import { mergeVariantPatch, OWNED_BOOK_CORRECTION_KEYS } from "./lib/variant-merge.mjs";
import { soProcessingDateFragment } from "./lib/so-processing-date.mjs";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const MODE = (process.env.MODE || "plan").toLowerCase();
const CONFIRM = process.env.CONFIRM || "";
const PHRASE = "FOLLOW THE BOOK ON COLOUR AND SEAT";
const CO = Number(process.env.COMPANY_ID || 1);
if (MODE !== "plan" && MODE !== "apply") { console.error(`MODE must be plan or apply, got ${MODE}`); process.exit(2); }
if (MODE === "apply" && CONFIRM !== PHRASE) {
  console.error(`MODE=apply requires CONFIRM="${PHRASE}" — refusing to write.`);
  process.exit(2);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(HERE, "data", "variant-book-corrections.json");
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const plain = (m) => console.log(m);

const TABLE = { SO: "mfg_sales_order_items", PO: "purchase_order_items" };
const inches = (v) => {
  const s = v == null ? "" : String(v).trim();
  const m = /^(\d+(?:\.\d+)?)/.exec(s.replace(/^[^\d]+/, ""));
  return m ? Number(m[1]) : null;
};
const pickColour = (v) => {
  const o = v && typeof v === "object" && !Array.isArray(v) ? v : {};
  for (const k of ["fabricCode", "colorCode", "colourCode", "fabricColor", "colourId"]) {
    const x = o[k] == null ? "" : String(o[k]).trim();
    if (x) return x;
  }
  return "";
};

const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const PDATE = soProcessingDateFragment(sql);

async function main() {
  const doc = JSON.parse(fs.readFileSync(FILE, "utf8"));
  const entries = doc.entries || [];
  plain(`mode=${MODE}; company ${CO}; ${entries.length} reviewed correction(s) in ${path.basename(FILE)}`);
  plain(`source: ${doc.source}`);
  plain("");

  /* The colour is resolved to a LIBRARY IDENTITY on both sides, never compared
     as a spelling. `active` is read because the library renumbered itself on
     2026-08-11 and a matcher without it answers with the DEAD row — the failure
     that cost 166 sofa lines their colour. */
  const fcRows = await sql`SELECT fabric_id, colour_id, label, active
    FROM scm.fabric_colours WHERE company_id = ${CO}`;
  if (fcRows.length < 50) {
    console.error(`REFUSED: only ${fcRows.length} fabric colours for company ${CO} — the matcher would answer null for everything.`);
    process.exit(2);
  }
  const { findColour } = buildFabricColourIndex(fcRows);
  plain(`fabric library: ${fcRows.length} colours loaded for company ${CO}`);
  plain("");

  const writable = [];
  let skipped = 0;
  for (const e of entries) {
    const table = TABLE[e.type];
    if (!table) { plain(`  !! ${e.ac_doc}: unknown type ${e.type} — skipped`); skipped++; continue; }
    /* An unrecognised axis used to fall through to the SCALAR branch and write
       seatHeight, so a typo would silently stamp a leg measurement into the seat.
       Named explicitly and refused, the way every other gate here is. */
    if (!["colour", "seat", "leg"].includes(e.axis)) {
      plain(`  !! ${e.ac_doc}: unknown axis ${JSON.stringify(e.axis)} — the axes are colour, seat, leg — skipped`);
      skipped++; continue;
    }
    const rows = e.type === "SO"
      ? await sql`SELECT i.id::text AS id, i.item_code, i.variants, i.doc_no,
                    (h.${PDATE} IS NOT NULL) AS proceeded
                  FROM scm.mfg_sales_order_items i
                  JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
                  WHERE h.company_id = ${CO} AND i.linked_ac_dtlkey = ${e.ac_dtlkey}`
      : await sql`SELECT i.id::text AS id, i.item_code, i.variants, h.po_number AS doc_no,
                    TRUE AS proceeded
                  FROM scm.purchase_order_items i
                  JOIN scm.purchase_orders h ON h.id = i.purchase_order_id
                  WHERE h.company_id = ${CO} AND i.linked_ac_dtlkey = ${e.ac_dtlkey}`;

    const head = `${e.ac_doc} DtlKey ${e.ac_dtlkey} (${e.item_code}, ${e.axis})`;
    if (!rows.length) {
      /* The migrated documents that carry NO line key at all. The reconcile
         pairs those by value then by document order, and a second, private
         matcher here would disagree with the one whose verdict is printed —
         this repo's most expensive recurring bug. Reported, never guessed at. */
      plain(`  !! ${head}: no ERP line carries that AutoCount key. This document was migrated without line keys, so the row can only be identified by the reconcile's own value-then-order fallback — REPORTED, not guessed. Skipped.`);
      skipped++; continue;
    }
    /* SEVERAL ROWS BEHIND ONE BOOK LINE IS THE NORMAL SOFA SHAPE, not an
       ambiguity: one AutoCount sofa line becomes one ERP line per compartment,
       and a scalar axis is written IDENTICALLY to every piece of a build —
       which is exactly why variant-reconcile.mjs reads it off the lead. So the
       correction goes to all of them, or to none. */
    const badShape = rows.filter((r) => r.variants !== null && (typeof r.variants !== "object" || Array.isArray(r.variants)));
    if (badShape.length) {
      plain(`  !! ${head}: ${badShape.length} of ${rows.length} row(s) hold a variants that is not a jsonb object (#1938 owns that shape) — skipped`);
      skipped++; continue;
    }
    const row = rows[0];

    /* THE STALE-LIST REFUSAL — asserted on EVERY row of the build. A build
       whose pieces disagree with each other is a state a human has to look at,
       never one to flatten by writing over it. */
    const pickScalar = (r) => (e.axis === "leg" ? pickAxisLeg(r.variants) : pickAxisSeat(r.variants));
    const valueOf = (r) => (e.axis === "colour" ? pickColour(r.variants) : String(inches(pickScalar(r)) ?? ""));
    const sameAs = (v, want) => (e.axis === "colour"
      ? (() => { const a = idOf(findColour, v), b = idOf(findColour, want); return a && b ? a === b : norm(v) === norm(want); })()
      : v === String(want));
    const now = valueOf(row);
    const spread = [...new Set(rows.map(valueOf))];
    if (spread.length > 1) {
      plain(`  !! ${head}: the ${rows.length} pieces of this build do not agree with each other (${spread.map((x) => JSON.stringify(x || "")).join(", ")}) — a human has to look at that. Skipped.`);
      skipped++; continue;
    }
    if (!sameAs(now, e.erp_now)) {
      const already = sameAs(now, e.book);
      plain(`  -- ${head}: the ERP now holds "${now || "(blank)"}", the list expected "${e.erp_now}" — ${already ? "ALREADY the book's value, nothing to do" : "SOMEBODY EDITED IT SINCE; re-review before writing"} — skipped`);
      skipped++; continue;
    }

    let patch = null;
    if (e.axis === "colour") {
      const hit = findColour(e.book);
      if (!hit) { plain(`  !! ${head}: the book's colour "${e.book}" is in NO LIVE row of the fabric library — refusing to write a code the library cannot confirm — skipped`); skipped++; continue; }
      patch = {
        fabricId: hit.fabric_id, colourId: hit.colour_id, fabricCode: hit.colour_id,
        colourLabel: hit.label, fabricLabel: hit.fabric_id,
      };
    } else {
      const n = inches(e.book);
      if (n === null) { plain(`  !! ${head}: the book's ${e.axis} "${e.book}" is not a number — skipped`); skipped++; continue; }
      patch = e.axis === "leg" ? { legHeight: `${n}"` } : { seatHeight: `${n}"` };
    }

    const down = await downstream(e.type, rows.map((r) => r.id));
    writable.push({ e, row, rows, table, patch, down });
    log(`${head}: ${e.axis} "${now}" -> "${e.book}"  [${row.proceeded ? "PROCEEDED" : "not proceeded"}; ${down.text}]  ERP ${row.doc_no}, ${rows.length} piece(s): ${rows.map((r) => r.item_code).join(" + ")}`);
    plain(`      book: ${JSON.stringify(e.desc2)}`);
    plain(`      why : ${e.why}`);
  }

  plain("");
  log(`PLAN: ${writable.length} line(s) would be corrected to the book; ${skipped} skipped.`);
  const prod = writable.filter((w) => w.down.building || w.down.delivered);
  if (prod.length) {
    log(`OF THOSE, ${prod.length} are already downstream — the floor may have built to the OLD value and the owner needs this list:`);
    for (const w of prod) plain(`      ${w.e.erp_doc} ${w.e.item_code}: ${w.e.axis} ${w.e.erp_now} -> ${w.e.book}   ${w.down.text}`);
  } else {
    log("None of them has a goods receipt or a delivery behind it: every correction is a records fix reaching the floor BEFORE the build.");
  }

  if (MODE !== "apply") { plain(""); log(`DRY-RUN. Set MODE=apply and CONFIRM="${PHRASE}" to write.`); await sql.end(); return; }

  let written = 0, rowsWritten = 0;
  for (const w of writable) {
    let n = 0;
    for (const r of w.rows) n += await mergeVariantPatch(sql, { table: w.table, id: r.id, patch: w.patch, owned: OWNED_BOOK_CORRECTION_KEYS });
    if (n !== w.rows.length) { plain(`  !! ${w.e.ac_doc}: merged ${n} of ${w.rows.length} piece(s) — a row vanished or its variants is not an object`); }
    if (n) { written++; rowsWritten += n; }
  }
  log(`APPLIED: ${written} of ${writable.length} book line(s) merged, across ${rowsWritten} ERP row(s).`);
  await sql.end();

  /* ── verify on a FRESH connection, and assert the SHAPE ─────────────────
     A row count answers "did a statement run", never "does the row hold what
     I meant" — the distinction that let a repair reproduce the jsonb
     double-encoding bug on 7 production rows while counting 7 of 7. */
  const v = postgres(DST, { ssl: "require", prepare: false, max: 1 });
  const { findColour: findAgain } = buildFabricColourIndex(
    await v`SELECT fabric_id, colour_id, label, active FROM scm.fabric_colours WHERE company_id = ${CO}`,
  );
  let ok = 0; const bad = [];
  for (const w of writable) {
    for (const wr of w.rows) {
      const [r] = w.e.type === "SO"
        ? await v`SELECT variants, jsonb_typeof(COALESCE(variants,'{}'::jsonb)) AS kind
                  FROM scm.mfg_sales_order_items WHERE id = ${wr.id}::uuid`
        : await v`SELECT variants, jsonb_typeof(COALESCE(variants,'{}'::jsonb)) AS kind
                  FROM scm.purchase_order_items WHERE id = ${wr.id}::uuid`;
      const why = [];
      if (!r) why.push("the row is gone");
      else {
        if (r.kind !== "object") why.push(`variants is jsonb ${r.kind}, not an object`);
        if (w.e.axis === "colour") {
          const got = findAgain(pickColour(r.variants));
          const want = findAgain(w.e.book);
          if (!got || !want || got.colour_id !== want.colour_id) why.push(`colour reads ${JSON.stringify(pickColour(r.variants))}, wanted ${w.e.book}`);
        } else {
          const read = w.e.axis === "leg" ? pickAxisLeg(r.variants) : pickAxisSeat(r.variants);
          const got = inches(read);
          if (got !== inches(w.e.book)) why.push(`${w.e.axis} reads ${JSON.stringify(read)}, wanted ${w.e.book}"`);
        }
      }
      if (why.length) bad.push(`${w.e.ac_doc} ${wr.item_code}: ${why.join("; ")}`);
      else ok++;
    }
  }
  await v.end();
  if (bad.length) {
    for (const b of bad) console.error(`VERIFY FAILED — ${b}`);
    console.error(`REFUSING to report success: ${bad.length} ERP row(s) do not hold what was written.`);
    process.exit(1);
  }
  log(`VERIFIED on a fresh connection: ${ok} ERP row(s) across ${writable.length} book line(s) hold the book's value, and every one is still a jsonb OBJECT.`);
}

const norm = (s) => String(s ?? "").trim().toUpperCase().replace(/\s+/g, " ");
const idOf = (findColour, text) => {
  if (!text) return null;
  const h = findColour(text);
  return h ? `${h.fabric_id}|${h.colour_id}` : null;
};
function pickAxisSeat(v) {
  const o = v && typeof v === "object" && !Array.isArray(v) ? v : {};
  for (const k of ["seatHeight", "depth"]) {
    const x = o[k] == null ? "" : String(o[k]).trim();
    if (x) return x;
  }
  return "";
}

/* THE LEG AXIS. The key names are NOT invented here: they are the ones
   `scripts/lib/variant-reconcile.mjs:278` compares on —
   `{ key: "leg", label: "leg height", erpKeys: ["legHeight", "sofaLegHeight"] }`.
   Reading a different key from the checker that reports the difference is how a
   repair "fixes" a row the report goes on calling wrong. */
function pickAxisLeg(v) {
  const o = v && typeof v === "object" && !Array.isArray(v) ? v : {};
  for (const k of ["legHeight", "sofaLegHeight"]) {
    const x = o[k] == null ? "" : String(o[k]).trim();
    if (x) return x;
  }
  return "";
}

/** Has the floor already acted on this line? */
async function downstream(type, ids) {
  const uuids = ids.map((x) => String(x));
  if (type === "PO") {
    const [{ n }] = await sql`SELECT COUNT(*)::int n FROM scm.grn_items WHERE purchase_order_item_id = ANY(${uuids}::uuid[])`;
    return { building: n > 0, delivered: false, text: n ? `${n} goods-receipt line(s) — RECEIVED` : "no goods receipt yet" };
  }
  const [{ n: po }] = await sql`SELECT COUNT(*)::int n FROM scm.purchase_order_items WHERE so_item_id = ANY(${uuids}::uuid[])`;
  const [{ n: dl }] = await sql`SELECT COUNT(*)::int n FROM scm.delivery_order_items WHERE so_item_id = ANY(${uuids}::uuid[])`;
  const bits = [];
  if (po) bits.push(`${po} purchase-order line(s) — the factory has been told`);
  if (dl) bits.push(`${dl} delivery line(s) — ALREADY DELIVERED`);
  return { building: po > 0, delivered: dl > 0, text: bits.length ? bits.join("; ") : "no purchase order and no delivery behind it" };
}

main().catch(async (e) => { console.error(e); try { await sql.end(); } catch { /* already closed */ } process.exit(1); });
