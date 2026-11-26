
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
