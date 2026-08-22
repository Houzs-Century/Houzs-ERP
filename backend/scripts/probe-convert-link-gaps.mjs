#!/usr/bin/env node
/* Read-only: on every conversion chain, which downstream lines never named the
   source line they came from?

   WHY. Owner, 2026-08-21, two questions about ONE receipt:

     「然后我不是收货了吗？为什么是show PO outstanding？还显示ordered？」
     「为什么 AutoCount 这一边 GRN 是进不进去的？不是 convert 而已嘛？」

   then, on being shown the mechanism: 「你要看 DO SI PI 也是」. He is right —
   it is one column repeated four times.

   ── THE COLUMN ───────────────────────────────────────────────────────────
   Every downstream document's line carries the id of the source line it was
   transferred from. `DOWNSTREAM` (src/scm/lib/autocount-convert-lines.ts) is
   the system's own table of them, and it is IMPORTED here rather than copied —
   the same reuse-not-replication rule probe-so-stock-status-stale.yml follows,
   and the one thing in this probe that could silently drift.

     DO  delivery_order_items.so_item_id             -> mfg_sales_order_items
     GR  grn_items.purchase_order_item_id            -> purchase_order_items
     IV  sales_invoice_items.do_item_id              -> delivery_order_items
     PI  purchase_invoice_items.grn_item_id          -> grn_items

   NULL there is legitimate: it means an ad-hoc line the operator added by hand,
   with no counterpart upstream. Every "new document" form offers that — the New
   GRN form's dashed "Add another item" button is the one the owner hit
   (`GrnNew.tsx:15-16`). The line is not a defect. What it COSTS is:

   ── WHAT AN UNLINKED LINE COSTS ──────────────────────────────────────────
   1. THE CONVERSION HAS NOTHING TO NAME. `readConvertSourceKeys` resolves which
      source lines a conversion took from this exact column. With none, the
      document is recorded as parentless and never sent — and the module header
      states the danger of the other direction plainly: a conversion that names
      no lines is NOT refused by AutoCount, the service falls back to every
      still-outstanding line on the source, so the book moves stock the ERP
      never moved and the outbox row still reads `sent`.

   2. THE ALREADY-CONVERTED CEILING CANNOT SEE IT. The owner's 2026-08-10 rule
      is a running total, not a flag: `Σ converted + this ≤ source qty`
      (`convert-ceilings.test.ts`). Both halves count through this column —
      `soDeliverableRemaining` sums DO lines by `so_item_id`, `doLineRemaining`
      sums invoiced by `do_item_id`. A line that carries none is not in the sum,
      so the SOURCE still reads as unconverted and can be converted AGAIN.

   3. ON THE PURCHASE SIDE ONLY, A STORED COUNTER STOPS MOVING. The sales chain
      derives live; the purchase chain reads `purchase_order_items.received_qty`,
      written by `recomputePoReceived`, whose first act is to drop every null
      link (`routes/grns.ts:844`). MRP calls a PO line outstanding while
      `qty > received_qty` (`routes/mrp.ts:862`). That is the owner's exact
      symptom: goods in the warehouse, order still open, `ordered` still on the
      board.

   ── THE COMPLEMENT OF diag-po-receipt-drift ──────────────────────────────
   That probe asks whether a PO line's stored `received_qty` still agrees with
   the GRN lines that received against it, and its first clause is
   `WHERE gi.purchase_order_item_id IS NOT NULL`
   (`diag-po-receipt-drift.mjs:42`). An unlinked line is invisible to it BY
   CONSTRUCTION — there is no disagreement to find when the line was never in
   the sum. It watches the linked-but-recount-failed route; this watches the
   never-linked route, on all four chains, which nothing watched.

   ── WHAT IT DOES NOT MEASURE ─────────────────────────────────────────────
   · It does not decide whether any single unlinked line is WRONG. A hand-added
     line is a legitimate operator action. The counts are a population, and the
     ALL / MIXED / NONE split is the shape a decision needs — not a defect list.
   · The "and the source is still open" figure for GR matches on
     (supplier, item_code) only, ignoring variants. It cannot know which PO line
     the operator meant, so it is an UPPER bound and is labelled one.
   · It says nothing about batch_no. An earlier hypothesis of mine blamed the
     batch bucket; the paths above are the ones the code actually takes.

   Read-only: SELECTs only. No DDL, no writes, no transaction, no lock. Exits 0
   for every legitimate answer, including zero findings; non-zero only if the
   database could not answer. */
