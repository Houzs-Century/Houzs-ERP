// ----------------------------------------------------------------------------
// migrated-so-lock — NEW sales orders are open, MIGRATED ones are read-only.
//
// Owner 2026-09-08: 「只开新单，旧单暂时不能改」. This is a PARTIAL lift of the
// cutover write freeze, not a replacement for it. The freeze
// (lib/write-freeze.ts) decides whether the sales-order MODULE may be saved at
// all; this decides, once it may, whether THIS DOCUMENT may.
//
// WHY A MIGRATED ORDER IS DIFFERENT — the two risks, both live, neither of which
// applies to an order the ERP originated:
//
//   1. `sync-ac-delta` runs again, and it can overwrite a staff edit with no
//      signal at all. A native order is not in its input set.
//   2. Payments taken in AutoCount since 2026-08-28 have never reached the ERP
//      and there is no automatic path. The 5-minute pull carries AutoCount's
//      outstanding balance into public.sales_orders.balance, a column with ZERO
//      readers — so the balance shown on a migrated order is wrong, and a
//      salesperson acting on it would chase a customer who has already paid.
//
// Risk 2 is the one that lifts this lock: when collections are corrected, set
// the switch to 'off'. That is the whole intended lifecycle of this file.
//
//   scm.app_config.key   = 'scm.migrated_so_lock'
//   scm.app_config.value = 'off' / '0' / 'false' / ''  -> migrated orders EDITABLE
//                        = 'all' / 'true'              -> locked for every company
//                        = company ids ('1', '1,2')    -> locked for those only
//   scm.app_config.description = the sentence staff see (optional, < 200 chars)
//
// NO AREA CLAUSE. The freeze's `-` grammar means "freeze this company MINUS
// these modules"; this key names one module already, so a `-` here can only be
// a value pasted from the neighbouring row. docs/write-freeze-staged-lift.md §8
// records that mistake being made. A value carrying `-` is therefore MALFORMED,
// and malformed locks (see below) rather than silently reading as 'on'.
//
// FAIL CLOSED ON A VALUE, FAIL OPEN ON AN OUTAGE — the same split write-freeze
// draws, for the same reasons:
//   • An unparseable value ('houzs', '1 - sales') is an instruction we cannot
//     honour. It resolves to 'all'. Loud, visible, undone by one UPDATE.
//   • An UNREACHABLE app_config is not an instruction. It fails OPEN, because a
//     Supabase blip must not stop the shop floor. The migrated documents are
//     still protected by the write freeze underneath this.
//   • ABSENT / EMPTY is NOT the seeded default here. Migration
//     20260908T0014_scm_migrated_so_lock.sql seeds '1', because the owner's
//     ruling is that migrated orders are locked TODAY — a fresh environment
//     reading "open" would be reading the wrong answer, not a neutral one.
// ----------------------------------------------------------------------------

import { OPEN_TOKENS, ALL_TOKENS } from './app-config-tokens';
import type { SoReconcileVerdict } from './so-reconcile-verdict';

/** Which companies have their migrated sales orders locked. */
export type MigratedSoLockScope = 'off' | 'all' | number[];

export interface MigratedSoLockValue {
  scope: MigratedSoLockScope;
  /** The value was present but unintelligible; scope was forced to 'all'. */
  malformed: boolean;
  /**
   * `verdict:` mode — lock by CORRECTNESS rather than by ORIGIN.
   *
   * false (every value that shipped before 2026-09-08): every migrated order of
   * a named company is read-only, which is what 「只开新单，旧单暂时不能改」 asked
   * for while the tally was running.
   *
   * true: a migrated order of a named company is read-only ONLY while the
   * published reconcile verdict says it still differs from the account book —
   * or while there is no fresh verdict to consult. See so-reconcile-verdict.ts.
   *
   * A MALFORMED value never sets this. Failing closed means the HARDEST lock,
   * and per-document is the softer of the two.
   */
  byVerdict: boolean;
}

/** The `verdict:` prefix, once, so the parser and the tests cannot disagree. */
export const VERDICT_PREFIX = 'verdict:';

