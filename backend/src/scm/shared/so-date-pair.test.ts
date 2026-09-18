// ----------------------------------------------------------------------------
// so-date-pair — the owner's both-dates-or-neither rule, and the enumeration of
// the write paths that must call it.
//
// THE RULE (owner, restated 2026-08-13): "processing date 和 delivery date 必须
// 同时有或者同时没有". A Processing Date RELEASES the order to purchasing to go
// and order the goods (owner 2026-08-18 — not a production date; this business
// schedules no factory) and the Delivery Date is what it is promised against.
//
// This file is the PREDICATE. Which write paths reach it is a different
// question and a different file — tests/soDatePairWiring.test.ts — because the
// bug was never in the predicate: the rule was written by hand in five places
// and missing from three others, and every unit test over the logic would
// still have passed.
// ----------------------------------------------------------------------------
import { describe, it, expect } from 'vitest';
import {
  SO_DATE_PAIR_REFUSAL,
  soDatePairCascadeColumns,
  soDatePairRefusal,
  soDateDay,
  soDateYmd,
} from './so-processing-date';

describe('soDatePairRefusal — the predicate', () => {
  it('accepts both dates set', () => {
    expect(soDatePairRefusal({
      nextProc: '2026-09-01', nextDeliv: '2026-09-20', origProc: null, origDeliv: null,
    })).toBeNull();
  });

  it('accepts neither date set', () => {
    expect(soDatePairRefusal({
      nextProc: null, nextDeliv: null, origProc: null, origDeliv: null,
    })).toBeNull();
  });

  it('refuses a Processing Date with no Delivery Date', () => {
    expect(soDatePairRefusal({
      nextProc: '2026-09-01', nextDeliv: null, origProc: null, origDeliv: null,
    })).toEqual(SO_DATE_PAIR_REFUSAL);
  });

  it('refuses a Delivery Date with no Processing Date', () => {
    expect(soDatePairRefusal({
      nextProc: null, nextDeliv: '2026-09-20', origProc: null, origDeliv: null,
    })).toEqual(SO_DATE_PAIR_REFUSAL);
  });

  it("refuses clearing one half of a stored pair", () => {
    expect(soDatePairRefusal({
      nextProc: '2026-09-01', nextDeliv: null,
      origProc: '2026-09-01', origDeliv: '2026-09-20',
    })).toEqual(SO_DATE_PAIR_REFUSAL);
  });

  /* The grandfather carve-out. Live orders are honestly unpaired (imported
     AutoCount history has no delivery date for some), so an edit that touches
     neither date — a remark, a phone number — must still save. */
  it('grandfathers a stored unpaired pair this save leaves alone', () => {
    expect(soDatePairRefusal({
      nextProc: '2026-09-01', nextDeliv: null,
      origProc: '2026-09-01', origDeliv: null,
    })).toBeNull();
    expect(soDatePairRefusal({
      nextProc: null, nextDeliv: '2026-09-20',
      origProc: null, origDeliv: '2026-09-20',
    })).toBeNull();
  });

  it('does NOT grandfather a move from one unpaired date to another', () => {
    expect(soDatePairRefusal({
      nextProc: '2026-10-05', nextDeliv: null,
      origProc: '2026-09-01', origDeliv: null,
    })).toEqual(SO_DATE_PAIR_REFUSAL);
  });

  /* A stored DATE reaches callers as '2026-09-01' from one client and as a full
     timestamp from another. If the compare did not normalise, an untouched
     order would read as changed and every edit of a legacy unpaired SO would
     start failing. */
  it('treats a timestamp and its day as the same stored value', () => {
    expect(soDatePairRefusal({
      nextProc: '2026-09-01', nextDeliv: null,
      origProc: '2026-09-01T00:00:00+00:00', origDeliv: null,
    })).toBeNull();
  });

  /* Presence is measured on the raw value, parseability is not. An unparseable
     date is still A DATE for the pair test — it must be refused as half a pair,
     not silently read as "no date" and let through to the column. */
  it('counts an unparseable but present value as a date', () => {
    expect(soDatePairRefusal({
      nextProc: 'next tuesday', nextDeliv: null, origProc: null, origDeliv: null,
    })).toEqual(SO_DATE_PAIR_REFUSAL);
    expect(soDateYmd('next tuesday')).toBeNull();
  });

  it('treats empty string and whitespace as absent', () => {
    expect(soDatePairRefusal({
      nextProc: '   ', nextDeliv: '', origProc: null, origDeliv: null,
    })).toBeNull();
  });
});

describe('soDatePairCascadeColumns — clearing one clears both', () => {
  it('clears the delivery date when the processing date is cleared', () => {
    expect(soDatePairCascadeColumns({
      procCleared: true, delivInPatch: false, origDeliv: '2026-09-20',
    })).toEqual(['customer_delivery_date']);
  });

  it('does not cascade when the request already names the delivery date', () => {
    expect(soDatePairCascadeColumns({
      procCleared: true, delivInPatch: true, origDeliv: '2026-09-20',
    })).toEqual([]);
  });

  it('does not cascade when there is no stored delivery date to clear', () => {
    expect(soDatePairCascadeColumns({
      procCleared: true, delivInPatch: false, origDeliv: null,
    })).toEqual([]);
  });

  /* ONE DIRECTION ONLY. Cascading the reverse would clear the Processing Date,
     which is the write `scm.so.remove_processing_date` guards — the cascade
     would become the road around that permission. */
  it('never cascades when the processing date is not being cleared', () => {
    expect(soDatePairCascadeColumns({
      procCleared: false, delivInPatch: false, origDeliv: '2026-09-20',
    })).toEqual([]);
  });
});

/* The approve-so gate reads the SO's stored dates through the PostgreSQL
   command transaction, whose postgres.js shim returns a DATE column as a JS
   Date. `String(date).slice(0, 10)` is 'Fri Aug 28' — it sorts after every
   '2026-…' string, so the gate refused a legal Delivery Date amendment
   (2990-SO-2606-011, 2026-09-04). These pin the Date branch. */
describe('soDateDay / soDateYmd — a Date object is a day, not "Fri Aug 28"', () => {
  it('reads a Date object as its UTC calendar day', () => {
    const stored = new Date('2026-08-28'); // what postgres.js hands back for DATE '2026-08-28'
    expect(soDateDay(stored)).toBe('2026-08-28');
    expect(soDateYmd(stored)).toBe('2026-08-28');
  });

  it('compares a stored Date against an amendment string in date order', () => {
    const nextProc = soDateDay(new Date('2026-08-28'));
    const nextDeliv = soDateDay('2026-09-19');
    // The failing shape: 'Fri Aug 28' > '2026-09-19' was TRUE.
    expect(nextProc > nextDeliv).toBe(false);
    expect(soDatePairRefusal({
      nextProc, nextDeliv, origProc: nextProc, origDeliv: soDateDay(new Date('2026-09-13')),
    })).toBeNull();
  });

  it('keeps the string shapes exactly as before', () => {
    expect(soDateDay('2026-09-01T00:00:00+00:00')).toBe('2026-09-01');
    expect(soDateDay('  2026-09-01 ')).toBe('2026-09-01');
    expect(soDateDay(null)).toBe('');
    expect(soDateDay(undefined)).toBe('');
    expect(soDateDay('')).toBe('');
    expect(soDateDay('next tuesday')).toBe('next tuesd');
    expect(soDateYmd('next tuesday')).toBeNull();
  });

  it('treats an invalid Date as absent', () => {
    expect(soDateDay(new Date('garbage'))).toBe('');
    expect(soDateYmd(new Date('garbage'))).toBeNull();
  });
});
