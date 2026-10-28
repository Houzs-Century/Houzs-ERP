#!/usr/bin/env node
/* check-keyless-lines — verify the documents check-ac-erp-reconcile.mjs has to
 * REFUSE to line-match, by comparing the two sides as MULTISETS.
 *
 * 「包括每个 line 都是要一样的」 — the owner, 2026-09-08. Every LINE has to match
 * the book, not just the document. And 「账本跟我们写的不一样呢，我们一定要对回账本啊」:
 * the book is the arbiter.
 *
 * WHAT THIS ANSWERS. The reconcile prints, per type, a count of documents that
 * "could NOT be line-matched (no line key on either side and the line counts
 * differ). Their line data is UNVERIFIED, not verified-clean." That sentence is
 * honest — pairing by POSITION invents findings, and it invented them five
 * separate times on 2026-09-07/08 — but a REFUSAL IS NOT AN ANSWER, and it was
 * three times reported as though it were one. This script gives the answer the
 * refusal withheld, without ever pairing by position:
 *
 *   IDENTICAL   the bag of (item, quantity) is the same on both sides, so the
 *               document IS identical however its lines are ordered.
 *   DIFFERS     the bags differ, and the difference NAMES the defect — which
 *               item, how much on each side. A finding with a document number.
 *   AMBIGUOUS   only where a sofa's compartments are uneven and the fold cannot
 *               state how many whole sofas that is. Both sides are printed in
 *               full for every one of these, per document, so the count is
 *               named rather than a bucket.
 *
 * IT READS EXACTLY WHAT THE RECONCILE READS. The population, the ERP SELECTs
 * and the item-code translation all come from the same three modules the
 * reconcile uses (lib/ac-scope.mjs, lib/ac-reconcile-erp-sql.mjs,
 * lib/ac-mapping-csv.mjs). A second statement of any of them would let this
 * script verify a different set of documents than the one being reported as
 * unverified — the failure lib/ac-mapping-csv.mjs records, where two parsers
 * for one CSV invented 40 of 111 item-code "defects".
 *
 * READ-ONLY. One connection, SELECTs only, no DDL, no writes, no transaction.
 *
 * Env: DATABASE_URL (required)  COMPANY_ID (default 1)
 *      MAX_SNAPSHOT_AGE_DAYS (default 2)   SHOW (default 40)
 *      TYPES (default "SO,GR,DO" — the three the reconcile reports unpairable)
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { buildScope, decodeSnapshot } from "./lib/ac-scope.mjs";
import { grPairGrain } from "./lib/ac-gr-pair-grain.mjs";
import { readMappingCsv, normCode } from "./lib/ac-mapping-csv.mjs";
import { soProcessingDateFragment } from "./lib/so-processing-date.mjs";
import { erpReconcileTypes } from "./lib/ac-reconcile-erp-sql.mjs";
import { bagOf, compareBags, printableBag } from "./lib/keyless-multiset.mjs";
import { splitBlankBookRows } from "./lib/ac-blank-book-row.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(here, "data");
const SNAP = path.join(DATA, "ac-reconcile-truth.json.gz");
const MAP_CSV = path.join(DATA, "autocount-erp-mapping-1561.csv");
const CO = Number(process.env.COMPANY_ID || 1);
const MAX_AGE_DAYS = Number(process.env.MAX_SNAPSHOT_AGE_DAYS || 2);
const SHOW = Math.max(1, Number(process.env.SHOW || 40));
const WANT = new Set((process.env.TYPES || "SO,GR,DO").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean));

const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const plain = (m) => console.log(m);

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("REFUSED: DATABASE_URL not set.");
  process.exit(2);
}
if (!fs.existsSync(SNAP)) {
  console.error(`REFUSED: ${SNAP} is missing. Run backend/scripts/export-ac-reconcile-truth.mjs against the book first.`);
  process.exit(2);
}
const snap = JSON.parse(zlib.gunzipSync(fs.readFileSync(SNAP)).toString("utf8"));
const ageDays = (Date.now() - new Date(snap.exported_at).getTime()) / 86400000;
plain(`AutoCount snapshot exported_at=${snap.exported_at} (${ageDays.toFixed(2)} days old)`);
if (!(ageDays <= MAX_AGE_DAYS)) {
  /* Same refusal, same reason, as check-ac-erp-reconcile.mjs: a verdict against
     a stale book would read as coverage we do not have. The file mtime is a
     checkout artifact and is deliberately not consulted. */
  console.error(`REFUSED: the AutoCount snapshot is ${ageDays.toFixed(1)} days old (limit ${MAX_AGE_DAYS}).`);
  process.exit(2);
}

