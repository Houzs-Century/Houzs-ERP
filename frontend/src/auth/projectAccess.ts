// ----------------------------------------------------------------------------
// projectAccess — the fail-closed reader for the PER-PROJECT `_access` payload.
//
// Owner's architectural ruling, 2026-07-19: the frontend is TOLD a permission,
// it does not compute one. auth/capabilities.ts does that for the answers that
// depend only on WHO you are, resolved once per /auth/me. This module is the
// same contract for the answers that also depend on WHICH PROJECT you are
// looking at — PMS section access is `user × project` (PIC is an assignment,
// projects.pic_id === user.id, not a job title), so it cannot live in a
// per-user capability set. It rides on the project-detail response instead.
//
// The SERVER still decides. `GET /api/projects/:id` computes
// pmsAccess.getPmsAccess(user, project) and ships it as `_access.pms`, and it
// strips finance / payment / sensitive / setup-dismantle from the wire on the
// same flags. This module does not re-derive any of that. Its ONLY job is to
// turn a payload that may be absent, partial, or stale into a fully-populated
// answer WITHOUT ever inventing a grant.
//
// ── WHAT WAS WRONG ──────────────────────────────────────────────────────────
//
// Five call sites treated a MISSING payload as FULL ACCESS. Each was written as
// a kindness to "older cached responses" and each is a fail-open:
//
//   MobilePMS.tsx  `pms.canPayment ?? true`          ← on a MONEY surface
//   MobilePMS.tsx  `(data._access?.level ?? "full") === "full"`
//   MobilePMS.tsx  `pms.canEdit !== false`
//   Projects.tsx   `!detail.data?._access || … === "full"`
//   Projects.tsx   `pms ? pms.canFinancial : fullAccess`
//
// The last one is not merely fail-open, it is fail-open TO THE WRONG COHORT:
// `fullAccess` is the ROW-level tier (PIC vs non-PIC on this project), while
// canFinancial is the SECTION-level finance tier (pmsAccess.isFinanceViewer —
// `*` / Super Admin / Sales Director / Finance Manager). A scoped PIC is
// `level === "full"` on their own project and is NOT a finance viewer. So the
// fallback handed the Finance Ledger + Financial Snapshot to every project's
// own PIC the moment `_access.pms` went missing.
//
// `?? true` on a payment card is the same defect class as the `?? []` that made
// a 403 render as an empty dropdown, and as the `?? 0` that printed a
// customer-facing SO PDF claiming the full amount owed. A permission we could
// not read is NO.
//
// ── THE CONTRACT ────────────────────────────────────────────────────────────
//
// Every reader goes through {@link readProjectAccess}. It returns a FULLY
// POPULATED, all-boolean shape — never partial, never undefined, so a call site
// cannot distinguish "absent" from "false" and therefore cannot be edited into
// treating absent as yes. There is no `?? true`, no `?? "full"`, no `|| {}` and
// no empty-object default in this file, and there must never be one.
//
// An absent payload is a BROKEN DEPLOYMENT, not a user without permissions —
// the backend has sent `_access.pms` unconditionally since the PMS section model
// shipped, so the only ways to see one missing are a stale PWA shell, a Pages
// deploy ahead of the Worker, or a truncated response. {@link projectAccessUnresolved}
// names that state so a caller can say "we couldn't load your permissions for
// this project" instead of the very different "you don't have permission".
// ----------------------------------------------------------------------------

/** The `_access.pms` flags this app reads. Mirrors backend PmsAccess; every
 *  field is REQUIRED here even though the wire type marks them optional —
 *  that is the whole point of going through the reader. */
export interface ProjectAccess {
  /** Row-level tier for this project: PIC / unscoped vs a scoped rep. NOT a
   *  substitute for any section flag below — see the header note on the
   *  canFinancial fallback that conflated the two. */
  full: boolean;
  canEdit: boolean;
  canFinancial: boolean;
  canRental: boolean;
  canPayment: boolean;
  canSensitive: boolean;
  canSetupDismantle: boolean;
  /** The server's PmsRole name, for display/telemetry only. Never gate on this
   *  — gate on the flags, which are what the backend itself strips the wire on.
   *  Empty string when unresolved. */
  role: string;
}

