#!/usr/bin/env node
/* Read-only: how much live sales-order demand carries NO delivery date, and what
   SHAPE that population has — for BOTH companies.

   WHY. The MRP page hides undated demand by default (Commander 2026-05-29 — an
   undated line is not ready to order). Measured against production on
   2026-08-16 for company 2 (2990), the default view returned 82 of 163 live
   SO-item ids and 8 of 68 short sofa sets: half the book, removed in silence.
   The owner: "明明这个东西没有 ready,可是我的 MRP 却 show 不出来."

   The DISPLAY half of that is fixed in the same PR as this script (the page now
   states what it is hiding). This probe answers the OTHER question the owner
   asked and explicitly did NOT want fixed here: WHY is so much of the book
   undated in the first place? Whether the field should become required is his
   call, and it needs the shape first. Company 2 was measured at 43% by hand;
   company 1 (HOUZS) has never been measured and is the larger book.

   THE HYPOTHESIS THIS TESTS, and what would refute it.

     H: the undated orders are LEGITIMATE. A delivery date is optional at
        create by design — the rule is both-or-neither, and NEITHER is legal:
          server  src/scm/shared/so-save-problems.ts:160,171 — a delivery date
                  is demanded only `if (facts.procDate && facts.completeness)`,
                  i.e. only once a Processing Date exists.
          client  frontend/src/vendor/scm/lib/so-form-validate.ts:93 — refuses
                  one-without-the-other, permits neither.
        So an order taken before the customer commits to a date saves cleanly on
        every path, and the population should look ORDINARY: spread across
        statuses, creators and months, with processing_date null too.

     REFUTED IF any of these turns up — each names a different real cause:
       (a) undated headers that DO carry a processing_date. That pair is refused
           on save, so something is writing around the form (an import, a direct
           API call, a trigger).
       (b) a concentration in ONE creator or ONE created_at window — an import
           or a migration cleared the field rather than users never filling it.
       (c) headers with no date whose LINES carry one (or the reverse). Then the
           field is not "unset", it is unset in the wrong place, and MRP's
           `line_delivery_date ?? header` read is what makes it invisible.

   MRP'S OWN DEFINITION IS THE ONE THAT COUNTS. `mrp.ts` reads a line as dated
   iff `line_delivery_date ?? so.customer_delivery_date` is non-null, so section
   A measures LINES that way — that, not the header count, is the population the
   page hides. Live = header status NOT IN the shared terminal set + line not
   cancelled + qty > 0, matching computeMrp's own demand filter.

   Writes NOTHING: every statement is a SELECT, there is no transaction, and no
   DDL. RE-RUN: idempotent — reading it twice changes nothing and gives the same
   answer for the same database. */
import postgres from "postgres";
import { SO_TERMINAL_STATES } from "./lib/so-terminal-states.mjs";

