
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
  | { readonly kind: 'company'; readonly companyId: number }
  | { readonly kind: 'activeCompany'; readonly ctx: CompanyScopeCtx }
  | { readonly kind: 'allowed'; readonly ctx: CompanyScopeCtx }
  | { readonly kind: 'centralised'; readonly why: string };

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
  throw new Error(`applyScope: unhandled scope kind ${(scope as { kind: string }).kind}`);
}

function stampScope(values: Row | Row[], scope: QueryScope): Row | Row[] {
  const rows = Array.isArray(values) ? values : [values];
  const stamped = stampRows(rows, scope);
  return Array.isArray(values) ? stamped : stamped[0]!;
}

function stampRows(rows: Row[], scope: QueryScope): Row[] {
  switch (scope.kind) {
    case 'company':
      return stampCompany(rows, { get: (k: string) => (k === 'companyId' ? scope.companyId : undefined) });
    case 'activeCompany':
      return stampCompany(rows, scope.ctx);
    case 'allowed':
      return stampCompany(rows, scope.ctx);
    case 'centralised':
      return rows;
  }
  throw new Error(`stampRows: unhandled scope kind ${(scope as { kind: string }).kind}`);
}

function scopedFrom(sb: ScmClient, table: string, scope: QueryScope) {
  const qb = sb.from(table);
  return {
    select<Cols extends string = '*'>(
      columns?: Cols,
      options?: { head?: boolean; count?: 'exact' | 'planned' | 'estimated' },
    ) {
      return applyScope(qb.select(columns, options), scope);
    },
    insert(values: Row | Row[]) {
      return qb.insert(stampScope(values, scope));
    },
    upsert(values: Row | Row[], options?: { onConflict?: string; ignoreDuplicates?: boolean }) {
      return qb.upsert(stampScope(values, scope), options);
    },
    update(values: Row) {
      return applyScope(qb.update(values), scope);
    },
    delete() {
      return applyScope(qb.delete(), scope);
    },
  };
}

export type ScopedQueryBuilder = ReturnType<typeof scopedFrom>;

export interface ScopedDb {
  from(table: string, scope: QueryScope): ScopedQueryBuilder;
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
