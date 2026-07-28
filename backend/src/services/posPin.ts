// ----------------------------------------------------------------------------
// POS PIN writes — shared by the two places that issue a tablet credential:
//   routes/pos.ts   POST /api/pos/admin-set-pin/:userId   (Members → Set PIN)
//   routes/users.ts POST /api/users/invite  { pos_pin }   (Invite Member)
//
// It lives here rather than inline in users.ts because that handler is Drizzle
// throughout and scm.pos_pins has no Drizzle model (raw SQL, like routes/pos.ts).
// ----------------------------------------------------------------------------
import type { Env } from "../types";
import { hashPassword } from "./auth";

export const isPosPin = (v: unknown): v is string =>
  typeof v === "string" && /^\d{6}$/.test(v);

/** Only a SALES-position member can PIN-login — routes/pos.ts /pin-login
 *  rejects every other position slug. So a PIN issued to anyone else is a
 *  credential that can never be used; both writers refuse it up front rather
 *  than store one that silently fails at the tablet. */
export const isPosPinPosition = (slug: string | null | undefined): boolean =>
  !!slug && slug.startsWith("sales");

/** Upsert a member's POS PIN, keyed by HOUZS user id (scm.staff is resolved
 *  here). Returns false when the member has no scm.staff row yet — nothing was
 *  written, and the caller decides how loudly to say so. */
export async function setPosPinForUser(
  env: Env,
  userId: number,
  pin: string,
): Promise<boolean> {
  const staff = await env.DB.prepare(`SELECT id FROM scm.staff WHERE user_id = ?`)
    .bind(userId)
    .first<{ id: string }>();
  if (!staff?.id) return false;
  const hash = await hashPassword(pin);
  await env.DB.prepare(
    `INSERT INTO scm.pos_pins (staff_id, pin_hash, updated_at) VALUES (?, ?, now())
       ON CONFLICT (staff_id) DO UPDATE SET pin_hash = EXCLUDED.pin_hash, updated_at = now()`,
  )
    .bind(staff.id, hash)
    .run();
  return true;
}
