// ---------------------------------------------------------------------------
// assistantAccess.ts — FE mirror of the backend Assistant access gate.
//
// PRIMARY PATH is the server answer: when /auth/me carried a capability set,
// canUseAssistant reads `org.assistant.use` (backend capabilities.ts composes the
// very same canUseAssistant gate) and the two name lists below are NOT consulted.
// They remain as the STALE-DEPLOY FALLBACK — a cached SPA shell talking to a
// Worker that predates the capability — and as the lockstep fixture. The BACKEND
// is the control (routes/assistant.ts returns 403); this file exists so a denied
// user is not shown a launcher / menu item that will 403 when tapped.
//
// Two rules in the fallback, mirrored from backend/src/services/assistant-scope.ts:
//   • DENY list   — field crew (owner 2026-07-18) + Sales (owner 2026-07-19,
//                   "remove the Assistant from Sales first").
//   • FAIL CLOSED — a NAMED position absent from the KNOWN list is denied, so a
//                   new position row does not silently inherit the Assistant. A
//                   user with NO position stays allowed (money hidden downstream).
//
// Exact normalised match, never a substring: `Storekeeper` would swallow
// "Storekeeper Supervisor", and a word-boundary regex over a free-text position
// name is how a RENAME silently moves permissions (BUG-HISTORY 2026-07-18).
// ---------------------------------------------------------------------------

export const ASSISTANT_DENIED_POSITIONS: ReadonlySet<string> = new Set([
  "driver",
  "helper",
  "storekeeper",
  "storekeeper supervisor",
  "sales director",
  "sales manager",
  "sales executive",
  "sales person",
]);

// Every position on the live `positions` table, normalised — mirror of the backend
// set of the same name. A named position absent here fails CLOSED (see below).
export const ASSISTANT_KNOWN_POSITIONS: ReadonlySet<string> = new Set([
  "super admin",
  "hr manager",
  "finance manager",
  "sales director",
  "sales manager",
  "sales executive",
  "sales person",
  "operation manager",
  "operation executive",
  "procurement/purchasing",
  "logistic admin",
  "storekeeper",
  "driver",
  "helper",
  "service admin",
  "storekeeper supervisor",
  "calendar viewer",
]);

const normalise = (n: string | null | undefined): string =>
  String(n ?? "").trim().toLowerCase().replace(/\s+/g, " ");

export function canUseAssistant(
  user:
    | {
        permissions?: unknown;
        position_name?: string | null;
        /** The server-resolved capability set from /auth/me; when present its
         *  `org.assistant.use` answer (the same backend gate) wins over the two
         *  name lists below, which stay only as the stale-deploy fallback. */
        capabilities?: Partial<Record<string, boolean>>;
      }
    | null
    | undefined,
): boolean {
  if (user?.capabilities) return user.capabilities["org.assistant.use"] === true;
  const perms = user?.permissions;
  const isWildcard = Array.isArray(perms)
    ? perms.includes("*")
    : typeof perms === "string" && perms.trim() === "*";
  if (isWildcard) return true;
  const position = normalise(user?.position_name);
  if (position === "") return true;
  if (ASSISTANT_DENIED_POSITIONS.has(position)) return false;
  return ASSISTANT_KNOWN_POSITIONS.has(position);
}
