// RETIRING A FINISHED DOCUMENT FROM THE AUTOCOUNT SYNC PAGE.
//
// The owner asked twice for three old test documents to stop appearing on
// System -> AutoCount Sync. They are `sent`, the page's own banner reads
// "Everything is in AutoCount", and their work is over; they are the entire
// contents of the screen whose job is to show what still needs attention.
//
// THE TWO ANSWERS THAT WERE ALREADY RULED OUT, and these tests exist so nobody
// re-ships either of them:
//
//   DELETE — 0277's own COMMENT ON TABLE forbids it ("Never delete rows: this
//   is the audit trail of what the ERP told AutoCount"), and the owner's
//   standing rule across the ERP is never delete, only cancel.
//
//   ANOTHER PREFIX MARKER — `isRequeuedNote` is a PREFIX test on `last_error`,
//   deliberately (a row whose own message quotes the marker mid-string is still
//   an open refusal). Stamping a second marker in front of a re-queued row's
//   note stops it reading as `requeued` and pushes it back onto Not accepted —
//   the opposite of what was asked. `archived_at` is a COLUMN OF ITS OWN for
//   exactly that reason: it touches neither `status` nor `last_error`, so every
//   verdict this module already reaches is unchanged by archiving.
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

  /* THE THREE DOCUMENTS THIS WAS BUILT FOR, as production holds them
     (read-only DSN, 2026-09-08). Each carries settled refusals BEHIND a
     re-queue marker plus the sends that replaced them — so a rule that looked
     only at `status` would refuse all three, and a rule that ignored the marker
     would archive a genuinely open refusal. It is `acOutboxState` that
     separates them, the same function the page and the health check use. */
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

  /* PENDING IS REPORTED AHEAD OF A SETTLED REFUSAL. Both are "not finished",
     but only one of them is going to resolve itself, and telling somebody to go
     and fix a document that the next five-minute send may well clear is how a
     page earns a reputation for crying wolf. */
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

  /* A DOCUMENT SENT AGAIN AFTER IT WAS RETIRED IS BACK. The retire is per ROW
     and a re-send writes a NEW row, so a partly-archived document is one that
     has moved on — it must be archivable again rather than reported as done. */
  test('a new send after a retire makes the document live again', () => {
    const v = acArchiveVerdict([
      row({ archived_at: '2026-09-08T01:00:00.000Z' }),
      row(),
    ]);
    expect(v.code).toBe('ok');
    /* Only the row that is not already retired is written. */
    expect(v.rows).toBe(1);
  });
});

describe('AC_ARCHIVE_MEANING', () => {
  test('every outcome has a sentence, and none of them names a column', () => {
    for (const [code, sentence] of Object.entries(AC_ARCHIVE_MEANING)) {
      expect(sentence.length, code).toBeGreaterThan(20);
      /* THE OWNER READS THESE. The same rule the skip reasons are held to:
         no table, no column, no SDK identifier on a page he opens. */
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
