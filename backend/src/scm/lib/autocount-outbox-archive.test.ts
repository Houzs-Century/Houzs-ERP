import { describe, expect, test } from 'vitest';
import {
  AC_ARCHIVE_MEANING,
  acArchiveAccepted,
  acArchiveVerdict,
  type AcArchiveRow,
} from './autocount-outbox-archive';
import { REQUEUE_NOTE_PREFIX } from './autocount-outbox-status';

const row = (over: Partial<AcArchiveRow> = {}): AcArchiveRow => ({
  status: 'sent',
  last_error: null,
  archived_at: null,
  ...over,
});

describe('acArchiveVerdict', () => {
  test('a document nobody ever queued cannot be retired', () => {
    const v = acArchiveVerdict([]);
    expect(v.code).toBe('doc-not-found');
    expect(acArchiveAccepted(v.code)).toBe(false);
  });

  test('a document whose every send arrived may be retired', () => {
    const v = acArchiveVerdict([row(), row(), row()]);
    expect(v.code).toBe('ok');
    expect(acArchiveAccepted(v.code)).toBe(true);
    expect(v.rows).toBe(3);
  });

  test('HC-SO-013361: 7 sent + 1 failed + 1 skipped, both re-queued — retirable', () => {
    const requeued = `${REQUEUE_NOTE_PREFIX} 2026-09-04T06:51:29.513Z -> outbox abaecb5b] Gave up after 6 attempts.`;
    const v = acArchiveVerdict([
      ...Array.from({ length: 7 }, () => row()),
      row({ status: 'failed', last_error: requeued }),
      row({ status: 'skipped', last_error: requeued }),
    ]);
    expect(v.code).toBe('ok');
    expect(v.rows).toBe(9);
  });

  test('an OUTSTANDING refusal is never retired — it is the page\'s whole job', () => {
    const v = acArchiveVerdict([
      row(),
      row({ status: 'skipped', last_error: 'refused, nothing sent (KeylessLineError): ...' }),
    ]);
    expect(v.code).toBe('needs-attention');
    expect(acArchiveAccepted(v.code)).toBe(false);
    expect(v.blocked).toBe(1);
  });

  test('an outstanding FAILED row blocks it too', () => {
    const v = acArchiveVerdict([row({ status: 'failed', last_error: 'AutoCount said no' })]);
    expect(v.code).toBe('needs-attention');
  });

  test('a document still on its way is not finished, so it is not retired', () => {
    const v = acArchiveVerdict([row(), row({ status: 'pending' })]);
    expect(v.code).toBe('still-working');
    expect(acArchiveAccepted(v.code)).toBe(false);
  });

  test('waiting is reported before attention when a document has both', () => {
    const v = acArchiveVerdict([
      row({ status: 'pending' }),
      row({ status: 'failed', last_error: 'AutoCount said no' }),
    ]);
    expect(v.code).toBe('still-working');
  });

  test('a document already retired says so rather than pretending to work', () => {
    const v = acArchiveVerdict([
      row({ archived_at: '2026-09-08T01:00:00.000Z' }),
      row({ archived_at: '2026-09-08T01:00:00.000Z' }),
    ]);
    expect(v.code).toBe('already-archived');
    expect(acArchiveAccepted(v.code)).toBe(false);
  });

  test('a new send after a retire makes the document live again', () => {
    const v = acArchiveVerdict([
      row({ archived_at: '2026-09-08T01:00:00.000Z' }),
      row(),
    ]);
    expect(v.code).toBe('ok');
    expect(v.rows).toBe(1);
  });
});

describe('AC_ARCHIVE_MEANING', () => {
  test('every outcome has a sentence, and none of them names a column', () => {
    for (const [code, sentence] of Object.entries(AC_ARCHIVE_MEANING)) {
      expect(sentence.length, code).toBeGreaterThan(20);
      expect(sentence, code).not.toMatch(/archived_at|last_error|autocount_outbox|status|SDK/);
    }
  });

  test('the vocabulary and the verdicts are the same set', () => {
    const codes = new Set(Object.keys(AC_ARCHIVE_MEANING));
    for (const c of ['ok', 'doc-not-found', 'needs-attention', 'still-working', 'already-archived']) {
      expect(codes.has(c), c).toBe(true);
    }
  });
});