const dedupe = <T>(xs: T[]): T[] => [...new Set(xs)];
const split = (s: string): string[] => s.split(',').map((t) => t.trim()).filter((t) => t.length > 0);

/**
 * Parse the stored value.
 *
 *   'off' | '' | '0' | 'false'   -> nothing locked
 *   'all' | 'true'               -> every company
 *   '1' | '1,2' | ' 1 , 2 '      -> those companies
 *   anything else, `-` included  -> 'all' (fail closed), malformed = true
 *
 * Exported because the unit tests are the specification for every row above.
 */
export function parseMigratedSoLock(raw: string | null | undefined): MigratedSoLockValue {
  const v = String(raw ?? '').trim().toLowerCase();
  if (OPEN_TOKENS.has(v)) return { scope: 'off', malformed: false, byVerdict: false };
  if (ALL_TOKENS.has(v)) return { scope: 'all', malformed: false, byVerdict: false };

  /* `verdict:` is read FIRST, and only its own prefix is consumed. Everything
     after it goes through the SAME company grammar as a bare value — one
     statement of "which companies", so the two modes can never disagree about
     who they name.

     A malformed remainder ('verdict:', 'verdict:off', 'verdict:houzs') falls
     through to the malformed answer below, which is `all` WITHOUT byVerdict:
     the hardest lock, not the softer one. A typo may never open a document,
     and per-document IS an opening. */
  const isVerdict = v.startsWith(VERDICT_PREFIX);
  const rest = isVerdict ? v.slice(VERDICT_PREFIX.length).trim() : v;

  /* A `-` can only have come from the write-freeze row (§8 of the runbook).
     Reading it as "on" would be right by accident; refusing to read it is right
     on purpose, and the operator sees a malformed value instead of a lock they
     did not mean to leave in place. Checked on the REMAINDER so that
     `verdict:1 - scm.sales.orders` — the same paste, one mode along — is
     refused exactly as `1 - scm.sales.orders` is. */
  if (rest.includes('-')) return { scope: 'all', malformed: true, byVerdict: false };

  if (isVerdict && ALL_TOKENS.has(rest)) {
    return { scope: 'all', malformed: false, byVerdict: true };
  }

  const tokens = split(rest);
  const ids = tokens.filter((t) => /^\d+$/.test(t)).map(Number);
  if (tokens.length > 0 && ids.length === tokens.length) {
    return { scope: dedupe(ids), malformed: false, byVerdict: isVerdict };
  }
  return { scope: 'all', malformed: true, byVerdict: false };
}

/**
 * Is a write to this document refused?
 *
 * PURE — the whole decision, so the tests can pin it without a request.
 *
 * `isMigrated` is `boolean | null` and NOT optional, deliberately. Every caller
 * has to say what it found out, and `null` — "I could not tell" — is a third
 * answer the compiler forces each call site to produce rather than inherit. An
 * optional argument defaulting to the permissive direction is how this exact
 * class of gate has shipped half-applied before.
 *
 * `null` LOCKS. "Not migrated" is the permissive answer, so a read that could
 * not run must not be able to look like it. lib/so-is-migrated.ts takes the same
 * position for the same reason, and it is the module that produces this value.
 */
export function migratedSoIsLocked(
  v: MigratedSoLockValue,
  companyId: number | null,
  isMigrated: boolean | null,
  verdict: SoReconcileVerdict | null,
): boolean {
  if (v.scope === 'off') return false;
  if (v.scope !== 'all') {
    /* An unresolved company is not locked, matching write-freeze: refusing
       writes we cannot attribute would take the other company down on a
       companies-master blip. */
    if (companyId == null || !v.scope.includes(companyId)) return false;
  }
  if (isMigrated === false) return false;

  /* ORIGIN MODE — every migrated order shut. Unchanged, and it is what every
     value that shipped before 2026-09-08 still means. */
  if (!v.byVerdict) return true; // true, or null (could not tell)

  /* CORRECTNESS MODE. `isMigrated === null` never reaches the verdict: we do
     not know WHICH question to ask about this document, so it locks first. */
  if (isMigrated == null) return true;

  /* `null` is not a fourth answer with its own meaning — it is a call site that
     did not go and look, and it locks for the same reason `unknown` does. The
     parameter is REQUIRED (never `verdict?:`) so the compiler makes every call
     site produce this value rather than inherit a permissive default; an
     optional argument defaulting the other way is exactly how this class of
     gate has shipped half-applied before. */
  if (verdict == null) return true;
  return verdict.kind !== 'clean';
}

