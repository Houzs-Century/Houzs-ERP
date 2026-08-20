// ----------------------------------------------------------------------------
// so-confirm-gate — everything a Sales Order must have before it may be
// CONFIRMED (owner rulings 2026-08-08, all in one morning):
//
//   1. "为什么会有这样的 sku square pillow 你可以允许 freetext 的吗!?"
//      (HC-SO-2607-013) — every line must name a REAL catalog SKU. A line with
//      no product picked (the scan pipeline's placeholder) or a code the
//      company's catalog does not hold blocks confirm.
//   2. HC-SO-2607-008 confirmed with salesperson "Unassigned" — a salesperson
//      is required to confirm. NARROWED 2026-08-19 from "salesperson_id OR any
//      non-blank `agent` text" to "a salesperson the ACCOUNT BOOK can be given",
//      because the looser question let that very order's own value through: see
//      collectSoConfirmProblems below and lib/ac-preflight.ts.
//   3. "venue is compulsory的" — a venue (venue text OR venue_id) is required
//      to confirm. No venue-less order class exists in code: the venue
//      resolver's "empty is honest" rule (venue-binding.ts) governs
//      AUTO-RESOLUTION only — when it resolves nothing, a human picks one.
//   4. WITHDRAWN 2026-08-13. This gate also demanded every goods line's
//      category-required variant axes, from HC-SO-2607-008's bedframe line
//      Y103-(Q) confirmed with no selections at all. The owner narrowed it the
//      same week: "只要是没有 proceed 这一张订单，其实都不一定是需要填写的，除非
//      它是 proceed 了" — an order that has not been PROCEEDED does not have to
//      be spec-complete; the moment it is proceeded, it does.
//
//      That rule already exists and is unchanged: setting a Processing Date is
//      what "proceed" means, and so-variant-check.ts gates it on the FULL axis
//      list (and on colour-KIV, owner 2026-07-24). Requiring the same axes at
//      CONFIRM merely moved the deadline earlier than the owner wanted — a
//      salesperson taking a deposit before the customer has chosen a seat
//      height could not book the order at all. Confirm now means "this is a
//      real order for a real customer"; proceed still means "this is buildable".
//
//      Kept out of this file rather than softened to a warning: two gates for
//      one rule is how the two drifted apart in the first place.
//
// DRAFTS STAY FREELY SAVEABLE. The gate runs on the DRAFT→CONFIRMED status
// transition and on creates that land directly CONFIRMED (asDraft !== true) —
// the desktop New SO, the mobile wizard and the POS handover. The scan
// pipeline creates DRAFTs and is untouched.
//
// Shape: the same aggregated `validation_failed` + problems[] contract as the
// Processing-Date gates (shared/so-save-problems.ts), so every confirm surface
// (desktop banner / list Confirm / mobile Create Sales Order) renders the full
// reason list through the existing humanApiError / SaveProblemsList path with
// no new client contract.
//
// A GATE THAT COULD NOT LOOK DOES NOT SAY "ALL CLEAR". soConfirmProblemsForDoc's
// three reads dropped their PostgREST error. The lines read was the dangerous
// one: `items ?? []` turned a failed query into an order with no lines, so every
// per-line rule above had nothing to object to and the gate returned an EMPTY
// problem list — which the caller spends as permission to confirm and to enqueue
// the order to AutoCount. A failed read must never read as an absence when the
// absence is what authorises the write (lib/downstream-lock.ts states the rule).
// An unreadable gate now returns a problem of its own instead, and the caller's
// existing `problems.length > 0 → 422` refuses without any change at the call
// site.
// ----------------------------------------------------------------------------
import type { SaveProblem } from '../shared/so-save-problems';
import { acAgentProblem } from './ac-preflight';

/** The gate's own third state: not "confirmable" and not "these things are
 *  wrong", but "we could not check". Rendered by the same SaveProblemsList as
 *  every other confirm problem, so no client contract changes. */
export const SO_CONFIRM_CHECK_FAILED = 'so_confirm_check_failed';

const checkFailedProblem = (reason: string): SaveProblem => ({
  code: SO_CONFIRM_CHECK_FAILED,
  message:
    'Could not check this order against the confirm rules, so it is left as a draft rather '
    + `than confirmed on a check that never ran — try again (${reason}).`,
});

export type SoConfirmLineFacts = {
  itemCode: string | null | undefined;
  /** item_group / itemGroup, any case. Kept because a confirm problem names
   *  the category, not because any rule here reads the line's variants — those
   *  belong to the PROCEED gate (so-variant-check.ts). */
  group: string | null | undefined;
  /** For naming a product-less line in the message. */
  lineNo?: number | null;
  description?: string | null;
};

export type SoConfirmFacts = {
  salespersonId: string | number | null | undefined;
  /** Legacy free-text salesperson name — either identifier satisfies the gate
   *  (the detail page reads both; imported history carries only `agent`). */
  agent: string | null | undefined;
  venue: string | null | undefined;
  venueId: string | null | undefined;
  /** Non-cancelled lines only. */
  lines: readonly SoConfirmLineFacts[];
  /** Non-blank item codes the company's catalog does NOT hold — resolved by
   *  the caller (route: one validateItemCodes read; create: [] because the
   *  create path already refused unknown codes before this gate). */
  nonCatalogCodes?: readonly string[];
};

const blank = (v: unknown): boolean => v == null || String(v).trim() === '';

