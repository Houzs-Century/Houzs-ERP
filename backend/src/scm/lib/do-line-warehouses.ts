/* company-scope-file: this module WRITES NOTHING. Its two reads are keyed on
   ids the caller resolved under its own company predicate, and the company is
   a REQUIRED argument on the default-warehouse fallback — which is the whole
   point of that signature; see inventory-movements.ts defaultWarehouseId. */
import { defaultWarehouseId } from './inventory-movements';

/* Moved out of routes/delivery-orders-mfg.ts on 2026-09-07, when the
   migrated-document guard pushed that file past its size ceiling. A MOVE, not
   a rewrite — the body is unchanged and all ten call sites still pass through
   here, which is the property that matters: the OUT, the resync, the restamp
   and the pre-flight availability check must all resolve a line's warehouse
   the SAME way, or the dialog and the movement measure two different
   buildings (2026-08-03, Nico / 2990-SO-2606-034). */
/* ── resolveDoLineWarehouses (Agent D 2026-05-31, TASK #32) ───────────────────
   PER-WAREHOUSE CORRECTNESS for the OUTBOUND side. A DO line MUST deduct from
   the warehouse of the Sales Order LINE it delivers (mfg_sales_order_items.
   warehouse_id, migration 0118) — never a single DO-header default. A KL SO
   line must ship from KL stock even if the DO header (or the default) points at
   PG; stock never crosses warehouses (CLAUDE.md locked rule).

   Resolution order per DO line:
     1. the linked SO line's warehouse_id (so_item_id → mfg_sales_order_items)
     2. the DO header's warehouse_id (ad-hoc lines with no so_item_id)
     3. the DO's OWN company's default warehouse (last-resort fallback)

   Returns a map of delivery_order_items.id → warehouse_id (or null when even
   the fallbacks are absent — the caller skips those lines so a wrong warehouse
   is never guessed).

   The `id` field is only a correlation key, so this also serves lines that do
   not exist yet: the pre-flight stock check passes synthetic ids and the request
   body's soItemId, and gets back exactly the warehouses the OUT will use. */
export async function resolveDoLineWarehouses(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- unchanged from delivery-orders-mfg.ts: the PostgREST-shaped client has no honest type until schema.pg.ts covers the SCM tables.
  sb: any,
  items: Array<{ id: string; so_item_id?: string | null }>,
  headerWarehouseId: string | null,
  /* The DO's company (2026-08-03) — step 3 is per company. It used to be a
     company-blind draw across every company's is_default warehouses, decided by
     alphabetical `code` order. */
  companyId: number | undefined,
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const soItemIds = [...new Set(items
    .map((it) => it.so_item_id ?? null)
    .filter((x): x is string => !!x))];
  const soWh = new Map<string, string | null>();
  if (soItemIds.length > 0) {
    const { data: soRows } = await sb.from('mfg_sales_order_items')
      .select('id, warehouse_id').in('id', soItemIds);
    for (const r of (soRows ?? []) as Array<{ id: string; warehouse_id: string | null }>) {
      soWh.set(r.id, r.warehouse_id ?? null);
    }
  }
  const fallback = headerWarehouseId ?? (await defaultWarehouseId(sb, companyId));
  for (const it of items) {
    const fromSo = it.so_item_id ? (soWh.get(it.so_item_id) ?? null) : null;
    out.set(it.id, fromSo ?? fallback);
  }
  return out;
}
