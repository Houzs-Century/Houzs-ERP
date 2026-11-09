import type { PositionPolicyRow } from "./positionPolicyRows";

/**
 * Crew PIN sign-in — helpers and drivers who have no usable email sign in with
 * their staff code (the fixed `EMP-` prefix plus the digits) and a 6-digit PIN.
 *
 * Three rules make a 6-digit secret safe enough to put on the internet, and they
 * live here so the login route, the admin route and the auth gate read ONE copy:
 *
 *   1. WHO may hold one. Only a member whose Title is the restricted
 *      `driver_helper` profile (Roles & Permissions › Titles — Driver, Helper,
 *      Outsource Transporter on the seed). A Title with no policy row is refused:
 *      an unclassified Title resolves to the FULL cohort, the widest reach there
 *      is, so it must never ride the weakest credential.
 *   2. HOW guessing is bounded. A durable per-account lock (FIELD_PIN_MAX_FAILURES
 *      wrong PINs lock it for FIELD_PIN_LOCK_MINUTES, stored on the PIN row, so it
 *      holds when KV is down), plus KV speed bumps per staff code and per IP.
 *   3. WHAT the session may reach. A PIN session is stamped origin 'field' at mint
 *      time, and the auth gate refuses every API outside FIELD_API_PREFIXES for
 *      it — whatever the member's role would otherwise allow. The menus are not
 *      the boundary; this list is.
 */

export const FIELD_LOGIN_PREFIX = "EMP-";
export const FIELD_PIN_LENGTH = 6;
export const FIELD_PIN_MAX_FAILURES = 5;
export const FIELD_PIN_LOCK_MINUTES = 15;
/* Several crew members can share one depot Wi-Fi address, so the per-IP budget
   is a few people's worth of the per-account budget, not one person's. */
export const FIELD_PIN_IP_MAX = 30;
export const FIELD_PIN_WINDOW_SECONDS = 15 * 60;

/** The staff code a typed login names, or null when it cannot be one.
 *  "42", "0042", "emp-0042" and "EMP-0042" all mean EMP-0042 — the code the
 *  member trigger issues is `EMP-` + the user id padded to 4 (mig 0234), with a
 *  `-N` suffix when that code was already taken. */
