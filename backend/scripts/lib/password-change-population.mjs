/* Who must choose a new password after the exposed-hash incident
   (docs/staging-dump-artifact-exposure-coe.md; owner approval 2026-11-10:
   "at least ADMINS and FINANCE staff").

   Derived from the permission model the running system enforces, not from job
   titles typed by hand:

   ADMIN — can do anything, or can change who can do anything:
     wildcard-role     the member's role holds "*" (Owner / IT Admin)
     god-title         the member's Title confers "*": a position_policy row with
                       cohort 'god', or, for a Title with NO row, one of the names
                       positionPolicy.ts GOD_POSITIONS lists (positionGrantsWildcard)
     users.manage      invite, disable, reset other members
     roles.manage      edit what every role may do

   FINANCE — can move or approve money:
     finance-duty      Title's position_policy.duty = 'finance'
     money-title       Title's position_policy.can_move_money = true
     <key>             the role literally holds a money key below

   A key outside services/permissions.ts PERMISSIONS[] is dropped at sign-in, so
   it confers nothing; tests/passwordChangePopulation.test.ts pins every key here
   to that catalogue and the god names to positionGrantsWildcard. */

export const ADMIN_KEYS = Object.freeze(["users.manage", "roles.manage"]);

export const FINANCE_KEYS = Object.freeze([
  "scm.payment_voucher.create",
  "scm.payment_voucher.write",
  "scm.payment_voucher.check",
  "scm.payment_voucher.approve",
  "scm.payment_voucher.post",
  "scm.payment_voucher.cancel",
  "scm.payment.backdate",
  "scm.payment.backdate.approve",
  "scm.so_payment.amend",
  "hr.payroll.approve",
]);

// Mirror of positionPolicy.ts GOD_POSITIONS, normalised the same way.
export const GOD_POSITION_NAMES = Object.freeze(["super admin", "owner", "managing director"]);

const normalise = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

function parseKeys(json) {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

const truthy = (v) => v === true || v === 1 || v === "1" || v === "t" || v === "true";

/**
 * @param {{ role_permissions: string|null, position_name: string|null,
 *           has_policy_row: boolean, policy_cohort: string|null,
 *           policy_duty: string|null, policy_money: unknown }} m
 * @returns {{ admin: string[], finance: string[] }} the reasons, empty when none
 */
export function classifyMember(m) {
  const keys = new Set(parseKeys(m.role_permissions));
  const admin = [];
  const finance = [];
  if (keys.has("*")) admin.push("wildcard-role");
  const godTitle = m.has_policy_row
    ? m.policy_cohort === "god"
    : GOD_POSITION_NAMES.includes(normalise(m.position_name));
  if (godTitle) admin.push("god-title");
  for (const k of ADMIN_KEYS) if (keys.has(k)) admin.push(k);
  if (m.has_policy_row && m.policy_duty === "finance") finance.push("finance-duty");
  if (m.has_policy_row && truthy(m.policy_money)) finance.push("money-title");
  for (const k of FINANCE_KEYS) if (keys.has(k)) finance.push(k);
  return { admin, finance };
}

/** Members in scope: active, holding a password (nothing to change otherwise),
 *  and admin or finance by the rules above. */
export function selectPopulation(rows) {
  const out = [];
  for (const r of rows) {
    if (r.status !== "active" || !r.has_password) continue;
    const c = classifyMember(r);
    if (c.admin.length || c.finance.length) out.push({ id: r.id, ...c });
  }
  return out;
}

/** Counts only — never an email or a name — for a log a public repo exposes. */
export function summarise(population) {
  const reasons = {};
  let admin = 0;
  let finance = 0;
  let both = 0;
  for (const p of population) {
    if (p.admin.length) admin += 1;
    if (p.finance.length) finance += 1;
    if (p.admin.length && p.finance.length) both += 1;
    for (const r of [...p.admin, ...p.finance]) reasons[r] = (reasons[r] ?? 0) + 1;
  }
  return { total: population.length, admin, finance, both, reasons };
}
