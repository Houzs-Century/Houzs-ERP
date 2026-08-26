// ----------------------------------------------------------------------------
// THE WAREHOUSE FOLLOWS THE SALES ORDER.
//
// Owner, 2026-07-31: "我们的 item 都不会有仓库, 还是跟着 SO 的" — an item never
// carries a warehouse of its own; the warehouse comes from the Sales Order.
//
// WHERE THE SO'S WAREHOUSE ACTUALLY LIVES. There is no warehouse FK on
// scm.mfg_sales_orders. The header records its warehouse as the free-text
// `sales_location`, written by warehouseLabel() (lib/warehouse-label.ts), which
// is the warehouse CODE when there is one and the name otherwise. That value is
// itself derived from the SO's `customer_state` through state_warehouse_mappings
// (deriveSalesLocationFromState / deriveWarehouseIdFromState in
// routes/mfg-sales-orders.ts). So the SO's warehouse is:
//
//     sales_location  ->  warehouses.code / warehouses.name   (what the SO says)
//     customer_state  ->  state_warehouse_mappings            (how it was derived)
//
// in that order — the recorded value first, the derivation only as a fallback
// for an SO whose sales_location was never filled.
//
// WHAT THIS IS *NOT*. It is NOT a fallback to a SIBLING LINE's warehouse. A
// NULL warehouse_id and a real one are different buckets on purpose: MRP,
// inventory balances and auto-allocation are strictly per-warehouse, and the
// WH_NONE bucket in the UI exists to stop unbound demand pooling stock across a
// warehouse boundary. Borrowing another line's warehouse would silently pool
// them. Falling back to the SO's OWN header cannot: every line of one SO shares
// one header, so the resolved warehouse is a property of the order, which is
// exactly what the owner said it is.
//
// The pure functions here take already-loaded masters so MRP (which loads the
// warehouse list anyway) pays no extra query per line, and so the rule is
// unit-testable without a database.
// ----------------------------------------------------------------------------

export type WarehouseRow = { id: string; code?: string | null; name?: string | null };
export type StateWarehouseMappingRow = { state?: string | null; warehouse_id?: string | null };

/** The SO header fields that carry the order's warehouse. */
export type SoWarehouseSource = {
  sales_location?: string | null;
  customer_state?: string | null;
};

export type SoWarehouseMasters = {
  warehouses: WarehouseRow[];
  stateMappings: StateWarehouseMappingRow[];
};

/* Canonicalise a state name the same tolerant way deriveWarehouseIdFromState
   does (trim + lowercase + collapse whitespace + the known aliases), so a
   mapping row written "Penang" still matches an SO carrying "Pulau Pinang". The
   alias list is copied from that function deliberately: if the two ever
   disagree, a line's warehouse would differ between the write path and MRP. */
const STATE_ALIASES: Record<string, string> = {
  'wilayah persekutuan kuala lumpur': 'kuala lumpur',
  'wp kuala lumpur': 'kuala lumpur',
  kl: 'kuala lumpur',
  penang: 'pulau pinang',
  malacca: 'melaka',
};

export function canonicalizeStateKey(s: string | null | undefined): string {
  if (!s) return '';
  const t = String(s).trim().toLowerCase().replace(/\s+/g, ' ');
  return STATE_ALIASES[t] ?? t;
}

/* sales_location -> warehouse id. Case-insensitive exact match on CODE or NAME,
   the same rule resolveWarehouseId uses on the SO->PO convert path
   (routes/mfg-purchase-orders.ts). Exact, never fuzzy: a near-match here would
   land stock in the wrong building. */
export function warehouseIdFromSalesLocation(
  salesLocation: string | null | undefined,
  warehouses: WarehouseRow[],
): string | null {
  const needle = (salesLocation ?? '').trim().toLowerCase();
  if (!needle) return null;
  const hit = (warehouses ?? []).find(
    (w) =>
      (w.code ?? '').trim().toLowerCase() === needle ||
      (w.name ?? '').trim().toLowerCase() === needle,
  );
  return hit?.id ?? null;
}

/* customer_state -> warehouse id, via state_warehouse_mappings. */
export function warehouseIdFromState(
  state: string | null | undefined,
  mappings: StateWarehouseMappingRow[],
): string | null {
  const want = canonicalizeStateKey(state);
  if (!want) return null;
  for (const m of mappings ?? []) {
    if (m.warehouse_id && canonicalizeStateKey(m.state) === want) return m.warehouse_id;
  }
  return null;
}

/** The Sales Order's own warehouse: what the header records, else how it would
 *  have been derived. Null when the SO carries neither. */
export function resolveSoWarehouseId(
  so: SoWarehouseSource | null | undefined,
  masters: SoWarehouseMasters,
): string | null {
  if (!so) return null;
  return (
    warehouseIdFromSalesLocation(so.sales_location, masters.warehouses) ??
    warehouseIdFromState(so.customer_state, masters.stateMappings)
  );
}

