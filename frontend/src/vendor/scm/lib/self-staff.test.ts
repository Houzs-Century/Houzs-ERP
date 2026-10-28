/* "Who am I on the staff roster?" — one answer, for every surface that asks.

   ── THE BUG ────────────────────────────────────────────────────────────────
   Desktop moved to matching on `user_id` FIRST in #2049, on a production
   measurement quoted in that commit: of 140 `scm.staff` rows only 18 carry an
   email while 102 carry `user_id`, and `user_id` is the key the BACKEND itself
   resolves the caller by (`resolveOwnerStaffId`). Mobile's `MobileNewSO` still
   matched email-then-name — the string `userId` appeared ZERO times in the file
   — so the majority of salespeople were not recognised as themselves on the
   phone, fell through to the `__self__` placeholder, and could be blocked
   outright by the save guard ("Pick a salesperson before confirming this
   order"). Its own comment claimed it matched "(by id / email / name)".

   Three copies of this resolution existed and no shared module did, which is
   the duplication class this repo keeps paying for. This is the module. */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { resolveSelfStaff } from './self-staff';

const read = (rel: string): string => readFileSync(resolve(process.cwd(), rel), 'utf8');

type Row = { id: string; name: string; email: string | null; userId: number | null };

const ROSTER: Row[] = [
  { id: 'staff-it', name: 'IT Admin', email: null, userId: 4 },
  { id: 'staff-amy', name: 'Amy Tan', email: 'amy@houzs.com', userId: 11 },
  { id: 'staff-ben', name: 'Ben Lim', email: null, userId: null },
];

describe('resolveSelfStaff', () => {
  test('user_id wins — the emailless majority is recognised as themselves', () => {
    /* THE PRODUCTION CASE. The IT Admin has a staff row (user_id 4, email NULL);
       id / email / name all miss it, so the old order offered a synthesized
       "self" option the create path then discarded. */
    expect(resolveSelfStaff(ROSTER, { userId: 4, email: null, name: 'Someone Else' }))
      .toBe(ROSTER[0]);
  });

  test('a string user id from the auth payload still matches a numeric staff row', () => {
    expect(resolveSelfStaff(ROSTER, { userId: '11' })).toBe(ROSTER[1]);
  });

  test('user_id beats a DIFFERENT person who happens to share the email', () => {
    expect(resolveSelfStaff(ROSTER, { userId: 4, email: 'amy@houzs.com' })).toBe(ROSTER[0]);
  });

  test('falls back to the bridge staff id, then email, then name', () => {
    expect(resolveSelfStaff(ROSTER, { staffId: 'staff-ben' })).toBe(ROSTER[2]);
    expect(resolveSelfStaff(ROSTER, { email: ' AMY@HOUZS.COM ' })).toBe(ROSTER[1]);
    expect(resolveSelfStaff(ROSTER, { name: 'ben lim' })).toBe(ROSTER[2]);
    expect(resolveSelfStaff(ROSTER, { staffName: 'Ben Lim' })).toBe(ROSTER[2]);
  });

  test('no match is undefined — never a wrong person', () => {
    expect(resolveSelfStaff(ROSTER, { userId: 999, email: 'nobody@houzs.com', name: 'Nobody' }))
      .toBeUndefined();
    expect(resolveSelfStaff([], { userId: 4 })).toBeUndefined();
  });

  test('a staff row with a null user_id is never matched by an absent caller id', () => {
    /* null === null must not resolve to "that is me". */
    expect(resolveSelfStaff(ROSTER, { userId: null, email: null, name: null })).toBeUndefined();
  });
});

describe('both New-SO surfaces read this module — no fourth copy', () => {
  const mobileSource = read('src/mobile/MobileNewSO.tsx');
  const desktopSource = read('src/pages/scm-v2/SalesOrderNew.tsx');

  test('mobile resolves the signed-in user through the shared module', () => {
    expect(mobileSource, 'MobileNewSO does not import the shared self-match')
      .toContain('resolveSelfStaff');
  });

  test('desktop resolves the signed-in user through the same module', () => {
    expect(desktopSource, 'SalesOrderNew stopped sharing the self-match')
      .toContain('resolveSelfStaff');
  });

  test('mobile no longer claims to match by an id it never looked at', () => {
    /* The comment above the old mobile memo said "(by id / email / name)" while
       the code read email then name. A comment that describes a rule the code
       does not run is worse than no comment: it is what stops the next reader
       from finding this. */
    expect(mobileSource).not.toContain('(by id / email / name)');
  });
});
