/**
 * The AutoCount pull sentinel's decision, as a pure function.
 *
 * NO SHEBANG and no I/O here: this is the half that can be proved without a
 * database. The runnable ../autocount-pull-sentinel.mjs does the SELECTs and
 * hands the numbers to `decide`.
 *
 * That split is the point. A sentinel whose thresholds have never been executed
 * is a claim about what would happen, and this repo spent a working day on one
 * of those on 2026-08-19 (`?mode=all`, written from reading the source, 39s ->
 * HTTP 503). The live query cannot run in CI; the judgement can, and does.
 */

/** The pull runs every five minutes, so days of staleness is unambiguous. */
export const STALE_CHECKPOINT_DAYS = 2;
/** Deliberately far looser than any plausible quiet period — see the runner. */
export const NO_ARRIVALS_DAYS = 30;

export const OK = 0;
export const ALARM = 1;
export const CANNOT_ANSWER = 2;

/**
 * @param {{checkpoint: string|null, behind: number|null, d7: number, d30: number, total: number}} state
 * @returns {{code: 0|1|2, alarms: string[], reason?: string}}
 */
export function decide(state) {
  const { checkpoint, behind, d7, d30, total } = state;
  const alarms = [];

  /* REFUSE before judging. An empty mirror makes "0 arrivals" trivially true,
     and reporting that as an alarm about the PULL points the next reader at the
     wrong system entirely. "I cannot answer" is a better output than a
     confident answer to a question the data cannot settle. */
  if (!Number.isFinite(total) || total === 0) {
    return {
      code: CANNOT_ANSWER,
      alarms: [],
      reason:
        "sales_orders holds no timestamped rows at all. The arrival test is unanswerable, " +
        "and that is a different failure from a stalled pull — it must not be reported as one.",
    };
  }

  if (checkpoint === null || checkpoint === undefined || checkpoint === "") {
    alarms.push(
      "pull_checkpoint IS NOT SET. pull.ts falls back to '2000-01-01', so every filtered run " +
        "asks AutoCount for everything since 2000. Not a leak, not a working incremental pull either.",
    );
  } else if (behind === null) {
    /* An unparseable checkpoint is not a pass: it is the value the next
       getSince() is built from, and nobody can say what it means. */
    alarms.push(`pull_checkpoint = ${JSON.stringify(checkpoint)} does not parse as a date.`);
  } else if (behind > STALE_CHECKPOINT_DAYS) {
    alarms.push(
      `pull_checkpoint is ${behind} days behind (limit ${STALE_CHECKPOINT_DAYS}). It only advances ` +
        "on a run with ZERO failures, so ONE bad row freezes it and the same window is refetched " +
        "forever. This is the exact shape of the cutover bug. Find the failing row — do NOT " +
        "advance it by hand, that skips whatever it is.",
    );
  }

  if (d30 === 0) {
    alarms.push(
      `NOTHING has arrived in ${NO_ARRIVALS_DAYS} days (7d: ${d7}). The pull may still be reporting ` +
        "successful runs — it counts per-row failures and carries on. This is the shape that hid " +
        "for months and was found by a salesperson who could not do their job.",
    );
  }

  return { code: alarms.length ? ALARM : OK, alarms };
}
