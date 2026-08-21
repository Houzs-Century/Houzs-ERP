// Read-only census: how many CLOSED delivery orders carry no proof of delivery?
//
// WHY THIS EXISTS. A delivery order can be closed from several screens, and
// until 2026-08-21 only one of them — the driver's POD screen — attached the
// customer's signature, the delivery photo and the GPS fix. The shared status
// hook was typed `{ id, status }`, so evidence could not travel through it; the
// desktop detail page, the desktop list drawer and the delivery-planning board
// all closed deliveries with no evidence and no warning. That is fixed forward.
//
// This answers the BACKWARD question, which is a different one and cannot be
// answered by reading code: how many already-closed deliveries have no
// customer-side proof, and are they concentrated anywhere? The number decides
// whether a backfill conversation is worth having. It does not perform one, and
// nothing here writes: a missing row IS the finding.
//
// STRICTLY READ-ONLY. One SELECT, no DDL, no writes, no transaction, manual
// trigger only. Exits 0 for every legitimate answer — including "none", which
// would be the happy one — because a red job reads as "the check broke" and the
// ANSWER is the output. Only an unreachable database exits non-zero.
//
// ── WHAT COUNTS AS "CLOSED", AND WHY IT IS NOT JUST 'DELIVERED' ─────────────
// The delivered bucket is SIGNED + DELIVERED + INVOICED (see
// src/scm/shared/do-shipped-states.ts and docs/modules/delivery-order.md). All
// three count as delivered downstream and all three satisfy the Sales-Invoice
// gate, so a delivery parked at SIGNED is just as closed — and the mobile
// shell's "Mark Signed" writes exactly that with no evidence at all. Counting
// only DELIVERED would have under-reported the hole by the whole SIGNED
// population and made the fix look more complete than it is.
//
// ── WHY SIGNATURE LENGTH IS REPORTED, NOT JUST NULL/NOT-NULL ────────────────
// `signature_data IS NOT NULL` OVERSTATES the evidence, and by a lot. Until the
// `hasSignature` fix, MobilePOD gated the signature on `canvas.toDataURL()` —
// which returns a perfectly valid non-empty PNG for an untouched, fully
// transparent pad. So every delivery confirmed on that screen stored a BLANK
// image, indistinguishable from a real POD that failed to render. A blank pad
// compresses to a very small PNG; a drawn signature does not. Reporting the
// byte length bucket is the only way to tell the two apart from here, and
// calling those rows "signed" without it would be exactly the sort of
// unfalsifiable claim this repo keeps having to retract.
//
// The 2,000-byte threshold is a REPORTING boundary, not a verdict: it separates
// "too small to be a drawn signature" from "plausibly one". Rows near it should
// be looked at, not trusted either way.
//
// ── WIDENED 2026-08-21, BECAUSE THE CLOSED-ONLY VIEW ANSWERS A NARROWER
//    QUESTION THAN THE ONE PEOPLE READ OFF IT ──────────────────────────────
// The first dispatch (run 32398425742) printed one row — company 2, DELIVERED,
// 12 closed, 0 drawn — and that was read as "no delivery in this system has
// ever stored a customer signature". It does not say that. It says no CLOSED
// delivery has. A signature sitting on a row that never reached a closed state
// would be invisible to it, and so would a signature stored in either of the
// two OTHER tables in this database that carry proof-of-delivery columns.
//
// Five sections now, and each exists because the previous one's successful
// result would ALSO be true of something else:
//
//   1  closed delivery orders, by company and status   (the original question)
//   2  EVERY delivery order, every status, all time    (has the column ever
//      been written at all — and what is the denominator)
//   3  scm.consignment_delivery_orders + public.trip_stops (the other two
//      places a proof of delivery could be)
//   4  of the closed rows, how many were created ALREADY closed by the
//      AutoCount import — an imported row never passed a capture screen, so
//      counting it as "evidence missing" invents a hole nobody dug
//   5  every closed row listed in closing order, with its company NAME — the
//      spread of the closing timestamps separates many doorstep deliveries
//      from one person clearing a backlog from a desk
//
// What NONE of them can tell you: which of the five closing screens was used.
// The status route writes no audit row, so that fact is not in this database.
// Do not infer it from these numbers.
import { readFileSync } from "node:fs";
import postgres from "postgres";

