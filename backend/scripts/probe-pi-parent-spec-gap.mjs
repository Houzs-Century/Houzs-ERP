#!/usr/bin/env node
/* probe-pi-parent-spec-gap — is the BUILD SPEC blank on the purchase invoice
 * only, or on the goods receipt it was raised from as well?
 *
 * READ-ONLY. One Postgres connection, SELECTs only. No DDL, no writes, no
 * transaction, no MODE=apply. Every legitimate answer exits 0 — including "they
 * are both blank", which is the answer that would refute the hypothesis below.
 * Non-zero is reserved for being UNABLE to answer.
 *
 * RE-RUN: read-only, so a second run answers again from current state. That is
 * the point — it is the before/after instrument for the repair it is sizing.
 *
 * ── THE QUESTION, AND WHY A REPAIR CANNOT BE WRITTEN WITHOUT IT ────────────
 * Run 34354779733 (2026-09-09 13:05Z, company 1) reports 35 of 55 purchase
 * invoices differing from the account book, and the second largest group is
 * nine documents whose every finding reads the same way:
 *
 *     colour / fabric: PI-003230 DtlKey 456469 (ERP VALKYRIE-(K)):
 *       AutoCount "NV-1WP" vs ERP "(blank)"
 *
 * The book states a colour, a divan height, a mattress gap, a leg height; the
 * ERP invoice line holds nothing. Two worlds produce that, and they want
 * OPPOSITE repairs:
 *
 *   H1  THE INVOICE IS A STALE SNAPSHOT. create-migrated-invoices.mjs copies
 *       `variants` off the parent goods-receipt row at the moment it writes the
 *       invoice (scripts/create-migrated-invoices.mjs, the `rows` map in
 *       writePi). The goods receipts were spec-repaired afterwards. If so the
 *       PARENT holds the book's values today, the invoice is simply behind, and
 *       the repair is a re-copy from the parent — no book reading, no judgement,
 *       the shape of repair-invoice-item-from-parent.mjs.
 *
 *   H2  NOBODY EVER HELD IT. The receipt line is blank too, and the value has
 *       to come from the BOOK — the shape of copy-book-specs-2026-09-09.mjs,
 *       which is a different script, a different review and a different risk.
 *
 * WHAT WOULD REFUTE H1: a parent goods-receipt line that is blank on the same
 * field. This probe goes and looks. It forms no opinion about which value is
 * right and it compares nothing to the book — it prints what each side holds.
 *
 * ── WHY NOT READ THE GOODS-RECEIPT VERDICT INSTEAD ─────────────────────────
 * Run 34355452828 (same book snapshot) reports GOODS RECEIPTS clean on colour,
 * seat size, specials and build heights — 0 differ on each. That is suggestive
 * and it is NOT an answer: that verdict covers 400 receipt×order pairs and 73
 * of company 1's 473 receipts sit OUTSIDE the compared population, so a parent
 * can be blank and never appear in it. The population a check did not cover is
 * exactly where this repo keeps finding the row that breaks the sweep.
 *
 * Env: DATABASE_URL (required), COMPANY_ID (default 1),
 *      DOCS (optional comma-separated ERP or AutoCount invoice numbers;
 *            blank = every migrated purchase invoice of the company)
 */
import postgres from "postgres";

import { AXES, pickAxis, txt } from "./lib/variant-reconcile.mjs";

const DSN = process.env.DATABASE_URL;
const CO = Number(process.env.COMPANY_ID || 1);
const WANT = new Set(
  String(process.env.DOCS || "").split(/[,\s]+/).map((s) => s.trim().toUpperCase()).filter(Boolean),
);

const say = (m) => console.log(m);
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => {
  console.error(process.env.GITHUB_ACTIONS ? `::error::${m}` : m);
  process.exit(2);
};
if (!DSN) bad("need DATABASE_URL");

/* THE KEY LIST IS IMPORTED, NEVER RETYPED. `AXES` in lib/variant-reconcile.mjs
   is what the reconcile itself reads, so this probe cannot disagree with the
   verdict it is sizing a repair for; a hand-copied list is the duplicated-rule
   bug this repo keeps paying for (docs/bugs/0708). Axes with no `erpKeys` —
   compartments and specials — are not single values and are handled below. */
const FIELDS = AXES.filter((a) => a.erpKeys.length > 0).map((a) => [a.label, a.erpKeys]);

