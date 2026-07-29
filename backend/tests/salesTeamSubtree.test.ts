import { env } from "cloudflare:test";
import { describe, expect, test, beforeEach } from "vitest";
import { subtreeRepIds } from "../src/services/salesTeam";

// Exercises the sales_reps downline resolver against the isolated test D1
// (sales_reps table from migration 067). subtreeRepIds is deliberately kept
// although caller-less on main — the SCM visibility tier that consumed it
// moved to the users manager_id tree (PR #245), and the admin-of-subtree
// PATCH checks left with the stripped sales-team admin module — so this file
// is what pins its contract: inclusive root, whole-branch traversal, archived
// reps pruned together with their downline.
//
// Reps are seeded without user_id, so no users/roles fixtures are needed
// despite the test D1 enforcing FKs.

async function seedRep(
  id: number,
  uplineId: number | null,
  opts: { archived?: string } = {},
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO sales_reps (id, code, name, upline_id, status, archived_at, is_admin)
     VALUES (?, ?, ?, ?, 'active', ?, 0)`,
  )
    .bind(id, `SR-${id}`, `Rep ${id}`, uplineId, opts.archived ?? null)
    .run();
}

const sorted = async (p: Promise<Set<number>>) => [...(await p)].sort((a, b) => a - b);

beforeEach(async () => {
  await env.DB.exec(`DELETE FROM sales_reps`);
});

describe("subtreeRepIds", () => {
  test("leaf rep resolves to just itself", async () => {
    await seedRep(1, null);
    expect(await sorted(subtreeRepIds(env, 1))).toEqual([1]);
  });

  test("root resolves to the whole downline across every tier", async () => {
    await seedRep(1, null); // root (director)
    await seedRep(2, 1); // manager under root
    await seedRep(3, 2); // exec under manager
    await seedRep(4, 1); // another direct report
    expect(await sorted(subtreeRepIds(env, 1))).toEqual([1, 2, 3, 4]);
  });

  test("mid node resolves to its own branch, not siblings or parent", async () => {
    await seedRep(1, null);
    await seedRep(2, 1);
    await seedRep(3, 2);
    await seedRep(4, 1); // sibling branch — must NOT appear under 2
    expect(await sorted(subtreeRepIds(env, 2))).toEqual([2, 3]);
  });

  test("an archived rep is pruned together with its entire branch", async () => {
    await seedRep(1, null);
    await seedRep(2, 1, { archived: "2026-01-01T00:00:00Z" });
    await seedRep(3, 2); // active, but only reachable through archived 2
    expect(await sorted(subtreeRepIds(env, 1))).toEqual([1]);
  });
});
