#!/usr/bin/env node
/* diag-so-erp-build — PRINT WHAT THE ERP ITSELF HOLDS for a sales order.
 *
 * READ-ONLY. SELECTs only, one connection, no MODE=apply and no write path of
 * any kind. It answers exactly one question, and answers it about OUR system:
 *
 *     「所以基本上model和sofa compartment基本上都有了啊？那为什么你说没有呢？」
 *
 * ── WHY IT EXISTS ───────────────────────────────────────────────────────────
 * On 2026-09-09 three sales orders were reported to the owner as having "no
 * source at all" for their sofa build. TWO sources had been checked — the
 * photograph (absent from AutoCount) and the book's own Desc2 (finishing notes
 * only) — and the third, THE VALUE OUR OWN DATABASE IS HOLDING, was never
 * looked at. He pushed back and he was right.
 *
 * The tally report had the same blind spot: `sofa build not verifiable` printed
 * the refusal and never the value behind it, so an order the ERP may already
 * have a perfectly good build for was handed to the owner as a blank to fill
 * from memory. That is fixed in the report itself; this script is the READ that
 * should have happened before anybody said "no source at all".
 *
 * ── IT DECIDES NOTHING, AND IT RESTATES NO RULE ─────────────────────────────
 * No comparison against the account book happens here and none may be added.
 * check-ac-erp-reconcile.mjs is the only thing in this repo that compares the
 * two sides; a second opinion about "different" is the failure documented in
 * docs/bugs/0708.
 *
 * The one rule it needs — what counts as a PIECE — is IMPORTED from
 * lib/variant-reconcile.mjs, the module that owns it and the module the
 * reconcile itself calls. It is not re-spelled here. `have.join("+")` in that
 * file and this script's piece list are the same function over the same rows,
 * which is why the report and this diagnostic cannot state different builds.
 *
 * Usage:  DOCS=HC-SO-013495,HC-SO-013497 COMPANY=1 node scripts/diag-so-erp-build.mjs
 * `DOCS` accepts ERP doc numbers or AutoCount document numbers, either way.
 */
import postgres from "postgres";

import { soProcessingDateFragment } from "./lib/so-processing-date.mjs";
import { compartmentOf, modelOf } from "./lib/variant-reconcile.mjs";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const CO = Number(process.env.COMPANY || 1);
const DOCS = String(process.env.DOCS || "")
  .split(/[,\s]+/)
  .map((s) => s.trim())
  .filter(Boolean);
if (!DOCS.length) { console.error("need DOCS=HC-SO-013495,... (ERP or AutoCount numbers)"); process.exit(2); }

const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
/* The ONE name of the Processing Date column, spliced as SQL text rather than
   bound as a parameter — see lib/so-processing-date.mjs. Migration 0286 renamed
   `internal_expected_dd` to `processing_date`, so naming the old one is a 42703
   that returns NOTHING; this script was caught doing exactly that by
   tests/soProcessingDateOneName.test.mjs before it ever reached production. */
const PDATE = soProcessingDateFragment(sql);
const plain = (m) => console.log(m);
const money = (sen) => (sen == null ? "—" : `RM ${(Number(sen) / 100).toFixed(2)}`);
const oneLine = (s) => String(s).replace(/\r?\n/g, " ⏎ ");

