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
  decide,
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
