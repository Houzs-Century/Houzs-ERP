## A delivery order could take goods off the other company's rack [high]

**Symptom.** Not reported by anyone — found by the 2026-08-21 permission audit,
which was checking whether a write's predicate is really the tenant boundary it
is assumed to be. In business terms: when a delivery order goes out, the system
takes the goods off the physical rack they were sitting on. The rack can be
CHOSEN on the delivery-order line, and nothing checked that the chosen rack
belonged to the same company as the order. A 2990 delivery could empty a Houzs
bay: Houzs's rack map would show goods gone that nobody in Houzs had touched,
and the stock-out record would be filed under 2990, where Houzs cannot see it.

**Root cause (traced).** `backend/src/scm/routes/delivery-orders-mfg.ts`,
`stockOutDoLinesFromRacks`. The helper already RECEIVES the order's `companyId`
— it is a declared parameter — and used it only to STAMP the movement rows:

```ts
const companyCol = companyId != null ? { company_id: companyId } : {};
```

Every rack read and write underneath ran with no company predicate. The rack id
is caller-supplied: it lands in `delivery_order_items.rack_id` straight off the
request body (`:3729` on create, `:5048` on the line PATCH), and the explicit
branch resolved it by id alone:

```ts
const { data } = await sb.from('warehouse_racks')
  .select('id, rack, warehouse_id').eq('id', explicitRackId).limit(1);
```

then walked that rack's placements and deleted or decremented them by row id.
The client is SERVICE-ROLE and mig 0061 enabled RLS with **zero** policies, so
nothing behind the statement re-checks anything — the predicate is the whole
boundary.

Why the existing checker did not see it: `check-company-scope.mjs` acquits a
handler once any scoped call appears in it, and the PATCH handler IS scoped
(`scopeToCompany(sb.from('delivery_orders')…)`). The write happens later, in a
module-level helper, on a different table. Its own header comment states the
danger and then proves only the DO: *"the (itemId, delivery_order_id) pair every
write below keys on is caller-supplied: it proves the two belong together, never
whose they are."*

**Fix.** The same `companyId` is now a FILTER as well as a stamp, on all five
rack statements in the helper — the explicit rack resolve, the warehouse rack
list, the placement read, and the placement delete/decrement. Written as a
`companyFilter()` wrapper because `companyId` is nullable and
`.eq('company_id', null)` is a malformed filter, not "no company". Both columns
are NOT NULL in production (`warehouse_rack_items` mig 0083, `warehouse_racks`
mig 0089), so the filter cannot silently drop a legitimate row.

**Deliberately NOT changed:** the explicit branch still does not require the rack
to be in the LINE'S ship-from warehouse, which the fallback branch does enforce.
That is a question about how operators actually pick racks, so it goes to the
owner rather than being decided here.

Pinned by `backend/tests/doRackStockOutCompanyKey.test.ts`. **Proved RED on the
unfixed tree** — 3 of its 4 assertions failed and it named the caller-steered
resolve at `delivery-orders-mfg.ts:~1388` — and green on the fix.

**Ref.** audit/permission-system, 2026-08-21.
