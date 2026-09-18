// Read-only report on the ERP -> Venture Portal feed: is it on, what is queued,
// and HOW MANY SECONDS a saved sales order actually takes to reach the portal.
//
// WHY THIS EXISTS AS A SCRIPT AND A WORKFLOW
//
// docs/modules/venture-portal-feed.md §2 carries an estimate — "2-3 s (LIKELY,
// not measured)" — and an instruction to replace it with the number from the
// first real order. That number lives only in production's
// scm.venture_portal_outbox, so without this the only ways to get it were to ask
// the owner to read a screen, or to open a SQL console against production. The
// first costs an interruption every time the question is asked; the second puts
// the production DSN in front of a person for a SELECT. CLAUDE.md forbids both,
// and Actions already holds secrets.DATABASE_URL for the deploy.
//
// WHAT IT MEASURES, precisely — and the first version of this script GOT IT
// WRONG, which is why the distinction is spelled out here rather than assumed.
//
// `created_at` is the moment the OUTBOX ROW was written, and there are two very
// different ways that happens:
//
//   op = INSERT / UPDATE / DELETE (optionally `:child_table`)
//       the capture TRIGGER, running in the SAME TRANSACTION as the
//       salesperson's Save. For these rows created_at IS the save, and
//       sent_at - created_at is the number the owner asked for:
//       「我要秒级 update 的」.
//
//   op = RECONCILE
//       a BACKFILL sweep (scm.vp_requeue_undelivered) queueing a historical
//       order that was never delivered. created_at is when the BACKFILL ran,
//       which has nothing to do with when the order was saved — often years
//       earlier. sent_at - created_at for these is "how long it waited in a
//       queue thousands deep", not a latency.
//
// MIXING THEM PRODUCES A CONFIDENT WRONG ANSWER. Measured on the first real
// dispatch, 2026-09-13: over the last 20 deliveries the median read 2094.6s —
// about 35 minutes — while 2,672 backfilled rows were draining. Read as
// save-to-portal latency that number says the feed is broken; it actually said
// the backlog was long. The two populations are reported separately now, and the
// SAVES line is the one §2 of the module guide is asking for.
//
// WHAT IT CANNOT TELL YOU, said plainly:
//
//   - WHICH sender delivered it. A row sent within a few seconds was almost
//     certainly the kick; one at a multiple of five minutes was almost certainly
//     the cron. Neither is recorded, so the script REPORTS the seconds and lets
//     a reader draw that line — it does not label rows with a guess.
//   - Whether the portal APPLIED it. That is `portal_outcome`, a separate fact,
//     and it is printed BESIDE the state rather than folded into it: a `held`
//     month is delivered and NOT counted, and conflating the two is what the
//     portal's contract warns against twice.
//   - Anything about a row that never sent. Those show in the status counts.
//
// ZERO SENT ROWS IS AN ANSWER, not a failure. It means no order has been
// delivered yet — which is the state on the day the feed is first turned on —
// and the script says so instead of reporting a latency computed over nothing.
// A verdict computed over an empty set must never read as a pass (CLAUDE.md).
//
// Strictly SELECTs. No DDL, no writes, no transaction. Exits 0 for every
// legitimate answer, because a red job reads as "the check broke" and the whole
// point is that the ANSWER is the output. Only an unreachable database or a
// query error exits non-zero.
import { readFileSync } from "node:fs";
import postgres from "postgres";

const FEED_KEY = "scm.venture_portal_feed";
/** How many recent deliveries to show individually. */
const SAMPLE = 20;

/**
 * Only count rows CREATED at or after this instant. Null counts everything.
 *
 * WHY IT EXISTS, and it is not a convenience. A measurement of this feed is only
 * meaningful against the code that was running when the row was QUEUED, and this
 * queue has already outlived two behaviour changes in one day. On 2026-09-13 the
 * sweep took rows strictly oldest-first, so a live save sat behind a 2,600-row
 * backfill; that was fixed at 13:16Z (`docs/bugs/0863-…`). Rows queued before
 * that carry the OLD behaviour's wait in their seconds — the newest such row read
 * 983.7s — and pooling them with rows queued after it produces a number that
 * describes neither.
 *
 * So the cutoff is an INPUT rather than a constant: the honest question is always
 * "how fast is the code that is running now", and the answer changes every time
 * the sender changes. Pass the deploy time of whatever you are measuring.
 *
 * Absent, it reports everything and says so — which is right for "is the feed
 * working at all" and wrong for "how fast is it today".
 */
const SINCE = (() => {
  const raw = (process.env.SINCE ?? "").trim();
  if (!raw) return null;
  const t = Date.parse(raw);
  if (Number.isNaN(t)) {
    console.error(`SINCE is not a date this can read: ${JSON.stringify(raw)}. Use an ISO instant like 2026-09-13T13:16:00Z.`);
    process.exit(1);
  }
  return new Date(t).toISOString();
})();

// Same resolution order as pg-migrate.mjs: env wins so CI needs no .dev.vars.
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

// `notice` surfaces the verdict on the run's summary page, so the answer is
// readable without opening the log.
const notice = (msg) =>
  console.log(process.env.GITHUB_ACTIONS ? `::notice::${msg}` : msg);

const secs = (v) => (v == null ? null : Number(v));
const fmt = (n) => (n == null ? "?" : `${n.toFixed(1)}s`);

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

