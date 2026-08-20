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
     WHERE upper(status) IN ('SIGNED', 'DELIVERED', 'INVOICED')
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
