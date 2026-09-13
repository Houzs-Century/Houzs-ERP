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
// WHAT IT MEASURES, precisely. `created_at` is stamped by the capture trigger,
// which runs in the SAME TRANSACTION as the salesperson's Save — so it IS the
// moment of the save, not the moment some sweep noticed. `sent_at` is stamped
// when the portal answered 2xx. The difference is the number the owner asked
// for: 「我要秒级 update 的」.
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

  // 3. THE NUMBER. Seconds from the salesperson's Save to the portal's 2xx.
  const delivered = await pg`
    SELECT doc_no,
           created_at,
           sent_at,
           EXTRACT(EPOCH FROM (sent_at - created_at)) AS seconds,
           portal_outcome,
           attempts
    FROM scm.venture_portal_outbox
    WHERE status = 'sent' AND sent_at IS NOT NULL AND created_at IS NOT NULL
    ORDER BY sent_at DESC
    LIMIT ${SAMPLE}`;

  if (delivered.length === 0) {
    notice("");
    notice("LATENCY           : NOT MEASURABLE YET — zero delivered rows.");
    notice("No sales order has reached the portal, so there is no number to report. Turn the feed on, save one order, and re-run this. Do not read this as 'fast'.");
  } else {
    const all = delivered.map((r) => secs(r.seconds)).filter((n) => n != null).sort((a, b) => a - b);
    const median = all[Math.floor(all.length / 2)];
    notice("");
    notice(`LATENCY over the last ${all.length} deliveries — save to portal 2xx:`);
    notice(`  fastest         : ${fmt(all[0])}`);
    notice(`  median          : ${fmt(median)}`);
    notice(`  slowest         : ${fmt(all[all.length - 1])}`);
    notice("");
    notice("  A delivery in a few seconds was the SAVE'S OWN kick. One near a multiple of 300s was the five-minute cron picking up something the kick missed. Which one is not recorded — this is the reader's call, not the script's.");
    notice("");
    notice("  newest first — doc, seconds, what the portal did with it:");
    for (const r of delivered) {
      notice(`    ${String(r.doc_no).padEnd(18)} ${fmt(secs(r.seconds)).padStart(8)}  ${r.portal_outcome ?? "(the portal said nothing)"}${Number(r.attempts) > 1 ? `  tried ${r.attempts}x` : ""}`);
    }
    notice("");
    notice(`Put the median into docs/modules/venture-portal-feed.md §2, which currently carries an ESTIMATE labelled LIKELY and asks for this number.`);
  }

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
