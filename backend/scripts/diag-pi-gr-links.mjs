#!/usr/bin/env node
/* diag-pi-gr-links — WHY the purchase invoices differ on 单据转换链, per line,
 * split by the column that would have to change to fix it.
 *
 * READ-ONLY. No UPDATE, no INSERT, no plan file. It exists because the repair
 * that follows it has two candidate causes and they want OPPOSITE writes, and
 * writing the wrong one is not a smaller mistake than writing nothing.
 *
 * ── THE NUMBER IT EXPLAINS ─────────────────────────────────────────────────
 * Runs 34268495385 / 34263816266 on `main`: PURCHASE INVOICES 53 differ. The
 * bug note docs/bugs/0730 attributes 47 of them to two columns:
 *   · `scm.grns.linked_ac_gr_docno` NULL  -> `doc_differs`, 59 lines
 *   · `scm.purchase_invoice_items.grn_item_id` NULL -> `erp_link_missing`, 58
 * That note was written from ONE run's printout. This re-measures both from the
 * live database and the current book, because a repair is about to be built on
 * the split.
 *
 * ── THE VERDICT IS NOT RE-IMPLEMENTED HERE ─────────────────────────────────
 * `fromVerdictFor` and the PI row query are IMPORTED from the same two modules
 * the reconcile uses (lib/transfer-chain-verdict.mjs, lib/ac-transfer-chain-run
 * .mjs). A diagnostic that restated the classification could agree with itself
 * and disagree with the report — the exact failure that put four "clean" tools
 * in front of the owner. The only thing computed here is the SUB-CAUSE of a
 * verdict the shared module returned.
 *
 * ── THE QUESTION THAT DECIDES THE REPAIR ───────────────────────────────────
 * When `scm.grns.linked_ac_gr_docno` is NULL there are two possible worlds and
 * they are not both repairable:
 *
 *   A. the receipt IS the book's receipt and we simply never stamped its number
 *      -> stamping it is a fact we already hold, and the PI line agrees at once
 *   B. the receipt is ERP-NATIVE — raised in the ERP while the shop traded
 *      through cutover — and the book's invoice was raised off a DIFFERENT
 *      receipt that we hold as another row
 *      -> stamping a book receipt number onto it would be INVENTING a link
 *
 * Section 3 separates them per document instead of assuming A, which is what
 * the brief this was written from does. `created_at` against the migration
 * window and `migrated_no_stock` are the two facts that tell them apart.
 *
 * Env: DATABASE_URL, COMPANY_ID (default 1), MAX_SNAPSHOT_AGE_DAYS (default 2)
 */
import postgres from "postgres";

import { chainEdges, loadChainBook } from "./lib/ac-transfer-chain-run.mjs";
import { fromVerdictFor, IS_DIFFERENCE } from "./lib/transfer-chain-verdict.mjs";
import { soProcessingDateFragment } from "./lib/so-processing-date.mjs";

const DSN = process.env.DATABASE_URL;
const CO = Number(process.env.COMPANY_ID || 1);
const MAX_AGE_DAYS = Number(process.env.MAX_SNAPSHOT_AGE_DAYS || 2);
const SHOW = Number(process.env.SHOW || 40);

const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const say = (m) => console.log(m);
const bad = (m) => {
  console.error(process.env.GITHUB_ACTIONS ? `::error::${m}` : m);
  process.exit(2);
};
if (!DSN) bad("need DATABASE_URL");

const up = (s) => String(s ?? "").trim().toUpperCase();

