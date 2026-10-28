/* The PO arm's counterpart to section B of diag-so-po-variant-divergence.mjs:
   classify every migrated bedframe PURCHASE ORDER line against its OWN
   AutoCount text, corpus-wide.

   WHY THE PO ARM NEEDS ITS OWN MEASUREMENT. refresh-so-variants.mjs keyed its
   parsed-Desc2 lookup on `${DocNo}|${erp_code}`, which is not a line identity,
   so several rows of one SKU collapsed onto the LAST row's parse. Both arms
   carried that defect and both were fixed on DtlKey in #1958. The SO arm's
   damage was then measured and repaired (#1958, #1964). The PO arm was only
   ever covered INDIRECTLY, through the GRN parents in section E of that
   diagnostic - never checked against its own text corpus-wide. This module is
   that check.

   WHY IT LARGELY ESCAPED, and why that must be a SEGMENT and not an excuse.
   ac-outstanding-po.json.gz holds 338 rows against the SO export's 13,588,
   because a RECEIVED purchase order is not "outstanding". Pre-#1958
   refresh-po-variants.mjs looked its parse up as

       parsed.get(`${it.linked_ac_docno}|${(it.item_code || "").toUpperCase()}`)
         ?? (it.description2 ? parseBedframe(it.description2) : null)

   so every line that export did NOT name fell through to the line's own
   description2 - line-accurate by construction, and incapable of carrying a
   collision. The damage, if any, is therefore confined to the lines the buggy
   key HIT, and the two segments are counted apart: a single aggregate would
   bury four bad rows inside four hundred good ones.

   THE AUTHORITY IS description2, NOT linked_ac_dtlkey. This is the trap that
   caught an earlier pass at this work. backfill-ac-line-keys.mjs did not read a
   key off each row - it grouped by (DocNo | item code), the SAME pair that
   collided, and ZIPPED the ordered DtlKeys onto the ERP lines by line_no. A
   join on linked_ac_dtlkey therefore INHERITS the guess and can never refute
   it. description2 is independent: both PO importers write it per line from the
   very export row that created that line (import-ac-outstanding-po.mjs binds
   `${i.d2}`, import-ac-so-linked-pos.mjs binds `${it.desc2}` <- `l.Desc2`), and
   no script UPDATEs the column afterwards - the refresh sweeps only read it.

   Nothing here writes. The classifier is pure: callers hand it rows and the
   export, and get back a verdict per row plus the counts. */

import { parseBedframe } from "./parse-bedframe.mjs";
import { isPendingColour } from "./fabric-colour-match.mjs";

export const norm2 = (s) => (s || "").replace(/\s+/g, " ").trim();

/* ONLY a genuine jsonb OBJECT is a value this check will judge. Anything else
   gets its own bucket and is left alone.

   THIS IS DELIBERATELY STRICTER THAN THE SO ARM'S `asObj`, which JSON.parses a
   string and takes element 0 of an array. Those helpers were written for
   diagnostics that wanted to SEE inside a damaged row. This one decides whether
   a row is healthy, and the two are not the same question: a jsonb STRING
   scalar - the shape the double-encoding defect leaves behind - still parses
   into a perfectly sensible object in JavaScript, but in the DATABASE
   `variants->>'colourId'` on it is NULL, so every consumer reads nothing.
   Unwrapping it here would report a row the ERP cannot read as AGREES, and a
   false clean is the one result this whole exercise must not produce.

   Rows in this bucket belong to #1938's shape repair, and the merge guard
   (`jsonb_typeof(...) = 'object'`) would refuse to write them anyway. */
export function asVariantObject(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return null;          // a jsonb string scalar - damaged
  if (Array.isArray(v)) return null;               // the concatenated-array shape - damaged
  return typeof v === "object" ? v : null;
}

/* The variant block a Desc2 re-parse produces, on exactly the axes the refresh
   sweeps write. Mirrors buildBedframeVariantPatch in lib/variant-merge.mjs. */
