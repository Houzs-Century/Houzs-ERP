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
//     20260908T0900_scm_migrated_so_lock.sql seeds '1', because the owner's
//     ruling is that migrated orders are locked TODAY — a fresh environment
//     reading "open" would be reading the wrong answer, not a neutral one.
// ----------------------------------------------------------------------------

/** Which companies have their migrated sales orders locked. */
export type MigratedSoLockScope = 'off' | 'all' | number[];

export interface MigratedSoLockValue {
  scope: MigratedSoLockScope;
  /** The value was present but unintelligible; scope was forced to 'all'. */
  malformed: boolean;
}

const OPEN_TOKENS = new Set(['', 'off', '0', 'false']);
const ALL_TOKENS = new Set(['all', 'true']);

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
  if (OPEN_TOKENS.has(v)) return { scope: 'off', malformed: false };
  if (ALL_TOKENS.has(v)) return { scope: 'all', malformed: false };

  /* A `-` can only have come from the write-freeze row (§8 of the runbook).
     Reading it as "on" would be right by accident; refusing to read it is right
     on purpose, and the operator sees a malformed value instead of a lock they
     did not mean to leave in place. */
  if (v.includes('-')) return { scope: 'all', malformed: true };

  const tokens = split(v);
  const ids = tokens.filter((t) => /^\d+$/.test(t)).map(Number);
  if (tokens.length > 0 && ids.length === tokens.length) {
    return { scope: dedupe(ids), malformed: false };
  }
  return { scope: 'all', malformed: true };
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
): boolean {
  if (v.scope === 'off') return false;
  if (v.scope !== 'all') {
    /* An unresolved company is not locked, matching write-freeze: refusing
       writes we cannot attribute would take the other company down on a
       companies-master blip. */
    if (companyId == null || !v.scope.includes(companyId)) return false;
  }
  if (isMigrated === false) return false;
  return true; // true, or null (could not tell)
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
