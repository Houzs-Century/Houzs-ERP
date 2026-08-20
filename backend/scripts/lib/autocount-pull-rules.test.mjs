/**
 * node --test backend/scripts/lib/autocount-pull-rules.test.mjs
 *
 * Zero dependencies, so it runs on a bare checkout — and the sentinel's own
 * workflow runs it before the sentinel, because a checker nobody runs is not a
 * checker.
 *
 * NO SHEBANG — see the header of autocount-pull-rules.mjs.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ALARM,
  CANNOT_ANSWER,
  NO_ARRIVALS_DAYS,
  OK,
  STALE_CHECKPOINT_DAYS,
  TZ_SLOP_HOURS,
  decide,
  normaliseBehind,
} from "./autocount-pull-rules.mjs";

/** A working day: checkpoint fresh, rows arriving. */
const healthy = { checkpoint: "2026-08-19 04:00:00", behind: 0, d7: 120, d30: 480, total: 3281 };

test("a healthy pull is silent", () => {
  const r = decide(healthy);
  assert.equal(r.code, OK);
  assert.deepEqual(r.alarms, []);
});

test("THE ACTUAL INCIDENT fires: checkpoint frozen at the cutover, mirror taking nothing", () => {
  /* The real shape from 2026-08-19. Every row failed with 42703, so `failed === 0`
     was never true and the checkpoint never advanced — while the job reported
     normal-looking runs every five minutes for months. If this case does not
     alarm, the sentinel is decoration. */
  const r = decide({ checkpoint: "2026-05-01 00:00:00", behind: 110, d7: 0, d30: 0, total: 3281 });
  assert.equal(r.code, ALARM);
  assert.equal(r.alarms.length, 2, "both the frozen checkpoint AND the dead arrival rate");
  assert.ok(r.alarms.some((a) => /pull_checkpoint is 110 days behind/.test(a)));
  assert.ok(r.alarms.some((a) => new RegExp(`NOTHING has arrived in ${NO_ARRIVALS_DAYS} days`).test(a)));
});

test("the half-shape fires too: checkpoint looks fine, nothing is arriving", () => {
  /* The nastier variant — a current checkpoint reads as health, and the mirror
     is still taking nothing. Catching only the frozen-checkpoint case would
     leave this one exactly as invisible as before. */
  const r = decide({ ...healthy, d7: 0, d30: 0 });
  assert.equal(r.code, ALARM);
  assert.equal(r.alarms.length, 1);
  assert.match(r.alarms[0], /NOTHING has arrived/);
});

test("the staleness limit is a limit, not a suggestion", () => {
  assert.equal(decide({ ...healthy, behind: STALE_CHECKPOINT_DAYS }).code, OK, "at the limit is fine");
  assert.equal(decide({ ...healthy, behind: STALE_CHECKPOINT_DAYS + 1 }).code, ALARM, "one past it is not");
});

test("a missing or unreadable checkpoint is an alarm, never a pass", () => {
  for (const checkpoint of [null, undefined, ""]) {
    const r = decide({ ...healthy, checkpoint, behind: null });
    assert.equal(r.code, ALARM, `checkpoint=${JSON.stringify(checkpoint)} must alarm`);
    assert.match(r.alarms[0], /IS NOT SET/);
  }
  const junk = decide({ ...healthy, checkpoint: "not-a-date", behind: null });
  assert.equal(junk.code, ALARM);
  assert.match(junk.alarms[0], /does not parse as a date/);
});

test("an empty mirror REFUSES rather than answering the wrong question", () => {
  /* 0 rows makes "0 arrivals in 30 days" trivially true. Reporting that as a
     stalled pull would send the next reader to the wrong system. CLAUDE.md:
     a check that answers a different question is how a guess feels proven. */
  const r = decide({ ...healthy, d7: 0, d30: 0, total: 0 });
  assert.equal(r.code, CANNOT_ANSWER);
  assert.deepEqual(r.alarms, []);
  assert.match(r.reason, /unanswerable/);

  assert.equal(decide({ ...healthy, total: NaN }).code, CANNOT_ANSWER, "an unreadable count is not zero");
});

test("the three exit codes are distinct, because the workflow depends on it", () => {
  assert.notEqual(OK, ALARM);
  assert.notEqual(ALARM, CANNOT_ANSWER);
  assert.equal(OK, 0, "0 must mean healthy — anything else and a green run is meaningless");
});

// --------------------------------------------------------------------------
// The naive-timestamp offset, found by the first live dispatch
// --------------------------------------------------------------------------

test("a checkpoint that reads AHEAD by a timezone's worth is not stale", () => {
  /* THE REAL OBSERVATION, 2026-08-19. The first production dispatch printed
     "-1d behind": the stored value was 2026-08-19T20:35:34 while UTC was
     13:03 — 7.5 hours "ahead", which is MYT for a checkpoint half an hour old.
     The runner appended "Z" and floored, turning a third of a day of offset
     into a whole negative day. */
  const aheadBy7h30 = -(7.5 / 24);
  assert.equal(normaliseBehind(aheadBy7h30), 0, "a timezone offset is not staleness");

  const r = decide({ ...healthy, behind: aheadBy7h30 });
  assert.equal(r.code, OK);
  assert.deepEqual(r.alarms, [], "the real production reading must be silent");
});

test("every inhabited UTC offset is absorbed, and beyond that is a finding", () => {
  /* -12..+14 is the full range of real offsets, so 14h is the boundary. Past
     it, a checkpoint really is in the future — and that is its own alarm, not
     something to clamp away: the next getSince() would ask for a window
     starting in the future and skip everything before it. */
  assert.equal(normaliseBehind(-(TZ_SLOP_HOURS / 24)), 0, "exactly at the boundary is tolerated");
  assert.equal(normaliseBehind(-(15 / 24)), null, "past it is not a timezone");

  const far = decide({ ...healthy, behind: -(72 / 24) });
  assert.equal(far.code, ALARM);
  assert.match(far.alarms[0], /72\.0 hours AHEAD/);
});

test("a genuinely stale checkpoint still alarms, offset or not", () => {
  /* The regression that would matter: absorbing the offset must not blunt the
     alarm this sentinel exists for. */
  const r = decide({ ...healthy, behind: 110 });
  assert.equal(r.code, ALARM);
  assert.match(r.alarms[0], /110 days behind/);

  assert.equal(decide({ ...healthy, behind: 2.0 }).code, OK, "at the limit is fine");
  assert.equal(decide({ ...healthy, behind: 2.6 }).code, ALARM, "past it is not");
});