try {
  // 1. Is it on, and for whom?
  const flag = await pg`
    SELECT value, updated_at FROM scm.app_config WHERE key = ${FEED_KEY}`;
  if (flag.length === 0) {
    notice(`THE SWITCH ROW IS MISSING — scm.app_config has no '${FEED_KEY}'.`);
    notice("That is not the same as 'off'. The migration seeds it, so a missing row means something deleted it. Do NOT insert it by hand to make this read tidy.");
  } else {
    const v = String(flag[0].value ?? "").trim();
    const on = v !== "" && v !== "off";
    notice(`switch            : ${on ? `ON for ${v === "all" ? "every company" : `company ${v}`}` : "OFF — nothing is being sent"} (set ${flag[0].updated_at})`);
  }

  /* SAID FIRST, every run. A latency without its window is not a measurement,
     and this queue has already outlived two behaviour changes in one day. */
  notice(
    SINCE
      ? `counting rows     : QUEUED AT OR AFTER ${SINCE} — earlier rows are excluded`
      : "counting rows     : ALL of them, however old. Pass SINCE to measure only what the CURRENT sender queued; without it, rows queued under older behaviour are mixed in",
  );

  // 2. What is in the queue?
  const counts = await pg`
    SELECT status, count(*)::int AS n
    FROM scm.venture_portal_outbox
    GROUP BY status ORDER BY status`;
  notice(
    counts.length === 0
      ? "queue             : empty — nothing has ever been captured"
      : `queue             : ${counts.map((r) => `${r.status} ${r.n}`).join(", ")}`,
  );

  // 3. THE NUMBER — reported per POPULATION, never pooled. See the header.
  const report = async (label, isSave) => {
    const rows = isSave
      ? await pg`
          SELECT doc_no, op, created_at, sent_at,
                 EXTRACT(EPOCH FROM (sent_at - created_at)) AS seconds,
                 portal_outcome, attempts
          FROM scm.venture_portal_outbox
          WHERE status = 'sent' AND sent_at IS NOT NULL AND created_at IS NOT NULL
            AND op <> 'RECONCILE'
            AND (${SINCE}::timestamptz IS NULL OR created_at >= ${SINCE}::timestamptz)
          ORDER BY sent_at DESC LIMIT ${SAMPLE}`
      : await pg`
          SELECT doc_no, op, created_at, sent_at,
                 EXTRACT(EPOCH FROM (sent_at - created_at)) AS seconds,
                 portal_outcome, attempts
          FROM scm.venture_portal_outbox
          WHERE status = 'sent' AND sent_at IS NOT NULL AND created_at IS NOT NULL
            AND op = 'RECONCILE'
            AND (${SINCE}::timestamptz IS NULL OR created_at >= ${SINCE}::timestamptz)
          ORDER BY sent_at DESC LIMIT ${SAMPLE}`;

    notice("");
    if (rows.length === 0) {
      notice(`${label}: NONE YET — zero delivered rows of this kind${SINCE ? ` created at or after ${SINCE}` : ""}.`);
      if (isSave) {
        notice("  No order SAVED since the feed was turned on has been delivered yet, so the save-to-portal number does not exist. Do not read this as 'fast'; save one order and re-run.");
      }
      return;
    }
    const all = rows.map((r) => secs(r.seconds)).filter((n) => n != null).sort((a, b) => a - b);
    notice(`${label} — last ${all.length}:`);
    notice(`  fastest         : ${fmt(all[0])}`);
    notice(`  median          : ${fmt(all[Math.floor(all.length / 2)])}`);
    notice(`  slowest         : ${fmt(all[all.length - 1])}`);
    /* created_at is PRINTED, not just filtered on. Which code was running when a
       row was queued is the thing that makes its seconds mean anything, and a
       reader cannot check the cutoff was the one they meant without seeing it. */
    notice("  newest first — doc, op, queued at, seconds, what the portal did with it:");
    for (const r of rows) {
      const queuedAt = new Date(r.created_at).toISOString().replace("T", " ").slice(0, 19);
      notice(`    ${String(r.doc_no).padEnd(18)} ${String(r.op).padEnd(34)} ${queuedAt}Z ${fmt(secs(r.seconds)).padStart(9)}  ${r.portal_outcome ?? "(the portal said nothing)"}${Number(r.attempts) > 1 ? `  tried ${r.attempts}x` : ""}`);
    }
  };

  await report("SAVE -> PORTAL (op is a trigger: this is the real latency)", true);
  notice("");
  notice("  A delivery in a few seconds was the SAVE'S OWN kick. One near a multiple of 300s was the five-minute cron picking up something the kick missed. Which one is not recorded — that inference is the reader's, not the script's.");
  notice("  This SAVE line is the number docs/modules/venture-portal-feed.md §2 asks for. The BACKFILL line below is NOT it.");

  await report("BACKFILL (op = RECONCILE: queue wait, NOT a latency)", false);
  notice("  These rows were queued by a backfill sweep, so created_at is when the SWEEP ran, not when the order was saved. Seconds here measure how long the backlog was, and must never be quoted as the feed's latency.");

  // 4. Anything stuck? The oldest thing still waiting IS the health signal.
  const oldest = await pg`
    SELECT doc_no, created_at,
           EXTRACT(EPOCH FROM (now() - created_at)) AS waiting_seconds,
           attempts, last_error
    FROM scm.venture_portal_outbox
    WHERE status = 'pending'
    ORDER BY created_at ASC LIMIT 1`;
  if (oldest.length > 0) {
    const w = secs(oldest[0].waiting_seconds);
    notice("");
    notice(`oldest waiting    : ${oldest[0].doc_no} for ${fmt(w)}${w != null && w > 3600 ? "  <- over an hour: BOTH senders have stopped" : ""}`);
    if (oldest[0].last_error) notice(`  last error      : ${oldest[0].last_error}`);
  }
} finally {
  await pg.end({ timeout: 5 });
}
