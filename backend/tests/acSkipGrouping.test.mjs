// The guard for docs/bugs/0606-the-outbox-health-report-counted-one-refusal-under-two-remed.md: a refusal is reported ONCE, under ONE class.
//
// The production sentence below is the real one, with the document number and
// item code removed. It contains the `keyless-line` needle AND, further along,
// the `dtlkey-subset` needle — so a reporter that filtered per needle listed
// the same row under both, with two remedies that contradict each other.
import { describe, expect, it } from 'vitest';

import { groupAcSkipsByKind } from '../scripts/lib/ac-skip-grouping.mjs';

const KEYLESS_TWO_NEEDLES =
  'refused, nothing sent (KeylessLineError): SO SO-000000: 1 of 8 line(s) carry no '
  + 'AutoCount DtlKey — line(s) 1. Sending this edit would append duplicate lines to '
  + 'the live account book.';

describe('grouping outbox skips by refusal class', () => {
  it('a reason matching two needles lands in exactly one bucket', () => {
    const rows = [{ doc_no: 'A', op: 'edit', last_error: KEYLESS_TWO_NEEDLES }];
    const { ordered } = groupAcSkipsByKind(rows);
    expect(ordered.map((g) => g.kind)).toEqual(['keyless-line']);
    expect(ordered[0].rows).toHaveLength(1);
  });

  it('every row is accounted for exactly once, across all buckets', () => {
    /* The arithmetic the old report broke: two rows on one document were
       printed as `skipped 2` twice, so a reader summing the buckets counted
       four documents in a queue holding two rows. */
    const rows = [
      { doc_no: 'A', op: 'edit', last_error: KEYLESS_TWO_NEEDLES },
      { doc_no: 'A', op: 'edit', last_error: KEYLESS_TWO_NEEDLES },
      { doc_no: 'B', op: 'create_po', last_error: 'refused, nothing sent (MissingCreditorError): x' },
      { doc_no: 'C', op: 'edit', last_error: 'a refusal class written next month' },
    ];
    const { ordered, unrecognised } = groupAcSkipsByKind(rows);
    const counted = ordered.reduce((n, g) => n + g.rows.length, 0) + unrecognised.length;
    expect(counted).toBe(rows.length);
  });

  it('buckets come back in AC_SKIP_KINDS priority order, not input order', () => {
    /* The order is load-bearing: the transport class sits before the master-data
       class on purpose, because "the host is not answering" reading as bad
       master data sends the investigation to the wrong subsystem. */
    const rows = [
      { doc_no: 'B', op: 'edit', last_error: 'masters not opened: something' },
      { doc_no: 'A', op: 'edit', last_error: KEYLESS_TWO_NEEDLES },
    ];
    expect(groupAcSkipsByKind(rows).ordered.map((g) => g.kind))
      .toEqual(['keyless-line', 'masters-not-opened']);
  });

  it('an unrecognised reason is returned separately, never folded into a neighbour', () => {
    const rows = [{ doc_no: 'C', op: 'edit', last_error: 'a refusal class written next month' }];
    const { ordered, unrecognised } = groupAcSkipsByKind(rows);
    expect(ordered).toHaveLength(0);
    expect(unrecognised).toHaveLength(1);
  });

  it('two unrecognised rows on the SAME document are both returned', () => {
    /* The smaller half of the same bug: the old "rest" set was keyed on
       `doc_no + op`, which collapses two rows of one document into one key and
       drops the second from the report entirely. */
    const rows = [
      { doc_no: 'C', op: 'edit', last_error: 'first unknown refusal' },
      { doc_no: 'C', op: 'edit', last_error: 'second unknown refusal' },
    ];
    expect(groupAcSkipsByKind(rows).unrecognised).toHaveLength(2);
  });

  it('an empty queue groups to nothing, without throwing', () => {
    expect(groupAcSkipsByKind([])).toEqual({ ordered: [], unrecognised: [] });
  });
});