export function normaliseFieldLogin(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let s = raw.trim().toUpperCase().replace(/\s+/g, "");
  if (s.startsWith(FIELD_LOGIN_PREFIX)) s = s.slice(FIELD_LOGIN_PREFIX.length);
  else if (s.startsWith("EMP")) s = s.slice(3);
  const m = /^(\d{1,6})(?:-(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  return `${FIELD_LOGIN_PREFIX}${m[1].padStart(4, "0")}${m[2] ? `-${m[2]}` : ""}`;
}

/** Does this staff code fit the crew sign-in form at all? A code outside the
 *  `EMP-` shape (a legacy import) cannot be typed there, so a PIN on it could
 *  never be used. */
export function staffCodeFitsFieldLogin(code: string | null | undefined): boolean {
  return !!code && normaliseFieldLogin(code) === code;
}

export const isFieldPinShape = (v: unknown): v is string =>
  typeof v === "string" && new RegExp(`^\\d{${FIELD_PIN_LENGTH}}$`).test(v);

/** What is wrong with a PIN an admin is about to set; null when it is fine.
 *  Sign-in accepts any 6 digits — this only stops the obvious ones being issued. */
export function fieldPinProblem(pin: unknown): string | null {
  if (!isFieldPinShape(pin)) return `The PIN must be exactly ${FIELD_PIN_LENGTH} digits.`;
  if (/^(\d)\1+$/.test(pin)) return "That PIN is too easy to guess (one digit repeated).";
  if ("0123456789".includes(pin) || "9876543210".includes(pin)) {
    return "That PIN is too easy to guess (a run of digits).";
  }
  return null;
}

/** May a member with this Title hold a crew PIN? Rule 1 in the header. */
export function isFieldPinEligible(
  row: Pick<PositionPolicyRow, "cohort" | "profile"> | null | undefined,
): boolean {
  return !!row && row.cohort === "restricted" && row.profile === "driver_helper";
}

/**
 * The APIs a field (PIN) session may call. Prefix match on a path segment
 * boundary — `/api/projects` admits `/api/projects/12` but not
 * `/api/projects-print`.
 *
 * Kept to the screens the crew works on (delivery board and job stops, proof of
 * delivery and its photos, the project crew pages, mileage) plus what every
 * signed-in screen needs (notices, presence, push, the selfie punch and the
 * member's own pay slip, their profile picture). Each of these routers still
 * applies its own permission and page-access gates on top; this list only
 * decides which doors exist at all for a PIN session.
 *
 * Deliberately ABSENT: /api/pos (its exchange-web-session would mint an
 * origin-less ERP session from a PIN one), /api/totp, /api/users (bar /me),
 * every money, HR, team, settings and SCM document route.
 */
export const FIELD_API_PREFIXES: readonly string[] = [
  "/api/auth",
  "/api/notifications",
  "/api/push",
  "/api/presence",
  "/api/client-errors",
  "/api/branding",
  "/api/announcements",
  "/api/attendance",
  "/api/users/me",
  "/api/projects",
  "/api/fleet-maintenance",
  "/api/scm/delivery-planning",
  "/api/scm/delivery-jobs",
  "/api/scm/delivery-orders-mfg",
  "/api/scm/lorries",
  "/api/scm/slips",
];

export function fieldSessionAllowsPath(path: string): boolean {
  return FIELD_API_PREFIXES.some((p) => path === p || path.startsWith(p + "/"));
}

export const FIELD_SESSION_REFUSAL =
  "Crew PIN sign-in opens the delivery and project crew screens only. Sign in with your email and password for anything else.";

/* SQL, kept here so the pg integration test executes the exact strings the
   routes run. `?` placeholders (the D1-compatible binding the routes use). */

/** Everything the PIN login needs, by staff code, in one read. */
export const FIELD_PIN_LOOKUP_SQL = `SELECT u.id, u.status, u.totp_enabled, s.id AS staff_id,
       fp.pin_hash, fp.failed_count, fp.locked_until,
       pp.cohort, pp.profile
  FROM scm.staff s
  JOIN users u ON u.id = s.user_id
  LEFT JOIN field_pins fp ON fp.user_id = u.id
  LEFT JOIN position_policy pp ON pp.position_id = u.position_id
 WHERE s.staff_code = ?`;

/** One wrong PIN: count it, and lock the account when the count reaches the
 *  limit. Counting happens in the statement so two simultaneous wrong guesses
 *  both land. A lock that has run out starts a fresh count, so the first wrong
 *  try after a lock is try 1 of a new budget, not an instant re-lock.
 *  RETURNING tells the caller whether this one locked it. */
export const FIELD_PIN_FAIL_SQL = `UPDATE field_pins
   SET failed_count = CASE WHEN locked_until IS NOT NULL AND locked_until <= now() THEN 1
                           ELSE failed_count + 1 END,
       locked_until = CASE WHEN locked_until IS NOT NULL AND locked_until <= now() THEN NULL
                           WHEN failed_count + 1 >= ${FIELD_PIN_MAX_FAILURES}
                           THEN now() + interval '${FIELD_PIN_LOCK_MINUTES} minutes'
                           ELSE locked_until END
 WHERE user_id = ?
 RETURNING failed_count, locked_until`;

/** A correct PIN: the count and any expired lock are cleared. */
export const FIELD_PIN_RESET_SQL = `UPDATE field_pins SET failed_count = 0, locked_until = NULL WHERE user_id = ?`;

/** Admin sets or replaces a PIN; a new PIN also lifts any lock. */
export const FIELD_PIN_UPSERT_SQL = `INSERT INTO field_pins (user_id, pin_hash, failed_count, locked_until, set_by, set_at)
VALUES (?, ?, 0, NULL, ?, now())
ON CONFLICT (user_id) DO UPDATE
   SET pin_hash = EXCLUDED.pin_hash, failed_count = 0, locked_until = NULL,
       set_by = EXCLUDED.set_by, set_at = now()`;

export const FIELD_PIN_DELETE_SQL = `DELETE FROM field_pins WHERE user_id = ?`;

/** Ends every PIN session of a member; their password sessions are untouched. */
export const FIELD_SESSIONS_DELETE_SQL = `DELETE FROM sessions WHERE user_id = ? AND origin = 'field'`;

/** Is this lock still in force? `locked_until` arrives as a Date or an ISO
 *  string depending on the driver; an unreadable value is treated as locked
 *  only when it parses, so garbage never locks a member out for good. */
export function isLocked(lockedUntil: unknown, now: number): boolean {
  if (lockedUntil == null || lockedUntil === "") return false;
  const t = lockedUntil instanceof Date ? lockedUntil.getTime() : Date.parse(String(lockedUntil));
  return Number.isFinite(t) && t > now;
}
