// ----------------------------------------------------------------------------
// amendment-routing — PURE classification of an amendment's changed fields into
// a TYPE (processing vs delivery/commercial) and a RESPONSIBLE DEPARTMENT. No
// React, no I/O, so the SO + PO amendment detail surfaces (desktop + mobile) and
// the shared amendment PDF all classify a change the SAME way. Mirror of the
// backend copy (backend/src/scm/shared/amendment-routing.ts) — keep the two
// FIELD_ROUTING tables in sync; the backend uses it only to stamp the audit note.
//
// OWNER-APPROVED MODEL (2026-07-25). Amendments fall into two TYPES by WHAT the
// change touches:
//   • PROCESSING       — WHAT is made: SKU / colour-fabric / quantity / add-remove
//                        line. Responsible group: Production / Design.
//   • DELIVERY/COMMERCIAL — WHEN and on what TERMS: delivery date, unit price,
//                        supplier. Split per field: SO sell price -> Sales Director,
//                        PO unit cost -> Finance, delivery date -> Logistics,
//                        supplier -> Purchasing.
// A single amendment can carry BOTH (a colour swap that also moves the delivery
// date) — it is then MIXED and shows both type badges.
//
// This is ADVISORY routing for display + accountability ONLY. It never gates the
// apply: any authorized approver applies the WHOLE amendment in ONE signature
// (the owner's soft-gate philosophy). Who approved / when / which routed rows is
// preserved by the audit record + the PDF stamp, not by a per-department block.
// ----------------------------------------------------------------------------

export type AmendmentType = 'PROCESSING' | 'DELIVERY_COMMERCIAL';

export type ResponsibleDept =
  | 'Production / Design'
  | 'Finance'
  | 'Sales Director'
  | 'Logistics'
  | 'Purchasing';

export type AmendmentFieldKind =
  | 'SPEC'
  | 'VARIANT'
  | 'QTY'
  | 'LINE'
  | 'PRICE'
  | 'COST'
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
  LINE:     { type: 'DELIVERY_COMMERCIAL', department: 'Sales Director' },
  PRICE:    { type: 'DELIVERY_COMMERCIAL', department: 'Sales Director' },
  COST:     { type: 'DELIVERY_COMMERCIAL', department: 'Finance' },
  DELIVERY: { type: 'DELIVERY_COMMERCIAL', department: 'Logistics' },
  SUPPLIER: { type: 'DELIVERY_COMMERCIAL', department: 'Purchasing' },
};

/** Human label for each atom — what the row chip / PDF routing block prints. */
export const FIELD_KIND_LABEL: Record<AmendmentFieldKind, string> = {
  SPEC: 'Spec / SKU',
  VARIANT: 'Colour / fabric',
  QTY: 'Quantity',
  LINE: 'Line',
  PRICE: 'Price',
  COST: 'Unit cost',
  DELIVERY: 'Delivery date',
  SUPPLIER: 'Supplier',
};

export const TYPE_LABEL: Record<AmendmentType, string> = {
  PROCESSING: 'Processing',
  DELIVERY_COMMERCIAL: 'Delivery / Commercial',
};

/** The responsible GROUP for a whole type — the badge subtitle. */
export const TYPE_RESPONSIBLE: Record<AmendmentType, string> = {
  PROCESSING: 'Production / Design',
  DELIVERY_COMMERCIAL: 'Purchasing / Logistics / Finance / Sales Director',
};

/** Classify one field atom. Total over AmendmentFieldKind, so never null. */
export const routeField = (kind: AmendmentFieldKind): FieldRouting => ({
  kind,
  ...FIELD_ROUTING[kind],
});

const LABEL_TO_KIND: Record<string, AmendmentFieldKind> = {
  spec: 'SPEC',
  sku: 'SPEC',
  'colour / fabric': 'VARIANT',
  colour: 'VARIANT',
  color: 'VARIANT',
  fabric: 'VARIANT',
  variant: 'VARIANT',
  variants: 'VARIANT',
  quantity: 'QTY',
  qty: 'QTY',
  line: 'LINE',
  'unit price': 'PRICE',
  'unit cost': 'COST',
  price: 'PRICE',
  cost: 'COST',
  'delivery date': 'DELIVERY',
  delivery: 'DELIVERY',
  supplier: 'SUPPLIER',
  notes: 'LINE',
};

/** Map a human field label (e.g. "Unit cost", "Delivery date") to its atom, or
    null when it is not a routable field. Case-insensitive. */
export const fieldKindFromLabel = (label: string | null | undefined): AmendmentFieldKind | null => {
  if (label == null) return null;
  return LABEL_TO_KIND[String(label).trim().toLowerCase()] ?? null;
};

export type RoutingSummary = {
  types: AmendmentType[];
  isMixed: boolean;
  departments: Array<{ department: ResponsibleDept; kinds: AmendmentFieldKind[] }>;
};

const TYPE_ORDER: AmendmentType[] = ['PROCESSING', 'DELIVERY_COMMERCIAL'];

/** Fold a flat list of changed field atoms into the type badges + the
    department -> fields routing block both the detail page and the PDF render. */
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
