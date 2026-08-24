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

/** What the Team profile needs to know before it offers a PIN box: does this
 *  member have a sales profile at all, is it still active, and is a PIN
 *  already on file. Four conditions decide whether the tablet's picker will
 *  ever list them (routes/pos.ts /sales-staff) and only these three are
 *  per-member — the fourth, company membership, the profile screen already
 *  holds. scm.staff(user_id) is UNIQUE (mig 0066), so the join is 1:1. */
export type PosPinStatus = {
  hasStaffRow: boolean;
  staffActive: boolean;
  positionSlug: string | null;
  positionEligible: boolean;
  hasPin: boolean;
  updatedAt: string | null;
};

export async function readPosPinStatus(env: Env, userId: number): Promise<PosPinStatus> {
  const row = await env.DB.prepare(
    `SELECT s.id AS staff_id, s.active AS staff_active, pn.slug AS position_slug,
            (p.staff_id IS NOT NULL) AS has_pin, p.updated_at
       FROM public.users u
       LEFT JOIN scm.staff s ON s.user_id = u.id
       LEFT JOIN public.positions pn ON pn.id = u.position_id
       LEFT JOIN scm.pos_pins p ON p.staff_id = s.id
      WHERE u.id = ?`,
  )
    .bind(userId)
    .first<{
      staff_id: string | null;
      staff_active: boolean | null;
      position_slug: string | null;
      has_pin: boolean | null;
      updated_at: string | null;
    }>();
  const slug = row?.position_slug ?? null;
  return {
    hasStaffRow: !!row?.staff_id,
    staffActive: row?.staff_active === true,
    positionSlug: slug,
    positionEligible: isPosPinPosition(slug),
    hasPin: row?.has_pin === true,
    updatedAt: row?.updated_at ?? null,
  };
}

/** The refusal, if any, for issuing a PIN to this member — EXPORTED AND PURE so
 *  a test EXECUTES the decision instead of matching the handler's spelling.
 *  `null` means the write may proceed.
 *
 *  Both refusals matter for the same reason: a stored PIN that /pin-login will
 *  never accept is indistinguishable, at the tablet, from a member who mistyped
 *  their number. The admin has to be told at the moment they issue it. */
export function posPinWriteRefusal(
  status: Pick<PosPinStatus, "hasStaffRow" | "positionEligible">,
): { error: string; message: string } | null {
  if (!status.hasStaffRow) {
    return { error: "no_staff_row", message: "This member has no sales profile yet." };
  }
  if (!status.positionEligible) {
    return {
      error: "not_pos_role",
      message: "A POS PIN only works for a Sales position — change the title first.",
    };
  }
  return null;
}
