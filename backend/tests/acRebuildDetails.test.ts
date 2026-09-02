// ----------------------------------------------------------------------------
// A REBUILD IS THE ANSWER TO A DOCUMENT THAT CANNOT BE MATCHED.
//
// Owner 2026-09-02, on HC-SO-013394 — held back because two book lines share an
// item code and the ERP line has no description to tell them apart:
//
//   「如果做得到 inistate 的东西，那就是我删或者 addline 都可以 sync 进去，
//     就代表这张单也进得去了啊」
//
// He is right, and the reasoning is what this file pins. The keyless refusal
// exists because APPENDING a line we could not match duplicates it. A rebuild
// appends to nothing: the details are cleared and the ERP's list is laid down in
// order, so the matching problem does not arise — and neither does the duplicate.
//
// The whole cost is that every DtlKey is destroyed and reissued, which is
// survivable only while nothing downstream holds them. That is the one thing the
// ERP may not decide from its own copy of the book, so the HOST checks it.
// ----------------------------------------------------------------------------
import { describe, expect, test } from 'vitest';
import writebackSrc from '../src/services/autocount-writeback.ts?raw';
import serviceSrc from '../scripts/autocount-service/AcSyncService.cs?raw';

const code = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const WRITEBACK = code(writebackSrc);
const SERVICE = code(serviceSrc);

describe('the ERP asks; it never infers', () => {
  test('the sources actually loaded — an empty scan must not read as a pass', () => {
    expect(WRITEBACK.length).toBeGreaterThan(1000);
    expect(SERVICE.length).toBeGreaterThan(1000);
  });

  test('rebuild is an explicit option, off unless asked', () => {
    expect(WRITEBACK).toMatch(/rebuild\?: boolean;/);
    /* `effOpts`, not `opts` — composeEdit derives the rule (ac-line-gone.ts)
       and must not reassign its own parameter to do it. */
    expect(WRITEBACK).toMatch(/if \(effOpts\.rebuild\) return \{[^}]*Rebuild: true \}/);
  });

  /* Inferring a rebuild from the failure would turn every future mismatch into a
     silent teardown of a live document. The refusal must still be reachable. */
  test('without the flag the keyless refusal still throws', () => {
    expect(WRITEBACK).toMatch(/throw new KeylessLineError\(/);
    const askIdx = WRITEBACK.indexOf('if (effOpts.rebuild) return');
    const throwIdx = WRITEBACK.indexOf('throw new KeylessLineError(');
    expect(askIdx, 'the rebuild escape must come BEFORE the throw').toBeLessThan(throwIdx);
    expect(askIdx).toBeGreaterThan(-1);
  });
});

describe('the host refuses a rebuild the book cannot survive', () => {
  test('it reads TRANSFERRED from the book, not from anything the ERP believes', () => {
    expect(SERVICE).toMatch(/static bool AnyLineTransferred\(/);
    expect(SERVICE).toMatch(/ISNULL\(d\.TransferedQty,0\) > 0/);
  });

  /* `> 0`, not `IS NOT NULL`: AutoCount writes 0 on a line that never moved, so
     a NULL test would call every document transferred and the rebuild would
     never run at all — a guard that refuses everything is not a guard. */
  test('an untouched line reads as NOT transferred', () => {
    expect(SERVICE).not.toMatch(/d\.TransferedQty IS NOT NULL/);
  });

  test('an unknown document type refuses rather than rebuilding blind', () => {
    const fn = SERVICE.slice(SERVICE.indexOf('static bool AnyLineTransferred('));
    expect(fn.slice(0, fn.indexOf('__DBLINE__'))).toMatch(/default: return true;/);
  });

  test('the rebuild is gated on the check, and says so when it refuses', () => {
    expect(SERVICE).toMatch(/if \(AnyLineTransferred\(type, docNo\)\)/);
    expect(SERVICE).toMatch(/cannot be rebuilt/);
  });
});

describe('the rebuilt document holds exactly what the ERP sent', () => {
  test('the details are cleared before the lines are laid down', () => {
    const clear = SERVICE.indexOf('doc.ClearDetails();');
    expect(clear, 'ClearDetails is never called').toBeGreaterThan(-1);
    expect(SERVICE.indexOf('foreach (var it in lines)', clear))
      .toBeGreaterThan(clear);
  });

  /* THE ORDERING BUG THIS FILE EXISTS FOR. A line the ERP DELETED is skipped on
     a rebuild — the cleared document already lacks it. That skip must happen
     BEFORE AddDetail: the retire branch sits further down the loop, and reaching
     it would mean the line had already been added back as a blank row. Found by
     reading the loop after writing the branch; there is no C# toolchain here to
     have caught it. */
  test('a deleted line is skipped BEFORE anything adds it back', () => {
    const skip = SERVICE.indexOf('if (rebuild && Bool(it, "Retire")) continue;');
    expect(skip, 'the rebuild skip is missing').toBeGreaterThan(-1);
    const add = SERVICE.indexOf('d = doc.AddDetail();', skip);
    expect(add, 'AddDetail not found after the skip').toBeGreaterThan(-1);
    expect(skip).toBeLessThan(add);
  });

  /* After a clear there are no keys left to edit, so a DtlKey in the payload
     must not send the loop down the EditDetail arm. */
  test('a rebuild never tries to edit a key the clear just destroyed', () => {
    expect(SERVICE).toMatch(/if \(!rebuild && it\.ContainsKey\("DtlKey"\)/);
  });

  /* ClearDetails is on the base document class, which is why this works for the
     three types the SDK gives no DeleteDetail — it is the only way a purchase
     order can lose a line at all. */
  test('the rebuild is not restricted to sales orders, unlike the delete', () => {
    const clear = SERVICE.slice(SERVICE.indexOf('if (rebuild) {'), SERVICE.indexOf('doc.ClearDetails();') + 40);
    expect(clear).not.toMatch(/type == "SO"/);
  });
});
