// PO outstanding "chasing list" — presentation helpers.
//
// The backend view scm.v_po_outstanding_lines (mig 20260912T1000) returns ONE
// row per outstanding PO line. A sofa set is stored as several COMPONENT lines
// (e.g. 9058-1A(LHF), 9058-1NA, 9058-L(RHF)) — there is no "set" key on the
// line (binding_id is null, each component carries its own so_item_id), so the
// only signal that several lines are one set is an identical `item_desc2` (the
// colour / configuration string) on the same PO. Rolling components up to one
// "set" row is therefore a PRESENTATION heuristic and lives here, not in SQL.
//
// The rule (agreed with the owner 2026-09-12):
//   group by (company_id, po_number, creditor_code, item_group, item_desc2)
//   — but when item_desc2 is BLANK, each item_code stays its own group so we
//   never over-merge distinct accessories/mattresses that simply have no spec.
// Within a group: remaining_qty sums, and the shown code is the longest common
// prefix of the component codes (trimmed), which yields "9058" for the sofa
// above and the code itself for a single-line group.

export type PoOutstandingLineRow = Record<string, unknown> & {
  po_item_id?: string;
  po_id?: string;
  po_number?: string | null;
  ac_po_no?: string | null;
  so_doc_no?: string | null;
  creditor_code?: string | null;
  creditor_name?: string | null;
  item_code?: string | null;
  item_desc?: string | null;
  item_desc2?: string | null;
  item_group?: string | null;
  location_code?: string | null;
  location_name?: string | null;
  po_date?: string | null;
  qty?: number | null;
  received_qty?: number | null;
  remaining_qty?: number | null;
  delivery_date?: string | null;
  supplier_delivery_date_2?: string | null;
  supplier_delivery_date_3?: string | null;
  company_id?: number | null;
  company_code?: string | null;
  is_outstanding?: boolean;
};

export type PoOutstandingSetRow = PoOutstandingLineRow & {
  /** Longest-common-prefix of the grouped component item codes (e.g. "9058"). */
  set_code: string;
  /** How many component lines this set row folds together (1 = a plain line). */
  component_count: number;
  /** The distinct component item codes, comma-joined, for the drill/tooltip. */
  component_codes: string;
};

const str = (v: unknown): string => (v == null ? '' : String(v));
const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Longest common prefix of a list of strings, trimmed so it never ends on a
 *  separator ("-", "(", whitespace). Empty list → "". */
export function longestCommonPrefix(items: string[]): string {
  if (items.length === 0) return '';
  let p = items[0];
  for (const s of items) {
    while (!s.startsWith(p)) p = p.slice(0, -1);
    if (p === '') break;
  }
  return p.replace(/[-(\s]+$/, '');
}

/** The grouping key for one line. Blank desc2 → key on item_code so distinct
 *  accessories with no spec are never merged together. */
function groupKey(r: PoOutstandingLineRow): string {
  const desc2 = str(r.item_desc2).trim();
  const spec = desc2 || `CODE:${str(r.item_code)}`;
  return [
    str(r.company_id),
    str(r.po_number),
    str(r.creditor_code),
    str(r.item_group),
    spec,
  ].join('||');
}

/**
 * Roll component lines up into one row per sofa "set" (see the rule above).
 * Order-preserving: the first line of each group carries the group's identity;
 * remaining_qty is summed and the component codes are collected.
 */
export function rollUpToSets(rows: PoOutstandingLineRow[]): PoOutstandingSetRow[] {
  const groups = new Map<string, PoOutstandingLineRow[]>();
  const order: string[] = [];
  for (const r of rows) {
    const k = groupKey(r);
    const bucket = groups.get(k);
    if (bucket) bucket.push(r);
    else {
      groups.set(k, [r]);
      order.push(k);
    }
  }
  return order.map((k) => {
    const g = groups.get(k)!;
    const head = g[0];
    const codes = [...new Set(g.map((x) => str(x.item_code)).filter(Boolean))];
    const remaining = g.reduce((a, x) => a + num(x.remaining_qty), 0);
    return {
      ...head,
      remaining_qty: remaining,
      set_code: codes.length === 1 ? codes[0] : longestCommonPrefix(codes) || codes[0] || '',
      component_count: g.length,
      component_codes: codes.join(', '),
    };
  });
}

/** Distinct company codes present in a row set, in first-seen order — feeds the
 *  All / HOUZS / 2990 filter chips without hardcoding the company list. */
export function companyCodesPresent(rows: PoOutstandingLineRow[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of rows) {
    const code = str(r.company_code).trim();
    if (code && !seen.has(code)) {
      seen.add(code);
      out.push(code);
    }
  }
  return out;
}