/* Says the three things a salesperson needs and nothing else: this ONE order is
   view-only, why, and that new orders are unaffected. Kept under
   OPERATOR_MESSAGE_MAX so both clients render it instead of a generic 5xx line
   (see write-freeze.ts for what happens when they do not). */
const DEFAULT_LOCKED_MESSAGE =
  'This order came from AutoCount and is view-only for now: its payments are still being '
  + 'reconciled, so an edit could be overwritten. New orders save normally. '
  + 'Ask IT if it must change today.';

export const OPERATOR_MESSAGE_MAX = 200;

/** The sentence a refused write returns. An operator-typed description wins. */
export function migratedSoLockMessage(description: string | null | undefined): string {
  const v = String(description ?? '').trim();
  if (v.length > 0 && v.length < OPERATOR_MESSAGE_MAX) return v;
  return DEFAULT_LOCKED_MESSAGE;
}

/* ── THE PER-DOCUMENT SENTENCE ──────────────────────────────────────────────

   In CORRECTNESS mode the refusal is about ONE document and it has to say so.
   「这单为什么不能改」 has a different answer per order now, and the sentence
   that says "migrated orders are locked" would be answering the old question.

   THE OPERATOR DESCRIPTION IS DELIBERATELY NOT CONSULTED HERE. In origin mode
   one sentence covered the whole population, so an operator could usefully
   retype it; here the sentence must name the document and the axis, and an
   operator override would erase precisely the part that makes the refusal
   actionable. This repo shipped 35 write paths that refused correctly and told
   nobody, and the owner reported it as "the button does nothing".

   THE CAP IS ENFORCED BY DROPPING AXES, NOT BY TRUNCATING. Both clients discard
   a sentence at or over OPERATOR_MESSAGE_MAX and fall back to a generic line,
   and a half-written axis name is worse than an honest "and 2 more". */

/** How many axes to name before summarising. */
const MAX_NAMED_AXES = 3;

function axisPhrase(axes: readonly string[]): string {
  const named = axes.slice(0, MAX_NAMED_AXES);
  const rest = axes.length - named.length;
  return named.join(', ') + (rest > 0 ? `, and ${rest} more` : '');
}

/**
 * Why THIS document is still shut, for a salesperson looking at it.
 *
 * `docNo` is the ERP document number — the one on their screen — not the
 * AutoCount number the reconcile keys on.
 */
export function migratedSoVerdictMessage(
  docNo: string | null,
  verdict: SoReconcileVerdict | null,
): string {
  const doc = (docNo ?? '').trim() || 'This order';

  if (verdict != null && verdict.kind === 'differs' && verdict.axes.length > 0) {
    const full = `${doc} still differs from the AutoCount book on: ${axisPhrase(verdict.axes)}. `
      + 'It opens by itself once that is corrected. Ask IT if it must change today.';
    if (full.length < OPERATOR_MESSAGE_MAX) return full;
    /* Too many axis names to fit. Say the count instead of half a list. */
    return `${doc} still differs from the AutoCount book on ${verdict.axes.length} points. `
      + 'It opens by itself once they are corrected. Ask IT.';
  }

  if (verdict != null && verdict.kind === 'differs') {
    return `${doc} still differs from the AutoCount book. `
      + 'It opens by itself once that is corrected. Ask IT if it must change today.';
  }

  /* UNKNOWN, or a call site that did not look. Both mean the same thing to the
     person: we cannot presently prove this order matches the book, so it stays
     view-only. Saying "it differs" here would be a claim we have not measured. */
  return `${doc} cannot be confirmed against the AutoCount book right now, so it stays view-only. `
    + 'Ask IT — the AutoCount check needs to run again.';
}
