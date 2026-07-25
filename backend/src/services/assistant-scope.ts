// ---------------------------------------------------------------------------
// assistant-scope.ts — who may ask the Assistant what, and which numbers reach
// the model at all.
//
// The Assistant is owner-only today (requirePermission("*")) for one reason: the
// specialists' briefs carry margin and per-salesperson performance, and a single
// prompt would hand those to anyone who could open the page. This module is the
// part that has to exist BEFORE it can be opened to staff.
//
// TWO AXES, and the second is the one that matters:
//   1. CAPABILITY — which specialists a caller may consult at all.
//   2. FIELD — which numbers survive into the payload.
//
// Redaction happens at GATHER, before the model is called. Showing a model the
// margin and instructing it not to repeat the margin is not a control; it is a
// request. A number the caller may not see must never enter the context window,
// because prompt text is advisory and a context window is not.
//
// NO NEW POLICY IS INVENTED HERE. The three flags come from positionPolicy, which
// the owner already approved and which every other surface obeys — this file
// applies them to a new surface rather than authoring a second rulebook. That
// matters: a second rulebook is how "Sales cannot see margin" ends up true on four
// screens and false on the fifth.
// ---------------------------------------------------------------------------

/** The caller's visibility, taken from positionPolicy — not re-derived here. */
export interface AssistantScope {
  /** Wildcard/owner. Sees everything; still passes through the same code path. */
  wildcard?: boolean;
  canSeeMargin: boolean;
  canSeeCommission: boolean;
  /** 'all' = whole company, 'own_downline' = their own reporting line only. */
  orderScope: 'all' | 'own_downline' | 'own';
}

/**
 * Positions with NO Assistant access at all (owner, 2026-07-18: "開放給operation
 * 除了driver helper storekeeper").
 *
 * These are the field crew. They hold a phone on a lorry, not a desk — the
 * Assistant answers planning questions they are not the ones to act on, and their
 * own job list is already the Delivery Planning board scoped to them
 * (lib/deliveryScope.ts). Denying the whole surface is simpler and more honest
 * than serving them an assistant that can answer almost nothing.
 *
 * ALL FOUR of positionPolicy's restricted cohort. The owner first named three;
 * asked whether the fourth (Storekeeper Supervisor) should follow, he said yes —
 * so this list and the restricted cohort are now the same set, which is one less
 * pair of things that can drift apart.
 *
 * Matched on the EXACT normalised name, never a substring: `Storekeeper`
 * would swallow "Storekeeper Supervisor", and a word-boundary regex on a free-text
 * position name is how a RENAME silently moves permissions (BUG-HISTORY,
 * 2026-07-18 — it has already happened twice in this codebase).
 */
export const ASSISTANT_DENIED_POSITIONS: ReadonlySet<string> = new Set([
  'driver',
  'helper',
  'storekeeper',
  'storekeeper supervisor',
  /* SALES — owner 2026-07-19: "我説的是吧assistant從sales 那邊移除先"
   * ("remove the Assistant from Sales first"). All four Sales-Department
   * positions on the live positions table, exact normalised names —
   * owner-confirmed 2026-07-19.
   *
   * NOT about CS. There is no CS department and no CS position in this system;
   * the only "CS" is an AI agent in the Agent Console (services/agents/
   * cs-agent.ts), a different feature, untouched. */
  'sales director',
  'sales manager',
  'sales executive',
  'sales person',
]);

/**
 * Every position name that exists on the live `positions` table, normalised.
 *
 * WHY THIS EXISTS — position access FAILS OPEN everywhere else. A position that
 * matches no rule falls through positionPolicy's terminal branch into cohort
 * "full" (positionPolicy.ts:602-618, "FAIL OPEN ... the anti-lockout
 * invariant"), which carries canSeeMargin + canSeeCommission + orderScope
 * "all". So creating a new position — say a Sales title that does not begin
 * with the word "Sales" — silently granted its holders margin, commission and
 * the whole Assistant from the moment the row was saved. That is the owner's
 * concern and it is real.
 *
 * The Assistant now fails CLOSED on an unrecognised name: unknown -> denied.
 * Deliberately scoped to THIS surface only. The global position default is NOT
 * flipped here — doing that repo-wide is the anti-lockout invariant above and
 * needs its own change with the owner's sign-off.
 *
 * CONSEQUENCE THE OWNER MUST KNOW: adding a position to the live table no
 * longer grants the Assistant. The name has to be added here too. That is the
 * trade — a new position starts with no Assistant instead of starting with
 * everything.
 *
 * Provenance: services/positionAccessSnapshot.ts, the generated photograph of
 * the owner's live rows (17 positions). Copied rather than imported because
 * that file is explicitly NOT WIRED — nothing reads it yet, and making this the
 * first consumer would couple a security gate to a file whose header says it is
 * a reviewable draft. Regenerate that snapshot, then update this list.
 */
