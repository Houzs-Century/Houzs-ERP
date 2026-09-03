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

  /* THE SENTENCE THAT MATCHES TWO NEEDLES. `KeylessLineError` writes "N of M
     line(s) carry no AutoCount DtlKey", which contains the `keyless-line`
     needle AND the `dtlkey-subset` needle ("carry no AutoCount DtlKey"). The
     order of AC_SKIP_KINDS is a PRIORITY order — `classifyAcSkip` returns the
     FIRST match — and this pins that the priority actually resolves this pair,
     because a reporter that classified per-needle instead printed the losing
     class as a second, differently-remedied entry (docs/bugs/0606-the-outbox-health-report-counted-one-refusal-under-two-remed.md).

     The two remedies are opposites in practice: keyless-line says backfill THIS
     document's line keys; dtlkey-subset says backfill the SOURCE document's,
     and an edit has no source document. */
  it('a reason matching two needles resolves to ONE kind, the higher-priority one', () => {
    const both =
      'refused, nothing sent (KeylessLineError): SO SO-000000: 1 of 8 line(s) '
      + 'carry no AutoCount DtlKey — line(s) 1.';
    const keyless = ts.AC_SKIP_KINDS.findIndex((k) => k.kind === 'keyless-line');
    const subset = ts.AC_SKIP_KINDS.findIndex((k) => k.kind === 'dtlkey-subset');
    expect(keyless).toBeGreaterThanOrEqual(0);
    expect(subset).toBeGreaterThan(keyless);
    expect(both).toContain(ts.AC_SKIP_KINDS[subset].needle);
    expect(ts.classifyAcSkip(both).kind).toBe('keyless-line');
    expect(mjs.classifyAcSkip(both)).toEqual(ts.classifyAcSkip(both));
  });

  it('an unrecognised reason is named as such, never folded into a neighbour', () => {
    const { kind, remedy } = ts.classifyAcSkip('a refusal class written next month');
    expect(kind).toBe(ts.AC_SKIP_UNRECOGNISED);
    expect(remedy).toBeNull();
  });
});

/* Found by opening /autocount-sync against production on 2026-08-15, not by a
   test: the page said "2 documents need attention — in the ERP and not in
   AutoCount" on the same screen that listed both of those documents as IN
   AutoCount. Both were FAILED rows carrying a re-queue marker, and the marker
   was only honoured for skips.

   It was right when written — the re-queue tool only ever selected `skipped`.
   #2189 added an explicit includeFailed opt-in and its first use put the marker
   on two failed rows. The harness the page was built against had no such row. */
describe('a re-queued FAILED row is history too', () => {
  const note = '[re-queued 2026-08-14T17:21:23.415Z -> outbox 6d18d288-6462-4d91-a33b-efaf1e1c82f4]'
    + ' Gave up after 6 attempts. Last error: Foreign Key Error (Constraint Name=FK_SO_SalesAgent)';

  it('it reads as requeued, not failed', () => {
    expect(ts.acOutboxState('failed', note)).toBe('requeued');
  });

  it('and it does NOT need attention — the document went through under a newer row', () => {
    expect(ts.acNeedsAttention('failed', note)).toBe(false);
  });

  it('a failed row WITHOUT the marker still needs attention', () => {
    /* The case the fix must not swallow: a real failure, never re-queued, is
       still a document in the ERP and not in the book. */
    expect(ts.acOutboxState('failed', 'Foreign Key Error (Constraint Name=FK_SO_SalesAgent)')).toBe('failed');
    expect(ts.acNeedsAttention('failed', 'Foreign Key Error (Constraint Name=FK_SO_SalesAgent)')).toBe(true);
  });

  it('the .mjs mirror agrees, for failed as well as skipped', () => {
    expect(mjs.acOutboxState('failed', note)).toBe(ts.acOutboxState('failed', note));
    expect(mjs.acNeedsAttention('failed', note)).toBe(ts.acNeedsAttention('failed', note));
  });

  it('a PENDING row carrying the marker is NOT history — it is the live attempt', () => {
    /* Only a terminal row can be history. A pending row IS the re-queued work,
       so calling it history would hide the thing actually in flight. */
    expect(ts.acOutboxState('pending', note)).toBe('pending');
  });
});