/** The raw wire shape. Everything optional because the wire genuinely may omit
 *  it; NOTHING optional survives {@link readProjectAccess}. */
export interface RawProjectAccess {
  level?: string;
  level_v2?: string;
  is_pic?: boolean;
  scoped?: boolean;
  pms?: {
    role?: string;
    canOpen?: boolean;
    canEdit?: boolean;
    canFinancial?: boolean;
    canRental?: boolean;
    canPayment?: boolean;
    canSensitive?: boolean;
    canSetupDismantle?: boolean;
    sections?: string[];
  } | null;
}

/** Carrier — any project-detail payload. Both Projects.tsx and MobilePMS.tsx
 *  hold a `{ _access?: … }` object; they pass it straight in. */
export interface ProjectAccessCarrier {
  _access?: RawProjectAccess | null;
}

/** The all-denied answer. Built fresh per call rather than shared, so no
 *  consumer can mutate a denial into a grant. */
export function denyProjectAccess(): ProjectAccess {
  return {
    full: false,
    canEdit: false,
    canFinancial: false,
    canRental: false,
    canPayment: false,
    canSensitive: false,
    canSetupDismantle: false,
    role: "",
  };
}

/**
 * True when the project payload carried no usable `_access.pms` — i.e. we do
 * not KNOW this user's section access, as distinct from knowing it is empty.
 *
 * `null`/`undefined` carrier means "not loaded yet", which is not the same
 * thing and returns false: a screen still fetching must show a skeleton, not a
 * permissions error. Only a LOADED payload missing its `pms` block is
 * unresolved.
 */
export function projectAccessUnresolved(
  carrier: ProjectAccessCarrier | null | undefined,
): boolean {
  if (!carrier) return false;
  return !carrier._access || !carrier._access.pms;
}

/**
 * Read the server's decision for this user × project. Fails CLOSED on every
 * axis: no carrier, no `_access`, no `pms`, an absent flag, or any value that
 * is not literally `true`.
 *
 * The `=== true` is deliberate and is not type paranoia. It is the difference
 * between "the server said no" and "the server said nothing", and it makes the
 * two behave identically at the call site so that no future edit can let
 * `undefined` mean yes.
 *
 * NOTE ON `full`: it is read from `_access.level === "full"` and is the ROW
 * tier only. It is NOT ored into any section flag here, because that OR is
 * exactly the bug this module exists to remove. A call site that wants "edit"
 * asks `canEdit`.
 */
/**
 * Owner approval matrix (2026-07-21): checklist APPROVAL keys are granted
 * EXPLICITLY only — the `*` wildcard does NOT confer them (the Super-Admin
 * position injects `*`, and admins/devs must not silently be approvers; the
 * Owner role carries the keys explicitly). Any other required_perm keeps
 * normal wildcard semantics. Mirror of backend services/permissions.ts.
 */
export const EXPLICIT_APPROVAL_KEYS: ReadonlySet<string> = new Set([
  "agreement.approve",
  "stock_transfer.approve",
  "stock_in.approve",
  "projects.approve",
]);

export function holdsChecklistApproval(
  permissions: readonly string[] | null | undefined,
  required: string,
): boolean {
  const p = permissions ?? [];
  if (EXPLICIT_APPROVAL_KEYS.has(required)) return p.includes(required);
  return p.includes("*") || p.includes(required);
}

export function readProjectAccess(
  carrier: ProjectAccessCarrier | null | undefined,
): ProjectAccess {
  const pms = carrier?._access?.pms;
  if (!pms) return denyProjectAccess();
  return {
    full: carrier?._access?.level === "full",
    canEdit: pms.canEdit === true,
    canFinancial: pms.canFinancial === true,
    canRental: pms.canRental === true,
    canPayment: pms.canPayment === true,
    canSensitive: pms.canSensitive === true,
    canSetupDismantle: pms.canSetupDismantle === true,
    role: typeof pms.role === "string" ? pms.role : "",
  };
}
