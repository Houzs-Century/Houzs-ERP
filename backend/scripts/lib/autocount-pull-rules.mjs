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

/**
 * `system_settings.pull_checkpoint` is a naive timestamp — no offset, no Z.
 *
 * The first live dispatch (2026-08-19) printed `-1d behind`, a negative
 * staleness, because the runner appended "Z" and read a LOCAL time as UTC. The
 * stored value was `2026-08-19T20:35:34.723` while UTC was 13:03: 7.5 hours in
 * the "future", which is MYT (UTC+8) for a checkpoint half an hour old.
 *
 * That is ONE observation, so the zone is NOT hardcoded here — guessing it from
 * a single sample is the failure this repo keeps paying for. Instead the
 * comparison is made robust to ANY real-world offset: a value that reads up to
 * this many hours ahead of now cannot be stale, and is clamped to zero rather
 * than reported as negative. 14 covers every inhabited UTC offset (-12..+14).
 *
 * The cost is stated rather than hidden: staleness carries up to 14h of slop,
 * so the 2-day threshold really fires somewhere between ~1.4 and ~2.6 days.
 * Against a pull that runs every five minutes, that is noise.
 */
export const TZ_SLOP_HOURS = 14;
/** Deliberately far looser than any plausible quiet period — see the runner. */
export const NO_ARRIVALS_DAYS = 30;

export const OK = 0;
export const ALARM = 1;
export const CANNOT_ANSWER = 2;

/**
 * @param {{checkpoint: string|null, behind: number|null, d7: number, d30: number, total: number}} state
 * @returns {{code: 0|1|2, alarms: string[], reason?: string}}
 */
/**
 * Staleness in whole days, with the naive-timestamp ambiguity absorbed.
 *
 * @returns 0 when the value reads ahead of now by an amount a timezone offset
 *          could explain (it cannot be stale); the day count when it is behind;
 *          `null` when it is ahead by more than any offset explains, which is a
 *          finding of its own rather than a value to clamp away.
 */
export function normaliseBehind(behind) {
  if (behind === null || behind === undefined || !Number.isFinite(behind)) return null;
  if (behind >= 0) return behind;
  return -behind <= TZ_SLOP_HOURS / 24 ? 0 : null;
}

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

  const staleness = normaliseBehind(behind);

  if (checkpoint === null || checkpoint === undefined || checkpoint === "") {
    alarms.push(
      "pull_checkpoint IS NOT SET. pull.ts falls back to '2000-01-01', so every filtered run " +
        "asks AutoCount for everything since 2000. Not a leak, not a working incremental pull either.",
    );
  } else if (behind === null) {
    /* An unparseable checkpoint is not a pass: it is the value the next
       getSince() is built from, and nobody can say what it means. */
    alarms.push(`pull_checkpoint = ${JSON.stringify(checkpoint)} does not parse as a date.`);
  } else if (staleness === null) {
    /* Ahead of now by MORE than any real timezone explains. Not staleness, but
       not health either: the next getSince() will be built from a timestamp
       that is genuinely in the future, so the window it asks for skips
       everything between now and then. */
    alarms.push(
      `pull_checkpoint is ${(-behind * 24).toFixed(1)} hours AHEAD of now, which no timezone offset ` +
        `explains (the column is naive, so up to ${TZ_SLOP_HOURS}h is tolerated). The next ` +
        "getSince() would ask for a window starting in the future and skip everything before it.",
    );
  } else if (staleness > STALE_CHECKPOINT_DAYS) {
    alarms.push(
      `pull_checkpoint is ${staleness} days behind (limit ${STALE_CHECKPOINT_DAYS}). It only advances ` +
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