function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    return readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/)?.[1];
  } catch {
    return undefined;
  }
}

const url = resolveUrl();
if (!url) {
  console.error("DATABASE_URL not set (env var or .dev.vars). Aborting.");
  process.exit(1);
}

const notice = (msg) =>
  console.log(process.env.GITHUB_ACTIONS ? `::notice::${msg}` : msg);

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

try {
  /* ONE statement. Grouped by company AND status because the two tenants got
     here by different routes and the remedy differs: 2990's deliveries were
     IMPORTED from a source system that has no POD step at all (nothing was
     ever lost — there was never anything to capture), while HOUZS rows were
     closed through screens that HAD a capture path and skipped it. A single
     total would blend a data-migration artefact with a live product gap and
     invite a backfill against rows that can never be backfilled. */
  const rows = await pg`
    SELECT company_id,
           status,
           count(*)::int                                                          AS closed,
           count(*) FILTER (
             WHERE signature_data IS NULL AND pod_r2_key IS NULL AND pod_lat IS NULL
           )::int                                                                 AS no_evidence_at_all,
           count(*) FILTER (WHERE length(signature_data) >= 2000)::int             AS signature_drawn,
           count(*) FILTER (
             WHERE signature_data IS NOT NULL AND length(signature_data) < 2000
           )::int                                                                 AS signature_suspect_blank,
           count(*) FILTER (WHERE pod_r2_key IS NOT NULL)::int                     AS has_photo,
           count(*) FILTER (WHERE pod_lat IS NOT NULL)::int                        AS has_gps,
           min(COALESCE(delivered_at, signed_at))                                  AS oldest,
           max(COALESCE(delivered_at, signed_at))                                  AS newest
      FROM scm.delivery_orders
     /* Cast to text rather than calling upper() on the column. status is the
        scm.do_status ENUM and Postgres has no upper() overload for it — the
        first dispatch of this script died on exactly that:
          POD census failed to read the database:
          function upper(scm.do_status) does not exist
        The enum labels are already upper-case, so the cast alone is enough.
        (No back-ticks in this comment: it sits inside a tagged template
        literal, where one would end the template and break the parse. That
        was the SECOND failed dispatch.) */
     WHERE status::text IN ('SIGNED', 'DELIVERED', 'INVOICED')
     GROUP BY company_id, status
     ORDER BY company_id, status
  `;

  if (rows.length === 0) {
    notice("No closed delivery orders at all. Nothing to report.");
    process.exit(0);
  }

  const sum = (k) => rows.reduce((n, r) => n + Number(r[k] ?? 0), 0);
  const closed = sum("closed");
  const bare = sum("no_evidence_at_all");
  const drawn = sum("signature_drawn");
  const suspect = sum("signature_suspect_blank");

  console.log("\nCLOSED DELIVERY ORDERS (SIGNED + DELIVERED + INVOICED)");
  console.log("company                              status      closed   none  drawn  blank?  photo    gps");
  for (const r of rows) {
    console.log(
      `${String(r.company_id ?? "(null)").padEnd(36)} ${String(r.status).padEnd(11)}` +
        `${String(r.closed).padStart(7)}${String(r.no_evidence_at_all).padStart(7)}` +
        `${String(r.signature_drawn).padStart(7)}${String(r.signature_suspect_blank).padStart(8)}` +
        `${String(r.has_photo).padStart(7)}${String(r.has_gps).padStart(7)}`,
    );
  }

  console.log("\nRANGE (oldest → newest close, per group)");
  for (const r of rows) {
    console.log(
      `  ${String(r.company_id ?? "(null)").padEnd(36)} ${String(r.status).padEnd(11)}` +
        ` ${r.oldest ? new Date(r.oldest).toISOString().slice(0, 10) : "—"}` +
        ` → ${r.newest ? new Date(r.newest).toISOString().slice(0, 10) : "—"}`,
    );
  }

  const pct = closed === 0 ? 0 : Math.round((bare / closed) * 1000) / 10;
  notice(
    `POD census: ${bare} of ${closed} closed delivery orders carry NO evidence ` +
      `(no signature, no photo, no GPS) — ${pct}%. ` +
      `${drawn} carry a signature long enough to be a real drawing; ` +
      `${suspect} carry one too short to be (likely the blank-pad bug).`,
  );

  /* ── SECTION 2 — THE WIDER QUESTION THE CLOSED-ONLY CENSUS CANNOT ANSWER ───
     Section 1 counts only SIGNED/DELIVERED/INVOICED, so `drawn = 0` there is
     compatible with two very different worlds: nobody has ever drawn a
     signature, OR signatures exist on rows that never reached a closed state.
     "Has this feature EVER produced a row" is a question about the whole table,
     and it is the question that decides whether the write path has ever worked.

     It also prints the DENOMINATOR the closed-only view hides: how many
     delivery orders exist at all. Twelve closed rows read as a catastrophe next
     to 10,000 deliveries and as "the module is barely used" next to 20.

     migrated_no_stock (mig 0276) is counted because it is the only column that
     PROVES the import hypothesis. A one-day date range LOOKS like an import;
     this flag says so. An imported row never had a capture step, so it can
     never be backfilled and must not be blended into a product-gap number. */
  const all = await pg`
    SELECT company_id,
           status::text                                                          AS status,
           count(*)::int                                                          AS rows,
           count(*) FILTER (WHERE signature_data IS NOT NULL)::int                AS sig_any,
           count(*) FILTER (WHERE length(signature_data) >= 2000)::int            AS sig_drawn,
           count(*) FILTER (WHERE pod_r2_key IS NOT NULL)::int                    AS photo,
           count(*) FILTER (WHERE pod_lat IS NOT NULL)::int                       AS gps,
           count(*) FILTER (WHERE migrated_no_stock)::int                         AS migrated,
           min(created_at)                                                        AS first_row,
           max(created_at)                                                        AS last_row
      FROM scm.delivery_orders
     GROUP BY company_id, status::text
     ORDER BY company_id, status::text
  `;

  console.log("\nEVERY DELIVERY ORDER — all statuses, all companies, all time");
  console.log("company  status         rows  sig!=null  drawn  photo    gps  imported  first row   last row");
  for (const r of all) {
    console.log(
      `${String(r.company_id ?? "(null)").padEnd(8)} ${String(r.status).padEnd(13)}` +
        `${String(r.rows).padStart(5)}${String(r.sig_any).padStart(11)}` +
        `${String(r.sig_drawn).padStart(7)}${String(r.photo).padStart(7)}${String(r.gps).padStart(7)}` +
        `${String(r.migrated).padStart(10)}` +
        `  ${r.first_row ? new Date(r.first_row).toISOString().slice(0, 10) : "—"}` +
        `  ${r.last_row ? new Date(r.last_row).toISOString().slice(0, 10) : "—"}`,
    );
  }
  const allSum = (k) => all.reduce((n, r) => n + Number(r[k] ?? 0), 0);
  const everRows = allSum("rows");
  const everSig = allSum("sig_any");
  const everDrawn = allSum("sig_drawn");
  const everPhoto = allSum("photo");
  const everGps = allSum("gps");
  notice(
    `WHOLE TABLE: ${everRows} delivery orders exist in any status. ` +
      `signature_data is non-null on ${everSig} of them (${everDrawn} long enough to be a real drawing); ` +
      `${everPhoto} carry a POD photo key; ${everGps} carry a GPS fix.`,
  );

  /* ── SECTION 3 — THE OTHER TWO PLACES A PROOF OF DELIVERY COULD LIVE ───────
     Answering "no delivery has ever carried a signature" from ONE table is the
     trap this repo keeps paying for: the successful result would ALSO be true
     if the signatures were simply somewhere else. Two other tables in this
     database have proof-of-delivery columns:

       scm.consignment_delivery_orders  — pod_r2_key + signature_data, the same
         pair, on the consignment lane's own DO table.
       public.trip_stops                — signature_r2_key + pod_photo_r2_key,
         the TMS trips lane (mig 0000 baseline / 003_trips_and_planner).

     Both are guarded with to_regclass because neither is guaranteed present:
     the consignment tables arrive through a hand-run schema script, not the
     migration tree, and an absent table is an ANSWER here ("that lane does not
     exist on this database"), not an error. */
  const [{ cdo, stops }] = await pg`
    SELECT to_regclass('scm.consignment_delivery_orders')::text AS cdo,
           to_regclass('public.trip_stops')::text               AS stops
  `;

  console.log("\nOTHER PROOF-OF-DELIVERY STORES");
  if (cdo) {
    const [c] = await pg`
      SELECT count(*)::int                                              AS rows,
             count(*) FILTER (WHERE signature_data IS NOT NULL)::int     AS sig_any,
             count(*) FILTER (WHERE length(signature_data) >= 2000)::int AS sig_drawn,
             count(*) FILTER (WHERE pod_r2_key IS NOT NULL)::int         AS photo
        FROM scm.consignment_delivery_orders
    `;
    console.log(
      `  scm.consignment_delivery_orders  rows ${c.rows}  sig!=null ${c.sig_any}  drawn ${c.sig_drawn}  photo ${c.photo}`,
    );
  } else {
    console.log("  scm.consignment_delivery_orders  — table not present on this database");
  }
  if (stops) {
    const [t] = await pg`
      SELECT count(*)::int                                              AS rows,
             count(*) FILTER (WHERE signature_r2_key IS NOT NULL)::int   AS sig,
             count(*) FILTER (WHERE pod_photo_r2_key IS NOT NULL)::int   AS photo
        FROM public.trip_stops
    `;
    console.log(`  public.trip_stops                rows ${t.rows}  signature ${t.sig}  photo ${t.photo}`);
  } else {
    console.log("  public.trip_stops                — table not present on this database");
  }

  /* ── SECTION 4 — WAS THE ROW CLOSED BY A PERSON, OR CREATED ALREADY CLOSED ─
     A signature can only be missing from a delivery somebody actually closed.
     A row that was INSERTED in its closed state never passed a capture screen,
     so counting it as "evidence missing" invents a hole nobody dug.

     Nothing in this database records WHICH of the five closing screens was
     used — the status route writes no audit row — so this is the closest
     honest split available, and it is deliberately two independent signals:
       migrated_no_stock / linked_ac_docno = the import says so itself;
       delivered_at within 60s of created_at = created already closed.
     Neither is a screen name. Read this as "how many closed rows could a
     driver ever have signed", not as a per-path breakdown. */
  const [closing] = await pg`
    SELECT count(*)::int                                                       AS closed,
           count(*) FILTER (WHERE migrated_no_stock)::int                      AS flagged_import,
           count(*) FILTER (WHERE linked_ac_docno IS NOT NULL)::int            AS has_ac_docno,
           count(*) FILTER (
             WHERE COALESCE(delivered_at, signed_at) IS NOT NULL
               AND COALESCE(delivered_at, signed_at) - created_at < interval '60 seconds'
           )::int                                                              AS born_closed
      FROM scm.delivery_orders
     WHERE status::text IN ('SIGNED', 'DELIVERED', 'INVOICED')
  `;
  /* ── SECTION 5 — TWELVE DELIVERIES, OR ONE PERSON CLEARING A BACKLOG ───────
     Section 4 says the twelve closed rows were NOT created already-closed by an
     import, which leaves "a person closed them through a screen". That is still
     two different worlds, and the difference decides whether anything is wrong:

       twelve DRIVER visits with the capture skipped  -> a product/UX problem
       ONE office sweep over a backlog                -> nothing was skipped,
         because nobody was standing at a customer's door to sign anything

     The tell is the SPREAD of delivered_at. Twelve real deliveries happen over
     hours and days. A backlog cleared from a desk happens in minutes. Printing
     the rows rather than a verdict, because a borderline spread is a judgement
     the owner should make on the evidence, not one this script should make for
     him.

     company_id is joined to its NAME here for the same reason: "company 2" is
     not something the owner can act on, and reading the number as a tenant is
     exactly the guess this file exists to stop. */
  const closedRows = await pg`
    SELECT d.do_number,
           co.code || ' - ' || co.name              AS company_name,
           d.created_at,
           COALESCE(d.delivered_at, d.signed_at)   AS closed_at
      FROM scm.delivery_orders d
      LEFT JOIN public.companies co ON co.id = d.company_id
     WHERE d.status::text IN ('SIGNED', 'DELIVERED', 'INVOICED')
     ORDER BY COALESCE(d.delivered_at, d.signed_at), d.do_number
  `;
  if (closedRows.length > 0) {
    console.log("\nEVERY CLOSED DELIVERY, IN THE ORDER IT WAS CLOSED");
    console.log("do number             company              created              closed");
    for (const r of closedRows) {
      console.log(
        `${String(r.do_number ?? "(none)").padEnd(21)} ${String(r.company_name ?? "(unnamed)").padEnd(20)}` +
          ` ${r.created_at ? new Date(r.created_at).toISOString().slice(0, 16).replace("T", " ") : "—"}` +
          ` ${r.closed_at ? new Date(r.closed_at).toISOString().slice(0, 16).replace("T", " ") : "—"}`,
      );
    }
    const stamps = closedRows.map((r) => (r.closed_at ? new Date(r.closed_at).getTime() : null)).filter((n) => n !== null);
    if (stamps.length > 1) {
      const spreadMin = Math.round((Math.max(...stamps) - Math.min(...stamps)) / 60000);
      notice(
        `CLOSING SPREAD: all ${stamps.length} closed deliveries were closed within ${spreadMin} minute(s) of each other. ` +
          `A short spread means one person clearing a backlog from a desk, not that many separate doorstep deliveries.`,
      );
    }
  }

  console.log("\nCOULD A DRIVER EVER HAVE SIGNED THESE?");
  console.log(`  closed delivery orders                       ${closing.closed}`);
  console.log(`  flagged migrated_no_stock (mig 0276 import)  ${closing.flagged_import}`);
  console.log(`  carrying an AutoCount doc no                 ${closing.has_ac_docno}`);
  console.log(`  created and closed within 60 seconds         ${closing.born_closed}`);
  const reachable = closing.closed - Math.max(closing.flagged_import, closing.born_closed);
  notice(
    `CLOSED BY A PERSON, upper bound: ${reachable} of ${closing.closed} closed delivery orders ` +
      `were not created already-closed by an import — those are the only ones a capture screen could have covered.`,
  );

  /* THE NUMBER IS THE OUTPUT, NOT A GATE. A non-zero count here is a fact about
     history, not a regression introduced by whoever ran this — failing the job
     would only teach people to stop running it. Deciding whether any of these
     rows can or should be backfilled is a conversation with the owner, and for
     the imported 2990 population the honest answer is that there is nothing to
     restore: no signature was ever taken. */
  process.exit(0);
} catch (e) {
  console.error(`POD census failed to read the database: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
} finally {
  await pg.end({ timeout: 5 });
}
