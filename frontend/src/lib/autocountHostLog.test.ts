// ----------------------------------------------------------------------------
// THE ANSWER MUST BE LIFTED OUT OF THE LOG, NOT LEFT IN IT.
//
// Ten delivery orders were refused sixty times with `Invalid transfer item.`
// while the host wrote the sentence naming the offending line into its own log
// on every one of those attempts. These tests pin the two things that make that
// sentence reachable: that the classifier recognises it, and that it never
// invents a verdict for a line it does not recognise.
//
// The needles are copied from AcSyncService.cs. If one is renamed there this
// suite still passes — a classifier cannot test the other system — which is
// exactly why the panel renders the raw tail as well and why
// AC_HOST_LOG_NOTHING_LIFTED is worded as "nothing matched", never as
// "nothing is wrong".
// ----------------------------------------------------------------------------
import { describe, expect, test } from 'vitest';
import {
  acHostLogFindings,
  AC_HOST_LOG_LINES,
  AC_HOST_LOG_NOTHING_LIFTED,
} from './autocountHostLog';

/** Verbatim shapes AcSyncService.cs writes, trimmed of their timestamps. */
const SHORTFALL =
  '  valid-transfer-item check: AutoCount kept FEWER rows than keys given - the shortfall IS the invalid transfer item(s)';
const COUNT = '  valid-transfer-item check: 2 row(s) for 3 key(s); columns = DtlKey, ItemCode';
const THREW =
  '  valid-transfer-item check THREW AutoCount.Invoicing.InvalidTransferItemException: Invalid transfer item. - that is the vendor\'s own validator refusing these keys, before any document was created';
const NO_ACCOUNT =
  '  WARNING: the target has NO DebtorCode and the transfer is about to run anyway.';
const ORDINARY = '  SO->DO shape: the ERP named 3 line(s)';

describe('the sentence that resolves a refusal is found', () => {
  test('the shortfall line is an ANSWER, not a note', () => {
    const [f] = acHostLogFindings([SHORTFALL]);
    expect(f.tone).toBe('answer');
    expect(f.meaning).toContain('shortfall IS the invalid transfer item');
  });

  test("the validator throwing outright is also an answer", () => {
    expect(acHostLogFindings([THREW])[0].tone).toBe('answer');
  });

  /* The PROVEN cause from 2026-08-17, and the one a reader is most likely to
     act on straight away, so it must not degrade to a note. */
  test('a target with no account is an answer', () => {
    expect(acHostLogFindings([NO_ACCOUNT])[0].tone).toBe('answer');
  });

  /* RULES is ordered specific-first and this is what that ordering buys: the
     bare `valid-transfer-item check:` needle is a substring of the shortfall
     line, so an unordered scan would classify the loud line as a quiet one. */
  test('the specific spelling wins over the general one', () => {
    expect(acHostLogFindings([SHORTFALL])[0].tone).toBe('answer');
    expect(acHostLogFindings([COUNT])[0].tone).toBe('note');
  });
});

describe('nothing is invented', () => {
  test('an unrecognised line produces no finding at all', () => {
    expect(acHostLogFindings([ORDINARY])).toHaveLength(0);
  });

  test('the line is carried verbatim — the machine keeps its own words', () => {
    expect(acHostLogFindings([SHORTFALL])[0].line).toBe(SHORTFALL);
  });

  test('order is the order the host wrote them in', () => {
    const found = acHostLogFindings([COUNT, ORDINARY, SHORTFALL]);
    expect(found.map((f) => f.line)).toEqual([COUNT, SHORTFALL]);
  });

  test('an empty log is an empty list, not a verdict', () => {
    expect(acHostLogFindings([])).toEqual([]);
  });
});

describe('the copy does not overclaim', () => {
  /* "Nothing matched" and "nothing is wrong" are different statements, and the
     tail this panel shows is a TAIL — the failure being chased may simply be
     older than it. */
  test('the empty-result sentence says nothing matched, never that all is well', () => {
    expect(AC_HOST_LOG_NOTHING_LIFTED).toMatch(/matched a known pattern/);
    expect(AC_HOST_LOG_NOTHING_LIFTED).not.toMatch(/no problem|all is well|healthy/i);
  });

  test('the default tail is a request, and a positive one', () => {
    expect(AC_HOST_LOG_LINES).toBeGreaterThan(0);
  });
});
