// ----------------------------------------------------------------------------
// amendment-routing (backend) — PURE classification of an amendment's changed
// fields into a TYPE (processing vs delivery/commercial) and a RESPONSIBLE
// DEPARTMENT. Mirror of the frontend copy
// (frontend/src/vendor/scm/lib/amendment-routing.ts) — keep the FIELD_ROUTING
// tables in sync. The backend uses it only to STAMP the routing summary onto the
// amendment-approved audit row (so-revision.ts / po-revision.ts), so accountability
// is recorded: which routed fields/departments the single approver signed off.
//
// This never gates the apply. Any authorized approver applies the WHOLE amendment
// in ONE signature (the owner's soft-gate model); the routing is advisory
// labelling for display + the audit trail, not a per-department hard block.
//
// See the frontend copy's header for the full owner-approved type model.
// ----------------------------------------------------------------------------

export type AmendmentType = 'PROCESSING' | 'DELIVERY_COMMERCIAL';

export type ResponsibleDept =
  | 'Production / Design'
  | 'Finance'
  | 'Logistics'
  | 'Purchasing';

export type AmendmentFieldKind =
  | 'SPEC'
  | 'VARIANT'
  | 'QTY'
  | 'LINE'
  | 'PRICE'
  | 'DELIVERY'
  | 'SUPPLIER';

export type FieldRouting = {
  kind: AmendmentFieldKind;
  type: AmendmentType;
  department: ResponsibleDept;
};

const FIELD_ROUTING: Record<AmendmentFieldKind, { type: AmendmentType; department: ResponsibleDept }> = {
  SPEC:     { type: 'PROCESSING',          department: 'Production / Design' },
  VARIANT:  { type: 'PROCESSING',          department: 'Production / Design' },
  QTY:      { type: 'PROCESSING',          department: 'Production / Design' },
  LINE:     { type: 'PROCESSING',          department: 'Production / Design' },
  PRICE:    { type: 'DELIVERY_COMMERCIAL', department: 'Finance' },
  DELIVERY: { type: 'DELIVERY_COMMERCIAL', department: 'Logistics' },
  SUPPLIER: { type: 'DELIVERY_COMMERCIAL', department: 'Purchasing' },
};

export const FIELD_KIND_LABEL: Record<AmendmentFieldKind, string> = {
  SPEC: 'Spec / SKU',
  VARIANT: 'Colour / fabric',
  QTY: 'Quantity',
  LINE: 'Line',
  PRICE: 'Price',
  DELIVERY: 'Delivery date',
  SUPPLIER: 'Supplier',
};

export const TYPE_LABEL: Record<AmendmentType, string> = {
  PROCESSING: 'Processing',
  DELIVERY_COMMERCIAL: 'Delivery / Commercial',
};

export const routeField = (kind: AmendmentFieldKind): FieldRouting => ({
  kind,
  ...FIELD_ROUTING[kind],
});

export type RoutingSummary = {
  types: AmendmentType[];
  isMixed: boolean;
  departments: Array<{ department: ResponsibleDept; kinds: AmendmentFieldKind[] }>;
};

const TYPE_ORDER: AmendmentType[] = ['PROCESSING', 'DELIVERY_COMMERCIAL'];

export const summariseRouting = (kinds: Array<AmendmentFieldKind | null | undefined>): RoutingSummary => {
  const clean = kinds.filter((k): k is AmendmentFieldKind => k != null);
  const typeSet = new Set<AmendmentType>();
  const deptOrder: ResponsibleDept[] = [];
  const deptKinds = new Map<ResponsibleDept, AmendmentFieldKind[]>();

  for (const k of clean) {
    const r = routeField(k);
    typeSet.add(r.type);
    if (!deptKinds.has(r.department)) {
      deptKinds.set(r.department, []);
      deptOrder.push(r.department);
    }
    const list = deptKinds.get(r.department)!;
    if (!list.includes(k)) list.push(k);
  }

  return {
    types: TYPE_ORDER.filter((t) => typeSet.has(t)),
    isMixed: typeSet.size > 1,
    departments: deptOrder.map((d) => ({ department: d, kinds: deptKinds.get(d)! })),
  };
};

/** Render the routing summary as a single-line human string for the audit note /
    field-change value, e.g.
      "Processing + Delivery/Commercial | Production / Design: Colour / fabric;
       Logistics: Delivery date". Null-safe: empty input yields ''. */
export const routingNote = (kinds: Array<AmendmentFieldKind | null | undefined>): string => {
  const s = summariseRouting(kinds);
  if (s.departments.length === 0) return '';
  const typeStr = s.types.map((t) => TYPE_LABEL[t]).join(' + ');
  const deptStr = s.departments
    .map((d) => `${d.department}: ${d.kinds.map((k) => FIELD_KIND_LABEL[k]).join(', ')}`)
    .join('; ');
  return `${typeStr} | ${deptStr}`;
};
