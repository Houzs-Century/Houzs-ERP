// ----------------------------------------------------------------------------
// audit-id-labels — the History drawer printed record ids ("Supplier Id
// d930541c-297b-...") because field_changes stores the foreign key a handler
// wrote, not the thing it points at (owner 2026-11-17: "why all this words?").
//
// This adds `from_label` / `to_label` beside `from` / `to` on every change whose
// field names a record, by reading that record's name at READ time, so the rows
// already in the log read correctly too — a write-time snapshot would only fix
// the history written after it shipped. `from` / `to` are left as they were.
//
// The field list is the measured population, not a guess: probe-audit-id-fields
// (run 44114043280, 2026-11-17) listed every field in entity_audit_log and
// mfg_so_audit_log holding a uuid. A field added later shows its id until it is
// added here.
//
// ── COMPANY SCOPE ──
// No company predicate on these lookups, deliberately. The ids come from audit
// rows the caller's route has already company-scoped, and each lookup returns
// only the name of exactly those ids; staff and venues carry no company_id to
// filter on at all. A name is never returned for an id the caller did not
// already hold.
//
// A failed lookup does not fail the history: the change keeps its raw value and
// the result says which tables could not be read, so the route can report it.
// ----------------------------------------------------------------------------

type Source = { table: string; select: string; label: (r: Record<string, unknown>) => string };

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const codeName = (r: Record<string, unknown>): string =>
  [text(r.code), text(r.name)].filter(Boolean).join(' · ');

const SUPPLIER: Source = { table: 'suppliers', select: 'id, code, name', label: codeName };
const WAREHOUSE: Source = { table: 'warehouses', select: 'id, code, name', label: (r) => text(r.name) || text(r.code) };
const STAFF: Source = { table: 'staff', select: 'id, name', label: (r) => text(r.name) };

export const AUDIT_ID_FIELDS: Partial<Record<string, Source>> = {
  supplierId: SUPPLIER,
  purchaseLocationId: WAREHOUSE,
  warehouseId: WAREHOUSE,
  toWarehouseId: WAREHOUSE,
  fromWarehouseId: WAREHOUSE,
  salespersonId: STAFF,
  agent: STAFF,
  collaboratorStaffIds: STAFF,
  purchaseOrderId: { table: 'purchase_orders', select: 'id, po_number', label: (r) => text(r.po_number) },
  deliveryOrderId: { table: 'delivery_orders', select: 'id, do_number', label: (r) => text(r.do_number) },
  grnId: { table: 'grns', select: 'id, grn_number', label: (r) => text(r.grn_number) },
  rackId: { table: 'warehouse_racks', select: 'id, rack', label: (r) => text(r.rack) },
  venueId: { table: 'venues', select: 'id, name', label: (r) => text(r.name) },
  amendment_id: { table: 'so_amendments', select: 'id, amendment_no', label: (r) => text(r.amendment_no) },
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHUNK = 200;

function idsIn(v: unknown): string[] {
  if (typeof v === 'string') return UUID.test(v) ? [v] : [];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string' && UUID.test(x));
  return [];
}

type Change = Record<string, unknown> & { field?: unknown; from?: unknown; to?: unknown };

function changesOf(entry: Record<string, unknown>): Change[] {
  const fc = entry.field_changes;
  return Array.isArray(fc) ? (fc.filter((c) => c && typeof c === 'object') as Change[]) : [];
}

export type AuditLabelReader = {
  from(table: string): {
    select(cols: string): { in(col: string, vals: string[]): PromiseLike<{ data: unknown; error: { message: string } | null }> };
  };
};

/** Adds from_label / to_label in place. Returns the tables that failed to read
 *  (empty when every lookup worked). */
export async function labelAuditIds(sb: AuditLabelReader, entries: Array<Record<string, unknown>>): Promise<string[]> {
  const wanted = new Map<Source, Set<string>>();
  for (const e of entries) {
    for (const ch of changesOf(e)) {
      const src = typeof ch.field === 'string' ? AUDIT_ID_FIELDS[ch.field] : undefined;
      if (!src) continue;
      const set = wanted.get(src) ?? new Set<string>();
      for (const id of [...idsIn(ch.from), ...idsIn(ch.to)]) set.add(id);
      if (set.size) wanted.set(src, set);
    }
  }
  if (!wanted.size) return [];

  const names = new Map<string, string>();
  const failed: string[] = [];
  await Promise.all([...wanted].map(async ([src, set]) => {
    const ids = [...set];
    for (let i = 0; i < ids.length; i += CHUNK) {
      const { data, error } = await sb.from(src.table).select(src.select).in('id', ids.slice(i, i + CHUNK));
      if (error) { failed.push(src.table); return; }
      for (const r of (data ?? []) as Array<Record<string, unknown>>) {
        const label = src.label(r);
        if (typeof r.id === 'string' && label) names.set(r.id, label);
      }
    }
  }));

  const labelOf = (v: unknown): string | undefined => {
    const ids = idsIn(v);
    if (!ids.length) return undefined;
    const parts = ids.map((id) => names.get(id));
    if (parts.some((p) => p === undefined)) return undefined;
    return parts.join(', ');
  };
  for (const e of entries) {
    for (const ch of changesOf(e)) {
      if (typeof ch.field !== 'string' || !AUDIT_ID_FIELDS[ch.field]) continue;
      const f = labelOf(ch.from);
      const t = labelOf(ch.to);
      if (f !== undefined) ch.from_label = f;
      if (t !== undefined) ch.to_label = t;
    }
  }
  return [...new Set(failed)];
}
