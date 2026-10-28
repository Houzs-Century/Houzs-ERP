// ---------------------------------------------------------------------------
// agent-company.ts — WHICH COMPANY'S BOOKS a headless agent works on.
//
// Every request-driven read in the SCM gets its company from companyContext:
// `scopeToCompany(query, c)`, `activeCompanyId(c)`. An agent has no request, so
// it has no company — and every scoping parameter in this codebase is OPTIONAL
// and NO-OPS when omitted. That combination has exactly one default, and the
// default is "silently plan both companies as one".
//
// It is not hypothetical. computeMrp's own doc lists "agent callers" among the
// cases that pass nothing, and on 2026-07-17 both headless callers did:
//   - procurement-agent — pooled Houzs + 2990 demand, let one book's stock cover
//     the other's shortage, and (once approval raised a real PO) would have
//     filed one company's SO lines under the other's purchase order.
//   - cs-agent — promised customers delivery dates backed by the other company's
//     supply.
// companyScope.ts's header is unambiguous that SO / PO / inventory are
// PER-COMPANY modules whose books the top-bar switcher ISOLATES. An agent that
// merges them is not doing less work correctly; it is doing wrong arithmetic.
//
// So a headless agent must NAME its company, and this is the one place that
// answers. One book per agent, explicitly. That is a REDUCTION IN SCOPE and it
// is the point: serving one company correctly beats serving two by mixing them.
// Multi-company means a per-company pass and a brief that reports per company —
// a shape change the console cards read, and the owner's call.
// ---------------------------------------------------------------------------

import { readAgentSetting } from '../agent-console';

/**
 * THREE STATES, never two — the same discipline as companyScope's allow-list
 * sentinel, and for the same reason: the states have OPPOSITE correct
 * behaviours, so collapsing any two is a bug in one direction or the other.
 *
 *  • RESOLVED   — plan this book. Scope every read to `id`.
 *
 *  • UNRESOLVED — the companies master is not readable (pre-migration /
 *    cold-start / single-company). Callers MUST degrade: pass `undefined`
 *    downstream so scoping no-ops, exactly as it did before multi-company. This
 *    is the ONLY state in which running unscoped is correct.
 *
 *  • STALE_PIN  — the owner's configured companyId names a company that is gone
 *    or deactivated. The caller MUST NOT RUN. This is the state I first folded
 *    into UNRESOLVED while writing this file, which would have run the agent
 *    unscoped — i.e. answered a bad pin with the exact cross-company pooling
 *    this module exists to prevent. "We could not read the master" and "you
 *    pointed at a company that is not there" look alike and are opposites: one
 *    means carry on as a single-company system, the other means stop.
 */
export type AgentCompany =
  | { state: 'RESOLVED'; id: number; code: string }
  | { state: 'UNRESOLVED' }
  | { state: 'STALE_PIN'; pinnedId: number };

/** The base company every agent falls back to. Resolved by CODE from our own
 *  companies master — never a hardcoded id (the same rule houzsCompanyId
 *  follows). */
const BASE_COMPANY_CODE = 'HOUZS';

/**
 * The company an agent plans for: `app_settings[<settingKey>].companyId` when it
 * names an ACTIVE company, else the base company.
 *
 * Never throws — the states above are the whole vocabulary, and each names what
 * the caller must do. Use `scopeFor` rather than reading `state` by hand.
 */
export async function resolveAgentCompany(
  db: D1Database,
  settingKey: string,
): Promise<AgentCompany> {
  let pinned = NaN;
  try {
    const cfg = await readAgentSetting<Record<string, unknown>>(db, settingKey);
    pinned = Number(cfg?.companyId);
  } catch {
    // Setting unreadable — treat as unpinned and fall back to the base company.
  }
  const isPinned = Number.isInteger(pinned) && pinned > 0;

  let list: Array<{ id: number; code: string }>;
  try {
    const rows = await db
      .prepare('SELECT id, code FROM companies WHERE is_active = 1')
      .all<{ id: number; code: string }>();
    list = rows.results ?? [];
  } catch {
    return { state: 'UNRESOLVED' };
  }
  // Master absent / empty: pre-migration or the D1 test mirror. Degrade.
  if (list.length === 0) return { state: 'UNRESOLVED' };

  if (isPinned) {
    const hit = list.find((r) => Number(r.id) === pinned);
    /* The pin is stale. NOT the base company — silently planning Houzs because
       the owner's pin went stale is the wrong-book bug wearing a helpful face —
       and NOT unresolved either, which would run unscoped across both books. */
    return hit
      ? { state: 'RESOLVED', id: Number(hit.id), code: String(hit.code) }
      : { state: 'STALE_PIN', pinnedId: pinned };
  }

  const base = list.find((r) => r.code === BASE_COMPANY_CODE);
  /* No pin and no HOUZS row, but companies DO exist — a multi-company install
     whose base company is named something else. There is no defensible guess
     here, so refuse rather than pick one. */
  if (!base) return { state: 'STALE_PIN', pinnedId: 0 };
  return { state: 'RESOLVED', id: Number(base.id), code: String(base.code) };
}

/**
 * The two things a caller needs, with the three states already handled:
 * `companyId` to pass downstream (undefined = no-op scoping, correct ONLY when
 * unresolved) and `refuse` — a reason string when the agent must not run.
 *
 * Exists so no caller re-implements the switch and gets STALE_PIN wrong the way
 * this file's first draft did.
 */
export function scopeFor(co: AgentCompany): {
  companyId: number | undefined;
  code: string | null;
  refuse: string | null;
} {
  switch (co.state) {
    case 'RESOLVED':
      return { companyId: co.id, code: co.code, refuse: null };
    case 'UNRESOLVED':
      // Single-company / cold-start: unscoped is what it always did, and is right.
      return { companyId: undefined, code: null, refuse: null };
    case 'STALE_PIN':
      return {
        companyId: undefined,
        code: null,
        refuse:
          co.pinnedId > 0
            ? `configured companyId ${co.pinnedId} is not an active company — refusing to plan a book that may not be yours`
            : `no active company named ${BASE_COMPANY_CODE} and no companyId configured — refusing to guess which book to plan`,
      };
  }
}
