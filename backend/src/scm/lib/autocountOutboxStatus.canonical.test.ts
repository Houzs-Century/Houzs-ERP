// The referee for the one rule that lives in two files.
//
// src/scm/lib/autocount-outbox-status.ts is the source; scripts/lib/
// autocount-skip-kinds.mjs is its plain-node mirror, because
// check-autocount-outbox-health.mjs runs under node against postgres.js and
// cannot import TypeScript. A copy with nothing checking it is a rule with two
// homes and no authority — this repo's own position (check-shared-mirrors.mjs),
// and the health check has already shipped a wrong classification once (#2094).
//
// This does not compare the files textually: one is TS with types and the other
// is JS, so they will never be byte-identical. It compares the VALUES and the
// BEHAVIOUR, which is what an operator actually reads.
import { describe, expect, it } from 'vitest';

import * as ts from './autocount-outbox-status';
// @ts-expect-error - the mirror is untyped JS on purpose; that is what it is for.
import * as mjs from '../../../scripts/lib/autocount-skip-kinds.mjs';

describe('autocount-outbox-status mirror', () => {
  it('the skip taxonomy is identical, kind / needle / remedy', () => {
    expect(mjs.AC_SKIP_KINDS).toEqual(ts.AC_SKIP_KINDS.map((k) => ({ ...k })));
  });

  it('the constants are identical', () => {
    expect(mjs.REQUEUE_NOTE_PREFIX).toBe(ts.REQUEUE_NOTE_PREFIX);
    expect(mjs.AC_MAX_ATTEMPTS).toBe(ts.AC_MAX_ATTEMPTS);
    expect(mjs.AC_SKIP_UNRECOGNISED).toBe(ts.AC_SKIP_UNRECOGNISED);
    expect(mjs.AC_OUTBOX_STATUSES).toEqual([...ts.AC_OUTBOX_STATUSES]);
    expect(mjs.AC_OUTBOX_STATES).toEqual([...ts.AC_OUTBOX_STATES]);
    expect(mjs.AC_STATE_MEANING).toEqual(ts.AC_STATE_MEANING);
  });

  /* Every reason the ERP can write, run through BOTH classifiers. Comparing the
     tables alone would not catch a mirror whose `includes` had become a
     `startsWith`. */
  it('classifies every known reason the same way', () => {
    for (const k of ts.AC_SKIP_KINDS) {
      const reason = `${k.needle}: some trailing detail from the ERP`;
      expect(mjs.classifyAcSkip(reason)).toEqual(ts.classifyAcSkip(reason));
      expect(ts.classifyAcSkip(reason).kind).toBe(k.kind);
    }
  });

  it('agrees on an unrecognised reason, a null reason and a re-queued note', () => {
    for (const reason of [
      null,
      '',
      'something no code path has ever written',
      '[re-queued 2026-08-15T00:00:00.000Z -> outbox abc] refused, nothing sent (ItemCodeError): x',
    ]) {
      expect(mjs.classifyAcSkip(reason)).toEqual(ts.classifyAcSkip(reason));
      expect(mjs.isRequeuedNote(reason)).toBe(ts.isRequeuedNote(reason));
      expect(mjs.acOutboxState('skipped', reason)).toBe(ts.acOutboxState('skipped', reason));
      expect(mjs.acNeedsAttention('skipped', reason)).toBe(ts.acNeedsAttention('skipped', reason));
    }
  });
});

describe('autocount-outbox-status', () => {
  it('a re-queued skip is history, not backlog', () => {
    const note = '[re-queued 2026-08-15T09:00:00.000Z -> outbox 7f3] refused, nothing sent (ItemCodeError): 9028-1S';
    expect(ts.acOutboxState('skipped', note)).toBe('requeued');
    expect(ts.acNeedsAttention('skipped', note)).toBe(false);
    /* The ORIGINAL reason survives behind the annotation and must still
       classify, or the page would show a re-queued row with no explanation of
       what it was re-queued FOR. */
    expect(ts.classifyAcSkip(note).kind).toBe('item-code');
  });

  it('an outstanding skip needs attention and names its remedy', () => {
    const reason = 'refused, nothing sent (MissingLocationError): line 2 has no warehouse';
    expect(ts.acOutboxState('skipped', reason)).toBe('skipped');
    expect(ts.acNeedsAttention('skipped', reason)).toBe(true);
    expect(ts.classifyAcSkip(reason).remedy).toContain('stock location');
  });

  it('a failed row always needs attention; pending and sent never do', () => {
    expect(ts.acNeedsAttention('failed', 'FK_SO_SalesAgent')).toBe(true);
    expect(ts.acNeedsAttention('pending', 'AutoCount threw a 500')).toBe(false);
    expect(ts.acNeedsAttention('sent', null)).toBe(false);
  });

  /* The marker is a PREFIX. A refusal whose own message quoted it mid-string is
     still an open question, and coercing it to `requeued` would hide a real
     divergence behind a word that means "already handled". */
  it('the re-queue marker only counts at the start', () => {
    const quoted = 'refused, nothing sent (ItemCodeError): the note said [re-queued ...] once';
    expect(ts.isRequeuedNote(quoted)).toBe(false);
    expect(ts.acOutboxState('skipped', quoted)).toBe('skipped');
  });

  it('an unrecognised reason is named as such, never folded into a neighbour', () => {
    const { kind, remedy } = ts.classifyAcSkip('a refusal class written next month');
    expect(kind).toBe(ts.AC_SKIP_UNRECOGNISED);
    expect(remedy).toBeNull();
  });
});
