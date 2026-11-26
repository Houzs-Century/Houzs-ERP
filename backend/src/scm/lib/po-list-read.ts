// exported one screen page instead (docs/bugs — "the Purchase Order Export held

import { PO_STATUS_BUCKETS } from './po-status-buckets';
import { HELD_OR_TERM, HOLD_COLUMNS } from './document-hold';
import { escapeForOr } from './postgrest-search';
import { scopeToCompany, type CompanyScopeCtx } from './companyScope';
import { inArm } from './so-ref-search';
import { chunkIn } from './paginate-all';

export const PO_HEADER_COLS =
  'id, po_number, linked_ac_docno, supplier_id, status, po_date, expected_at, currency, ' +
  'subtotal_sen, tax_sen, total_sen, notes, submitted_at, received_at, ' +
  'cancelled_at, created_at, created_by, updated_at, ' +
  'revision, ' +
  'purchase_location_id, ' +
  'supplier_delivery_date_2, supplier_delivery_date_3, supplier_delivery_date_4, ' +
  HOLD_COLUMNS;

/* PR — Commander 2026-05-27: PO list rows surface a per-row items summary
   (AutoCount-style). purchase_location embeds the warehouse the PO ships to
   (PR #77), the list needs its NAME for the "Purchase Location" column (Owner
   2026-07-02). Supplier CONTACT fields ride the embed because the quick-view
   drawer renders its SUPPLIER panel straight off the list row (owner
   2026-07-24). supplier_sku rides the items embed (owner 2026-08-05). */
export const PO_LIST_SELECT = `${PO_HEADER_COLS}, supplier:suppliers(id, code, name, contact_person, phone, email, email2, email3, address), items:purchase_order_items(item_code, material_name, qty, supplier_sku), purchase_location:warehouses!purchase_location_id(id, code, name)`;

/** The list's filter contract, as the query string carries it.
 *  `creditorNames`/`creditorCodes`/`currencies` are the SERVER-FILTERABLE column
 *  funnels the Purchase Orders grid pushes down so pagination runs over the
 *  filtered set (owner 2026-09-16). Line-level and MRP-derived funnels are not
 *  here — they stay client-side on the loaded page (see PurchaseOrdersListV2). */
export type PoListFilters = {
  status: string | null;
  supplierId: string | null;
  q: string | null;
  from: string | null;
  to: string | null;
  sort: string | null;
  creditorNames: string[] | null;
  creditorCodes: string[] | null;
  currencies: string[] | null;
  docDates: string[] | null;
  soRefPoIds: string[];
  itemCodePoIds: string[];
};

const param = (v: string | undefined): string | null => (v === undefined || v === '' ? null : v);

function jsonArrayParam(v: string | undefined): string[] | null {
  if (v === undefined || v === '') return null;
  try {
    const parsed = JSON.parse(v) as unknown;
    if (!Array.isArray(parsed)) return null;
    const out = parsed.filter((x): x is string => typeof x === 'string' && x.length > 0);
    return out.length ? out : null;
  } catch {
    return null;
  }
}

function isoDates(v: string[] | null): string[] | null {
  const out = (v ?? []).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
  return out.length ? out : null;
}

export function readPoListFilters(query: (key: string) => string | undefined): PoListFilters {
  return {
    status: param(query('status')),
    supplierId: param(query('supplierId')),
    q: param(query('q')),
    from: param(query('from')),
    to: param(query('to')),
    sort: param(query('sort')),
    creditorNames: jsonArrayParam(query('creditorNames')),
    creditorCodes: jsonArrayParam(query('creditorCodes')),
    currencies: jsonArrayParam(query('currencies')),
    docDates: isoDates(jsonArrayParam(query('docDates'))),
    soRefPoIds: [],
    itemCodePoIds: [],
  };
}

/** The SELECT for the list read. When a creditor funnel is active the supplier
 *  embed becomes `!inner` so a `supplier.name`/`supplier.code` filter removes the
 *  parent PO (a plain embed would only null the embed and keep every PO). Shared
 *  by the list and both exports so all three match the same set. */
