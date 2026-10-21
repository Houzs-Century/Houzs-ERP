// ---------------------------------------------------------------------------
// pendingReminderAccess.ts — who the daily "pending work" popup auto-shows to.
//
// UX gate only. The data boundary is unchanged: the popup asks the SAME
// /api/projects?my_pending=1 endpoint the Projects list uses, and that endpoint
// keeps its own per-caller role lanes. This file decides solely whether the
// reminder MODAL pops on app open — it does not widen or narrow what any user
// can read, and a denied user can still open Projects normally.
//
// Owner 2026-10-21: the reminder was showing to everyone with a pending row,
// including Drivers. Restrict it to the positions whose job is to act on
// project pending work; everyone else (field crew, warehouse, Finance, HR, …)
// no longer gets the popup.
//
// ALLOW LIST, fail CLOSED: a position absent from the set below is denied, so a
// NEW position row (or one with no position set) does not silently inherit the
// popup — add it here when the owner asks. `*` permission (owner / super admin)
// always sees it, as a guard against a position rename.
//
// Exact normalised match, never a substring: `Storekeeper` would swallow
// "Storekeeper Supervisor", and a word-boundary match over a free-text position
// name is how a RENAME silently moves permissions (see assistantAccess.ts).
// ---------------------------------------------------------------------------

// Normalised names from the live `positions` table (owner's 2026-10-21 pick).
export const PENDING_REMINDER_POSITIONS: ReadonlySet<string> = new Set([
  "owner",
  "managing director",
  "super admin",
  "it developer executive",
  "sales director",
  "sales manager",
  "sales executive",
  "operation manager",
  "operation executive",
  "logistic admin",
]);

const normalise = (n: string | null | undefined): string =>
  String(n ?? "").trim().toLowerCase().replace(/\s+/g, " ");

export function canSeePendingReminder(
  user:
    | {
        permissions?: unknown;
        position_name?: string | null;
      }
    | null
    | undefined,
): boolean {
  const perms = user?.permissions;
  const isWildcard = Array.isArray(perms)
    ? perms.includes("*")
    : typeof perms === "string" && perms.trim() === "*";
  if (isWildcard) return true;
  return PENDING_REMINDER_POSITIONS.has(normalise(user?.position_name));
}
