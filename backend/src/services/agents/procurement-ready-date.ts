// ---------------------------------------------------------------------------
// procurement-ready-date.ts — the Procurement Agent's answer to the ONE question
// other agents ask it: "if I need these items, when can procurement have them
// ready?"
//
// This is the first TYPED A2A FACT (owner 2026-07-24, verbatim intent): "Customer
// service ask ... procurement agent when the items can be ready" — CS must NOT
// read stock/ETA out of the DB itself; it asks the agent that owns that judgment.
// So the answer is a deterministic function of the SAME lead-time model the agent
// already plans against (scm/lib/lead-time.ts): the owner's manual base table +
// the learned supplier-punctuality buffer + the learned season buffer. It is the
// exact INVERSE of MRP's order-by hint — MRP does `deliveryDate - lead`; this does
// `orderDate + lead` — so the two can never disagree about how long a supplier
// takes.
//
// DETERMINISTIC, READ-ONLY, no LLM: a fact, not a judgment. It composes existing
// governed loaders and writes nothing.
//
// V1 SCOPE (documented seam): the estimate is the LEAD-TIME ready date assuming a
// FRESH order placed on `asOfDate`. It does NOT yet net against on-hand stock or
// in-flight POs — an item already in the warehouse is "ready now", and one on an
// open PO is ready on that PO's date. Folding those in is re-deriving MRP per
// request; deferred to the A2A wiring (task #34), where the caller can pass the
// on-hand / open-PO context. Stated so the answer is honest about being an
// upper-bound "order-from-scratch" date, not a promise that ignores stock.
// ---------------------------------------------------------------------------

import type { Env } from '../../types';
import { getSupabaseService } from '../../db/supabase';
import { resolveAgentCompany, scopeFor } from './agent-company';
import { PROCUREMENT_AGENT_SETTING_KEY, loadLeadBuffers } from './procurement-learning';
import {
  loadLeadTimeBase,
  resolveLeadDays,
  addCalendarDays,
  LEAD_TIME_SELECT,
  type LeadBuffers,
  type LeadTimeBase,
  type LeadTimeBreakdown,
} from '../../scm/lib/lead-time';

/** One thing to make ready. `key` is any label the caller wants echoed back (an
 *  SO line id, an item code) so it can correlate the per-item answer. */
export interface ReadyDateItem {
  key?: string;
  /** The line's item_group; matched lowercase against the five lead categories. */
  category: string | null;
  warehouseId: string | null;
  /** The item's main supplier code — drives the learned supplier buffer. Omit to
   *  skip that layer (base + season only). */
  supplierCode?: string | null;
  /** The customer delivery date, if known — drives the season buffer (the month
   *  the goods are needed). Omit to skip the season layer. */
  deliveryDate?: string | null;
}

export interface ReadyDateItemResult {
  key: string | null;
  category: string | null;
  supplierCode: string | null;
  /** Every lead layer broken out, so the caller can explain WHY a date is what it
   *  is: "base 7 + supplier 3 + season 2". */
  leadDays: LeadTimeBreakdown;
  readyDate: string | null;
}

export interface ReadyDateEstimate {
  asOfDate: string;
  /** When ALL items are ready = the LATEST per-item ready date (the critical
   *  path). Null when there are no items. */
  readyDate: string | null;
  /** The longest single-item lead in days — the critical path length. */
  leadDaysMax: number;
  perItem: ReadyDateItemResult[];
}

/**
 * PURE core: compose the ready-date estimate from an already-loaded base table +
 * buffers. No I/O, so it is directly testable and cannot disagree with MRP's
 * resolveLeadDays (it calls the same function). readyDate for the set is the
 * LATEST item — the set is ready only when its slowest line lands.
 */
export function estimateReadyDate(
  base: LeadTimeBase,
  buffers: LeadBuffers,
  asOfDate: string,
  items: ReadyDateItem[],
): ReadyDateEstimate {
  const asOf = String(asOfDate ?? '').slice(0, 10);

  const perItem: ReadyDateItemResult[] = items.map((it) => {
    const leadDays = resolveLeadDays(base, buffers, {
      warehouseId: it.warehouseId ?? null,
      category: it.category ?? null,
      supplierCode: it.supplierCode ?? null,
      deliveryDate: it.deliveryDate ?? null,
    });
    return {
      key: it.key ?? null,
      category: it.category ?? null,
      supplierCode: it.supplierCode ?? null,
      leadDays,
      readyDate: addCalendarDays(asOf, leadDays.total),
    };
  });

  let leadDaysMax = 0;
  let readyDate: string | null = null;
  for (const r of perItem) {
    if (r.leadDays.total > leadDaysMax) leadDaysMax = r.leadDays.total;
    // YYYY-MM-DD compares lexicographically; the latest string is the latest date.
    if (r.readyDate && (readyDate == null || r.readyDate > readyDate)) readyDate = r.readyDate;
  }

  return { asOfDate: asOf, readyDate, leadDaysMax, perItem };
}

/**
 * Company-scoped wrapper: load the owner's base lead table (scoped to the agent's
 * company, EXACTLY as computeMrp does — same query, same NO-OP-when-unresolved
 * scoping) + the learned buffers, then run the pure core.
 *
 * Refuses rather than guesses the company: a ready date computed against the
 * wrong company's lead table is a wrong promise. `asOfDate` defaults to today.
 */
export async function estimateReadyDateForCompany(
  env: Env,
  opts: { items: ReadyDateItem[]; asOfDate?: string },
): Promise<ReadyDateEstimate> {
  const db = env.DB;
  const asOf = String(opts.asOfDate ?? new Date().toISOString()).slice(0, 10);

  const sb = getSupabaseService(env);
  const company = scopeFor(await resolveAgentCompany(db, PROCUREMENT_AGENT_SETTING_KEY));
  if (company.refuse) {
    throw new Error(`procurement_company_unresolved: ${company.refuse}`);
  }
  const companyId = company.companyId ?? null;

  // Mirrors computeMrp's `scoped`: a NO-OP when companyId is null (unresolved /
  // single-company), else `.eq('company_id', ...)`. The base loader THROWS on a
  // read error — a zeroed lead table would quote "ready today" for everything.
  const scoped = <Q>(q: Q): Q =>
    companyId != null ? (q as unknown as { eq(c: string, v: unknown): Q }).eq('company_id', companyId) : q;
  const base = await loadLeadTimeBase(
    scoped(sb.from('mrp_category_lead_times').select(LEAD_TIME_SELECT)),
  );
  const buffers = await loadLeadBuffers(db);

  return estimateReadyDate(base, buffers, asOf, opts.items);
}