export function poListSelect(f: PoListFilters): string {
  const creditorFilter =
    (f.creditorNames !== null && f.creditorNames.length > 0) ||
    (f.creditorCodes !== null && f.creditorCodes.length > 0);
  const supplierEmbed = creditorFilter
    ? 'supplier:suppliers!inner(id, code, name, contact_person, phone, email, email2, email3, address)'
    : 'supplier:suppliers(id, code, name, contact_person, phone, email, email2, email3, address)';
  return `${PO_HEADER_COLS}, ${supplierEmbed}, items:purchase_order_items(item_code, material_name, qty, supplier_sku), purchase_location:warehouses!purchase_location_id(id, code, name)`;
}

const BUCKETS: Readonly<Record<string, string[] | undefined>> = PO_STATUS_BUCKETS;

const SORT_COLS = new Set(['po_date', 'po_number', 'status', 'total_sen']);

export function poListSort(sort: string | null): { col: string; asc: boolean } {
  const [rawCol, rawDir] = (sort ?? 'po_date:desc').split(':');
  return { col: rawCol !== undefined && SORT_COLS.has(rawCol) ? rawCol : 'po_date', asc: rawDir === 'asc' };
}

type Filterable = {
  order(col: string, opts: { ascending: boolean }): Filterable;
  in(col: string, vals: string[]): Filterable;
  eq(col: string, val: unknown): Filterable;
  or(filters: string): Filterable;
  gte(col: string, val: unknown): Filterable;
  lte(col: string, val: unknown): Filterable;
};

/** ORDER BY the list's sort, with po_number as the unique tiebreaker so range
 *  paging can neither skip nor repeat rows sharing the sort key. */
export function orderPoList<Q>(q: Q, sort: string | null): Q {
  const { col, asc } = poListSort(sort);
  let out = (q as unknown as Filterable).order(col, { ascending: asc });
  if (col !== 'po_number') out = out.order('po_number', { ascending: asc });
  return out as unknown as Q;
}

/** Tab + supplier + COMPANY + search + date range. `validStatuses` is the raw
 *  status vocabulary a non-bucket `status` must belong to — VALID_STATUSES in
 *  routes/mfg-purchase-orders.ts, which stays declared there on purpose
 *  (tests/purchaseDocVocab.test.ts). */
export function filterPoList<Q>(q: Q, f: PoListFilters, c: CompanyScopeCtx, validStatuses: ReadonlySet<string>): Q {
  let out = q as unknown as Filterable;
  if (f.status && f.status !== 'all') {
    if (f.status === 'on_hold') out = out.or(HELD_OR_TERM);
    else if (BUCKETS[f.status]) out = out.in('status', BUCKETS[f.status]!);
    else if (validStatuses.has(f.status)) out = out.eq('status', f.status);
  }
  if (f.supplierId) out = out.eq('supplier_id', f.supplierId);
  /* Server-filterable column funnels (owner 2026-09-16): Creditor Name / Code
     via the `supplier` embed (poListSelect makes it `!inner` so these remove the
     parent PO, not just null the embed), Currency on the base column. Multi-value
     via `in`. The grid pushes the ticked values so pagination runs over the
     filtered set. */
  if (f.creditorNames && f.creditorNames.length > 0) out = out.in('supplier.name', f.creditorNames);
  if (f.creditorCodes && f.creditorCodes.length > 0) out = out.in('supplier.code', f.creditorCodes);
  if (f.currencies && f.currencies.length > 0) out = out.in('currency', f.currencies);
  if (f.docDates && f.docDates.length > 0) out = out.in('po_date', f.docDates);
  out = scopeToCompany(out, c);
  if (f.q) {
    const s = escapeForOr(f.q);
    if (s) out = out.or([`po_number.ilike.%${s}%`, `notes.ilike.%${s}%`, ...inArm('id', [...f.soRefPoIds, ...f.itemCodePoIds])].join(','));
  }
  if (f.from) out = out.gte('po_date', f.from);
  if (f.to) out = out.lte('po_date', f.to);
  return out as unknown as Q;
}

