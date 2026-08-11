# Module: Quote (SCM)

A saved POS cart, priced and named to a customer, that has **not** become an
order yet. The only pre-sale document in the SCM surface.

> Convention: money is in **sen** (integer cents) end-to-end. Dates are stored
> UTC, displayed DD/MM/YYYY. All reads/writes go through `/api/scm/*`.

Written 2026-08-11 to close the gap CLAUDE.md names — the module lost its delete
and gained a cancel that day, and had no guide. Read this before changing the
module; if your change alters its SURFACE, update this file in the same PR.

---

## 1. What it is for

A salesperson prices a cart for a customer and saves it so it can be recalled,
edited, and eventually turned into a Sales Order. Ported from 2990's
`apps/api/src/routes/quotes.ts` (#386).

"**Open**" means not yet promoted **and** not cancelled:
`promoted_to_order_id IS NULL AND cancelled_at IS NULL`. (Before mig 0278 it
meant only the first half — see §4.)

A quote **never reaches AutoCount**. It is pre-sale; nothing syncs until it
becomes an SO.

---

## 2. Surfaces — there are none yet

**No desktop page, no mobile screen, no query hook.** Nothing in
`frontend/src` calls `/api/scm/quotes`. The module is an API-only port waiting
for the POS UI that will consume it.

That is worth knowing for two reasons: a change here breaks no screen today, and
whatever screen arrives will be the first real test of these endpoints.

---

## 3. API surface

Mounted in `backend/src/scm/index.ts`, under the POS block ported from 2990:

```
scm.use("/quotes/*", scmAreaGuard("scm.sales.orders", { writeLevel: "view" }));
scm.route("/quotes", quotes);
```

Note `writeLevel: "view"` — the area gate lets anyone with **view** on
`scm.sales.orders` write here, not just those with write. That is deliberate for
a pre-sale cart (a salesperson who can see orders may save a quote), and it is
also why the row-level scoping in §5 is doing the real work.

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | List open quotes — company- AND row-scoped (§5) |
| POST | `/` | Save the current cart as a quote |
| PATCH | `/:id` | Update an OPEN quote's cart in place |
| PATCH | `/:id/cancel` | Retire a quote (§4) |

Handler file: `backend/src/scm/routes/quotes.ts` (~300 lines — small enough to
read whole).

`POST /` mints the id server-side as `QU-XXXXXXXX` (TEXT PK, no DB default,
mirroring 2990). It refuses on an unresolved company with 409
`company_unresolved`, because `company_id` is `NOT NULL` with no default and the
insert would otherwise 500 during a Hyperdrive cold start.

`PATCH /:id` deliberately updates the **cart only** — customer name and phone
are left alone. It refuses a promoted or cancelled quote with 404
`not_found_or_converted`.

---

## 4. Cancel — and the delete it replaced

**There is no delete.** `DELETE /quotes/:id` used to hard-purge a quote row. It
was removed 2026-08-11 under the owner's rule **不可以删只可以 cancel**.

Of the three document-level hard deletes found on the SCM route surface, this
was the **least guarded**: no status check, no audit row, no downstream lock. Any
quote in the active company, at any point in its life, could be erased by id —
including one already promoted to a sales order, which would have destroyed the
only record of what the customer was quoted before that order existed.

**Removing it required building the replacement first.** `scm.quotes` (mig 0101)
had **no retirement path at all**:

- no `status` column
- `expires_at` exists but is written by nothing
- `promoted_to_order_id` is set only by a conversion that already happened

Delete *was* the retirement path. So mig **0278** added `cancelled_at` and
`cancelled_by` — the same shape the sibling documents use
(`purchase_consignment_orders.cancelled_at`, `delivery_orders.cancelled_at`) —
and `PATCH /:id/cancel` uses them.

`cancelled_by` is `uuid` with **no FK** to `scm.staff`, matching `created_by`
(mig 0101 precedent): the SCM auth bridge can pin a caller to the seeded
system-staff uuid, so an FK would refuse legitimate writes.

Cancel semantics:

| situation | result |
|---|---|
| open quote | `cancelled_at` + `cancelled_by` stamped, 200 |
| already cancelled | 200, unchanged — idempotent, retry-safe |
| already promoted | 409 `already_converted` — *"Cancel the order, not the quote"* |
| other company | 404 `NOT_THIS_COMPANY` |

Mig 0278 also adds `idx_quotes_open_v2`, the partial index matching the new
two-condition open filter. 0101's `idx_quotes_open` is left in place.

---

## 5. Row-level visibility — the load-bearing part of `created_by`

`GET /` is scoped twice: by company, and by **row**.

`created_by` is the caller's REAL `scm.staff` uuid (via `resolveCallerStaffId`,
the mig-0066 `staff.user_id` link) — **not** `c.get('user').id`, which the SCM
auth bridge pins to one shared system staff row. Before that fix every quote was
stamped "system" and the list could not answer who quoted this customer.

