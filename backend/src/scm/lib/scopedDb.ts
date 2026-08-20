// ----------------------------------------------------------------------------
// scopedDb.ts — make "no company scope" a value the author has to TYPE.
//
// WHY THIS EXISTS. The SCM supabase client is the SERVICE-ROLE client and mig
// 0061 enabled RLS on every scm table with ZERO policies, so no policy is ever
// evaluated on an app request. The `company_id` predicate a statement carries is
// the entire tenant boundary (CLAUDE.md, "Company scope: the predicate is the
// only isolation — on WRITES too").
//
// Today a forgotten predicate and a deliberate cross-company read are the SAME
// TEXT. `sb.from('stock_transfers').update(...).eq('id', id)` is either a bug or
// a decision, and nothing in the source says which. That is CLAUDE.md's
// **BUG CLASS optional-param-noop** in its purest form: the absence of an
// argument decides the answer, with no compile error, no failing test and no
// runtime signal. It has already cost this module specifically — the 2026-07-22
// audit scoped "every" sibling flow and missed the stock-transfer cancel, which
// let a caller in company A cancel company B's POSTED transfer and reverse B's
// stock.
//
// The remedy is the one that BUG CLASS prescribes: make the deciding parameter
// REQUIRED, so the compiler enumerates the call sites. `scmDb(c).from(table)`
// with no scope is a TS2554, and "this statement is deliberately centralised"
// becomes `CENTRALISED('<sentence>')` — a clause in the diff instead of an
// absence.
//
// ⚠️ WHAT THIS DOES NOT SOLVE. Read this before quoting it as coverage:
//   · it constrains CONVERTED files only. Conversion is per-file and tracked in
//     backend/scripts/company-scope-converted.json.
//   · it cannot check the scope is the RIGHT one. `companyIdScope(otherId)`
//     compiles perfectly.
//   · `any` absorbs it. A helper taking `sb: any` and calling `.from(t)` with
//     one argument is not an error, so a converted route that hands its client
//     to such a helper is unchecked from that point on. `unscoped(why)` is the
//     honest way to spell that hand-off; it does not make it safe.
//   · raw `env.DB` SQL and `.rpc()` are outside it entirely.
//
// DELEGATION, NOT REIMPLEMENTATION. Every arm below calls the helper in
// companyScope.ts that already owns the rule. In particular the THREE-STATE
// sentinel documented on `allowedCompanyIds` (undefined = unresolved, no
// predicate; [] = resolved-and-granted-nothing, match nothing; non-empty = the
// granted set) is NOT re-derived here — the ctx-derived scopes carry the CONTEXT
// so `scopeToCompany` / `scopeToAllowedCompanies` decide it themselves. See the
// note on QueryScope below for why that shape differs from the obvious one.
// ----------------------------------------------------------------------------

import type { Variables } from '../env';
import {
  type CompanyScopeCtx,
  scopeToCompany,
  scopeToCompanyId,
  scopeToAllowedCompanies,
  stampCompany,
} from './companyScope';

/** The SCM service-role client, named through the context type so this file
 *  never has to write the `any` generics `env.ts` already carries. */
export type ScmClient = Variables['supabase'];

type Row = Record<string, unknown>;

/**
 * THE FOUR ANSWERS TO "which company's rows does this statement touch".
 *
 * ⚠️ THE TWO CTX-DERIVED KINDS CARRY THE CONTEXT, NOT A RESOLVED ID, AND THAT
 * IS LOAD-BEARING. The obvious shape — `{ kind: 'company'; companyId: number }`
 * for `companyScope(c)` — cannot represent the sentinel's third state, because
 * "no active company resolved" is not a number. Collapsing it either way is the
 * failure companyScope.ts's header warns about in capitals: fold UNRESOLVED into
 * `[]` and every single-company install goes blank; fold `[]` into UNRESOLVED
 * and a caller granted no company sees EVERY company. So the ctx travels and the
 * existing helper decides, which is also what keeps this file from owning a
 * second copy of that rule.
 */