const book = decodeSnapshot(snap);
const SCOPE = buildScope(book);
const GR_PAIR = grPairGrain(book, SCOPE);

const mappingRows = readMappingCsv(fs.readFileSync(MAP_CSV, "utf8"));
const codeMap = new Map([...mappingRows].map(([ac, m]) => [ac, normCode(m.erp)]));
const mapped = (s) => codeMap.get(normCode(s)) ?? normCode(s);

const sql = postgres(url, { ssl: "require", prepare: false, max: 1, connect_timeout: 30 });
const PDATE = soProcessingDateFragment(sql);
const refuse = async (msg) => {
  console.error(`REFUSED: ${msg}`);
  await sql.end({ timeout: 5 }).catch(() => {});
  process.exit(2);
};

const TYPES = erpReconcileTypes({ sql, CO, PDATE }).filter((c) => WANT.has(c.t));
if (!TYPES.length) await refuse(`TYPES="${process.env.TYPES}" selects none of SO PO GR DO IV PI.`);

const erp = {};
try {
  for (const cfg of TYPES) {
    erp[cfg.t] = { docs: await cfg.docs(), lines: cfg.lines ? await cfg.lines() : [] };
  }
} catch (e) {
  await refuse(`the ERP database could not be read: ${e.message}`);
}

/* The money axis is only meaningful where the ERP's price is COPIED from the
   book. `priceDeclared` on the type says it is derived from the purchase order
   instead; a migrated delivery order carries no money at all (the reconcile
   counts that as a POPULATION property, not per-document drift). Comparing
   money there would measure our own derivation and report it as the book being
   wrong. */
const COMPARE_MONEY = { SO: true, PO: true, GR: false, DO: false, IV: true, PI: true };

/* EVERY LINE OF BOTH SIDES, for a document the bags could not settle.
   「包括每个 line 都是要一样的」 is answered by showing the lines, not by a count,
   and the owner reads the build text and the piece list TOGETHER. Truncated only
   in width, never in row count: a dropped row is the one that mattered. */
const cut = (s, n) => {
  const v = String(s ?? "").replace(/\s+/g, " ").trim();
  return v.length > n ? `${v.slice(0, n - 1)}…` : v;
};
function dumpBothSides(r) {
  plain("         ── the book ──");
  for (const l of [...r.acRaw].sort((a, b) => a.seq - b.seq)) {
    const d2 = r.desc2.get(l.dtlKey);
    plain(
      `         seq ${String(l.seq).padStart(4)}  ${cut(l.itemKey, 30).padEnd(30)} ` +
        `qty ${String(l.qty ?? 0).padStart(5)}  RM ${((l.docSubTotalSen ?? l.subTotalSen ?? 0) / 100).toFixed(2).padStart(10)}` +
        (d2 ? `  build: ${cut(d2, 70)}` : "  build: (none)"),
    );
  }
  plain("         ── ours ──");
  for (const l of [...r.erpRaw].sort((a, b) => (a.line_no ?? 0) - (b.line_no ?? 0) || (a.item_code > b.item_code ? 1 : -1))) {
    plain(
      `         ${cut(l.item_code, 30).padEnd(35)} ` +
        `qty ${String(l.qty ?? 0).padStart(5)}  RM ${(((l.qty == null ? 0 : Number(l.qty)) * (l.unit_price_sen == null ? 0 : Number(l.unit_price_sen))) / 100).toFixed(2).padStart(10)}` +
        (l.description2 ? `  build: ${cut(l.description2, 70)}` : "  build: (none)"),
    );
  }
}