export const ASSISTANT_KNOWN_POSITIONS: ReadonlySet<string> = new Set([
  'super admin',
  'hr manager',
  'finance manager',
  'sales director',
  'sales manager',
  'sales executive',
  'sales person',
  'operation manager',
  'operation executive',
  'procurement/purchasing',
  'logistic admin',
  'storekeeper',
  'driver',
  'helper',
  'service admin',
  'storekeeper supervisor',
  'calendar viewer',
]);

const normalisePosition = (n: string | null | undefined): string =>
  String(n ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * May this user open the Assistant at all?
 *
 * A wildcard holder always may. For everyone else the surface now fails CLOSED on a
 * named position — the owner's concern was that a NEW position row silently inherits
 * the Assistant (positionPolicy fails OPEN into cohort "full"), so the gate here is:
 *
 *   • wildcard                    → yes.
 *   • NO position at all ("")     → yes, with the money-hidden scope. Not the
 *                                   owner's concern — that is a missing-data
 *                                   fallback, documented on scopeForUser, and the
 *                                   numbers are already withheld downstream.
 *   • on the deny list            → no (field crew + Sales).
 *   • a NAMED position we do not  → no. It must be whitelisted in
 *     recognise                     ASSISTANT_KNOWN_POSITIONS first. This is the
 *                                   fail-closed the owner asked for; scoped to THIS
 *                                   surface only, the global default is untouched.
 */
export function canUseAssistant(
  user: { permissions?: unknown; position_name?: string | null } | null | undefined,
): boolean {
  const perms = user?.permissions;
  const isWildcard = Array.isArray(perms)
    ? perms.includes('*')
    : typeof perms === 'string' && perms.trim() === '*';
  if (isWildcard) return true;
  const position = normalisePosition(user?.position_name);
  if (position === '') return true;
  if (ASSISTANT_DENIED_POSITIONS.has(position)) return false;
  return ASSISTANT_KNOWN_POSITIONS.has(position);
}

/**
 * May this user TEACH agents standing rules in chat (teach-in-chat)?
 *
 * Owner decision 2026-07-26: OPEN to every staff member who may use the Assistant
 * at all ("先让我的员工都可以 train，暂时之后我们才调整特定的员工"). So v1 is
 * exactly canUseAssistant — if you can open the chat, you can teach.
 *
 * This function is THE SEAM for that "adjust to specific employees later": to
 * narrow who may teach, change ONLY this function (gate on a future `agents.teach`
 * permission, or a position allowlist) and nothing else moves. It is kept separate
 * from canUseAssistant precisely so USING and TEACHING can diverge without hunting
 * the callsite. Every teach is audited (who taught what), so the owner can review
 * who has been steering an agent before deciding whom to keep.
 *
 * NOTE this is a stronger action than asking a question: a taught rule steers the
 * agent for EVERYONE on its next run. The safety net that makes opening it safe is
 * unchanged — the owner can retire any instruction in the Agent Console, and the
 * governance matrix + per-agent stage ceilings still gate what an agent may ACT on
 * autonomously; a taught rule biases JUDGMENT, it does not lift a hard gate.
 */
export function canTeachAgents(
  user: { permissions?: unknown; position_name?: string | null } | null | undefined,
): boolean {
  return canUseAssistant(user);
}

/**
 * Derive a caller's scope from the ONE policy, never from a fresh rule.
 *
 * Three cases, and the third is the one that needs stating:
 *   • wildcard (`*`)         → sees everything, as everywhere else.
 *   • a positioned user      → positionPolicy's flags VERBATIM. Note this honours
 *                              the owner's default-FULL model: an unclassified
 *                              position sees money, because that is his ruling
 *                              ("暂时都可以看到系统里的所有内容") and this surface
 *                              must not be quietly stricter than every other one.
 *   • NO position at all     → money hidden. Not a policy disagreement: the policy
 *                              has no input to decide from, and "we cannot tell"
 *                              must not resolve to "entitled". Defaulting the
 *                              unknown to permissive is how `?? 0` style bugs
 *                              become disclosures.
 */
export function scopeForUser(
  user: { permissions?: unknown; position_name?: string | null; department_name?: string | null } | null | undefined,
  resolve: (i: { position_name: string | null; department_name: string | null }) => {
    flags: { canSeeMargin: boolean; canSeeCommission: boolean; orderScope: 'own_downline' | 'all' };
  } | null,
): AssistantScope {
  const perms = user?.permissions;
  const isWildcard = Array.isArray(perms)
    ? perms.includes('*')
    : typeof perms === 'string' && perms.trim() === '*';
  if (isWildcard) return { wildcard: true, canSeeMargin: true, canSeeCommission: true, orderScope: 'all' };

  const position = user?.position_name ?? null;
  if (!position) {
    return { canSeeMargin: false, canSeeCommission: false, orderScope: 'own' };
  }
  const policy = resolve({ position_name: position, department_name: user?.department_name ?? null });
  if (!policy) return { canSeeMargin: false, canSeeCommission: false, orderScope: 'own' };
  return {
    canSeeMargin: policy.flags.canSeeMargin,
    canSeeCommission: policy.flags.canSeeCommission,
    orderScope: policy.flags.orderScope,
  };
}

/** Capability keys whose entire subject is money the caller may not be entitled
 *  to. Gated wholesale, because redacting the numbers out of a receivables brief
 *  leaves a brief about nothing. */
const CAPABILITY_REQUIREMENTS: Record<string, (s: AssistantScope) => boolean> = {
  // "Who owes us money" is a finance view. Margin visibility is the existing proxy
  // for finance-grade access in positionPolicy.
  receivables: (s) => s.canSeeMargin,
  // Commercial intelligence IS margin + per-salesperson performance.
  sales_intel: (s) => s.canSeeMargin || s.canSeeCommission,
};

/**
 * Field names that must not reach the model for a caller without the matching
 * flag. Matched case-insensitively on the KEY, at any depth.
 *
 * Deliberately a DENYLIST of concepts rather than an allowlist of fields: the
 * briefs are free-form JSON written by six different agents, so an allowlist would
 * silently drop new legitimate fields and make the Assistant useless, while this
 * list fails toward hiding. Where the two disagree, hiding a number the caller
 * could have seen is a complaint; showing one they could not is a leak.
 */
const MARGIN_KEYS = /(margin|gross_?profit|grossProfit|profit|cost_?centi|costCenti|unit_?cost|unitCost|landed_?cost|markup)/i;
const COMMISSION_KEYS = /(commission|payout|incentive)/i;

/** Value substituted for a redacted number — visible, not silently dropped, so an
 *  answer built on it can say "hidden" rather than "zero". A missing key would let
 *  the model treat the figure as absent and reason as if it were nil. */
export const REDACTED = '[hidden for your role]';

export function isCapabilityAllowed(key: string, scope: AssistantScope): boolean {
  if (scope.wildcard) return true;
  const req = CAPABILITY_REQUIREMENTS[key];
  return req ? req(scope) : true;
}

export function allowedCapabilityKeys(keys: readonly string[], scope: AssistantScope): string[] {
  return keys.filter((k) => isCapabilityAllowed(k, scope));
}

/**
 * Deep-redact a gathered payload in place-free fashion (returns a new value).
 * Arrays and nested objects are walked; scalars are returned as-is.
 */
export function redactFacts<T>(facts: T, scope: AssistantScope): T {
  if (scope.wildcard) return facts;
  const hideMargin = !scope.canSeeMargin;
  const hideCommission = !scope.canSeeCommission;
  if (!hideMargin && !hideCommission) return facts;

  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if ((hideMargin && MARGIN_KEYS.test(k)) || (hideCommission && COMMISSION_KEYS.test(k))) {
          out[k] = REDACTED;
          continue;
        }
        out[k] = walk(val);
      }
      return out;
    }
    return v;
  };
  return walk(facts) as T;
}

/** A one-line note appended to the model's instructions so an answer built on a
 *  redacted payload says so, instead of quietly reporting less than it knows. */
export function scopeNote(scope: AssistantScope): string | null {
  if (scope.wildcard) return null;
  const hidden: string[] = [];
  if (!scope.canSeeMargin) hidden.push('margin and cost figures');
  if (!scope.canSeeCommission) hidden.push('commission figures');
  if (hidden.length === 0) return null;
  return `Some values are marked "${REDACTED}" because this user's role does not include ${hidden.join(' or ')}. Never guess or reconstruct a hidden value; say it is not available to them.`;
}
