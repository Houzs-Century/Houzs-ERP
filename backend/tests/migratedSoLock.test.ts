/* The SPECIFICATION for the migrated-sales-order lock (owner 2026-09-08,
   「只开新单，旧单暂时不能改」). Every row of the grammar table in
   backend/src/scm/lib/migrated-so-lock.ts is a case here, plus the two things
   that are easy to get backwards and expensive to get wrong:

     • a value we cannot parse LOCKS, and a `-` (the write-freeze row's grammar,
       pasted into the wrong key) is one of those;
     • `isMigrated === null` — "the read failed" — LOCKS, because "not migrated"
       is the permissive answer and a failed read must not be able to look like
       the permissive answer. */
import { describe, expect, test } from 'vitest';
import {
  migratedSoIsLocked,
  migratedSoLockMessage,
  parseMigratedSoLock,
  OPERATOR_MESSAGE_MAX,
} from '../src/scm/lib/migrated-so-lock';
import { soDocNoFromPath } from '../src/scm/lib/migrated-so-readonly';

describe('parseMigratedSoLock', () => {
  test.each(['off', '0', 'false', '', '   ', null, undefined])('%s is open', (v) => {
    expect(parseMigratedSoLock(v as string | null)).toEqual({ scope: 'off', malformed: false });
  });

  test.each(['all', 'true', 'ALL', ' True '])('%s locks every company', (v) => {
    expect(parseMigratedSoLock(v)).toEqual({ scope: 'all', malformed: false });
  });

  test('a single company id', () => {
    expect(parseMigratedSoLock('1')).toEqual({ scope: [1], malformed: false });
  });

  test('several, whitespace and duplicates tolerated', () => {
    expect(parseMigratedSoLock(' 1 , 2 , 1 ')).toEqual({ scope: [1, 2], malformed: false });
  });

  /* THE MISTAKE THIS GUARDS: scm.write_freeze and scm.migrated_so_lock are
     neighbouring rows with similar grammars, and the runbook records the paste
     being made. The freeze's `-` clause means nothing here, so a value carrying
     one is refused rather than read as a lock the operator did not type. */
  test('a write-freeze value pasted in is MALFORMED, not "on"', () => {
    expect(parseMigratedSoLock('1 - scm.procurement.products'))
      .toEqual({ scope: 'all', malformed: true });
  });

  test.each(['houzs', 'company 1', '1;2', '1.5', 'on'])('%s is malformed and locks all', (v) => {
    expect(parseMigratedSoLock(v)).toEqual({ scope: 'all', malformed: true });
  });

  /* A trailing comma used to yield company 0 under Number(); strict digits mean
     it is simply the same list. */
  test('a trailing comma does not invent a company', () => {
    expect(parseMigratedSoLock('1,')).toEqual({ scope: [1], malformed: false });
  });
});

describe('migratedSoIsLocked', () => {
  const on = parseMigratedSoLock('1');
  const off = parseMigratedSoLock('off');
  const all = parseMigratedSoLock('all');

  test('off never locks, whatever the document is', () => {
    expect(migratedSoIsLocked(off, 1, true)).toBe(false);
    expect(migratedSoIsLocked(off, 1, null)).toBe(false);
  });

  test('a NATIVE order is never locked — this is the owner ruling', () => {
    expect(migratedSoIsLocked(on, 1, false)).toBe(false);
    expect(migratedSoIsLocked(all, 1, false)).toBe(false);
  });

  test('a MIGRATED order of a locked company is locked', () => {
    expect(migratedSoIsLocked(on, 1, true)).toBe(true);
  });

  test('a company the value does not name is untouched', () => {
    expect(migratedSoIsLocked(on, 2, true)).toBe(false);
  });

  test('an UNRESOLVED company is not locked — a companies-master blip must not stop 2990', () => {
    expect(migratedSoIsLocked(on, null, true)).toBe(false);
  });

  test("'all' reaches a company the list never named", () => {
    expect(migratedSoIsLocked(all, 2, true)).toBe(true);
  });

  /* The one that decides whether this gate is safe or theatre. */
  test('isMigrated = null (the read failed) LOCKS', () => {
    expect(migratedSoIsLocked(on, 1, null)).toBe(true);
    expect(migratedSoIsLocked(all, 1, null)).toBe(true);
  });
});

describe('migratedSoLockMessage', () => {
  test('the default survives both clients\' length guard', () => {
    expect(migratedSoLockMessage(null).length).toBeLessThan(OPERATOR_MESSAGE_MAX);
  });

  test('it says the three things staff need: view-only, why, and that new orders work', () => {
    const m = migratedSoLockMessage(null);
    expect(m).toMatch(/AutoCount/);
    expect(m).toMatch(/view-only/i);
    expect(m).toMatch(/New orders? save/i);
  });

  test('an operator-typed description wins', () => {
    expect(migratedSoLockMessage('Ask Nick before touching an old order.'))
      .toBe('Ask Nick before touching an old order.');
  });

  /* A description long enough to be discarded by the clients falls back rather
     than rendering as a generic 5xx line — the failure write-freeze.ts records. */
  test('an over-long description falls back to the default', () => {
    expect(migratedSoLockMessage('x'.repeat(OPERATOR_MESSAGE_MAX)))
      .toBe(migratedSoLockMessage(null));
  });

  test('a blank description falls back', () => {
    expect(migratedSoLockMessage('   ')).toBe(migratedSoLockMessage(null));
  });
});

describe('soDocNoFromPath', () => {
  /* CREATE must never resolve a document — this is the owner's 「只开新单」 in
     one assertion. */
  test.each([
    '/api/scm/mfg-sales-orders',
    '/api/scm/mfg-sales-orders/',
    '/mfg-sales-orders',
  ])('%s carries no document (create)', (p) => {
    expect(soDocNoFromPath(p)).toBeNull();
  });

  test('a top-level write resolves the doc number', () => {
    expect(soDocNoFromPath('/api/scm/mfg-sales-orders/HC-SO-012929')).toBe('HC-SO-012929');
  });

  test('a NESTED write resolves the SAME doc number', () => {
    expect(soDocNoFromPath('/api/scm/mfg-sales-orders/HC-SO-012929/items/44')).toBe('HC-SO-012929');
    expect(soDocNoFromPath('/api/scm/mfg-sales-orders/HC-SO-012929/payments/7/slip')).toBe('HC-SO-012929');
    expect(soDocNoFromPath('/api/scm/mfg-sales-orders/HC-SO-012929/amendments')).toBe('HC-SO-012929');
  });

  test('a query string is not part of the doc number', () => {
    expect(soDocNoFromPath('/api/scm/mfg-sales-orders/HC-SO-1?version=3')).toBe('HC-SO-1');
  });

  test('an encoded segment is decoded', () => {
    expect(soDocNoFromPath('/api/scm/mfg-sales-orders/HC%2DSO%2D1')).toBe('HC-SO-1');
  });

  /* A static collection route resolves a "doc number" that names no order. That
     is fine and deliberate: the lookup finds no row, the answer is "not
     migrated", and the write proceeds — safe by construction rather than by an
     allow-list the next static route would fall off. */
  test('a static collection route resolves its own segment, which names no order', () => {
    expect(soDocNoFromPath('/api/scm/mfg-sales-orders/recompute-allocation')).toBe('recompute-allocation');
  });
});
