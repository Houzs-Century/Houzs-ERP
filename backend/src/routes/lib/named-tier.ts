// ─────────────────────────────────────────────────────────────────────────
// named-tier.ts — the "BD / Owner / weisiang" tier.
//
// The owner has twice named the SAME three accounts for a cross-event power:
// creating an event (2026-07-24) and compiling everyone's outstanding tasks
// into a reminder (2026-10-07: "full access for this only ummu, owner,
// weisiang"). Ummu is the only BD-role user, the Owner account is the Owner
// position, and Lim is matched by email. A role wildcard ("*") is NOT the
// tier: the other Super Admins are deliberately outside it. One matcher here,
// mirrored by frontend/src/auth/salesAccess.ts; the backend is the authority.
// ─────────────────────────────────────────────────────────────────────────

export interface TierUser {
  role_name?: string | null;
  position_name?: string | null;
  email?: string | null;
}

/** May this user CREATE an event (New Project)? BD staff, the Owner position, weisiang. */
export function canCreateEvent(user: TierUser | null | undefined): boolean {
  if (!user) return false;
  const role = (user.role_name ?? "").toLowerCase();
  const position = (user.position_name ?? "").toLowerCase();
  const email = (user.email ?? "").toLowerCase();
  return /\bbd\b/.test(role) || position === "owner" || email === "weisiang329@gmail.com";
}

/**
 * May this user see Projects › Reminder — every person's incomplete checklist
 * tasks across all events? Same three as canCreateEvent; named separately
 * because it is a different decision that happens to share the tier today.
 */
export function canCompileReminders(user: TierUser | null | undefined): boolean {
  return canCreateEvent(user);
}