const totals = [];
for (const cfg of TYPES) {
  const t = cfg.t;
  const B = cfg.pairGrain ? GR_PAIR.view : book[t];

  const erpByAc = new Map();
  for (const d of erp[t].docs) {
    const ac = d.ac_no ? String(d.ac_no).trim() : null;
    if (!ac || erpByAc.has(ac)) continue;
    erpByAc.set(ac, d);
  }
  const erpLinesByAc = new Map();
  for (const l of erp[t].lines) {
    const ac = String(l.ac_no).trim();
    if (!erpLinesByAc.has(ac)) erpLinesByAc.set(ac, []);
    erpLinesByAc.get(ac).push(l);
  }

  const rows = { IDENTICAL: [], DIFFERS: [], AMBIGUOUS: [] };
  const compartmentNotes = [];
  let bothSides = 0;
  let unpairable = 0;

  for (const [ac, d] of erpByAc) {
    const h = B.headers.get(ac);
    if (!h) continue;
    bothSides++;
    /* AutoCount's own EMPTY ROWS are DECLARED, not compared — a row with no item
       code, no quantity and no money is not a line the ERP can hold, and
       counting it made eleven blank rows on six sales orders read as missing
       lines on go-live morning. The rule is lib/ac-blank-book-row.mjs and it is
       stated ONCE: check-ac-erp-reconcile.mjs applies the same call. Stating it
       twice is what made these two scripts answer 25 and 26 for the same
       population at the same moment on 2026-09-08 (runs 34191731557 and
       34191733632) — the exact failure the shared SELECTs were extracted to
       prevent, one layer up.

       The rule grew a SECOND ARM on 2026-09-08 (owner ruling): a row that
       carries a quantity and still states no item code, no description, no
       build text and no money is also nothing. That arm reads the Desc2, which
       is why `B.desc2` is passed here — the module REFUSES to answer without
       it, so this call site cannot silently drift back to the narrower rule. */
    const { lines: acLines } = splitBlankBookRows(B.lines.get(ac) || [], B.desc2);
    const erpLines = erpLinesByAc.get(ac) || [];

    /* THE POPULATION, restated EXACTLY as check-ac-erp-reconcile.mjs states it
       before it gives up: no ERP line of this document carries an AutoCount
       line key, AND the two sides do not agree on how many lines there are. */
    if (erpLines.some((l) => l.ac_dtlkey != null)) continue;
    if (acLines.length === erpLines.length) continue;
    unpairable++;

    const bookBag = bagOf(
      acLines.map((l) => ({
        code: mapped(l.itemKey),
        rawCode: l.itemKey,
        qty: l.qty ?? 0,
        /* The DOCUMENT's own currency, which is what the ERP stores. Reading
           the LOCAL total instead is what once made an exchange rate look like
           a RM 13,068.55 discount (docs/bugs/0665). */
        sen: l.docSubTotalSen ?? l.subTotalSen ?? 0,
      })),
      "book",
    );
    const erpBag = bagOf(
      erpLines.map((l) => ({
        code: l.item_code,
        qty: l.qty == null ? 0 : Number(l.qty),
        sen: Math.round((l.qty == null ? 0 : Number(l.qty)) * (l.unit_price_sen == null ? 0 : Number(l.unit_price_sen))),
        suffixed: l.line_suffix != null,
        /* The BOOK's own build text, written verbatim onto every compartment row
           by both cutover importers. It is the only thing on a keyless document
           that says which compartments are ONE sofa — see the fold in
           lib/keyless-multiset.mjs. */
        desc2: l.description2,
      })),
      "erp",
    );

    const r = compareBags({ book: bookBag, erp: erpBag, compareMoney: COMPARE_MONEY[t] });
    /* Our compartments disagreeing with the book's decoded build text is a
       COMPARTMENT finding, not a line one — reported in its own count so it can
       never be read as a missing line, and never as coverage either. */
    const notes = [...erpBag.values()].flatMap((v) => (v.notes || []).map((n) => `${v.key}: ${n}`));
    if (notes.length) compartmentNotes.push({ ac, erpNo: d.erp_no, notes });
    rows[r.verdict].push({
      ac, erpNo: d.erp_no, acLines: acLines.length, erpLines: erpLines.length,
      bookBag, erpBag, acRaw: acLines, erpRaw: erpLines, desc2: B.desc2, ...r,
    });
  }

  plain("");
  plain(`═══════════ ${t} — ${cfg.label} ═══════════`);
  plain(
    `${bothSides} document(s) present on both sides; ${unpairable} of them carry NO AutoCount line key on any ` +
      `ERP line AND differ in line count — the set check-ac-erp-reconcile.mjs reports as UNVERIFIED.`,
  );
  plain(
    `   money axis: ${COMPARE_MONEY[t] ? "compared" : "NOT compared — " + (cfg.priceDeclared || "the ERP does not copy this type's price from the book")}`,
  );
  log(
    `${t} KEYLESS MULTISET — of ${unpairable}: ${rows.IDENTICAL.length} IDENTICAL, ` +
      `${rows.DIFFERS.length} DIFFER, ${rows.AMBIGUOUS.length} AMBIGUOUS.`,
  );

  if (rows.DIFFERS.length) {
    plain(`   DIFFERS — the bags are not equal, and the difference names the defect (first ${Math.min(SHOW, rows.DIFFERS.length)} of ${rows.DIFFERS.length}):`);
    for (const r of rows.DIFFERS.slice(0, SHOW)) {
      plain(`      ${r.ac} (ERP ${r.erpNo}) — book ${r.acLines} line(s), ours ${r.erpLines}:`);
      for (const dd of r.differences) plain(`         ${dd}`);
      for (const aa of r.ambiguities) plain(`         (also ambiguous) ${aa}`);
      dumpBothSides(r);
    }
    if (rows.DIFFERS.length > SHOW) plain(`      ... ${rows.DIFFERS.length - SHOW} more`);
  }
  if (rows.AMBIGUOUS.length) {
    plain(`   AMBIGUOUS — the multiset cannot decide. BOTH SIDES PRINTED, one document per block (${rows.AMBIGUOUS.length}):`);
    for (const r of rows.AMBIGUOUS) {
      plain(`      ${r.ac} (ERP ${r.erpNo}) — book ${r.acLines} line(s), ours ${r.erpLines}`);
      plain(`         book: ${printableBag(r.bookBag)}`);
      plain(`         ours: ${printableBag(r.erpBag)}`);
      for (const aa of r.ambiguities) plain(`         why: ${aa}`);
      dumpBothSides(r);
    }
  }
  if (rows.IDENTICAL.length) {
    plain(`   IDENTICAL (first ${Math.min(SHOW, rows.IDENTICAL.length)} of ${rows.IDENTICAL.length}): ` +
      rows.IDENTICAL.slice(0, SHOW).map((r) => `${r.ac}[${r.acLines}v${r.erpLines}]`).join(", "));
  }

  if (compartmentNotes.length) {
    log(
      `${t} COMPARTMENT SHAPE — ${compartmentNotes.length} of the ${unpairable} carry sofa rows that are not what ` +
        "the book's own build text decodes to. The LINE agrees (model, quantity, money); what disagrees is which " +
        "compartments we minted. That is the variant axis, reported here so it is not lost, and it is NOT a missing line.",
    );
    for (const c of compartmentNotes.slice(0, SHOW)) {
      plain(`      ${c.ac} (ERP ${c.erpNo})`);
      for (const n of c.notes) plain(`         ${n}`);
    }
    if (compartmentNotes.length > SHOW) plain(`      ... ${compartmentNotes.length - SHOW} more`);
  }

  totals.push({ t, unpairable, identical: rows.IDENTICAL.length, differs: rows.DIFFERS.length, ambiguous: rows.AMBIGUOUS.length, shape: compartmentNotes.length });
}

