// ----------------------------------------------------------------------------
// THE QUEUE REPORT MAY NOT CONTRADICT ITSELF, AND MAY NOT ASSERT A SHAPE IT
// CANNOT KNOW.
//
// Both sentences under test were caught by the owner READING the report, not by
// any check — the second one twice in two days:
//
//   「为什么会有矛盾的点呢」
//
// 1. The totals line ended "(3 of those have been re-queued)" appended to
//    "skipped 3 / failed 1", so the same rows were counted as outstanding and
//    described as history in one sentence.
// 2. The FAILED heading read "each is a document that is in the ERP and NOT in
//    AutoCount" over a failed EDIT of SO-013361 — a document the owner had open
//    in AutoCount while reading it.
// ----------------------------------------------------------------------------
import { describe, expect, test } from 'vitest';
import {
  acFailedHeadingLine,
  acQueueTotalsLine,
} from '../scripts/lib/ac-queue-report-lines.mjs';

describe('the totals line says where the re-queued rows sit', () => {
  const by = { pending: 0, sent: 26, failed: 1, skipped: 3 };

  test('with none re-queued it is just the counts', () => {
    const line = acQueueTotalsLine(30, by, 0);
    expect(line).toBe('queue: 30 row(s) — pending 0 / sent 26 / failed 1 / skipped 3');
  });

  /* THE CONTRADICTION. "of those" named no set, so a reader could not tell
     whether 3 things were waiting or none were. */
  test('it never says "of those have been re-queued" again', () => {
    expect(acQueueTotalsLine(30, by, 3)).not.toMatch(/of those have been re-queued/i);
  });

  test('it names the set the re-queued rows are inside, and calls them history', () => {
    const line = acQueueTotalsLine(30, by, 3);
    expect(line).toMatch(/failed\/skipped above/i);
    expect(line).toMatch(/history/i);
    expect(line).toMatch(/waiting on nobody/i);
  });
});

describe('the FAILED heading does not assert a shape it cannot know', () => {
  /* The exact row that exposed it: a failed EDIT on a document that IS in the
     account book. */
  const editRow = [{ op: 'edit', doc_no: 'HC-SO-013361' }];
  const createRow = [{ op: 'create_so', doc_no: 'HC-SO-9' }];

  test('a failed EDIT is never described as missing from AutoCount', () => {
    const line = acFailedHeadingLine(editRow);
    expect(line).not.toMatch(/NOT in AutoCount/i);
    expect(line).toMatch(/IS there and the change did not land|IS in AutoCount/i);
  });

  test('a failed CREATE still says the document is not there', () => {
    expect(acFailedHeadingLine(createRow)).toMatch(/NOT in AutoCount/i);
  });

  /* A MIXED batch may not pick one and print it as if it covered both. */
  test('a mixed batch names both meanings', () => {
    const line = acFailedHeadingLine([...editRow, ...createRow]);
    expect(line).toMatch(/CREATE/);
    expect(line).toMatch(/EDIT/);
  });

  test('the count is still the first thing a reader sees', () => {
    expect(acFailedHeadingLine(editRow)).toMatch(/^FAILED: 1 —/);
  });
});