export function blockFor(bf, findColour) {
  const fc = isPendingColour(bf.color) ? null : findColour(bf.color);
  const tot = (Number(bf.gap) || 0) + (Number(bf.divan) || 0) + (Number(bf.leg) || 0);
  return {
    fabricId: fc ? fc.fabric_id : null,
    colourId: fc ? fc.colour_id : null,
    fabricCode: fc ? fc.colour_id : null,
    colourLabel: fc ? fc.label : null,
    fabricLabel: fc ? fc.fabric_id : null,
    gap: bf.gap != null ? bf.gap + '"' : null,
    divanHeight: bf.divan != null ? bf.divan + '"' : null,
    legHeight: bf.leg != null ? bf.leg + '"' : null,
    totalHeight: tot ? tot + '"' : null,
    size: bf.size || null,
    _n: { gap: bf.gap ?? null, divan: bf.divan ?? null, leg: bf.leg ?? null },
  };
}

/* The axes compared. Deliberately the same five section B uses, so the PO
   number is readable against the SO number without a footnote. totalHeight is
   derived from gap+divan+leg and would double-count; the four fabric aliases
   all move with colourId. */
export const AXES = ["colourId", "gap", "divanHeight", "legHeight", "size"];
export const COLOUR_KEYS = ["fabricId", "colourId", "fabricCode", "colourLabel", "fabricLabel"];
export const SHAPE_KEYS = ["gap", "divanHeight", "legHeight", "totalHeight", "size"];
export const diffAxes = (a, b) => AXES.filter((k) => (a[k] ?? null) !== (b[k] ?? null));

/* Rebuild the COLLIDED lookup exactly as pre-#1958 refresh-po-variants.mjs
   built it: PO export rows mapped through the AutoCount->ERP code CSV, keyed on
   `${DocNo}|${ERP_CODE}`, last write wins. This is the map whose entries the
   sweep stamped onto every line sharing a key. */
export function buildCollidedPoKey(poExportRows, acToErp) {
  const m = new Map();
  for (const r of poExportRows) {
    const erp = acToErp.get((r.ItemCode || "").trim().toUpperCase().replace(/\s+/g, " "));
    if (!erp) continue;
    m.set(`${r.DocNo}|${erp.toUpperCase()}`, r);   // last write wins - the defect
  }
  return m;
}

