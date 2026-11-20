// Mail Center access rules that follow the Org Chart (owner 2026-11-21):
//  - a person's departments are their primary department plus every extra one
//    (user_departments), and each opens its department mailboxes;
//  - 'department_all' also opens those departments' colleagues' own mailboxes;
//  - a member of the Management department reads every mailbox;
//  - every level change and grant is written to mail_access_changes.
import type { Env } from "../types";

/** The Org Chart department whose members read the whole company's mail. */
export const MANAGEMENT_DEPARTMENT = "management";

type Db = Env["DB"];

export async function departmentIdsOf(db: Db, userId: number, primary: number | null): Promise<number[]> {
  let ids: number[] = [];
  try {
    const res = await db
      .prepare(`SELECT department_id FROM user_departments WHERE user_id = ?`)
      .bind(userId)
      .all<{ department_id: number }>();
    ids = res.results.map((r) => Number(r.department_id));
  } catch {
    // user_departments is PG-only (mig 0020); the D1 test mirror has the primary only.
  }
  if (primary != null) ids.unshift(Number(primary));
  return [...new Set(ids.filter((n) => Number.isFinite(n)))];
}

export async function isInManagement(db: Db, departmentIds: number[]): Promise<boolean> {
  if (departmentIds.length === 0) return false;
  const ph = departmentIds.map(() => "?").join(", ");
  const row = await db
    .prepare(`SELECT 1 AS hit FROM departments WHERE id IN (${ph}) AND lower(trim(name)) = ? LIMIT 1`)
    .bind(...departmentIds, MANAGEMENT_DEPARTMENT)
    .first<{ hit: number }>();
  return row != null;
}

/** Department mailboxes (no owner) of these departments; `colleagues` adds the
 *  own mailboxes of everyone in them. `coSql` is the caller's active-company predicate. */
export async function departmentMailboxes(
  db: Db,
  departmentIds: number[],
  colleagues: boolean,
  coSql: string,
): Promise<string[]> {
  if (departmentIds.length === 0) return [];
  const ph = departmentIds.map(() => "?").join(", ");
  // company-scope: coSql is the caller's active-company predicate on email_addresses.
  const shared = await db
    .prepare(
      `SELECT address FROM email_addresses
        WHERE active = 1${coSql} AND assigned_user_id IS NULL AND department_id IN (${ph})`,
    )
    .bind(...departmentIds)
    .all<{ address: string }>();
  const out = shared.results.map((r) => r.address);
  if (colleagues) {
    const members = `SELECT id FROM users WHERE status = 'active' AND department_id IN (${ph})`;
    const run = (inner: string, binds: number[]) =>
      // company-scope: coSql is the caller's active-company predicate on email_addresses.
      db
        .prepare(`SELECT address FROM email_addresses WHERE active = 1${coSql} AND assigned_user_id IN (${inner})`)
        .bind(...binds)
        .all<{ address: string }>();
    let own;
    try {
      own = await run(`${members} UNION SELECT user_id FROM user_departments WHERE department_id IN (${ph})`, [...departmentIds, ...departmentIds]);
    } catch {
      own = await run(members, departmentIds); // D1 test mirror: no user_departments
    }
    out.push(...own.results.map((r) => r.address));
  }
  return out;
}

/** Best effort: the log must never block the access change itself. */
export async function recordAccessChange(
  db: Db,
  row: { companyId: number | null; byUserId: number | null; userId: number; change: string },
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO mail_access_changes (id, company_id, by_user_id, user_id, change) VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(crypto.randomUUID(), row.companyId, row.byUserId, row.userId, row.change)
      .run();
  } catch (e) {
    console.error("mail_access_changes insert failed", e);
  }
}

export const LEVEL_NAME: Record<string, string> = {
  personal: "L1 · Own",
  department: "L2 · Department mailbox",
  department_all: "L3 · Whole department",
  company: "L4 · Company",
};
