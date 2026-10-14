// ----------------------------------------------------------------------------
// posLogin — the record of every POS PIN login (scm.pos_logins, migration
// 20261014T1800). Owner 2026-10-14: a part-timer's days at an event are
// counted from their POS logins, and the first login of the day is their
// arrival time. The sessions table cannot say this (a row goes on logout and
// on expiry), so /pin-login writes a row here and logout stamps it.
//
// Both are BEST-EFFORT by design: a login that cannot be recorded still logs
// in, and a logout that cannot be stamped still logs out — the tablet at the
// booth must never be stopped by the attendance book.
// ----------------------------------------------------------------------------
import type { Env } from "../types";
import { sidFor } from "./session-revocation";

export async function recordPosLogin(
  env: Env,
  args: { staffId: string; userId: number; companyId: number | null; token: string },
): Promise<void> {
  try {
    let companyId = args.companyId;
    /* A tablet that sent no company: the member's only company, else none. */
    if (companyId == null) {
      const rows = await env.DB.prepare(`SELECT company_id FROM public.user_companies WHERE user_id = ? LIMIT 2`)
        .bind(args.userId).all<{ company_id: number }>();
      const list = rows.results;
      companyId = list.length === 1 ? Number(list[0].company_id) : null;
    }
    const sid = await sidFor(args.token);
    await env.DB.prepare(
      `INSERT INTO scm.pos_logins (company_id, staff_id, user_id, session_sid) VALUES (?, ?, ?, ?)`,
    ).bind(companyId, args.staffId, args.userId, sid).run();
  } catch (e) {
    console.warn("pos_login_not_recorded", e instanceof Error ? e.message : String(e));
  }
}

export async function recordPosLogout(env: Env, token: string): Promise<void> {
  try {
    const sid = await sidFor(token);
    await env.DB.prepare(
      `UPDATE scm.pos_logins SET logged_out_at = now() WHERE session_sid = ? AND logged_out_at IS NULL`,
    ).bind(sid).run();
  } catch (e) {
    console.warn("pos_logout_not_recorded", e instanceof Error ? e.message : String(e));
  }
}