/** A LINE's effective warehouse: its own if it has one, otherwise its Sales
 *  Order's. This is the whole rule, in one place, for every reader. */
export function resolveLineWarehouseId(
  lineWarehouseId: string | null | undefined,
  so: SoWarehouseSource | null | undefined,
  masters: SoWarehouseMasters,
): string | null {
  return lineWarehouseId ?? resolveSoWarehouseId(so, masters);
}

/** Whether two warehouses genuinely DIFFER for a drift check. Both sides must
 *  resolve to a real, distinct warehouse: a side that is NULL is unbound (or, on
 *  the SO side, "inherit the order's" once resolveLineWarehouseId has run) — NOT
 *  a move. Comparing a real id against NULL with plain `!==` was the bug: it read
 *  every never-set line warehouse as "SO warehouse moved". */
export function warehousesDiffer(
  aWarehouseId: string | null | undefined,
  bWarehouseId: string | null | undefined,
): boolean {
  const a = aWarehouseId ?? null;
  const b = bWarehouseId ?? null;
  return a != null && b != null && a !== b;
}

/** WRITE-time warehouse default for a brand-new order's goods lines — the
 *  read-time chain above (Location, then State) applied at create, plus ONE
 *  final fallback the read chain does not have: the creating operator's own
 *  store (owner 2026-08-25, after 2990-SO-2608-045 was born with four goods
 *  lines no allocation bucket could ever match).
 *
 *  THE STORE ONLY STANDS IN WHEN THE ORDER WOULD OTHERWISE BE LOCATIONLESS. A
 *  resolved Location or State always wins — those are statements about the
 *  ORDER. And an EXPLICIT Location that fails to resolve (typo, retired
 *  warehouse) blocks the store too: the operator said something specific, and
 *  silently overriding it with their parking spot would bind lines to a
 *  warehouse that contradicts the header text. That case keeps today's NULL
 *  and the [null-warehouse] signal keeps naming it. */
export function chooseCreateWarehouseDefault(i: {
  /** body.salesLocation, trimmed — null when the caller sent none. */
  explicitSalesLocation: string | null;
  /** explicitSalesLocation resolved against the warehouse master, if sent. */
  salesLocationWarehouseId: string | null;
  /** customer_state resolved through state_warehouse_mappings. */
  stateWarehouseId: string | null;
  /** The creating operator's scm.staff.showroom_warehouse_id — already
   *  verified to exist in the ACTIVE company's warehouse master (the staff
   *  row is shared across companies, so an unverified id could bind a Houzs
   *  order to a 2990 showroom). */
  operatorStoreWarehouseId: string | null;
}): { warehouseId: string | null; usedOperatorStore: boolean } {
  const derived = i.salesLocationWarehouseId ?? i.stateWarehouseId;
  if (derived) return { warehouseId: derived, usedOperatorStore: false };
  if (i.explicitSalesLocation) return { warehouseId: null, usedOperatorStore: false };
  if (i.operatorStoreWarehouseId) {
    return { warehouseId: i.operatorStoreWarehouseId, usedOperatorStore: true };
  }
  return { warehouseId: null, usedOperatorStore: false };
}

/* ── Loaders ────────────────────────────────────────────────────────────────
   Kept apart from the rule above so callers that already hold the masters (MRP
   loads the warehouse list for its own labels) do not re-read them. `scope`
   is the caller's own company-scoping wrapper — MRP's `scoped()`, or
   scopeToCompany bound to a Context — so this file never needs a Context and
   works from the headless write paths too. */
type Scope = <T>(q: T) => T;
const identityScope: Scope = (q) => q;

export async function loadSoWarehouseMasters(
  sb: any,
  scope: Scope = identityScope,
): Promise<SoWarehouseMasters> {
  const { data: warehouses } = await scope(sb.from('warehouses').select('id, code, name'));
  const { data: stateMappings } = await scope(
    sb.from('state_warehouse_mappings').select('state, warehouse_id'),
  );
  return {
    warehouses: (warehouses ?? []) as WarehouseRow[],
    stateMappings: (stateMappings ?? []) as StateWarehouseMappingRow[],
  };
}

/** One-shot: the warehouse a NEW line of `docNo` should inherit. Used by the
 *  write paths that previously inserted warehouse_id NULL. Fail-soft — a
 *  missing header or master simply yields null, which is the behaviour those
 *  paths had before. */
export async function soWarehouseIdForDoc(
  sb: any,
  docNo: string,
  scope: Scope = identityScope,
): Promise<string | null> {
  try {
    const { data: hdr } = await sb
      .from('mfg_sales_orders')
      .select('sales_location, customer_state')
      .eq('doc_no', docNo)
      .maybeSingle();
    if (!hdr) return null;
    const masters = await loadSoWarehouseMasters(sb, scope);
    return resolveSoWarehouseId(hdr as SoWarehouseSource, masters);
  } catch {
    return null;
  }
}