/** Parse the AutoCount -> ERP item-code CSV into a lookup. */
export function parseAcToErpCsv(text) {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter(Boolean);
  lines.shift();
  const m = new Map();
  for (const ln of lines) {
    const f = []; let cur = ""; let q = false;
    for (let i = 0; i < ln.length; i++) {
      const c = ln[i];
      if (q) { if (c === '"') { if (ln[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
      else if (c === '"') q = true;
      else if (c === ",") { f.push(cur); cur = ""; }
      else cur += c;
    }
    f.push(cur);
    if (f[0]) m.set(f[0].trim().toUpperCase().replace(/\s+/g, " "), (f[1] || "").trim());
  }
  return m;
}

/**
 * Classify ONE purchase-order line.
 *
 * @param row  {id, po_number, ac, item_code, d2, dtl, variants, status}
 *             `ac` is the header's linked_ac_docno, `dtl` its linked_ac_dtlkey.
 * @param ctx  {byDtl, collided, findColour}
 * @returns a verdict object. `verdict` is one of:
 *   NO-TEXT          the line has no description2, so it cannot be checked at
 *                    all. NEVER falls back to position - that is the guess this
 *                    whole exercise exists to refuse.
 *   BAD-SHAPE        `variants` is not a jsonb object; #1938's repair owns it.
 *   AGREES           variants match what the parser makes of the line's own text
 *   MISMATCH         they do not
 * and `attributable` is true only when the row holds EXACTLY what the collided
 * key would have produced - the proof that this row's value came from another
 * line's text rather than from a human choice.
 */
export function classifyPoLine(row, { byDtl, collided, findColour }) {
  const bug = collided.get(`${row.ac}|${(row.item_code || "").toUpperCase()}`) || null;
  const covered = bug != null;                    // the buggy key HIT this line
  const ex = row.dtl != null ? byDtl.get(Number(row.dtl)) || null : null;

  /* DtlKey provenance - reported, never trusted. Same four outcomes section B
     prints for the SO arm, so the two are read side by side. */
  let provenance;
  if (row.dtl == null) provenance = "NO-DTLKEY";
  else if (!ex) provenance = "KEY-NOT-IN-EXPORT";
  else if (row.d2 == null) provenance = "NO-DESCRIPTION2";
  else if (norm2(row.d2) === norm2(ex.Desc2)) provenance = "CORROBORATED";
  else provenance = "CONTRADICTED";

  const base = { id: row.id, po: row.po_number, ac: row.ac, code: row.item_code,
                 dtl: row.dtl, status: row.status, covered, provenance,
                 d2: row.d2, collidedText: bug ? norm2(bug.Desc2) : null };

  if (row.d2 == null) return { ...base, verdict: "NO-TEXT" };
  const cur = asVariantObject(row.variants);
  if (!cur) return { ...base, verdict: "BAD-SHAPE" };

  const want = blockFor(parseBedframe(row.d2), findColour);
  const axes = diffAxes(cur, want);
  if (!axes.length) return { ...base, verdict: "AGREES" };

  /* ATTRIBUTION. A mismatch is only the collision's doing when the row holds
     precisely the block the OTHER line's text produces. Without this gate the
     bucket would also collect values a human deliberately set, and repairing
     those would overwrite a real decision with a re-parse. */
  let attributable = false;
  if (bug && norm2(bug.Desc2) !== norm2(row.d2)) {
    const wouldBe = blockFor(parseBedframe(bug.Desc2), findColour);
    attributable = diffAxes(cur, wouldBe).length === 0;
  }
  return { ...base, verdict: "MISMATCH", attributable, axes, want,
           from: Object.fromEntries(axes.map((k) => [k, cur[k] ?? null])),
           to: Object.fromEntries(axes.map((k) => [k, want[k] ?? null])) };
}

/** Roll a list of verdicts into the counts, split by export coverage. */
export function tally(verdicts) {
  const blank = () => ({ lines: 0, agrees: 0, mismatch: 0, attributable: 0, noText: 0, badShape: 0 });
  const out = { covered: blank(), fellThrough: blank(), total: blank(),
                provenance: { CORROBORATED: 0, CONTRADICTED: 0, "NO-DESCRIPTION2": 0,
                              "KEY-NOT-IN-EXPORT": 0, "NO-DTLKEY": 0 } };
  for (const v of verdicts) {
    for (const seg of [v.covered ? out.covered : out.fellThrough, out.total]) {
      seg.lines++;
      if (v.verdict === "AGREES") seg.agrees++;
      else if (v.verdict === "NO-TEXT") seg.noText++;
      else if (v.verdict === "BAD-SHAPE") seg.badShape++;
      else { seg.mismatch++; if (v.attributable) seg.attributable++; }
    }
    out.provenance[v.provenance]++;
  }
  return out;
}

/* The SQL both the check and the repair read. One string, so the repair can
   never act on a different population than the check measured. */
export const PO_LINE_SQL = `
  SELECT i.id::text AS id, i.item_code, i.description2 AS d2, i.variants,
         i.linked_ac_dtlkey AS dtl, h.po_number, h.linked_ac_docno AS ac,
         UPPER(COALESCE(h.status::text, '')) AS status
    FROM scm.purchase_order_items i
    JOIN scm.purchase_orders h ON h.id = i.purchase_order_id
   WHERE h.company_id = 1 AND i.item_group = 'bedframe'
     AND h.linked_ac_docno IS NOT NULL`;