const asObj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
const specialsOf = (v) => {
  const s = asObj(v).specials;
  return Array.isArray(s) ? s.filter(Boolean).map(String) : [];
};

/* A PROBE THAT CANNOT MATCH MUST NOT REPORT A CLEAN RUN (CLAUDE.md). If the
   import ever moves or `pickAxis` changes shape, every line would read as blank
   on both sides — which is a real answer this probe can legitimately print, so
   nothing downstream would notice. Prove the reader works on a known object
   before reading a single production row. */
if (!FIELDS.length) bad("AXES carried no axis with erpKeys — the reader is dead, refusing to report.");
for (const [label, keys] of FIELDS) {
  const probe = pickAxis(Object.fromEntries([[keys[0], "SELFTEST"]]), keys);
  if (probe !== "SELFTEST") bad(`pickAxis cannot read "${label}" via ${keys[0]} — the reader is dead, refusing to report.`);
  if (pickAxis({}, keys) !== "") bad(`pickAxis answered non-empty for an empty "${label}" — blanks would be invisible.`);
}

const sql = postgres(DSN, { max: 1, prepare: false, idle_timeout: 20, connect_timeout: 30 });

try {
  /* Every migrated purchase-invoice LINE beside the goods-receipt line it was
     raised from. A LEFT JOIN on purpose: a line pointing at no receipt row is
     itself a finding and must not vanish from the count. */
  const rows = await sql`
    SELECT h.invoice_number      AS erp_no,
           h.linked_ac_docno     AS ac_no,
           i.id::text            AS line_id,
           i.item_code,
           i.qty::float8         AS qty,
           i.variants            AS inv_variants,
           i.grn_item_id::text   AS grn_item_id,
           g.grn_number          AS parent_grn,
           gi.item_code          AS parent_item_code,
           gi.variants           AS grn_variants
      FROM scm.purchase_invoice_items i
      JOIN scm.purchase_invoices h ON h.id = i.purchase_invoice_id
      LEFT JOIN scm.grn_items gi ON gi.id = i.grn_item_id
      LEFT JOIN scm.grns g ON g.id = gi.grn_id
     WHERE h.company_id = ${CO}
       AND h.linked_ac_docno IS NOT NULL
     ORDER BY h.invoice_number, i.created_at, i.id`;

  if (!rows.length) bad(`company ${CO} holds no migrated purchase-invoice lines. Nothing to answer about.`);

  const inScope = rows.filter((r) => !WANT.size
    || WANT.has(String(r.erp_no).toUpperCase()) || WANT.has(String(r.ac_no).toUpperCase()));
  if (WANT.size && !inScope.length) bad(`none of DOCS matched a migrated purchase invoice of company ${CO}.`);

  say("");
  say("═════════ PURCHASE INVOICE vs THE GOODS RECEIPT IT WAS RAISED FROM ═════════");
  say(`company ${CO} · ${inScope.length} invoice line(s) across `
    + `${new Set(inScope.map((r) => r.erp_no)).size} invoice(s)`
    + (WANT.size ? ` · filtered to ${WANT.size} document(s)` : ""));
  say("");

  /* ── the per-field tally, over EVERY line, printed or not ─────────────── */
  const tally = new Map(FIELDS.map(([name]) => [name, {
    bothBlank: 0, invBlankParentHas: 0, invHas: 0, differ: 0, noParent: 0,
  }]));
  const recopyable = new Map();  // erp_no -> Set(field) the parent could answer
  let noParentLines = 0;

  for (const r of inScope) {
    const iv = asObj(r.inv_variants);
    const gv = asObj(r.grn_variants);
    const hasParent = r.grn_item_id != null && r.parent_grn != null;
    if (!hasParent) noParentLines += 1;
    for (const [name, keys] of FIELDS) {
      const t = tally.get(name);
      if (!hasParent) { t.noParent += 1; continue; }
      const a = txt(pickAxis(iv, keys));
      const b = txt(pickAxis(gv, keys));
      if (a && b && a !== b) t.differ += 1;
      else if (a) t.invHas += 1;
      else if (b) {
        t.invBlankParentHas += 1;
        if (!recopyable.has(r.erp_no)) recopyable.set(r.erp_no, new Set());
        recopyable.get(r.erp_no).add(name);
      } else t.bothBlank += 1;
    }
  }

  say("── 1. FOR EACH FIELD: who holds a value, the invoice or the receipt it came from");
  say(`   ${"field".padEnd(18)} ${"invoice BLANK,".padEnd(16)} ${"invoice".padEnd(10)} ${"BOTH".padEnd(8)} ${"both hold,".padEnd(12)} no parent`);
  say(`   ${"".padEnd(18)} ${"receipt HAS it".padEnd(16)} ${"holds it".padEnd(10)} ${"blank".padEnd(8)} ${"they DIFFER".padEnd(12)} row`);
  for (const [name] of FIELDS) {
    const t = tally.get(name);
    say(`   ${name.padEnd(18)} ${String(t.invBlankParentHas).padEnd(16)} ${String(t.invHas).padEnd(10)} `
      + `${String(t.bothBlank).padEnd(8)} ${String(t.differ).padEnd(12)} ${t.noParent}`);
  }
  say("");
  say("   'invoice BLANK, receipt HAS it' is the only column a re-copy from the parent can close.");
  say("   'BOTH blank' is the column that would need the ACCOUNT BOOK instead — a different repair.");
  say("   'both hold, they DIFFER' is neither: the two sides of our own chain disagree and somebody must choose.");
  say("");

  /* ── specials, which are an ARRAY and cannot be tallied the same way ──── */
  let specInvBlankParentHas = 0; let specBothBlank = 0; let specInvHas = 0; let specDiffer = 0;
  for (const r of inScope) {
    if (r.grn_item_id == null || r.parent_grn == null) continue;
    const a = specialsOf(r.inv_variants);
    const b = specialsOf(r.grn_variants);
    if (!a.length && !b.length) specBothBlank += 1;
    else if (!a.length) specInvBlankParentHas += 1;
    else if (!b.length) specInvHas += 1;
    else if (a.slice().sort().join("|") !== b.slice().sort().join("|")) specDiffer += 1;
    else specInvHas += 1;
  }
  say("── 2. SPECIALS (variants.specials — an array, so counted separately)");
  say(`   invoice empty, receipt has some: ${specInvBlankParentHas} · invoice has some: ${specInvHas} `
    + `· BOTH empty: ${specBothBlank} · both non-empty and DIFFERENT: ${specDiffer}`);
  say("");

  /* ── the item code, which repair-invoice-item-from-parent.mjs already owns ── */
  const itemMismatch = inScope.filter((r) => r.parent_item_code
    && String(r.item_code ?? "") !== String(r.parent_item_code));
  say("── 3. ITEM CODE: does the invoice line still name what its parent names");
  say(`   lines whose item code differs from the parent receipt line: ${itemMismatch.length}`);
  for (const r of itemMismatch.slice(0, 40)) {
    say(`   ${String(r.erp_no).padEnd(18)} invoice "${r.item_code}" vs receipt ${r.parent_grn} "${r.parent_item_code}"`);
  }
  if (itemMismatch.length > 40) say(`   … and ${itemMismatch.length - 40} more NOT PRINTED. The count above covers every line.`);
  say("");

  say("── 4. LINES POINTING AT NO GOODS-RECEIPT ROW AT ALL");
  say(`   ${noParentLines} of ${inScope.length} invoice line(s) carry no reachable parent.`);
  say("   A re-copy cannot answer these whatever else is true of them.");
  say("");

  say("── 5. WHICH INVOICES A RE-COPY FROM THE PARENT WOULD MOVE");
  const named = [...recopyable].sort(([a], [b]) => String(a).localeCompare(String(b)));
  say(`   ${named.length} invoice(s) hold at least one field their own parent already answers:`);
  for (const [erpNo, fields] of named) {
    say(`   ${String(erpNo).padEnd(18)} ${[...fields].join(", ")}`);
  }
  if (!named.length) {
    say("   NONE. H1 is REFUTED on this cut: no purchase-invoice line is blank on a field its");
    say("   parent goods-receipt line holds, so a re-copy from the parent would change nothing");
    say("   and the values have to come from the account book instead.");
  }
  say("");
  const bookOnly = [...tally.values()].reduce((n, t) => n + t.bothBlank, 0);
  note(`re-copy from the parent could fill ${named.length} invoice(s); `
    + `${bookOnly} field-reading(s) across all axes are blank on BOTH sides and would need the account book instead.`);
  say("Read-only: SELECTs only, no transaction, nothing was written.");
} catch (e) {
  bad(`could not answer: ${e?.message ?? e}`);
} finally {
  await sql.end({ timeout: 5 });
}