/** Every reason this order may not be CONFIRMED. [] = confirm may proceed. */
export function collectSoConfirmProblems(facts: SoConfirmFacts): SaveProblem[] {
  const out: SaveProblem[] = [];

  /* RULE 2 ASKS THE WRITE-BACK'S OWN QUESTION, not one of its own — see
     lib/ac-preflight.ts. `blank(salespersonId) && blank(agent)` was a THIRD
     opinion about "does this order name a salesperson", and it was the loosest
     of the three: `agent` is free text with no writer that keeps it honest, so
     HC-SO-2607-008's own value "Unassigned" satisfied it, while `resolveAcAgent`
     — the function that decides what the account book is actually given —
     returns null for it and the create dies as MissingAgentError five minutes
     later in a queue the salesperson never opens. Measured on origin/main
     @839fcaed0: gate says [], composer says null, same order.

     The rule has not moved. It is the owner's 2026-08-08 ruling on that exact
     order, now enforced against the value that leaves the building. */
  const agentProblem = acAgentProblem({
    salespersonId: facts.salespersonId,
    agent: facts.agent,
  });
  if (agentProblem) out.push(agentProblem);

  if (blank(facts.venue) && blank(facts.venueId)) {
    out.push({
      code: 'venue_required',
      message: 'A venue is required before this order can be confirmed.',
      field: 'Venue',
    });
  }

  const nonCatalog = new Set((facts.nonCatalogCodes ?? []).map((c) => c.trim()).filter(Boolean));
  facts.lines.forEach((l, idx) => {
    const code = String(l.itemCode ?? '').trim();
    if (!code) {
      const name = String(l.description ?? '').trim();
      const where = l.lineNo != null ? `Line ${l.lineNo}` : `Line ${idx + 1}`;
      out.push({
        code: 'so_line_no_product',
        message: `${where}${name ? ` ("${name}")` : ''} has no catalog product picked — pick a real SKU before confirming.`,
        ...(name ? { line: name } : {}),
        field: 'Product',
      });
      return;
    }
    if (nonCatalog.has(code)) {
      out.push({
        code: 'so_line_not_catalog',
        message: `${code} is not in the product catalog — pick a real SKU before confirming.`,
        line: code,
        field: 'Product',
      });
    }
  });

  /* NO VARIANT CHECK HERE — see rule 4 in the header. Variant completeness is
     the PROCEED rule (so-variant-check.ts, gated on the Processing Date), not
     the confirm rule. */

  return out;
}

/** IO wrapper for the status route: load the header + non-cancelled lines +
 *  catalog membership for one doc, and collect the confirm problems. The
 *  catalog read is scoped to the SO's OWN company (mfg_products.code is only
 *  unique per company); a company-less legacy header degrades to an unscoped
 *  read, matching validateItemCodes. */
export async function soConfirmProblemsForDoc(sb: any, docNo: string): Promise<SaveProblem[]> {
  const { data: head, error: headErr } = await sb
    .from('mfg_sales_orders')
    .select('salesperson_id, agent, venue, venue_id, company_id')
    .eq('doc_no', docNo)
    .maybeSingle();
  if (headErr) return [checkFailedProblem(`header: ${headErr.message}`)];
  const h = (head ?? {}) as {
    salesperson_id?: string | number | null; agent?: string | null;
    venue?: string | null; venue_id?: string | null; company_id?: number | null;
  };
  const { data: items, error: itemsErr } = await sb
    .from('mfg_sales_order_items')
    .select('item_code, item_group, description, line_no, cancelled')
    .eq('doc_no', docNo);
  /* THE ONE THAT LET THE ORDER THROUGH. `items ?? []` folded a failed read into
     an order with NO lines, every per-line rule then had nothing to object to,
     the gate returned zero problems, and the DRAFT was confirmed — and enqueued
     to AutoCount — carrying the placeholder and free-text lines this gate exists
     to stop. The header and catalog reads below already refused by accident
     (an empty header reads as "no salesperson", an empty catalog reads as "every
     code is non-catalog"), but they refused with a sentence that named the wrong
     problem. All three now say what actually happened. */
  if (itemsErr) return [checkFailedProblem(`lines: ${itemsErr.message}`)];
  const lines = ((items ?? []) as Array<{
    item_code: string | null; item_group: string | null;
    description: string | null;
    line_no: number | null; cancelled: boolean | null;
  }>).filter((i) => !i.cancelled);

  const codes = [...new Set(lines.map((i) => String(i.item_code ?? '').trim()).filter(Boolean))];
  let nonCatalogCodes: string[] = [];
  if (codes.length > 0) {
    let q = sb.from('mfg_products').select('code').in('code', codes);
    if (h.company_id != null) q = q.eq('company_id', h.company_id);
    const { data: prods, error: prodsErr } = await q;
    if (prodsErr) return [checkFailedProblem(`catalog: ${prodsErr.message}`)];
    const known = new Set(((prods ?? []) as Array<{ code: string }>).map((r) => r.code));
    nonCatalogCodes = codes.filter((c) => !known.has(c));
  }

  return collectSoConfirmProblems({
    salespersonId: h.salesperson_id ?? null,
    agent: h.agent ?? null,
    venue: h.venue ?? null,
    venueId: h.venue_id ?? null,
    lines: lines.map((i) => ({
      itemCode: i.item_code,
      group: i.item_group,
      lineNo: i.line_no,
      description: i.description,
    })),
    nonCatalogCodes,
  });
}
