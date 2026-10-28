import { env } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";
import { listMyCases, myCasesPredicateSql } from "../src/services/assrVisibility";

/**
 * "My Cases" keys on WHO RAISED the case, not on a name match.
 *
 * Owner ruling 2026-08-21: 「如果是他开的 就算不是他as agent它也可以看啊 … 那就是他
 * submit就代表他认领这个case了啊」 — a case a person opened is theirs whether or not
 * the order names them as agent, because AutoCount's agent data is unreliable and
 * AutoCount-sourced orders are open to every Houzs staff member to raise a case
 * on. Submitting IS claiming.
 *
 * Before this change the list matched ONLY
 * `LOWER(COALESCE(sales_agent,'')) LIKE '%<subtree member name>%'` — free text
 * mirrored from AutoCount (mig 010). The ACCESS gate was moved off that
 * mechanism on 2026-08-20; this list was not, so a rename, a stray space or a
 * different spelling silently dropped a person's OWN case out of their list.
 *
 * The name arm is still here on purpose and these tests pin that too: census run
 * 32463589829 measured 1,113 user→case pairs across 28 users reachable ONLY by
 * the agent text (office staff raising a case on a rep's behalf). Union, never
 * replace.
 *
 * Org chart used throughout:  manager(10) → rep(11),  office(12) unrelated,
 *                             stranger(13) unrelated.
 */

const MANAGER = 10;
const REP = 11;
const OFFICE = 12;
const STRANGER = 13;

async function user(id: number, name: string, managerId: number | null) {
  await env.DB.prepare(
    `INSERT INTO users (id, name, email, password_hash, role_id, manager_id, status)
     VALUES (?, ?, ?, 'x', 1, ?, 'active')`,
  )
    .bind(id, name, `u${id}@example.com`, managerId)
    .run();
}

async function seedCase(
  id: number,
  createdBy: number | null,
  salesAgent: string | null,
) {
  await env.DB.prepare(
    `INSERT INTO assr_cases (id, assr_no, doc_no, stage, customer_name, created_by, sales_agent)
     VALUES (?, ?, ?, 'pending_review', 'Cust', ?, ?)`,
  )
    .bind(id, `ASSR/MC-${id}`, `SO-MC-${id}`, createdBy, salesAgent)
    .run();
}

const myCaseIds = async (userId: number): Promise<number[]> => {
  const r = await listMyCases(env, userId, "");
  return (r.cases as Array<{ id: number }>).map((x) => x.id).sort((a, b) => a - b);
};

beforeEach(async () => {
  await env.DB.exec(`DELETE FROM assr_cases`);
  await env.DB.exec(`DELETE FROM users WHERE id IN (10,11,12,13)`);
  await env.DB.exec(
    `INSERT OR IGNORE INTO roles (id, name, permissions) VALUES (1, 'Test', '[]')`,
  );
  await user(MANAGER, "Alice Manager", null);
  await user(REP, "Bob Rep", MANAGER);
  await user(OFFICE, "Cathy Office", null);
  await user(STRANGER, "Dan Stranger", null);
});

describe("the creator arm — the ruling", () => {
  test("a case the caller RAISED is theirs even when sales_agent names someone else", async () => {
    // The exact shape the ruling is about: AutoCount says the agent is Dan, but
    // Bob opened the case, so Bob claimed it.
    await seedCase(1, REP, "Dan Stranger");
    expect(await myCaseIds(REP)).toEqual([1]);
  });

  test("a case the caller RAISED with NO sales_agent at all is theirs", async () => {
    await seedCase(2, REP, null);
    expect(await myCaseIds(REP)).toEqual([2]);
  });

  test("the pyramid rule stands — a manager sees a case their downline raised", async () => {
    await seedCase(3, REP, "Dan Stranger");
    expect(await myCaseIds(MANAGER)).toEqual([3]);
  });

  test("a case someone OUTSIDE the subtree raised, naming nobody, is not mine", async () => {
    await seedCase(4, STRANGER, null);
    expect(await myCaseIds(REP)).toEqual([]);
    expect(await myCaseIds(MANAGER)).toEqual([]);
  });
});

describe("the legacy name arm — kept, because production needs it", () => {
  test("office raises a case on a rep's behalf: the REP still sees it", async () => {
    // created_by = office, sales_agent = the rep. 1,113 live pairs look like
    // this (census 32463589829) — dropping the name arm would take them away.
    await seedCase(5, OFFICE, "Bob Rep");
    expect(await myCaseIds(REP)).toEqual([5]);
  });

  test("a legacy case with NO created_by is still reachable by agent text", async () => {
    await seedCase(6, null, "Bob Rep");
    expect(await myCaseIds(REP)).toEqual([6]);
  });

  test("both arms together, de-duplicated into one list", async () => {
    await seedCase(7, REP, "Dan Stranger"); // creator arm only
    await seedCase(8, OFFICE, "Bob Rep"); // name arm only
    await seedCase(9, STRANGER, "Dan Stranger"); // neither
    expect(await myCaseIds(REP)).toEqual([7, 8]);
  });
});

describe("myCasesPredicateSql — shape", () => {
  test("emits the creator arm by ID and the name arm as BINDS", () => {
    const p = myCasesPredicateSql([10, 11], ["alice manager", "bob rep"]);
    expect(p).not.toBeNull();
    expect(p!.sql).toContain("created_by IN (10,11)");
    expect(p!.sql).toContain("LOWER(COALESCE(sales_agent, '')) LIKE ?");
    expect(p!.binds).toEqual(["%alice manager%", "%bob rep%"]);
  });

  test("non-integer / non-positive ids are dropped before inlining", () => {
    const p = myCasesPredicateSql([0, -3, 4, Number.NaN], []);
    expect(p!.sql).toBe("created_by IN (4)");
  });

  test("no ids and no names FAILS CLOSED (null), never an unfiltered list", () => {
    expect(myCasesPredicateSql([], [])).toBeNull();
    expect(myCasesPredicateSql([0], ["", "  "])).toBeNull();
  });

  test("a caller with a name but no resolvable id still gets the legacy arm", () => {
    const p = myCasesPredicateSql([], ["bob rep"]);
    expect(p!.sql).toBe("LOWER(COALESCE(sales_agent, '')) LIKE ?");
    expect(p!.binds).toEqual(["%bob rep%"]);
  });
});