type GrnRow = { id: string; purchase_order_id: string | null; grn_number: string | null; received_at: string | null };
type GrnReader = {
  from(table: 'grns'): {
    select(cols: string): {
      in(col: string, vals: string[]): {
        neq(col: string, val: string): {
          order(col: string, opts: { ascending: boolean }): {
            order(col: string, opts: { ascending: boolean }): {
              range(from: number, to: number): PromiseLike<{ data: GrnRow[] | null; error: { message: string } | null }>;
            };
          };
        };
      };
    };
  };
};

type PoItemRow = { id: string; purchase_order_id: string | null };
type GrnItemRow = { purchase_order_item_id: string | null; grn_id: string };
type GrnStatusRow = { id: string; grn_number: string | null; status: string | null; received_at: string | null };
type PlainInReader<Row> = {
  from(table: string): {
    select(cols: string): {
      in(col: string, vals: string[]): {
        order(col: string, opts: { ascending: boolean }): {
          range(from: number, to: number): PromiseLike<{ data: Row[] | null; error: { message: string; code?: string } | null }>;
        };
      };
    };
  };
};

export type PoGrnRef = { id: string; grnNumber: string; receivedAt: string | null };

export function mergePoGrnLinks(
  headerLinks: ReadonlyArray<{ poId: string; grnId: string; grnNumber: string | null; receivedAt?: string | null }>,
  lineLinks: ReadonlyArray<{ poId: string; grnId: string; grnNumber: string | null; receivedAt?: string | null; cancelled: boolean }>,
): { childIds: Set<string>; grnsByPo: Map<string, PoGrnRef[]> } {
  const childIds = new Set<string>();
  const grnsByPo = new Map<string, PoGrnRef[]>();
  const add = (poId: string, grnId: string, grnNumber: string | null, receivedAt: string | null) => {
    childIds.add(poId);
    if (!grnNumber) return;
    const arr = grnsByPo.get(poId) ?? [];
    if (!arr.some((x) => x.id === grnId)) arr.push({ id: grnId, grnNumber, receivedAt });
    grnsByPo.set(poId, arr);
  };
  for (const h of headerLinks) add(h.poId, h.grnId, h.grnNumber, h.receivedAt ?? null);
  for (const l of lineLinks) if (!l.cancelled) add(l.poId, l.grnId, l.grnNumber, l.receivedAt ?? null);
  return { childIds, grnsByPo };
}

/* Tier 2 downstream-lock (mirror computeGrnFlags in lib/grn-consumption-flags):
   the non-cancelled GRNs each PO was received into. Powers both `has_children`
   (the list hides Edit / Cancel on a downstream-locked PO) and the "GRN No"
   column (owner 2026-07-02); `id` rides along because GRN detail routes by UUID
   (owner 2026-07-31), `receivedAt` feeds the "GRN Date" column (HC-0179: the
   purchaser opened each GRN through the relation map just to read its date). The GRN read carries no company predicate of its own: it
   is keyed by PO ids that were themselves read under the company scope.

   A GRN belongs to a PO two ways, and both are real: the header FK, and — since
   a supplier multi-receive (grns POST /from-po-items) bundles picks across POs
   under one header — the grn_items line link. `includeLineLinked` runs the line
   pass: the paged LIST passes true (bounded: page ≤ 100, legacy path .limit(500)),
   the EXPORT passes false because it stamps every PO a tab matches and the extra
   per-line reads would blow the Worker subrequest budget (lib/paginate-all.ts).

   Batched by URL size (chunkIn): an `in.(…)` list of many uuids is refused at
   the gateway, so each read chunks its ids. */