plain("");
plain("═══════════ TOTAL ═══════════");
plain("type  unverified  IDENTICAL  DIFFERS  AMBIGUOUS   shape-note");
const sum = { unpairable: 0, identical: 0, differs: 0, ambiguous: 0 };
for (const r of totals) {
  plain(`${r.t.padEnd(6)}${String(r.unpairable).padStart(10)}${String(r.identical).padStart(11)}${String(r.differs).padStart(9)}${String(r.ambiguous).padStart(11)}${String(r.shape).padStart(13)}`);
  for (const k of Object.keys(sum)) sum[k] += r[k === "unpairable" ? "unpairable" : k];
}
plain(`${"ALL".padEnd(6)}${String(sum.unpairable).padStart(10)}${String(sum.identical).padStart(11)}${String(sum.differs).padStart(9)}${String(sum.ambiguous).padStart(11)}`);
log(
  `KEYLESS MULTISET TOTAL — ${sum.unpairable} document(s) the reconcile calls unverified: ` +
    `${sum.identical} PROVEN identical, ${sum.differs} carry a real difference, ${sum.ambiguous} genuinely undecidable.`,
);

await sql.end({ timeout: 5 });
/* Exit 0 for every legitimate answer: a red job reads as "the check broke", and
   the answer IS the output. Non-zero is reserved for an unreachable book or DB. */
process.exit(0);
