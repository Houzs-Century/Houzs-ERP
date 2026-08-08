// ----------------------------------------------------------------------------
// so-confirm-gate — everything a Sales Order must have before it may be
// CONFIRMED (owner rulings 2026-08-08, all in one morning):
//
//   1. "为什么会有这样的 sku square pillow 你可以允许 freetext 的吗!?"
//      (HC-SO-2607-013) — every line must name a REAL catalog SKU. A line with
//      no product picked (the scan pipeline's placeholder) or a code the
//      company's catalog does not hold blocks confirm.
//   2. HC-SO-2607-008 confirmed with salesperson "Unassigned" — a salesperson
//      (salesperson_id OR the legacy `agent` text) is required to confirm.
//   3. "venue is compulsory的" — a venue (venue text OR venue_id) is required
//      to confirm. No venue-less order class exists in code: the venue
//      resolver's "empty is honest" rule (venue-binding.ts) governs
//      AUTO-RESOLUTION only — when it resolves nothing, a human picks one.
//   4. HC-SO-2607-008's bedframe line Y103-(Q) confirmed with NO variant
//      selections — every goods line must carry its category-required variant
//      axes (the EXISTING so-variant-rule machinery: sofa seat/fabric,
//      bedframe divan/leg/gap/fabric; mattress / accessory / service / others
//      have no axes and pass). A colour-KIV line (fabric SERIES committed,
//      colour confirmed later — isColourKiv) SATISFIES the fabric axis here:
//      KIV is a legitimate confirmed-order state and only blocks the
//      Processing Date (owner rule 2026-07-24), not confirm.
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
// ----------------------------------------------------------------------------
import { missingConfirmVariantAxes } from '../shared';
import type { SaveProblem } from '../shared/so-save-problems';

export type SoConfirmLineFacts = {
  itemCode: string | null | undefined;
  /** item_group / itemGroup, any case. */
  group: string | null | undefined;
  variants: Record<string, unknown> | null | undefined;
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

  if (blank(facts.salespersonId) && blank(facts.agent)) {
    out.push({
      code: 'salesperson_required',
      message: 'A salesperson must be assigned before this order can be confirmed.',
      field: 'Salesperson',
    });
  }

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

  // Category-required variants — one problem per (line, axis), same wording
  // shape as the Processing-Date gate so the two read alike. The fabric axis
  // is satisfied by a colour-KIV line (series committed, colour later) —
  // missingConfirmVariantAxes IS that rule, shared with both frontends.
  for (const l of facts.lines) {
    const code = String(l.itemCode ?? '').trim();
    if (!code) continue; // already reported as product-less above
    for (const axis of missingConfirmVariantAxes(l.group ?? '', l.variants ?? null)) {
      out.push({
        code: 'variants_incomplete',
        message: `${code} — ${axis.label} is required before this order can be confirmed`,
        line: code,
        field: axis.label,
      });
    }
  }

  return out;
}

/** IO wrapper for the status route: load the header + non-cancelled lines +
 *  catalog membership for one doc, and collect the confirm problems. The
 *  catalog read is scoped to the SO's OWN company (mfg_products.code is only
 *  unique per company); a company-less legacy header degrades to an unscoped
 *  read, matching validateItemCodes. */
export async function soConfirmProblemsForDoc(sb: any, docNo: string): Promise<SaveProblem[]> {
  const { data: head } = await sb
    .from('mfg_sales_orders')
    .select('salesperson_id, agent, venue, venue_id, company_id')
    .eq('doc_no', docNo)
    .maybeSingle();
  const h = (head ?? {}) as {
    salesperson_id?: string | number | null; agent?: string | null;
    venue?: string | null; venue_id?: string | null; company_id?: number | null;
  };
  const { data: items } = await sb
    .from('mfg_sales_order_items')
    .select('item_code, item_group, variants, description, line_no, cancelled')
    .eq('doc_no', docNo);
  const lines = ((items ?? []) as Array<{
    item_code: string | null; item_group: string | null;
    variants: Record<string, unknown> | null; description: string | null;
    line_no: number | null; cancelled: boolean | null;
  }>).filter((i) => !i.cancelled);

  const codes = [...new Set(lines.map((i) => String(i.item_code ?? '').trim()).filter(Boolean))];
  let nonCatalogCodes: string[] = [];
  if (codes.length > 0) {
    let q = sb.from('mfg_products').select('code').in('code', codes);
    if (h.company_id != null) q = q.eq('company_id', h.company_id);
    const { data: prods } = await q;
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
      variants: i.variants,
      lineNo: i.line_no,
      description: i.description,
    })),
    nonCatalogCodes,
  });
}
