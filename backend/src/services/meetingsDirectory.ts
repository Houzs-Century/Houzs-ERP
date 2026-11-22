// meetingsDirectory.ts — this ERP's staff list for the meeting-room hub.
//
// Booking a meeting means picking people from every company, including colleagues who
// have never opened the Meetings page. So once an hour (cron) each company with a hub
// key sends the hub its whole active staff list: id, name, email, company name and Org
// Chart department. People left out are switched off there. A user granted no company
// is sent with every company (the same fail-open the grants read uses for "no rows").
//
// No hub address or key: nothing is sent, nothing throws.
import type { Env } from "../types";

export const MEETINGS_DIRECTORY_JOB = "meetings-directory";

type UserRow = { id: number; name: string | null; email: string; department: string | null; position_department: string | null };
type GrantRow = { user_id: number; company_id: number };
type CompanyRow = { id: number; code: string; name: string };

export type DirectoryPerson = { id: string; name: string; email: string; company: string; department: string };

/** Who goes to each company's list. Pure, so the grant rule is tested without a database. */
export function directoryFor(company: CompanyRow, users: UserRow[], grants: GrantRow[]): DirectoryPerson[] {
  const granted = new Map<number, Set<number>>();
  for (const g of grants) {
    if (!granted.has(g.user_id)) granted.set(g.user_id, new Set());
    granted.get(g.user_id)!.add(Number(g.company_id));
  }
  return users
    .filter((u) => !granted.has(u.id) || granted.get(u.id)!.has(company.id))
    .map((u) => ({
      id: String(u.id),
      name: (u.name ?? "").trim() || u.email,
      email: u.email,
      company: company.name,
      department: (u.department ?? u.position_department ?? "").trim(),
    }));
}

function keyFor(env: Env, code: string): string {
  const v = /^[A-Z0-9]{2,12}$/.test(code) ? (env as unknown as Record<string, unknown>)[`IT_HUB_API_KEY_${code}`] : undefined;
  return typeof v === "string" ? v.trim() : "";
}

export async function pushMeetingsDirectory(env: Env): Promise<{ sent: number; skipped: string[] }> {
  const base = (env.IT_HUB_URL ?? "").trim().replace(/\/+$/, "");
  if (!base) return { sent: 0, skipped: ["no hub address"] };
  const companies = (await env.DB.prepare("SELECT id, code, name FROM companies WHERE is_active = 1 ORDER BY id").all<CompanyRow>()).results;
  const users =
    (
      await env.DB.prepare(
        `SELECT u.id, u.name, u.email, d.name AS department, pd.name AS position_department
         FROM users u
         LEFT JOIN departments d ON d.id = u.department_id
         LEFT JOIN positions p ON p.id = u.position_id
         LEFT JOIN departments pd ON pd.id = p.department_id
         WHERE u.status = 'active' AND u.id > 0`,
      ).all<UserRow>()
    ).results;
  const grants = (await env.DB.prepare("SELECT user_id, company_id FROM user_companies").all<GrantRow>()).results;
  let sent = 0;
  const skipped: string[] = [];
  for (const co of companies) {
    const key = keyFor(env, co.code);
    if (!key) {
      skipped.push(co.code);
      continue;
    }
    const res = await fetch(`${base}/api/v1/sys/meetings/directory`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${key}`, "X-Reporter-Id": "system", "Content-Type": "application/json" },
      body: JSON.stringify({ people: directoryFor(co, users, grants) }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`hub refused the ${co.code} staff list: ${res.status}`);
    sent++;
  }
  return { sent, skipped };
}