export type QueryScope =
  /** `companyIdScope(id)` — STRICT. The id is already resolved (normally by
   *  `requireActiveCompanyId`), so there is no degrade branch to preserve. */
  | { readonly kind: 'company'; readonly companyId: number }
  /** `companyScope(c)` — PER-COMPANY with companyScope.ts's documented degrade.
   *  Delegates to `scopeToCompany`, three states and all. */
  | { readonly kind: 'activeCompany'; readonly ctx: CompanyScopeCtx }
  /** `allowedScope(c)` — CROSS-COMPANY: widen to the caller's granted set.
   *  Delegates to `scopeToAllowedCompanies`. "Shared queue" never means "no
   *  predicate"; it means a wider one. */
  | { readonly kind: 'allowed'; readonly ctx: CompanyScopeCtx }
  /** `CENTRALISED(why)` — deliberately NO company predicate, with the reason
   *  written down. This is the whole point of the module: the absence is now a
   *  sentence a reviewer can disagree with. */
  | { readonly kind: 'centralised'; readonly why: string };

/* A reason that is not a reason is the absence wearing a costume. Throwing is
   deliberate and it is a PROGRAMMER error, not an operator one: an empty `why`
   cannot reach production without failing scopedDb.test.ts first. */
function requireWhy(why: string, at: string): string {
  if (why.trim() === '') {
    throw new Error(
      `${at}: the reason IS the mechanism — pass a sentence saying why this statement carries no company predicate.`,
    );
  }
  return why;
}

/** PER-COMPANY, degrading. Delegates to `scopeToCompany` at apply time. */
export function companyScope(c: CompanyScopeCtx): QueryScope {
  return { kind: 'activeCompany', ctx: c };
}

/** PER-COMPANY, strict. Delegates to `scopeToCompanyId`. */
export function companyIdScope(companyId: number): QueryScope {
  return { kind: 'company', companyId };
}

/** CROSS-COMPANY. Delegates to `scopeToAllowedCompanies`. */
export function allowedScope(c: CompanyScopeCtx): QueryScope {
  return { kind: 'allowed', ctx: c };
}

/** DELIBERATELY UNSCOPED, and say why. `why` is required and non-empty. */
export function CENTRALISED(why: string): QueryScope {
  return { kind: 'centralised', why: requireWhy(why, 'CENTRALISED') };
}

/**
 * Attach the scope's PREDICATE to a builder that already accepts one. Every arm
 * hands off to companyScope.ts; nothing about the three-state sentinel is
 * decided here.
 */
export function applyScope<Q>(query: Q, scope: QueryScope): Q {
  switch (scope.kind) {
    case 'company':
      return scopeToCompanyId(query, scope.companyId);
    case 'activeCompany':
      return scopeToCompany(query, scope.ctx);
    case 'allowed':
      return scopeToAllowedCompanies(query, scope.ctx);
    case 'centralised':
      return query;
  }
  /* Unreachable while QueryScope is closed. It THROWS rather than returning
     `query` on purpose: a fifth kind added without an arm above must not
     silently come to mean "no predicate". */
  throw new Error(`applyScope: unhandled scope kind ${(scope as { kind: string }).kind}`);
}

/**
 * Stamp the scope's company onto rows being CREATED. See the arm comments in
 * `scopedFrom` for why this is a different operation from `applyScope` and why
 * conflating the two is the exact defect this module exists to end.
 */
function stampScope(values: Row | Row[], scope: QueryScope): Row | Row[] {
  const rows = Array.isArray(values) ? values : [values];
  const stamped = stampRows(rows, scope);
  return Array.isArray(values) ? stamped : stamped[0]!;
}

function stampRows(rows: Row[], scope: QueryScope): Row[] {
  switch (scope.kind) {
    /* A resolved id has no "unresolved" branch, so it delegates through a
       SYNTHETIC context — the shape companyScope.ts widened CompanyScopeCtx to
       accept, precisely so one implementation of "explicit company_id wins"
       serves both a request and a headless caller. */
    case 'company':
      return stampCompany(rows, { get: (k: string) => (k === 'companyId' ? scope.companyId : undefined) });
    case 'activeCompany':
      return stampCompany(rows, scope.ctx);
    /* CROSS-COMPANY modules still stamp the ACTIVE company on create — a trip is
       created from whichever company you are currently in even though it may
       reference the other company's documents (companyScope.ts, second bullet).
       A SET is not a company; there is nothing else a new row could be. */
    case 'allowed':
      return stampCompany(rows, scope.ctx);
    case 'centralised':
      return rows;
  }
  throw new Error(`stampRows: unhandled scope kind ${(scope as { kind: string }).kind}`);
}

