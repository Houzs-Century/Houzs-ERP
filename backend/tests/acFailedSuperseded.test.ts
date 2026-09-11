// The health report used to call HC-DO-2609-004 and -009 failures while the
// page showed them as in the account book, because the page had the rule and
// the report did not. These are the cases that decide it.
import { describe, expect, it } from 'vitest';
import {
  acDocKeyOf,
  isoTimestamp,
  newestArrivalByDoc,
  supersededFailureKeys,
} from '../scripts/lib/ac-failed-superseded.mjs';

const REFUSED = '2026-09-08T02:00:00.000Z';
const ARRIVED = '2026-09-08T05:00:00.000Z';

describe('a failure the account book has since answered', () => {
  it('is discounted when the document arrived AFTER the refusal', () => {
    const arrivals = newestArrivalByDoc([{ doc_type: 'DO', doc_no: 'HC-DO-2609-004', arrived_at: ARRIVED }]);
    const keys = supersededFailureKeys([{ doc_type: 'DO', doc_no: 'HC-DO-2609-004', created_at: REFUSED }], arrivals);
    expect([...keys]).toEqual(['DO:HC-DO-2609-004']);
  });

  it('is NOT discounted when the refusal came after the arrival', () => {
    /* Arrived, then edited into a refusal: it is in the book AND needs
       attention. Both are true, and the report must keep saying so. */
    const arrivals = newestArrivalByDoc([{ doc_type: 'DO', doc_no: 'HC-DO-2609-004', arrived_at: REFUSED }]);
    const keys = supersededFailureKeys([{ doc_type: 'DO', doc_no: 'HC-DO-2609-004', created_at: ARRIVED }], arrivals);
    expect(keys.size).toBe(0);
  });

  it('is NOT discounted when the document never arrived', () => {
    const keys = supersededFailureKeys(
      [{ doc_type: 'DO', doc_no: 'HC-DO-2609-009', created_at: REFUSED }],
      newestArrivalByDoc([]),
    );
    expect(keys.size).toBe(0);
  });

  it('is NOT discounted when a timestamp cannot be read', () => {
    const arrivals = newestArrivalByDoc([{ doc_type: 'DO', doc_no: 'D1', arrived_at: ARRIVED }]);
    const keys = supersededFailureKeys([{ doc_type: 'DO', doc_no: 'D1', created_at: 'not a date' }], arrivals);
    expect(keys.size).toBe(0);
  });
});

describe('a document is its TYPE and its number', () => {
  it('does not let one type answer another type\'s failure', () => {
    /* SO HC-2609-004 arriving must not clear DO HC-2609-004. Matching on the
       number alone would forgive a real failure in silence. */
    const arrivals = newestArrivalByDoc([{ doc_type: 'SO', doc_no: 'HC-2609-004', arrived_at: ARRIVED }]);
    const keys = supersededFailureKeys([{ doc_type: 'DO', doc_no: 'HC-2609-004', created_at: REFUSED }], arrivals);
    expect(keys.size).toBe(0);
  });

  it('keys a row by both halves', () => {
    expect(acDocKeyOf({ doc_type: 'DO', doc_no: 'HC-DO-2609-004' })).toBe('DO:HC-DO-2609-004');
  });
});

describe('one spelling of a moment', () => {
  it('turns the Date postgres.js returns into the ISO string the rule compares', () => {
    expect(isoTimestamp(new Date(ARRIVED))).toBe(ARRIVED);
  });

  it('keeps an unusable value unusable rather than inventing one', () => {
    expect(isoTimestamp(null)).toBe('');
    expect(isoTimestamp(undefined)).toBe('');
    expect(isoTimestamp(new Date('nonsense'))).toBe('');
  });

  it('compares a Date against a Date correctly end to end', () => {
    /* The shape the script actually passes: both sides straight off
       postgres.js. A string/Date mix-up here would compare "2026-..." against
       "Tue Sep 08 2026" and answer nonsense. */
    const arrivals = newestArrivalByDoc([{ doc_type: 'DO', doc_no: 'D1', arrived_at: new Date(ARRIVED) }]);
    const keys = supersededFailureKeys([{ doc_type: 'DO', doc_no: 'D1', created_at: new Date(REFUSED) }], arrivals);
    expect([...keys]).toEqual(['DO:D1']);
  });
});

describe('more than one arrival', () => {
  it('takes the NEWEST, so an old send cannot clear a later refusal', () => {
    const arrivals = newestArrivalByDoc([
      { doc_type: 'DO', doc_no: 'D1', arrived_at: '2026-09-08T01:00:00.000Z' },
      { doc_type: 'DO', doc_no: 'D1', arrived_at: '2026-09-08T09:00:00.000Z' },
    ]);
    expect(arrivals.get('DO:D1')).toBe('2026-09-08T09:00:00.000Z');
    /* Refused at 02:00 — after the first send, before the second. The newest
       arrival is what decides, so this IS history. */
    expect(supersededFailureKeys([{ doc_type: 'DO', doc_no: 'D1', created_at: REFUSED }], arrivals).size).toBe(1);
  });

  it('ignores an arrival row whose timestamp is missing', () => {
    const arrivals = newestArrivalByDoc([{ doc_type: 'DO', doc_no: 'D1', arrived_at: null }]);
    expect(arrivals.size).toBe(0);
  });
});

describe('a SKIP the account book has since answered', () => {
  /* The half the first version of this rule left out (docs/bugs/0743 covered
     `failed` only), and the half that kept telling an operator to backfill a
     key that was already there — HC-SO-001180, HC-SO-001463, HC-SO-001473. */
  const REFUSED_AT = '2026-09-01T02:00:00.000Z';
  const ARRIVED_AT = '2026-09-08T05:00:00.000Z';

  it('is discounted by the same rule and the same function as a failure', () => {
    const arrivals = newestArrivalByDoc([{ doc_type: 'SO', doc_no: 'HC-SO-001180', arrived_at: ARRIVED_AT }]);
    const keys = supersededFailureKeys(
      [{ doc_type: 'SO', doc_no: 'HC-SO-001180', created_at: REFUSED_AT }],
      arrivals,
    );
    expect([...keys]).toEqual(['SO:HC-SO-001180']);
  });

  it('is NOT discounted when the arrivals map never learned that document', () => {
    /* The bug this test exists for: the arrivals were read for the FAILED
       documents only, so every skip looked un-arrived and the widened rule
       would have changed nothing while looking correct. An empty map must
       therefore discount NOTHING, loudly and by construction. */
    const keys = supersededFailureKeys(
      [{ doc_type: 'SO', doc_no: 'HC-SO-001463', created_at: REFUSED_AT }],
      newestArrivalByDoc([]),
    );
    expect(keys.size).toBe(0);
  });
});
