/* The SPECIFICATION for "is this sales order an AutoCount import?"
   (`backend/src/scm/lib/so-is-migrated.ts`), and the regression test for
   docs/bugs/0703 — a brand-new order going read-only minutes after it was saved
   because the AutoCount write-back stamped the column the lock read.

   THE TWO DOCUMENTS ARE PINNED BY NAME, and that is the point of this file.
   Both were measured on production before the fix shipped — Actions -> *SO
   migrated shape (read-only)*, run 34214516108, 2026-09-08:

     HC-SO-2609-001   linked_ac_docno "HC-SO-2609-001"   created by a person at
                      14:06:50 MYT, written back at 14:11, and classed as
                      MIGRATED by 14:12. It must answer FALSE.
     HC-SO-013361     linked_ac_docno "SO-013361"        carried across by the
                      2026-08 cutover import. It must answer TRUE — including
                      after nine `edit` write-backs, three of which AutoCount
                      answered for, which is what makes it the right control:
                      having BEEN to AutoCount is not the same as having come
                      FROM it. */
import { describe, expect, test } from 'vitest';
import { soIsMigrated, soIsMigratedShape } from '../src/scm/lib/so-is-migrated';

describe('soIsMigratedShape — the two documents docs/bugs/0703 names', () => {
  test('HC-SO-2609-001 — created by staff, written back, is NOT migrated', () => {
    expect(soIsMigratedShape('HC-SO-2609-001', 'HC-SO-2609-001')).toBe(false);
  });

  test('HC-SO-013361 — carried across by the cutover, IS migrated', () => {
    expect(soIsMigratedShape('HC-SO-013361', 'SO-013361')).toBe(true);
  });

  /* The unfixed rule was `linked_ac_docno IS NOT NULL`, which answers TRUE for
     both of the rows above. This is the assertion that was RED before the fix. */
  test('the old predicate cannot tell them apart; this one can', () => {
    const oldRule = (link: string | null) => link !== null;
    expect(oldRule('HC-SO-2609-001')).toBe(oldRule('SO-013361'));
    expect(soIsMigratedShape('HC-SO-2609-001', 'HC-SO-2609-001'))
      .not.toBe(soIsMigratedShape('HC-SO-013361', 'SO-013361'));
  });
});

describe('soIsMigratedShape — the grammar', () => {
  test.each([null, undefined, '', '   '])('no book number at all (%s) is NOT migrated', (v) => {
    expect(soIsMigratedShape('HC-SO-2609-001', v as string | null)).toBe(false);
  });

  test.each([
    ['HC-SO-2609-001', 'HC-SO-2609-001'],
    ['  HC-SO-2609-001 ', 'hc-so-2609-001'],
    ['hc-so-2609-001', 'HC-SO-2609-001  '],
  ])('%s == %s — the book took OUR number, so NOT migrated', (erp, book) => {
    expect(soIsMigratedShape(erp, book)).toBe(false);
  });

  test.each([
    ['HC-SO-013361', 'SO-013361'],
    ['HC-SO-000021', 'SO-000021'],
    ['2990-SO-000021', 'SO-000021'],
  ])('%s is a prefix + %s — the cutover built it that way, so MIGRATED', (erp, book) => {
    expect(soIsMigratedShape(erp, book)).toBe(true);
  });

  /* THE TRAP `frontend/src/lib/autocountRegister.ts` records, pinned here so the
     two copies of the rule cannot drift apart: a bare SUFFIX is not a prefixed
     number. `SO-013361` ends with `13361`, and reading that as "the same
     document without its prefix" would excuse a book number that is really a
     different, shorter document. A real prefix ends at a separator — and since
     an unclassifiable pair LOCKS, the assertion is not "it is not prefixed" but
     that it does not travel down the write-back arm. */
  test('a bare suffix is not a prefix — it does not read as our own number', () => {
    expect(soIsMigratedShape('SO-013361', '13361')).toBe(true);
    expect(soIsMigratedShape('SO-013361', 'SO-013361')).toBe(false);
  });

  test('the prefix is derived from the pair, never a hard-coded HC-', () => {
    expect(soIsMigratedShape('ANYCO-SO-9', 'SO-9')).toBe(true);
  });
});

describe('soIsMigratedShape — it fails CLOSED on a pair it cannot classify', () => {
  /* Cannot be produced by the cutover import (`"HC-" + acDoc` by construction)
     and is EMPTY on production today — 0 of 2,883, run 34214516108. It can be
     reached by `renumber-sales-orders.mjs` giving a migrated order a new
     doc_no, and reading that as "the ERP made this" would OPEN a document the
     owner ruled shut. Locking one nobody can classify is recoverable in a
     minute; opening one is not. */
  test.each([
    ['HC-SO-9999', 'SO-013361'],
    ['SO-013361', 'HC-SO-013361'],
    ['HCSO-013361', 'SO-013361'],
  ])('%s vs %s fits neither shape, so it LOCKS', (erp, book) => {
    expect(soIsMigratedShape(erp, book)).toBe(true);
  });

  test('a missing ERP number cannot make a book number look like ours', () => {
    expect(soIsMigratedShape(null, 'SO-013361')).toBe(true);
  });
});

describe('soIsMigrated — the read', () => {
  const read = (data: unknown) => () => Promise.resolve({ data, error: null });

  test('reads the PAIR off the row', async () => {
    await expect(soIsMigrated(read({ doc_no: 'HC-SO-013361', linked_ac_docno: 'SO-013361' }), 'HC-SO-013361'))
      .resolves.toBe(true);
    await expect(soIsMigrated(read({ doc_no: 'HC-SO-2609-001', linked_ac_docno: 'HC-SO-2609-001' }), 'HC-SO-2609-001'))
      .resolves.toBe(false);
  });

  /* PostgREST has come back camelCase where this repo expected snake_case
     before, and here that mistake would read as "no book number" — open, not
     shut. Both spellings, same answer. */
  test('accepts camelCase, because the permissive direction is the dangerous one', async () => {
    await expect(soIsMigrated(read({ docNo: 'HC-SO-013361', linkedAcDocno: 'SO-013361' }), 'HC-SO-013361'))
      .resolves.toBe(true);
  });

  test('falls back to the doc number it was ASKED about when the row omits it', async () => {
    await expect(soIsMigrated(read({ linked_ac_docno: 'SO-013361' }), 'HC-SO-013361')).resolves.toBe(true);
  });

  test('no such order answers false — the handler will 404 and write nothing', async () => {
    await expect(soIsMigrated(read(null), 'HC-SO-000000')).resolves.toBe(false);
  });

  /* FAILS CLOSED. "Not migrated" is the permissive answer, so a read that could
     not run must not be able to look like it. The middleware's catch is what
     turns this throw into `isMigrated: null`, and null LOCKS. */
  test('a failed read THROWS rather than answering false', async () => {
    await expect(soIsMigrated(() => Promise.resolve({ data: null, error: { message: 'boom' } }), 'HC-SO-1'))
      .rejects.toThrow(/soIsMigrated: boom/);
  });
});