const sql = postgres(process.env.DATABASE_URL, { ssl: "require", prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(1)}%` : "n/a");

/* 1 = HOUZS, 2 = 2990. Both, always: the 2026-08-16 measurement covered only
   2990, and a one-company answer to a two-company question is how this repo
   keeps producing confident wrong numbers. */
const COMPANIES = [
  [1, "HOUZS"],
  [2, "2990"],
];

/** A column this probe would LIKE but must not assume. A missing one is
    reported as missing — never silently skipped, which would read as a clean
    section that simply never ran. */
async function hasColumn(schema, table, column) {
  const [r] = await sql`
    SELECT count(*)::int AS n FROM information_schema.columns
     WHERE table_schema = ${schema} AND table_name = ${table} AND column_name = ${column}`;
  return r.n > 0;
}

async function perCompany(companyId, label) {
  note(`\n${"=".repeat(72)}`);
  note(`COMPANY ${companyId} — ${label}`);
  note("=".repeat(72));

  /* ── A. What MRP hides: LINES undated by MRP's own rule ─────────────────── */
  const [lines] = await sql`
    SELECT count(*)::int AS live,
           count(*) FILTER (WHERE i.line_delivery_date IS NULL
                              AND h.customer_delivery_date IS NULL)::int AS undated
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
     WHERE h.company_id = ${companyId}
       AND i.cancelled = false
       AND i.qty > 0
       AND UPPER(COALESCE(h.status::text,'')) <> ALL(${SO_TERMINAL_STATES})`;
  note(`\n=== A. Live SO LINES (MRP's demand set) ===`);
  note(`  live lines:                 ${lines.live}`);
  note(`  undated (no line, no hdr):  ${lines.undated}   ${pct(lines.undated, lines.live)}  <- what the MRP page hides by default`);

  /* ── B. The owner's 43%: headers with no delivery date ──────────────────── */
  const [hdr] = await sql`
    SELECT count(*)::int AS live,
           count(*) FILTER (WHERE customer_delivery_date IS NULL)::int AS undated
      FROM scm.mfg_sales_orders
     WHERE company_id = ${companyId}
       AND UPPER(COALESCE(status::text,'')) <> ALL(${SO_TERMINAL_STATES})`;
  note(`\n=== B. Live SO HEADERS ===`);
  note(`  live orders:                ${hdr.live}`);
  note(`  no customer_delivery_date:  ${hdr.undated}   ${pct(hdr.undated, hdr.live)}`);

  /* ── C(a). REFUTATION TEST — a processing date with no delivery date ─────
     The save path refuses this pair, so any row here was written around the
     form. Non-zero REFUTES "the field is simply optional". */
  const [xor] = await sql`
    SELECT count(*) FILTER (WHERE processing_date IS NOT NULL)::int AS with_proc,
           count(*) FILTER (WHERE processing_date IS NULL)::int     AS no_proc
      FROM scm.mfg_sales_orders
     WHERE company_id = ${companyId}
       AND UPPER(COALESCE(status::text,'')) <> ALL(${SO_TERMINAL_STATES})
       AND customer_delivery_date IS NULL`;
  note(`\n=== C(a). Of the undated headers, do any carry a PROCESSING date? ===`);
  note(`  neither date (legal save):  ${xor.no_proc}`);
  note(`  processing but NO delivery: ${xor.with_proc}   ${Number(xor.with_proc) ? "<- REFUTES 'just optional': the save path refuses this pair" : "(none — consistent with 'optional at create')"}`);

  /* ── C(c). REFUTATION TEST — is the date on the LINES instead? ───────────
     If the header is blank but a line carries a date, the value is not absent,
     it is in the other place; MRP's coalesce would then read the line as DATED
     and the header count would overstate what is hidden. */
  const [split] = await sql`
    SELECT count(*)::int AS hdr_null,
           count(*) FILTER (WHERE k.dated_lines > 0)::int AS some_line_dated,
           count(*) FILTER (WHERE k.dated_lines = 0)::int AS no_line_dated
      FROM scm.mfg_sales_orders h
      JOIN LATERAL (
        SELECT count(*) FILTER (WHERE i.line_delivery_date IS NOT NULL)::int AS dated_lines
          FROM scm.mfg_sales_order_items i
         WHERE i.doc_no = h.doc_no AND i.cancelled = false
      ) k ON true
     WHERE h.company_id = ${companyId}
       AND UPPER(COALESCE(h.status::text,'')) <> ALL(${SO_TERMINAL_STATES})
       AND h.customer_delivery_date IS NULL`;
  note(`\n=== C(c). Undated HEADER — is the date on the lines instead? ===`);
  note(`  header blank, some line dated: ${split.some_line_dated}   ${Number(split.some_line_dated) ? "<- these are NOT hidden by MRP (it coalesces line -> header)" : ""}`);
  note(`  header blank, no line dated:   ${split.no_line_dated}   <- genuinely undated`);

  /* ── C. by STATUS — where in the lifecycle they sit ──────────────────────
     An order still in NEW/PENDING with no date is a customer who has not
     committed; a CONFIRMED or PROCEEDED one with no date is a scheduling gap. */
  const byStatus = await sql`
    SELECT coalesce(status::text, '(null)') AS status,
           count(*)::int AS n,
           min(created_at)::date AS first_seen,
           max(created_at)::date AS last_seen
      FROM scm.mfg_sales_orders
     WHERE company_id = ${companyId}
       AND UPPER(COALESCE(status::text,'')) <> ALL(${SO_TERMINAL_STATES})
       AND customer_delivery_date IS NULL
     GROUP BY 1 ORDER BY n DESC`;
  note(`\n=== C. Undated live headers, by STATUS ===`);
  if (!byStatus.length) note(`  none`);
  for (const r of byStatus) {
    note(`  ${String(r.status).padEnd(14)} ${String(r.n).padStart(5)}   ${r.first_seen} .. ${r.last_seen}`);
  }

  /* ── C(b). REFUTATION TEST — one import window, or a steady trickle? ──── */
  const byMonth = await sql`
    SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS mon,
           count(*)::int AS undated,
           (SELECT count(*)::int FROM scm.mfg_sales_orders h2
             WHERE h2.company_id = ${companyId}
               AND UPPER(COALESCE(h2.status::text,'')) <> ALL(${SO_TERMINAL_STATES})
               AND date_trunc('month', h2.created_at) = date_trunc('month', h.created_at)) AS live_that_month
      FROM scm.mfg_sales_orders h
     WHERE h.company_id = ${companyId}
       AND UPPER(COALESCE(h.status::text,'')) <> ALL(${SO_TERMINAL_STATES})
       AND h.customer_delivery_date IS NULL
     GROUP BY 1, date_trunc('month', h.created_at)
     ORDER BY 1 DESC LIMIT 18`;
  note(`\n=== C(b). Undated live headers by CREATED month (newest first) ===`);
  note(`  month     undated / live-that-month   share`);
  for (const r of byMonth) {
    note(`  ${r.mon}   ${String(r.undated).padStart(5)} / ${String(r.live_that_month).padStart(5)}          ${pct(r.undated, r.live_that_month)}`);
  }
  note(`  (one spike = an import cleared them; a flat share = users never fill it)`);

  /* ── C(b). REFUTATION TEST — one creator, or everybody? ──────────────────
     The two shapes this can take are both guarded, because the probe cannot be
     run against a database before the owner dispatches it: if `created_by` is
     gone the section says so, and if `public.users` is gone it still reports
     the raw ids rather than dying on the join. A section that silently does not
     run is the failure mode CLAUDE.md names — green is not evidence until you
     know the check ran. */
  if (!(await hasColumn("scm", "mfg_sales_orders", "created_by"))) {
    note(`\n=== C(b). by CREATOR: NOT RUN — scm.mfg_sales_orders has no created_by column ===`);
  } else {
    const named = await hasColumn("public", "users", "email");
    const byWho = named
      ? await sql`
        SELECT coalesce(u.email, h.created_by::text, '(null — no creator recorded)') AS who,
               count(*)::int AS undated,
               max(h.created_at)::date AS last_seen
          FROM scm.mfg_sales_orders h
          -- ::text on BOTH sides: this probe has no local database to prove the
          -- two column types against, and a uuid-vs-text mismatch would fail the
          -- owner's dispatch for a diagnostic join. Text compares either way.
          LEFT JOIN public.users u ON u.id::text = h.created_by::text
         WHERE h.company_id = ${companyId}
           AND UPPER(COALESCE(h.status::text,'')) <> ALL(${SO_TERMINAL_STATES})
           AND h.customer_delivery_date IS NULL
         GROUP BY 1 ORDER BY undated DESC LIMIT 12`
      : await sql`
        SELECT coalesce(h.created_by::text, '(null — no creator recorded)') AS who,
               count(*)::int AS undated,
               max(h.created_at)::date AS last_seen
          FROM scm.mfg_sales_orders h
         WHERE h.company_id = ${companyId}
           AND UPPER(COALESCE(h.status::text,'')) <> ALL(${SO_TERMINAL_STATES})
           AND h.customer_delivery_date IS NULL
         GROUP BY 1 ORDER BY undated DESC LIMIT 12`;
    note(`\n=== C(b). Undated live headers by CREATOR ${named ? "" : "(raw ids — public.users.email not found)"} ===`);
    for (const r of byWho) {
      note(`  ${String(r.who).padEnd(40)} ${String(r.undated).padStart(5)}   last ${r.last_seen}`);
    }
    note(`  ((null) or one service account dominating = written by an import, not typed)`);
  }

  /* ── Still being produced? A rule that only grandfathers old rows is enough
        when nothing is adding to the pile; if this week is adding, making the
        field required would start refusing live work. */
  const [recent] = await sql`
    SELECT count(*) FILTER (WHERE created_at > now() - interval '7 days')::int  AS d7,
           count(*) FILTER (WHERE created_at > now() - interval '30 days')::int AS d30
      FROM scm.mfg_sales_orders
     WHERE company_id = ${companyId}
       AND UPPER(COALESCE(status::text,'')) <> ALL(${SO_TERMINAL_STATES})
       AND customer_delivery_date IS NULL`;
  note(`\n=== Still being produced? ===`);
  note(`  undated live orders created in the last  7 days: ${recent.d7}`);
  note(`  undated live orders created in the last 30 days: ${recent.d30}`);
  note(`  ${Number(recent.d30) ? "<- STILL PRODUCED: making the field required would refuse live work, not just old rows" : "(historical only — a required-field flip would touch no new order)"}`);

  const eg = await sql`
    SELECT doc_no, status::text AS status, processing_date, created_at::date AS created
      FROM scm.mfg_sales_orders
     WHERE company_id = ${companyId}
       AND UPPER(COALESCE(status::text,'')) <> ALL(${SO_TERMINAL_STATES})
       AND customer_delivery_date IS NULL
     ORDER BY created_at DESC LIMIT 10`;
  note(`\n=== newest 10 undated live orders ===`);
  for (const r of eg) {
    note(`  ${String(r.doc_no).padEnd(20)} ${String(r.status ?? "-").padEnd(12)} proc=${r.processing_date ?? "-"}  created=${r.created}`);
  }
}

async function main() {
  note(`terminal (done) statuses excluded: ${SO_TERMINAL_STATES.join(", ")}`);
  for (const [id, label] of COMPANIES) await perCompany(id, label);
  note(`\nRead-only: every statement above is a SELECT. Nothing was written.`);
  await sql.end({ timeout: 5 });
}
main().catch(async (e) => {
  console.error("FAIL", e.message);
  await sql.end({ timeout: 5 });
  process.exit(1);
});
