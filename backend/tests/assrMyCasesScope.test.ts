import { env } from 'cloudflare:test';
import { describe, expect, test, beforeEach } from 'vitest';
import {
  myCasesPredicate,
  normalizeAgentName,
  MIN_REVERSE_AGENT_LEN,
} from '../src/services/assrMyCases';

// The /api/assr/my-cases row rule (services/assrMyCases.ts). Two regressions
// this suite pins (both seen live 2026-08-21, Shawn covering resigned agents'
// customers):
//
//   1. A case the rep CREATED never showed in their list when the SO's
//      sales_agent was someone else's name (a resigned agent's, typically) —
//      created_by is now an OR-arm of the predicate.
//   2. AutoCount spellings that differ from users.name by spacing or a
//      dropped surname (PEIFEN vs "Pei Fen", SHELDON vs "Sheldon Tan")
//      orphaned whole case sets — names are now compared space-stripped in
//      both directions, with a length floor on the reverse arm so initials
//      ("CH") cannot match half the org.
//
// The predicate is executed against the real D1 schema, not inspected as a
// string: what is asserted is which ROWS come back.

const CALLER = 7;
/** A user id no seeded row carries as created_by — isolates the name arms. */
const NAME_ONLY_CALLER = 12345;

async function seed(id: number, agent: string | null, createdBy: number | null): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO assr_cases (id, assr_no, doc_no, stage, sales_agent, created_by)
     VALUES (?, ?, ?, 'pending_review', ?, ?)`,
  )
    .bind(id, `ASSR/MYC-${id}`, `SO-MYC-${id}`, agent, createdBy)
    .run();
}

async function visibleIds(names: string[], userId: number): Promise<number[]> {
  const scope = myCasesPredicate(names, userId);
  const rows = await env.DB.prepare(
    `SELECT id FROM assr_cases WHERE ${scope.sql} AND archived_at IS NULL ORDER BY id`,
  )
    .bind(...scope.binds)
    .all<{ id: number }>();
  return (rows.results ?? []).map((r) => r.id);
}

beforeEach(async () => {
  await env.DB.exec(`DELETE FROM assr_cases`);
  await seed(1, 'KINGSLEY', null); //          exact name, no creator
  await seed(2, 'Chea Huan', null); //         spaces on both sides
  await seed(3, 'PEIFEN', null); //            AutoCount dropped the space
  await seed(4, 'SHELDON', null); //           AutoCount dropped the surname
  await seed(5, 'CH', null); //                initials — must NOT reverse-match
  await seed(6, 'SOMEONE ELSE', CALLER); //    raised by the caller
  await seed(7, 'SOMEONE ELSE', 999); //       raised by a different user
  await seed(8, null, null); //                no agent, no creator
});

describe('myCasesPredicate — name arms', () => {
  test('exact and spaced spellings still match (pre-change behaviour kept)', async () => {
    expect(await visibleIds(['kingsley'], NAME_ONLY_CALLER)).toEqual([1]);
    expect(await visibleIds(['chea huan'], NAME_ONLY_CALLER)).toEqual([2]);
  });

  test('space-stripped forward match: PEIFEN reaches "Pei Fen"', async () => {
    expect(await visibleIds(['pei fen'], NAME_ONLY_CALLER)).toEqual([3]);
  });

  test('reverse match: SHELDON reaches "Sheldon Tan"', async () => {
    expect(await visibleIds(['sheldon tan'], NAME_ONLY_CALLER)).toEqual([4]);
  });

  test(`reverse arm refuses agents shorter than ${MIN_REVERSE_AGENT_LEN} chars`, async () => {
    // "CH" is inside "chea huan", but an initials-length agent must not
    // claim the row. (Forward arm does not fire either: "ch" does not
    // contain "cheahuan".)
    expect(await visibleIds(['chea huan'], NAME_ONLY_CALLER)).toEqual([2]);
  });

  test('a blank subtree name contributes nothing', async () => {
    expect(await visibleIds(['', '  '], CALLER)).toEqual([6]);
  });
});

describe('myCasesPredicate — created_by arm', () => {
  test("a case the caller raised is visible even under someone else's agent name", async () => {
    expect(await visibleIds(['shawn'], CALLER)).toEqual([6]);
  });

  test('with NO subtree names at all, the created_by arm still answers', async () => {
    expect(await visibleIds([], CALLER)).toEqual([6]);
  });

  test("another user's created_by does not leak in", async () => {
    expect(await visibleIds(['nobody-matches'], NAME_ONLY_CALLER)).toEqual([]);
  });
});

describe('normalizeAgentName', () => {
  test('lowercases and strips all whitespace', () => {
    expect(normalizeAgentName('  Pei  Fen ')).toBe('peifen');
    expect(normalizeAgentName('SHELDON TAN')).toBe('sheldontan');
  });
});