export async function stampPoListGrns<R extends { id: string }>(
  sb: unknown,
  rows: R[],
  includeLineLinked: boolean,
): Promise<{
  error: string | null;
  rows: Array<R & { has_children: boolean; transfer_to_grns: PoGrnRef[] }>;
}> {
  if (rows.length === 0) {
    return { error: null, rows: rows.map((r) => ({ ...r, has_children: false, transfer_to_grns: [] })) };
  }
  const poIds = rows.map((r) => r.id);

  const { data: headerRows, error: hErr } = await chunkIn<GrnRow>(poIds, (batch, from, to) =>
    (sb as GrnReader)
      .from('grns')
      .select('id, purchase_order_id, grn_number, received_at')
      .in('purchase_order_id', batch)
      .neq('status', 'CANCELLED')
      .order('grn_number', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to));
  if (hErr) return { error: hErr.message, rows: [] };
  const headerLinks = headerRows
    .filter((g) => g.purchase_order_id)
    .map((g) => ({ poId: g.purchase_order_id as string, grnId: g.id, grnNumber: g.grn_number, receivedAt: g.received_at }));

  let lineLinks: Array<{ poId: string; grnId: string; grnNumber: string | null; receivedAt: string | null; cancelled: boolean }> = [];
  if (includeLineLinked) {
    const { data: itemRows, error: iErr } = await chunkIn<PoItemRow>(poIds, (batch, from, to) =>
      (sb as PlainInReader<PoItemRow>)
        .from('purchase_order_items')
        .select('id, purchase_order_id')
        .in('purchase_order_id', batch)
        .order('id', { ascending: true })
        .range(from, to));
    if (iErr) return { error: iErr.message, rows: [] };
    const itemToPo = new Map<string, string>();
    for (const it of itemRows) if (it.purchase_order_id) itemToPo.set(it.id, it.purchase_order_id);
    const itemIds = [...itemToPo.keys()];

    const { data: grnItemRows, error: giErr } = itemIds.length
      ? await chunkIn<GrnItemRow>(itemIds, (batch, from, to) =>
          (sb as PlainInReader<GrnItemRow>)
            .from('grn_items')
            .select('purchase_order_item_id, grn_id')
            .in('purchase_order_item_id', batch)
            .order('grn_id', { ascending: true })
            .range(from, to))
      : { data: [] as GrnItemRow[], error: null };
    if (giErr) return { error: giErr.message, rows: [] };

    const headerIds = new Set(headerRows.map((g) => g.id));
    const lineGrnIds = [...new Set(grnItemRows.map((r) => r.grn_id).filter((x): x is string => !!x))]
      .filter((gid) => !headerIds.has(gid));
    const { data: lineGrnRows, error: lgErr } = lineGrnIds.length
      ? await chunkIn<GrnStatusRow>(lineGrnIds, (batch, from, to) =>
          (sb as PlainInReader<GrnStatusRow>)
            .from('grns')
            .select('id, grn_number, status, received_at')
            .in('id', batch)
            .order('id', { ascending: true })
            .range(from, to))
      : { data: [] as GrnStatusRow[], error: null };
    if (lgErr) return { error: lgErr.message, rows: [] };
    const grnMeta = new Map<string, { grnNumber: string | null; receivedAt: string | null; cancelled: boolean }>();
    for (const g of headerRows) grnMeta.set(g.id, { grnNumber: g.grn_number, receivedAt: g.received_at, cancelled: false });
    for (const g of lineGrnRows) if (!grnMeta.has(g.id)) grnMeta.set(g.id, { grnNumber: g.grn_number, receivedAt: g.received_at, cancelled: (g.status ?? '').toUpperCase() === 'CANCELLED' });

    lineLinks = grnItemRows.flatMap((r) => {
      const poId = r.purchase_order_item_id ? itemToPo.get(r.purchase_order_item_id) : undefined;
      const meta = r.grn_id ? grnMeta.get(r.grn_id) : undefined;
      if (!poId || !meta) return [];
      return [{ poId, grnId: r.grn_id, grnNumber: meta.grnNumber, receivedAt: meta.receivedAt, cancelled: meta.cancelled }];
    });
  }

  const { childIds, grnsByPo } = mergePoGrnLinks(headerLinks, lineLinks);
  for (const arr of grnsByPo.values()) arr.sort((a, b) => a.grnNumber.localeCompare(b.grnNumber));
  return {
    error: null,
    rows: rows.map((r) => ({ ...r, has_children: childIds.has(r.id), transfer_to_grns: grnsByPo.get(r.id) ?? [] })),
  };
}