async function main() {
  const loaded = loadChainBook({ maxAgeDays: MAX_AGE_DAYS });
  if (!loaded.ok) bad(`the chain snapshot cannot be used: ${loaded.why}`);
  note(`chain snapshot exported ${loaded.exportedAt} (${loaded.ageDays.toFixed(2)} days old)`);

  const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
  try {
    /* NOT awaited. This is a postgres.js Query spliced verbatim into a
       template; awaiting it would EXECUTE `SELECT processing_date` on its own.
       lib/so-processing-date.mjs says so in its own header. */
    const PDATE = soProcessingDateFragment(sql);
    const edge = chainEdges({ sql, CO, PDATE }).find((e) => e.t === "PI");
    const rows = await edge.rows();
    const B = loaded.book.PI;
    say(`\nERP purchase-invoice lines read: ${rows.length}`);
    say(`book purchase-invoice lines in the snapshot: ${B.lines.size}`);

    /* ── 1. THE VERDICT TALLY, from the shared classifier ──────────────── */
    const tally = new Map();
    const diffs = [];
    let unkeyed = 0;
    let keyNotInBook = 0;
    let cancelledSkipped = 0;

    for (const row of rows) {
      const key = row.child_key == null ? "" : String(row.child_key).trim();
      if (!key) { unkeyed += 1; continue; }
      const bl = B.lines.get(key);
      if (!bl) { keyNotInBook += 1; continue; }
      if (B.cancelled.has(bl.docNo)) { cancelledSkipped += 1; continue; }

      const parents = [row.parent_a, row.parent_b]
        .map((p) => (p == null ? "" : String(p).trim())).filter(Boolean);
      const v = fromVerdictFor({
        bookFromDocType: bl.fromDocType,
        bookFromDocNo: bl.fromDocNo,
        bookFromLineKey: bl.fromSoDtlKey,
        erpHasLink: row.has_link === true,
        erpParentDocNo:
          parents.find((p) => up(p) === up(bl.fromDocNo)) ?? parents[0] ?? null,
        erpParentLineKey: row.parent_line_key == null ? null : String(row.parent_line_key).trim(),
      });
      tally.set(v, (tally.get(v) ?? 0) + 1);
      if (IS_DIFFERENCE.has(v)) {
        diffs.push({ v, key, row, bl, parents });
      }
    }

    say("\n── 1. VERDICT TALLY on the PI transfer-chain edge (the report's own classifier)");
    for (const [v, n] of [...tally].sort((a, b) => b[1] - a[1])) {
      say(`   ${String(n).padStart(5)}  ${v}${IS_DIFFERENCE.has(v) ? "   <- counted as a DIFFERENCE" : ""}`);
    }
    say(`   ${String(unkeyed).padStart(5)}  (skipped: our line carries no book line key)`);
    say(`   ${String(keyNotInBook).padStart(5)}  (skipped: line key not in the book snapshot)`);
    say(`   ${String(cancelledSkipped).padStart(5)}  (skipped: the book's invoice is cancelled)`);
    const diffDocs = new Set(diffs.map((d) => String(d.row.ac_no ?? "").trim()));
    say(`\n   ${diffs.length} differing line(s) across ${diffDocs.size} invoice(s)`);

    /* ── 2. THE SUB-CAUSE, per differing line ──────────────────────────── */
    const sub = new Map();
    const bump = (k) => sub.set(k, (sub.get(k) ?? 0) + 1);
    const grnDocGaps = new Map(); // erp grn_number -> {bookWants:Set, lines:n}

    for (const d of diffs) {
      if (d.v === "erp_link_missing") {
        bump("A. purchase_invoice_items.grn_item_id IS NULL (we point at no receipt line)");
        continue;
      }
      if (d.v === "doc_differs") {
        /* We DO hold a receipt line. Which column made the presented parent
           the purchase order rather than the receipt? parent_a is the
           receipt's `linked_ac_gr_docno` and it is the only one that can be
           blank while the link itself exists. */
        const hasGrDoc = d.row.parent_a != null && String(d.row.parent_a).trim() !== "";
        if (!hasGrDoc) {
          bump("B. scm.grns.linked_ac_gr_docno IS NULL (the receipt does not name its book receipt)");
          /* KEYED ON THE INVOICE LINE'S id, NOT on `erp_no`. On this edge
             `erp_no` is the INVOICE number (`h.invoice_number` in the PI arm of
             chainEdges), and the first version of this diagnostic keyed the
             receipt lookup on it — so it asked scm.grns for `HC-PI-007927`,
             matched nothing, and printed NO-ROW for all 20. The receipt is
             reached from the line, below. */
          const k = String(d.row.id ?? "");
          if (!k) { bump("B (unkeyed: the edge returned no line id)"); continue; }
          if (!grnDocGaps.has(k)) grnDocGaps.set(k, { wants: new Set(), lines: 0, invoice: String(d.row.erp_no ?? "?") });
          grnDocGaps.get(k).wants.add(String(d.bl.fromDocNo ?? "").trim());
          grnDocGaps.get(k).lines += 1;
        } else {
          bump(`C. we name a receipt, but a DIFFERENT one than the book (real disagreement)`);
        }
        continue;
      }
      bump(`D. ${d.v}`);
    }
    say("\n── 2. SUB-CAUSE of each differing line — the column that would have to change");
    for (const [k, n] of [...sub].sort((a, b) => b[1] - a[1])) say(`   ${String(n).padStart(5)}  ${k}`);

    /* ── 3. WORLD A OR WORLD B, per receipt ────────────────────────────── */
    say("\n── 3. FOR CAUSE B: is the receipt the book's receipt, or ERP-native?");
    say("   (stamping a book receipt number onto an ERP-native receipt would INVENT a link)");
    if (grnDocGaps.size === 0) {
      say("   nothing lands on cause B on this cut.");
    } else {
      /* Walk the LINE to its receipt: invoice line -> grn_item -> grn. This is
         the join the chain edge already makes; it simply does not project the
         receipt's own number, only its `linked_ac_gr_docno` (which is the NULL
         being investigated). */
      const ids = [...grnDocGaps.keys()];
      const facts = await sql`
        SELECT pii.id::text AS line_id, g.grn_number, g.created_at, g.status::text AS status,
               COALESCE(g.migrated_no_stock, false) AS migrated_no_stock,
               g.linked_ac_gr_docno, p.linked_ac_docno AS po_doc,
               (SELECT count(*)::int FROM scm.inventory_movements m
                 WHERE m.company_id = g.company_id AND m.source_doc_no = g.grn_number) AS movements,
               array_remove(p.linked_ac_grn_docnos, NULL) AS po_named_receipts
          FROM scm.purchase_invoice_items pii
          JOIN scm.grn_items gi ON gi.id = pii.grn_item_id
          JOIN scm.grns g ON g.id = gi.grn_id
          LEFT JOIN scm.purchase_orders p ON p.id = g.purchase_order_id
         WHERE pii.id = ANY(${ids}::uuid[])
         ORDER BY g.grn_number`;
      const byNo = new Map(facts.map((f) => [f.line_id, f]));
      /* CLASSIFY EVERY LINE FIRST, then print at most SHOW of them. These used
         to be one loop over `.slice(0, SHOW)`, so the three counters below
         described only the rows that fitted on screen while the denominator
         beside them (`grnDocGaps.size`) described all of them. On 2026-09-09
         the same tree answered "59 lines · 40 derivable · 0 NOT-ON-PO · 0
         NO-ROW" at SHOW=40 and "59 · 59 · 0 · 0" at SHOW=300 — the first reads
         as 19 lines nobody can account for, and it is a display setting.
         A verdict must never depend on how much of it was printed. */
      const classified = [...grnDocGaps].map(([lineId, g]) => {
        const f = byNo.get(lineId);
        /* THE EVIDENCE THAT SEPARATES THE TWO WORLDS. stamp-ac-grn-refs.mjs put
           the book's receipt numbers on the purchase order; if the receipt the
           book's invoice names is one of THEM, the receipt is the book's and the
           only thing missing is the stamp. If it is not, we are looking at a
           receipt the book never raised against this order. */
        const onPo = (f?.po_named_receipts ?? []).map(up);
        const wantedOnPo = [...g.wants].some((w) => onPo.includes(up(w)));
        const verdict = wantedOnPo
          ? (f?.migrated_no_stock ? "DERIVABLE" : "DERIVABLE?")
          : (f ? "NOT-ON-PO" : "NO-ROW");
        return { g, f, verdict };
      });
      const derivable = classified.filter((c) => c.verdict.startsWith("DERIVABLE")).length;
      const native = classified.filter((c) => c.verdict === "NOT-ON-PO").length;
      const unclear = classified.filter((c) => c.verdict === "NO-ROW").length;
      /* The three buckets are the whole set or the classifier grew a fourth
         answer nobody counted. Refusing beats printing a summary that does not
         add up. */
      if (derivable + native + unclear !== classified.length) {
        bad(`cause B: ${classified.length} line(s) classified but the buckets hold `
          + `${derivable + native + unclear} — a verdict is going uncounted.`);
      }
      say("");
      say(`   ${"ERP receipt".padEnd(22)} ${"invoice".padEnd(16)} ${"book wants".padEnd(22)} ${"PO".padEnd(12)} ${"verdict".padEnd(12)} migrated moves created`);
      for (const { g, f, verdict } of classified.slice(0, SHOW)) {
        const erpNo = f?.grn_number ?? "(no receipt row)";
        const wants = [...g.wants].join(",");
        say(`   ${String(erpNo).padEnd(22)} ${String(g.invoice).padEnd(16)} ${wants.slice(0, 21).padEnd(22)} ${String(f?.po_doc ?? "?").padEnd(12)} ` +
            `${verdict.padEnd(12)} ${String(f?.migrated_no_stock ?? "?").padEnd(8)} ${String(f?.movements ?? "?").padEnd(5)} ` +
            `${f?.created_at ? new Date(f.created_at).toISOString().slice(0, 10) : "?"}`);
      }
      if (grnDocGaps.size > SHOW) {
        say(`   … and ${grnDocGaps.size - SHOW} more NOT PRINTED (raise SHOW). `
          + "The counts below cover every line, printed or not.");
      }
      say(`\n   invoice lines on cause B: ${grnDocGaps.size} · the book's receipt IS stamped on their PO: ${derivable} ` +
          `· NOT on the PO: ${native} · no receipt row read: ${unclear}`);
      /* A line whose book side names SEVERAL receipts cannot be settled by
         stamping one number, whatever the rest of the evidence says. Counted
         separately so it is never mistaken for a derivable one. */
      const multi = [...grnDocGaps.values()].filter((g) => [...g.wants].some((w) => /[,;\s]/.test(w))).length;
      say(`   of those, the book names SEVERAL source receipts on the line: ${multi} — ` +
          "one stamp cannot answer those, whatever else is true of them");
      say("   DERIVABLE means stamp-ac-grn-refs.mjs already recorded that receipt number against this");
      say("   purchase order, so naming it on the receipt states a fact we already hold.");
    }

    /* ── 4. FOR CAUSE A: what the book says raised the unlinked lines ──── */
    say("\n── 4. FOR CAUSE A: the receipts the book names for lines we link to nothing");
    const linkMissing = diffs.filter((d) => d.v === "erp_link_missing");
    if (linkMissing.length === 0) {
      say("   nothing lands on cause A on this cut.");
    } else {
      const byInvoice = new Map();
      for (const d of linkMissing) {
        const k = String(d.row.erp_no ?? "?");
        if (!byInvoice.has(k)) byInvoice.set(k, []);
        byInvoice.get(k).push(d);
      }
      say(`   ${linkMissing.length} line(s) across ${byInvoice.size} invoice(s)`);
      /* Does the book name ONE source document per line, and is it a receipt we
         hold? That is the whole feasibility question for a PI->GR line matcher.
         Counted, not eyeballed. */
      const held = new Set(
        (await sql`SELECT DISTINCT upper(linked_ac_gr_docno) AS d FROM scm.grns
                    WHERE company_id = ${CO} AND status <> 'CANCELLED'
                      AND linked_ac_gr_docno IS NOT NULL`).map((r) => r.d),
      );
      let oneSource = 0; let multi = 0; let none = 0; let sourceHeld = 0; let sourceNotHeld = 0;
      for (const d of linkMissing) {
        const toks = up(d.bl.fromDocNo).split(/[,;\s]+/).filter(Boolean);
        if (toks.length === 0) none += 1;
        else if (toks.length > 1) multi += 1;
        else {
          oneSource += 1;
          if (held.has(toks[0])) sourceHeld += 1; else sourceNotHeld += 1;
        }
      }
      say(`   the book names exactly ONE source document: ${oneSource} · several: ${multi} · none: ${none}`);
      say(`   of the single-source lines, we HOLD that receipt: ${sourceHeld} · we do not: ${sourceNotHeld}`);
      say("   only the 'we hold it' rows are candidates for a line matcher; the rest are scope, not doubt.");
      say("");
      for (const [inv, ds] of [...byInvoice].slice(0, SHOW)) {
        say(`   ${inv.padEnd(24)} ${ds.length} line(s): ` +
            [...new Set(ds.map((d) => up(d.bl.fromDocNo) || "(nothing)"))].join(", "));
      }
      if (byInvoice.size > SHOW) say(`   … and ${byInvoice.size - SHOW} more (raise SHOW)`);
    }

    /* ── 5. THE SIDE EFFECT NOBODY ASKED FOR ───────────────────────────── */
    say("\n── 5. WHAT STAMPING linked_ac_gr_docno WOULD DO TO THE GOODS-RECEIPT AXIS");
    say("   `linked_ac_gr_docno IS NOT NULL` is the filter that puts a receipt INTO the GR");
    say("   comparison (lib/ac-reconcile-erp-sql.mjs) and into ONWARD_COVERAGE.GR. Stamping it");
    say("   therefore ADDS documents to a population, and a repair that fixes PI by making GR");
    say("   worse has to say so out loud before it runs.");
    const [pop] = await sql`
      SELECT count(*) FILTER (WHERE linked_ac_gr_docno IS NOT NULL)::int AS in_scope,
             count(*) FILTER (WHERE linked_ac_gr_docno IS NULL)::int     AS out_of_scope,
             count(*)::int AS total
        FROM scm.grns WHERE company_id = ${CO} AND status <> 'CANCELLED'`;
    say(`   scm.grns (company ${CO}, not cancelled): ${pop.total} total · ${pop.in_scope} in the GR comparison ` +
        `· ${pop.out_of_scope} outside it`);
    if (grnDocGaps.size) {
      say(`   this repair would move ${grnDocGaps.size} receipt(s) from outside into the GR comparison.`);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