import postgres from "postgres";
import { DOWNSTREAM } from "../src/scm/lib/autocount-convert-lines.ts";

/* Before anything else. A missing connection string surfaced as four empty
   per-chain "NOT MEASURED --" lines reads as four unrelated hiccups; it is
   one answerable fact, said once, and it is not a legitimate answer. */
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set - the database cannot be asked. Nothing was measured.");
  process.exit(1);
}

const sql = postgres(process.env.DATABASE_URL, { ssl: "require", prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const CO = process.env.COMPANY ? Number(process.env.COMPANY) : null;
const ONE_DOC = (process.env.DOC ?? "").trim();

const pct = (n, d) => (d === 0 ? "—" : `${((n / d) * 100).toFixed(1)}%`);
const pad = (s, w) => String(s).padEnd(w);
const rpad = (s, w) => String(s).padStart(w);

/* postgres.js throws some errors with an EMPTY message, and "NOT MEASURED --"
   with nothing after it says nothing at all. Name the error class when the
   message is blank, so every unmeasured line carries something actionable. */
const why = (e) => {
  const m = String(e?.message ?? "").trim();
  const code = e?.code ? ` [${e.code}]` : "";
  return (m || e?.name || e?.constructor?.name || "unknown error") + code;
};

/* THE CHAINS ARE THE PROBE. The first version tracked "did anything at all get
   measured", and the first prod run exited GREEN with all four chains failing on
   an enum cast, because the incidental RECOUNT_FAILED section had answered. A
   green run whose entire subject is NOT MEASURED is the one wrong answer
   available, so the count that decides the exit code is the CHAIN count. */
let chainsMeasured = 0;
const CHAIN_KEYS = ["DO", "GR", "IV", "PI"];

/* The human document-number COLUMN per chain. `DOWNSTREAM` carries `docNoOf`, a
   FUNCTION, which SQL cannot use — so the name is written here and then PROVED
   against the spec below rather than trusted. */
const DOC_NO_COL = {
  DO: "do_number",
  GR: "grn_number",
  IV: "invoice_number",
  PI: "invoice_number",
};

/* What an unlinked line costs on THIS chain, in the operator's vocabulary. Only
   the purchase chain has a stored counter to stop moving; saying so per chain
   keeps the report from implying the sales side has one too. */
const COST = {
  DO: "the sales order still reads as undelivered, so it can be delivered again",
  GR: "purchase_order_items.received_qty never moves — MRP keeps the order open",
  IV: "the delivery order still reads as uninvoiced, so it can be invoiced again",
  PI: "the goods receipt still reads as unbilled, so it can be billed again",
};

const CHAIN_LABEL = {
  DO: "SO -> DO   delivery order",
  GR: "PO -> GR   goods receipt",
  IV: "DO -> IV   sales invoice",
  PI: "GR -> PI   purchase invoice",
};

/* PROVE the column name is the one the spec reads, instead of asserting it in a
   comment: hand docNoOf an object carrying ONLY that key and check it comes
   back. A rename upstream turns this into a loud line, not a silent zero. */
function verifyDocNoCols() {
  const bad = [];
  for (const [k, spec] of Object.entries(DOWNSTREAM)) {
    const col = DOC_NO_COL[k];
    let got;
    try { got = spec.docNoOf({ [col]: "__PROBE__" }); } catch { got = "(threw)"; }
    if (got !== "__PROBE__") bad.push(`${k}: DOWNSTREAM.${k}.docNoOf does not read '${col}' (got ${JSON.stringify(got)})`);
  }
  return bad;
}

async function main() {
  note("=== conversion link-gap probe (read-only) ===");
  note(`scope: ${CO == null ? "BOTH companies" : `company ${CO}`}`);
  if (ONE_DOC) note(`single document: ${ONE_DOC}`);
  note("");

  const specProblems = verifyDocNoCols();
  if (specProblems.length) {
    note("!! THE SPEC MOVED — read the numbers below with that in mind:");
    for (const p of specProblems) note(`   ${p}`);
    note("");
  } else {
    note("Document-number columns verified against DOWNSTREAM.docNoOf. ✓");
    note("");
  }

  const summary = [];

  for (const key of ["DO", "GR", "IV", "PI"]) {
    const spec = DOWNSTREAM[key];
    const { table, itemTable, itemFk, sourceFk, sourceItemTable, itemQtyCol } = spec;
    const docNo = DOC_NO_COL[key];

    note(`── ${CHAIN_LABEL[key]} ──`);
    note(`   ${itemTable}.${sourceFk} -> ${sourceItemTable}`);

    /* Cancelled and draft documents are excluded: they are not claiming to have
       moved anything, so an unlinked line on one is not a gap.

       `status::text` BEFORE the COALESCE, not after. These columns are ENUMs,
       and `COALESCE(enum, '')` coerces the '' literal INTO the enum type at PLAN
       time — '' is no label, so the whole statement raises 22P02 before a row is
       read. Migration 0155 fixed exactly this in fn_reconcile_dropship_batch,
       where it had been silently no-opping in production; the first run of this
       probe reproduced it on all four chains.

       The labels themselves are NOT defined in this repo (the enum types come
       from 2990's schema), so the filter list is not something this probe can
       verify. It therefore PRINTS the statuses it actually saw — a cancelled
       label under a name not in the list is then visible in the output instead
       of quietly inflating every count. */
    let rows;
    try {
      rows = await sql`
        SELECT h.${sql(docNo)}                       AS doc_no,
               h.company_id                          AS company_id,
               UPPER(COALESCE(h.status::text, ''))   AS status,
               COUNT(i.id)                           AS line_count,
               COUNT(i.${sql(sourceFk)})             AS linked_count
          FROM scm.${sql(table)} h
          LEFT JOIN scm.${sql(itemTable)} i ON i.${sql(itemFk)} = h.id
         WHERE UPPER(COALESCE(h.status::text, '')) NOT IN ('CANCELLED', 'DRAFT')
           ${CO == null ? sql`` : sql`AND h.company_id = ${CO}`}
         GROUP BY h.${sql(docNo)}, h.company_id, h.status
      `;
    } catch (e) {
      /* A chain this probe cannot read must SAY so. A silent skip reads as
         "no gaps on that chain", which is the one wrong answer available. */
      note(`   NOT MEASURED — ${why(e).slice(0, 140)}`);
      note("");
      summary.push({ key, unreadable: true });
      continue;
    }

    chainsMeasured++;
    const b = { ALL: 0, MIXED: 0, NONE: 0, EMPTY: 0 };
    for (const r of rows) {
      const lines = Number(r.line_count);
      const linked = Number(r.linked_count);
      if (lines === 0) b.EMPTY++;
      else if (linked === lines) b.ALL++;
      else if (linked === 0) b.NONE++;
      else b.MIXED++;
    }
    const total = rows.length;

    const seen = new Map();
    for (const r of rows) seen.set(r.status, (seen.get(r.status) ?? 0) + 1);
    note(`   documents                              ${rpad(total, 7)}`);
    /* The filter list is unverifiable from this repo, so show its input. */
    note(`   statuses counted: ${[...seen.entries()].map(([k, v]) => `${k || "(blank)"}=${v}`).join("  ") || "(none)"}`);
    note(`   statuses excluded: CANCELLED, DRAFT`);
    note(`   ALL lines linked                       ${rpad(b.ALL, 7)}  ${pct(b.ALL, total)}`);
    note(`   MIXED — some linked, some not          ${rpad(b.MIXED, 7)}  ${pct(b.MIXED, total)}`);
    note(`   NONE linked (hand-entered)             ${rpad(b.NONE, 7)}  ${pct(b.NONE, total)}`);
    note(`   EMPTY — no lines                       ${rpad(b.EMPTY, 7)}  ${pct(b.EMPTY, total)}`);

    /* Lines, not documents: a MIXED document's cost is measured in the lines
       that are missing, and one gap in a fifty-line receipt is not the same
       event as fifty. */
    let lineCounts = null;
    try {
      const [lc] = await sql`
        SELECT COUNT(*)                              AS lines,
               COUNT(*) FILTER (WHERE i.${sql(sourceFk)} IS NULL) AS unlinked,
               COALESCE(SUM(i.${sql(itemQtyCol)}) FILTER (WHERE i.${sql(sourceFk)} IS NULL), 0) AS unlinked_qty
          FROM scm.${sql(itemTable)} i
          JOIN scm.${sql(table)} h ON h.id = i.${sql(itemFk)}
         WHERE UPPER(COALESCE(h.status::text, '')) NOT IN ('CANCELLED', 'DRAFT')
           ${CO == null ? sql`` : sql`AND h.company_id = ${CO}`}
      `;
      lineCounts = lc;
      note(`   LINES  ${lc.unlinked} of ${lc.lines} carry no link  (${pct(Number(lc.unlinked), Number(lc.lines))}), ${lc.unlinked_qty} unit(s)`);
    } catch (e) {
      note(`   LINES  NOT MEASURED — ${why(e).slice(0, 100)}`);
    }
    note(`   cost of a gap: ${COST[key]}`);
    note("");

    summary.push({ key, total, ...b, lines: lineCounts });
  }

  /* ── The MRP symptom, GR only, as an UPPER bound ──────────────────────────
     The other three chains derive live, so "the source is still open" is not a
     stored fact there — the ALL/MIXED/NONE split above is the whole answer for
     them. This asks the extra question only where a stored counter exists.
     `open` is measured NOW: a PO line since closed by another receipt is not
     evidence of a missing rollup, and excluding it keeps the bound honest. */
  note("── The MRP symptom (PO -> GR only), as an UPPER bound ──");
  try {
    const orphans = await sql`
      WITH unlinked AS (
        SELECT i.item_code, i.qty_accepted, g.supplier_id, g.grn_number, g.company_id
          FROM scm.grn_items i
          JOIN scm.grns g ON g.id = i.grn_id
         WHERE i.purchase_order_item_id IS NULL
           AND UPPER(COALESCE(g.status::text, '')) NOT IN ('CANCELLED', 'DRAFT')
           AND COALESCE(i.qty_accepted, 0) > 0
           ${CO == null ? sql`` : sql`AND g.company_id = ${CO}`}
      )
      SELECT u.grn_number, u.item_code, u.qty_accepted,
             p.po_number, pi.qty, pi.received_qty,
             (pi.qty - COALESCE(pi.received_qty, 0)) AS still_open
        FROM unlinked u
        JOIN scm.purchase_order_items pi ON pi.item_code = u.item_code
        JOIN scm.purchase_orders p       ON p.id = pi.purchase_order_id
                                        AND p.supplier_id = u.supplier_id
                                        AND p.company_id  = u.company_id
       WHERE pi.qty - COALESCE(pi.received_qty, 0) > 0
         AND UPPER(COALESCE(p.status::text, '')) NOT IN ('CANCELLED', 'DRAFT', 'CLOSED')
       ORDER BY u.grn_number DESC, u.item_code
    `;
    const gs = new Set(orphans.map((r) => r.grn_number));
    note(`  hand-entered receipt lines whose supplier`);
    note(`  still has an OPEN PO line for that item  ${rpad(orphans.length, 7)}`);
    note(`  receipts involved                        ${rpad(gs.size, 7)}`);
    note("  UPPER BOUND: the match is (supplier, item_code) only. It cannot know");
    note("  the operator meant that PO line, and it ignores variants — both widen");
    note("  it, neither narrows it.");
    if (orphans.length) {
      note("");
      note(`    ${pad("RECEIPT", 20)}${pad("ITEM", 22)}${rpad("RECVD", 8)}  ${pad("OPEN PO", 20)}${rpad("ORDERED", 9)}${rpad("BOOKED", 8)}${rpad("OPEN", 8)}`);
      for (const r of orphans.slice(0, 15)) {
        note(`    ${pad(r.grn_number, 20)}${pad(r.item_code, 22)}${rpad(r.qty_accepted, 8)}  ${pad(r.po_number, 20)}${rpad(r.qty, 9)}${rpad(r.received_qty ?? 0, 8)}${rpad(r.still_open, 8)}`);
      }
      if (orphans.length > 15) note(`    ... and ${orphans.length - 15} more (not printed, not dropped)`);
    }
  } catch (e) {
    note(`  NOT MEASURED — ${why(e).slice(0, 140)}`);
    note("  Treat the per-chain splits above as the only measured answer.");
  }
  note("");

  /* ── Route B, for contrast: linked, but the recount failed ────────────────
     scm.entity_audit_log, entity_type 'GRN', action 'RECOUNT_FAILED' — the row
     postGrnAndRollup writes (grns.ts:471-484). A FLOOR: it sees only failures
     the failing code managed to record, which is why diag-po-receipt-drift
     compares state against the ledger instead. Reported so the two routes to an
     open PO stay visibly separate rather than one being assumed. */
  note("── Route B, for contrast: linked, but the recount failed ──");
  try {
    const rf = await sql`
      SELECT a.entity_doc_no, a.created_at, LEFT(COALESCE(a.note, ''), 150) AS note
        FROM scm.entity_audit_log a
       WHERE a.entity_type = 'GRN'
         AND a.action = 'RECOUNT_FAILED'
         ${CO == null ? sql`` : sql`AND a.company_id = ${CO}`}
       ORDER BY a.created_at DESC
       LIMIT 25
    `;
    note(`  RECOUNT_FAILED rows on receipts         ${rpad(rf.length, 7)}${rf.length === 25 ? "  (capped at 25)" : ""}`);
    note("  A FLOOR. For the authoritative answer on route B run");
    note("  diag-po-receipt-drift, which compares received_qty against the ledger.");
    for (const r of rf.slice(0, 10)) {
      note(`    ${pad(r.entity_doc_no ?? "(no number)", 20)}${String(r.created_at).slice(0, 19)}`);
      if (r.note) note(`      ${r.note}`);
    }
  } catch (e) {
    note(`  NOT MEASURED — ${why(e).slice(0, 140)}`);
  }
  note("");

  /* ── One named document, line by line ────────────────────────────────────
     The splits above are populations. For the document actually in front of the
     owner, print the lines and let a human read them. The number is searched on
     every chain, so he does not have to know which kind it is. */
  if (ONE_DOC) {
    note(`── ${ONE_DOC}, line by line ──`);
    let found = false;
    for (const key of ["DO", "GR", "IV", "PI"]) {
      const spec = DOWNSTREAM[key];
      const { table, itemTable, itemFk, sourceFk, itemQtyCol } = spec;
      const docNo = DOC_NO_COL[key];
      let rows;
      try {
        rows = await sql`
          SELECT h.status                        AS status,
                 h.created_at                    AS created_at,
                 i.item_code                     AS item_code,
                 i.${sql(itemQtyCol)}            AS qty,
                 i.${sql(sourceFk)}              AS source_id
            FROM scm.${sql(table)} h
            JOIN scm.${sql(itemTable)} i ON i.${sql(itemFk)} = h.id
           WHERE h.${sql(docNo)} = ${ONE_DOC}
             ${CO == null ? sql`` : sql`AND h.company_id = ${CO}`}
           ORDER BY i.item_code
        `;
      } catch { continue; }
      if (!rows.length) continue;
      found = true;
      note(`   found on the ${CHAIN_LABEL[key]} chain`);
      note(`   status ${rows[0].status}   created ${String(rows[0].created_at).slice(0, 19)}`);
      note("");
      note(`   ${pad("ITEM", 24)}${rpad("QTY", 8)}   LINKED TO A SOURCE LINE?`);
      for (const r of rows) {
        note(`   ${pad(r.item_code, 24)}${rpad(r.qty, 8)}   ${r.source_id ? "yes" : "— NO —"}`);
      }
      const unlinked = rows.filter((r) => !r.source_id).length;
      note("");
      note(`   ${unlinked} of ${rows.length} line(s) carry no link.`);
      if (unlinked) note(`   Cost: ${COST[key]}`);
      note("");
    }
    if (!found) {
      note(`   No document numbered ${ONE_DOC} on any chain in scope.`);
      note("   Check the number and the company.");
      note("");
    }
  } else {
    note("Pass DOC=<number> to print one document line by line (any chain).");
    note("");
  }

  note("── Summary ──");
  for (const s of summary) {
    if (s.unreadable) { note(`  ${pad(s.key, 4)} NOT MEASURED`); continue; }
    note(`  ${pad(s.key, 4)}${rpad(s.total, 6)} docs   ALL ${rpad(s.ALL, 5)}  MIXED ${rpad(s.MIXED, 5)}  NONE ${rpad(s.NONE, 5)}`);
  }
  note("");
  note("MIXED is the shape that decides the AutoCount question: a conversion can");
  note("name the linked lines with their real quantities, but the account book's");
  note("document would then be SHORT the hand-entered ones. That trade-off is a");
  note("business decision, and it needs these numbers first.");
  note("");
  note("=== end (read-only; nothing was written) ===");

  /* EXIT ZERO IS NOT SUCCESS. Zero findings is a legitimate answer; a chain that
     could not be READ is not an answer at all, and a partial read is not a
     clean run just because the sections that happened to work printed a number. */
  if (chainsMeasured < CHAIN_KEYS.length) {
    console.error(
      `Only ${chainsMeasured} of ${CHAIN_KEYS.length} chains could be read. ` +
      `This is NOT a clean result - see the NOT MEASURED lines above.`,
    );
    process.exitCode = 1;
  }
}

main()
  .then(() => sql.end())
  .catch(async (e) => {
    console.error(e);
    try { await sql.end(); } catch { /* connection already gone */ }
    /* Non-zero is reserved for "the database could not answer". Every
       legitimate result above exits 0, including zero findings. */
    process.exit(1);
  });