Visibility follows the same rule and the same helper as the sibling sales lists
(SO / DO / SI / DR): a view-all caller (`scm.so.view_all`, or a director position
via `canViewAllSales`) sees everything; everyone else sees SELF plus their full
`manager_id` downline.

Two traps here:

- **Pass the real Houzs integer user id** (`c.get('houzsUser')?.id`) to
  `resolveSalesScopeIds`. Feeding it `user.id` — the pinned system staff uuid —
  is the documented non-admin 500.
- **Rows predating the `created_by` fix carry the pinned system uuid**, whose
  staff row has `user_id` NULL, so no caller's downline contains it and only a
  view-all caller sees them. Deliberately not backfilled: that is a data change,
  not a scoping fix.

2990 enforced this with RLS. The Houzs port runs the service-role client with no
RLS, so the rule had to be re-implemented in the handler — it silently
evaporated on the way over, and every open quote (someone else's customer, phone,
email and priced cart) was readable by anyone with SO view.

---

## 6. Data model

`scm.quotes` (mig 0101, cloned from 2990's `public.quotes`):

| column | note |
|---|---|
| `id` | text PK, `QU-XXXXXXXX`, minted in the route |
| `company_id` | bigint NOT NULL, FK `public.companies` |
| `created_by` | uuid NOT NULL, no FK — load-bearing for visibility (§5) |
| `showroom_id` | uuid, **nullable and unused** — 2990's showroom resolution is POS-staff-specific; `company_id` scoping replaces it. Kept so the wire shape still carries it |
| `customer_name` / `customer_phone` / `customer_email` | phone stored E.164 via `normalizePhone`, so a quote that becomes an SO does not carry a differently-formatted number into it |
| `cart` / `addons` | jsonb |
| `subtotal` / `addon_total` / `total` | integer sen |
| `pricing_version` | text — currently `v1` |
| `expires_at` | timestamptz, **written by nothing today** |
| `promoted_to_order_id` | text, no FK — the route only filters `IS NULL` on it |
| `cancelled_at` / `cancelled_by` | mig 0278 (§4) |

RLS is stripped; the route + area guard + service-role key are the protection.

---

## 7. Traps, collected

- **No UI exists.** Nothing in the frontend calls this router.
- **No delete, by rule.** `PATCH /:id/cancel` is the retirement path.
- **`expires_at` is dead weight** — declared, never written, never filtered.
  Do not build expiry on the assumption it already works.
- **`showroom_id` is permanently NULL** here.
- **`created_by` is not decoration** — it is the row-visibility key. Anything
  that writes a quote must resolve the real staff uuid.
- **Pass `houzsUser.id`, never `user.id`,** to the sales-scope lookup.
- **A promoted quote is not cancellable.** The order is the live document.

## See also

- `docs/hard-delete-inventory.md` — every SCM delete, classified
- `docs/modules/sales-order.md` — what a quote becomes
- `BUG-HISTORY.md` 2026-08-11, "Two more document-level hard deletes"
