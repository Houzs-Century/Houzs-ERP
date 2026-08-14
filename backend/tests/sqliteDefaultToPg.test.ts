// The SQLite -> Postgres column-DEFAULT translation, pinned.
//
// WHY IT IS WORTH A FILE. This runs during the D1 -> Postgres load and decides
// what every FUTURE row of a column gets when an insert omits it. A wrong answer
// is not a crash: it is a silently wrong value on rows nobody is looking at yet,
// which is the class this repo keeps paying for. The module had no test of any
// kind, and it exports `__internals` "for the checker only" — an invitation
// nothing had taken up.
//
// WHY VITEST AND NOT node:test, which is what the other scripts/lib checks use.
// Two reasons, and the second is the one that matters:
//   1. The module imports src/db/d1-compat.ts at load time (deliberately — it
//      keeps NO copy of the date rules). Plain `node --test` cannot load it;
//      it needs --experimental-transform-types. Vitest transforms TS anyway.
//   2. coverage-ratchet counts a file as tested only if it is EXECUTED during
//      the vitest coverage run. A node:test file produces no coverage, so it
//      would have left `backend/scripts/lib` exactly as untested as before while
//      looking like a fix.
//
// The two REFUSALS below are the load-bearing part: cases where a plausible
// translation exists and would be wrong, argued at length in the module's own
// comments. The test is what stops someone "helpfully" implementing them.
import { describe, expect, test } from 'vitest';

import { sqliteDefaultToPg, __internals } from '../scripts/lib/sqlite-default-to-pg.mjs';

const clause = (raw: unknown, type: string) => sqliteDefaultToPg(raw, type).clause;

describe('sqliteDefaultToPg', () => {
  test('a caller that passes no default gets a refusal, not a guess', () => {
    for (const empty of [null, undefined]) {
      const r = sqliteDefaultToPg(empty, 'text');
      expect(r.clause).toBeNull();
      expect(r.reason).toMatch(/caller bug/);
    }
    expect(clause('', 'text')).toBeNull();
  });

  test('NULL is carried through rather than dropped', () => {
    expect(clause('NULL', 'text')).toBe('default null');
    expect(clause('null', 'bigint')).toBe('default null');
  });

  test('numeric literals are quoted for text columns and bare for numeric ones', () => {
    expect(clause('0', 'bigint')).toBe('default 0');
    expect(clause('42', 'double precision')).toBe('default 42');
    // Postgres will not coerce an integer literal into a text column's default;
    // SQLite's text affinity would have stored '0' anyway.
    expect(clause('0', 'text')).toBe("default '0'");
    expect(clause('1', 'bytea')).toBeNull();
  });

  test('SQLite booleans are literal 1/0 and follow the column type', () => {
    expect(clause('TRUE', 'bigint')).toBe('default 1');
    expect(clause('false', 'bigint')).toBe('default 0');
    expect(clause('true', 'text')).toBe("default '1'");
    expect(clause('true', 'bytea')).toBeNull();
  });

  test('hex literals become decimal', () => {
    expect(clause('0x10', 'bigint')).toBe('default 16');
    expect(clause('0x10', 'text')).toBe("default '16'");
  });

  test('a string default on a numeric column is carried only when it really is a number', () => {
    expect(clause("'abc'", 'text')).toBe("default 'abc'");
    expect(clause("'7'", 'bigint')).toBe('default 7');
    const r = sqliteDefaultToPg("'abc'", 'bigint');
    expect(r.clause).toBeNull();
    expect(r.reason).toMatch(/Postgres will not/);
  });

  /* REFUSAL 1. rewriteDialect renders SQLite's 'now' as ('now')::timestamptz, and
     Postgres resolves that literal WHEN IT IS READ — so the default would freeze
     at CREATE TABLE time and stamp every future row with the load's timestamp.
     Silently wrong is worse than absent. */
  test('strftime() defaults are REFUSED, not translated', () => {
    const r = sqliteDefaultToPg("strftime('%Y-%m-%dT%H:%M:%SZ','now')", 'text');
    expect(r.clause).toBeNull();
    expect(r.reason).toMatch(/freeze at CREATE TABLE time/);
  });

  /* REFUSAL 2. CURRENT_TIME has no rewriteDialect rule, and inventing one here
     would be the second translation this module exists to avoid. */
  test('CURRENT_TIME is REFUSED and names where support belongs', () => {
    const r = sqliteDefaultToPg('CURRENT_TIME', 'text');
    expect(r.clause).toBeNull();
    expect(r.reason).toMatch(/d1-compat/);
  });

  test('CURRENT_TIMESTAMP and CURRENT_DATE route through the shared now-expression path', () => {
    // They are exactly datetime('now') / date('now'), so they must not grow a
    // second translation here. Only the contract is asserted; the rewrite itself
    // belongs to rewriteDialect.
    for (const expr of ['CURRENT_TIMESTAMP', 'current_date']) {
      const r = sqliteDefaultToPg(expr, 'text');
      if (r.clause === null) expect(typeof r.reason).toBe('string');
      else expect(r.clause.startsWith('default ')).toBe(true);
    }
  });

  test('anything unrecognised is refused and quotes what it saw', () => {
    const r = sqliteDefaultToPg('some_other_column', 'text');
    expect(r.clause).toBeNull();
    expect(r.reason).toMatch(/unrecognised default expression/);
    expect(r.reason).toMatch(/some_other_column/);
  });

  test('stripOuterParens unwraps only parens that wrap the WHOLE expression', () => {
    const { stripOuterParens } = __internals;
    expect(stripOuterParens('(0)')).toBe('0');
    expect(stripOuterParens('((0))')).toBe('0');
    expect(stripOuterParens("  ( 'x' ) ")).toBe("'x'");
    // Two separate groups, not a whole wrap.
    expect(stripOuterParens('(a) || (b)')).toBe('(a) || (b)');
    // A paren inside a string literal must not fool the scanner.
    expect(stripOuterParens("'a)b'")).toBe("'a)b'");
  });

  test('a parenthesised default translates identically to the bare one', () => {
    expect(clause('(0)', 'bigint')).toBe(clause('0', 'bigint'));
    expect(clause("('x')", 'text')).toBe(clause("'x'", 'text'));
  });

  test('every refusal carries a reason and every acceptance carries none', () => {
    const cases: Array<[string, string]> = [
      ['0', 'bigint'], ["'x'", 'text'], ['NULL', 'text'], ['0x10', 'bigint'],
      ["strftime('%Y','now')", 'text'], ['CURRENT_TIME', 'text'], ['nonsense', 'text'],
      ["'abc'", 'bigint'], ['1', 'bytea'],
    ];
    for (const [raw, type] of cases) {
      const r = sqliteDefaultToPg(raw, type);
      if (r.clause === null) expect(typeof r.reason, `${raw}/${type} refused with no reason`).toBe('string');
      else expect(r.reason, `${raw}/${type} accepted but still carries a reason`).toBeNull();
    }
  });
});