try {
  /* Matched on EITHER key on purpose: the owner and the reports name documents
     by the AutoCount number, the ERP names them by doc_no, and a script that
     accepted only one would answer "not found" about a document it holds. */
  const heads = await sql`
    SELECT h.doc_no, h.linked_ac_docno AS ac_no, h.status::text AS status,
           h.${PDATE} AS processing_date
      FROM scm.mfg_sales_orders h
     WHERE h.company_id = ${CO}
       AND (h.doc_no = ANY(${DOCS}) OR h.linked_ac_docno = ANY(${DOCS}))
     ORDER BY h.doc_no`;

  const found = new Set(heads.flatMap((h) => [h.doc_no, h.ac_no].filter(Boolean)));
  for (const want of DOCS) {
    if (!found.has(want)) plain(`!! ${want} — NO SUCH SALES ORDER in company ${CO}. Nothing is held.`);
  }

  for (const h of heads) {
    const items = await sql`
      SELECT i.line_no, i.item_code, i.description, i.description2, i.item_group,
             i.qty::float8 AS qty, i.unit_price_sen, i.linked_ac_dtlkey AS ac_dtlkey,
             i.line_suffix, i.variants, i.custom_specials, i.remark, i.cancelled
        FROM scm.mfg_sales_order_items i
       WHERE i.doc_no = ${h.doc_no}
       ORDER BY COALESCE(i.line_no, 0), i.item_code`;

    plain("");
    plain(`════════ ${h.doc_no}  (account book ${h.ac_no ?? "—"})  ════════`);
    plain(
      `   status ${h.status} · processing date ` +
        `${h.processing_date ?? "(none — NOT proceeded)"} · ${items.length} line(s) in the ERP`,
    );

    /* ── THE PIECE LIST LEADS ────────────────────────────────────────────────
       Model, seat size and colour are already known from the account book. The
       PIECE LIST is the only open question, so it is the first thing on the
       page and the thing the owner can answer 「对」 to in one word. */
    const sofa = items.filter((i) => i.item_group === "sofa" && !i.cancelled);
    plain("");
    if (!sofa.length) {
      plain("   THE PIECE LIST WE HOLD: none — this document has no live sofa line.");
    } else {
      const byModel = new Map();
      for (const i of sofa) {
        const m = modelOf(i.item_code) || "(no model)";
        if (!byModel.has(m)) byModel.set(m, []);
        byModel.get(m).push(i);
      }
      for (const [model, rows] of byModel) {
        /* Same function, same rows, as lib/variant-reconcile.mjs's `have`. */
        const pieces = rows.map((r) => compartmentOf(r.item_code)).filter(Boolean);
        const placeholder = rows.some((r) => /SOFA UNPARSED/.test(String(r.remark ?? "")));
        plain(
          `   THE PIECE LIST WE HOLD (${model}): ` +
            (pieces.length ? pieces.join("+") : "NOTHING — no compartment rows") +
            (placeholder ? "   [carries the importer's SOFA UNPARSED placeholder]" : ""),
        );
        plain(`      ${rows.length} compartment row(s) on this build.`);
      }
    }

    plain("");
    plain("   every line, as the ERP stores it:");
    for (const i of items) {
      plain(
        `      #${String(i.line_no ?? 0).padStart(3)} ${String(i.item_code ?? "?").padEnd(24)} ` +
          `qty ${String(i.qty).padStart(5)}  ${money(i.unit_price_sen).padStart(12)}  ` +
          `AC line key ${i.ac_dtlkey ?? "(none)"}${i.line_suffix ? ` / suffix ${i.line_suffix}` : ""}` +
          `${i.cancelled ? "   [CANCELLED]" : ""}`,
      );
      if (i.description) plain(`           description : ${oneLine(i.description)}`);
      if (i.description2) plain(`           description2: ${oneLine(i.description2)}`);
      if (i.remark) plain(`           remark      : ${oneLine(i.remark)}`);
      /* variants VERBATIM — the specials the owner asks about live in
         variants.specials. `custom_specials` is DERIVED and self-erasing, so it
         is printed LABELLED as derived and never as the answer; printing the
         two side by side unlabelled is how a reader comes to quote the empty
         one (docs/notes: the specials field trap). */
      if (i.variants) plain(`           variants    : ${JSON.stringify(i.variants)}`);
      if (i.custom_specials) {
        plain(`           custom_specials (DERIVED, NOT the source of truth): ${JSON.stringify(i.custom_specials)}`);
      }
    }
  }
} finally {
  await sql.end({ timeout: 5 });
}