/**
 * The scoped stand-in for `PostgrestQueryBuilder`.
 *
 * ⚠️ TWO THINGS ARE LOAD-BEARING HERE.
 *
 * 1. `.from()` returns a `PostgrestQueryBuilder`, which has NO `.eq()`. A
 *    predicate can only attach AFTER `.select()` / `.update()` / `.delete()`
 *    turn it into a filter builder — which is exactly why each verb below is
 *    written out by hand and the scope is applied inside it. These are explicit
 *    pass-throughs and NOT a Proxy: this is money-path code, and a Proxy makes
 *    the set of forwarded methods invisible to a reader and to `tsc`.
 *
 * 2. **THE INSERT ARM STAMPS. EVERY OTHER ARM PREDICATES.** They are opposite
 *    operations and swapping them is silent:
 *      · a predicate on an INSERT filters nothing (there is no row yet), so the
 *        new row lands with no company at all;
 *      · a stamp on an UPDATE rewrites `company_id`, i.e. it MOVES the row into
 *        the caller's company — and it filters nothing, so it moves EVERY row
 *        the statement's other predicates matched.
 *    Getting this wrong rebuilds, inside the abstraction meant to end it, the
 *    exact blind spot `check-company-scope.mjs` learned the hard way: seven
 *    cross-company MONEY writes hid behind `insert({ company_id:
 *    activeCompanyId(c) })` while the checker printed `0 WRITE`, because a stamp
 *    reads like a predicate and is not one. It is pinned by test, not by this
 *    comment — see `scopedDb.test.ts`, "update PREDICATES and never stamps".
 */
function scopedFrom(sb: ScmClient, table: string, scope: QueryScope) {
  const qb = sb.from(table);
  return {
    /** READ — predicate.
     *
     *  `Cols extends string` is not decoration. supabase-js resolves the ROW
     *  type from the column-list STRING LITERAL, so a parameter typed plain
     *  `string` erases it and every `data` in every converted handler degrades
     *  to `GenericStringError[]` — which surfaces as a pile of TS2352 casts that
     *  look like conversion work and are pure wrapper artefact. Measured on the
     *  pilot, the draft that typed it `string` produced 19 errors at the swap
     *  step and 25 after retyping its two `sb: any` parameters; the generic took
     *  those to 17 and 21, so 2 and then 4 of them were this and nothing else. */
    select<Cols extends string = '*'>(
      columns?: Cols,
      options?: { head?: boolean; count?: 'exact' | 'planned' | 'estimated' },
    ) {
      return applyScope(qb.select(columns, options), scope);
    },
    /** CREATE — STAMP. There is no row to filter; the scope says which company
     *  the new row BELONGS to. */
    insert(values: Row | Row[]) {
      return qb.insert(stampScope(values, scope));
    },
    /** CREATE-OR-UPDATE — STAMP, for the create half. PostgREST attaches no
     *  filter to an upsert, so a predicate here would be dead code that reads
     *  like protection. */
    upsert(values: Row | Row[], options?: { onConflict?: string; ignoreDuplicates?: boolean }) {
      return qb.upsert(stampScope(values, scope), options);
    },
    /** WRITE — predicate. The payload is passed through UNTOUCHED: stamping it
     *  would re-company the row (see the block comment above). */
    update(values: Row) {
      return applyScope(qb.update(values), scope);
    },
    /** WRITE — predicate. */
    delete() {
      return applyScope(qb.delete(), scope);
    },
  };
}

export type ScopedQueryBuilder = ReturnType<typeof scopedFrom>;

export interface ScopedDb {
  /**
   * The scope is a REQUIRED second argument. Omitting it is a TS2554 —
   * "Expected 2 arguments, but got 1" — which is the whole mechanism.
   */
  from(table: string, scope: QueryScope): ScopedQueryBuilder;
  /**
   * THE ESCAPE, and it is deliberately loud. Returns the raw service-role
   * client for the one thing this wrapper cannot cover: handing the client to a
   * library function (`mintMonthlyDocNo`, `recordEntityAudit`, `reverseMovements`)
   * or calling `.rpc()`. Nothing downstream of this call is checked, so `why`
   * has to say what makes it safe. Grep-able by design: `unscoped(` is the
   * inventory of what conversion did NOT cover.
   */
  unscoped(why: string): ScmClient;
}

/**
 * The scoped client for a request. Takes the same `{ get }` shape as
 * companyScope.ts's helpers, so a headless job with a reconstructed context can
 * use it too.
 */
export function scmDb(c: CompanyScopeCtx): ScopedDb {
  const sb = c.get('supabase') as ScmClient;
  return {
    from: (table, scope) => scopedFrom(sb, table, scope),
    unscoped: (why) => {
      requireWhy(why, 'unscoped');
      return sb;
    },
  };
}
