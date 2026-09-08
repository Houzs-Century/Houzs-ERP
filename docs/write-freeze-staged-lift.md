# Runbook: the SCM write freeze, and lifting it module by module

The write freeze is the switch between "staff cannot save" and "staff can save".
It is one row in one table, it takes effect within 30 seconds, and it needs no
deploy.

> **Rollback, if you read nothing else.** One statement puts the row back to
> what production holds TODAY — product setup open, everything else shut:
>
> ```sql
> UPDATE scm.app_config SET value = '1 - scm.procurement.products', updated_at = now()
>  WHERE key = 'scm.write_freeze';
> ```
>
> Or, without a database: Actions -> **SCM write freeze (on/off)** -> Run
> workflow -> `target=prod`, `state=on`, `companies=1`,
> `areas=scm.procurement.products`. Either way it is in force inside 30 seconds.
>
> **Do not type a bare `'1'` here unless you mean it.** That is the *original*
> state, and it also shuts product setup — which has been open since
> 2026-09-02. `areas` is CUMULATIVE, never a delta; §6a is the worked case.
> Section 7 has the rest, including the bigger hammers.

---

## 1. What it does today

`scm.app_config` key `scm.write_freeze` holds the text
**`1 - scm.procurement.products`**.

Measured on production 2026-09-08 at 10:31 MYT — Actions -> *SCM write freeze —
status (read-only)*, run `34180338466`. The row was last written 2026-09-02 at
11:52 MYT. **Re-run that workflow rather than believing this paragraph**: it
said the row held a bare `1` for six days after somebody opened product setup,
which is exactly the stale-fact failure CLAUDE.md warns about.

| | |
|---|---|
| Frozen | Company 1 (Houzs) — **23 of the 24 areas** |
| Already reopened | `scm.procurement.products` (product setup) — 1 area |
| Not frozen | Company 2 (2990) — trades completely normally |
| Still allowed for everyone | Every read. GET / HEAD / OPTIONS are never refused |
| Bypass | Anyone holding `*` or `scm.admin`. Measured 2026-09-08: **6 of 78 active people hold `*`; no role grants `scm.admin` at all** (Actions -> *Role permissions diag (read-only)*, run `34180958897`) |

Enforced by `backend/src/scm/lib/write-freeze.ts`, mounted at
`scm.use('/*', scmWriteFreeze())` ahead of every SCM sub-router, so it covers
the whole `/api/scm/*` surface in one place.

A refused write returns **503** with:

```
Saving is paused while the AutoCount data is brought across. Nothing is broken
and retrying will not help. Editing reopens after the cutover — ask IT if
something must change today.
```

---

## 2. The grammar

```
value  :=  off | <companies> [ - <areas> ]

off        'off' | '0' | 'false' | empty | row absent        -> nobody is frozen
companies  'all' | 'true' | comma-separated company ids      -> who is frozen
areas      comma-separated L2 area keys                      -> who is LET BACK IN
```

The `-` reads as **minus**: *freeze company 1, minus sales orders.*

Whitespace anywhere is fine, case does not matter, a trailing comma is fine, and
the `scm.` prefix on an area may be left off. All of these are the same value:

```
1 - scm.sales.orders, scm.procurement.po
1-scm.sales.orders,scm.procurement.po
  1  -  SCM.Sales.Orders , procurement.po ,
```

Worked examples:

| Value | Meaning |
|---|---|
| `off` | Everyone can save. |
| `1` | **Today.** Houzs frozen everywhere; 2990 normal. |
| `all` | Both companies frozen everywhere. |
| `1 - scm.sales.orders` | Houzs frozen EXCEPT sales orders. |
| `1 - scm.sales.orders, scm.procurement.po` | Houzs frozen except sales orders and purchase orders. |
| `1,2 - scm.sales.orders` | Both companies frozen except sales orders, for both. |
| `all - scm.sales.orders` | Everyone frozen except sales orders. |

**An exception only applies to companies the value actually freezes.** `1 -
scm.sales.orders` says nothing at all about company 2, which was never frozen.

---

## 3. What a malformed value does

This is the part to be sure of before typing into a production row.

| What you typed | What happens | Why |
|---|---|---|
| Company part unreadable — `houzs`, `company 1`, `1;2`, `1.5` | **Every company is frozen.** | We cannot tell who to freeze. Freezing too much is loud, is visible within 30s, and section 7 undoes it. Silently opening would be invisible, and would let back in exactly the drift the freeze exists to stop. |
| Area name wrong — `1 - scm.sales.order` | **Company 1 stays frozen, nothing is lifted.** The bad token is reported. | A typo must never open anything. It costs you a lift that did not happen, which you can see. |
| Good area next to a bad one — `1 - scm.sales.orders, scm.sales.nonsense` | Sales orders lifts. The nonsense does not. | Same rule, per token. |
| Extra dash — `1 -- scm.sales.orders` | Company 1 frozen, nothing lifted. | The company part still reads fine, so this does not escalate to freezing 2990 as well. Nothing opens either way. |
| Empty, whitespace, or the row is missing | **Open.** | Migration 0272 seeds `off`; every fresh environment reads empty. This is the default state, not a typo. |

**The rule in one line: a value nobody can parse freezes. A typo can never
open.**

Two things deliberately do NOT fail closed:

- **An unreachable `app_config`** (Supabase down, PostgREST blip) fails **open**.
  A database outage must not take the SCM write surface down for both companies.
  That is a different fault from a typed instruction we cannot read.
- **`off` and an absent row** stay open, as above.

You should rarely see any of this, because **the workflow validates before it
writes**: a bad area name fails the job with a "did you mean", and the row is
left untouched.

---

## 4. The modules you can lift

The keys are the same L2 areas the route guards already use
(`backend/src/scm/lib/scm-areas.ts`, pinned to `scm/index.ts` by
`backend/tests/writeFreezeAreas.test.ts`).

**Lifting an area opens EVERY router mapped to it.** Check this column before
you lift — this is the part that surprises people.

| Area key | Staff call it | Opens |
|---|---|---|
| `scm.sales.orders` | sales orders | `/mfg-sales-orders`, `/so-amendments`, `/quotes`, `/pwp-codes`, `/scan-so`, `/scan-payment`, `/slips` |
| `scm.procurement.po` | purchase orders | `/mfg-purchase-orders`, `/po-amendments` |
| `scm.procurement.grn` | goods receipts | `/grns` |
| `scm.procurement.pi` | purchase invoices | `/purchase-invoices` |
| `scm.procurement.pr` | purchase returns | `/purchase-returns` |
| `scm.procurement.mrp` | MRP | `/mrp`, `/mrp-lead-times` |
| `scm.procurement.suppliers` | suppliers | `/suppliers` |
| `scm.procurement.products` | product setup | `/products`, `/admin/categories`, `/mfg-products`, `/product-models`, `/fabric-library`, `/fabric-tracking`, `/sofa-combos`, `/sofa-quick-picks`, `/special-addons`, `/addons`, `/pwp-rules`, `/delivery-fees`, `/fabric-tier-addon`, `/pos-pools`, `/maintenance-config`, `/maintenance-push`, `/so-settings`, `/free-item-campaigns`, `/model-free-gifts`, `/so-dropdown-options`, `/venues` |
| `scm.sales.delivery` | delivery orders | `/delivery-orders-mfg` |
| `scm.sales.invoices` | sales invoices | `/sales-invoices` |
| `scm.sales.returns` | delivery returns | `/delivery-returns` |
| `scm.warehouse.inventory` | inventory | `/inventory`, `/warehouse` |
| `scm.warehouse.adjustments` | stock adjustments | `/inventory/adjustments` |
| `scm.warehouse.transfers` | stock transfers | `/stock-transfers` |
| `scm.warehouse.stock_take` | stock takes | `/stock-takes` |
| `scm.finance.accounting` | accounting | `/accounting`, `/payment-vouchers`, `/payment-audit-log` |
| `scm.finance.outstanding` | outstanding balances | `/outstanding`, `/unbilled-deliveries` |
| `scm.consignment.orders` | consignment orders | `/consignment-orders` |
| `scm.consignment.notes` | consignment notes | `/consignment-notes` |
| `scm.consignment.returns` | consignment returns | `/consignment-returns` |
| `scm.consignment.po_orders` | consignment purchase orders | `/purchase-consignment-orders` |
| `scm.consignment.po_receives` | consignment receives | `/purchase-consignment-receives` |
| `scm.consignment.po_returns` | consignment purchase returns | `/purchase-consignment-returns` |
| `scm.transportation.drivers` | delivery planning | `/drivers`, `/trips`, `/dp-orders`, `/delivery-planning`, `/delivery-planning-regions`, `/delivery-residence-rules`, `/delivery-zones`, `/delivery-rate-cards`, `/delivery-messages`, `/driver-leave`, `/lorries`, `/lorry-capacity`, `/lorry-service-records`, `/threepl-companies`, `/helpers`, `/scan-lorry-invoice` |

### What CANNOT be lifted on its own

These routers sit on the coarse `scm.access` umbrella with no L2 key, so no
exception can name them. **They stay frozen until the company itself is
unfrozen.** Several of them accept writes:

`/hr` (12 write endpoints), `/categories` (6), `/localities` (3),
`/currencies` (2), `/personal-quick-picks` (2), `/state-warehouse-mappings` (2),
`/staff` (1), `/pos-cart` (1), `/sales-analysis` (1).
Read-only anyway: `/reports`, `/document-flow`, `/entity-audit-log`,
`/fabric-colours`, `/po-so-coverage`, `/ar`.

If a lifted module turns out to need one of these to save, the answer is to
finish the lift for the whole company (`off`), not to widen the grammar in a
hurry.

---

## 5. Reading the current state — do this before and after every change

**Option A — the workflow (no session needed).**
Actions -> **SCM write freeze — status (read-only)** -> Run workflow ->
`target=prod`. One SELECT; it cannot change anything. The answer appears as run
annotations: the raw value, what it means in English, which areas are paused,
which have reopened, and a loud warning if the stored value is unparseable.

**Option B — the endpoint.**

```
GET /api/scm/write-freeze
```

Requires `*` or `scm.admin` (the same people who can bypass the freeze).
Returns the row read **fresh**, not from the 30s cache, plus a one-line
`summary`, the areas currently open, any `unresolvedTokens` your last edit left
behind, the full `liftable` list, and `neverLiftable`.

**Option C — SQL.**

```sql
SELECT value, description, updated_at
  FROM scm.app_config WHERE key = 'scm.write_freeze';
```

---

## 6. The staged lift

Each stage is one workflow run. **Verify after each one before starting the
next**, and do not run two stages back to back without watching the floor in
between — the whole reason for staging is to find out that a module is broken
while only that module is open.

Actions -> **SCM write freeze (on/off)** -> Run workflow:

- `target` = `prod`
- `state` = `on` (the freeze stays ON — you are naming exceptions to it)
- `companies` = `1`
- `areas` = the cumulative list for the stage
- `message` = optional; overrides the sentence staff see

> `areas` is **cumulative**. It is the complete list of what is open, not a
> delta. Stage 3 must repeat stages 1 and 2, or they close again.

| Stage | `areas` | Opens |
|---|---|---|
| 0 | *(blank)* | Nothing. Today's state. |
| 1 | `scm.sales.orders` | Sales orders + amendments, quotes, scan/slip intake |
| 2 | `scm.sales.orders,scm.procurement.po` | ...and purchase orders + PO amendments |
| 3 | `scm.sales.orders,scm.procurement.po,scm.procurement.grn` | ...and goods receipts |
| 4 | `scm.sales.orders,scm.procurement.po,scm.procurement.grn,scm.sales.delivery` | ...and delivery orders |
| 5 | `...,scm.procurement.pi,scm.sales.invoices` | ...and both invoice modules |
| 6 | — set `state` = `off` | Everything. The freeze is over. |

The equivalent SQL, if you would rather do it directly (stage 2 shown):

```sql
UPDATE scm.app_config
   SET value = '1 - scm.sales.orders, scm.procurement.po', updated_at = now()
 WHERE key = 'scm.write_freeze';
```

And the final release:

```sql
UPDATE scm.app_config SET value = 'off', updated_at = now()
 WHERE key = 'scm.write_freeze';
```

> Doing it in SQL skips the validation the workflow runs. If you type an area
> name wrong here, nothing lifts — check section 5 immediately afterwards.

## 6a. GO-LIVE: opening sales orders — the exact statement, PREPARED, NOT RUN

Owner 2026-09-08: 「只开新单，旧单暂时不能改」. This is the step that actually
opens the door. **Nothing below has been executed** — it is written so the
decision costs seconds when he makes it.

**Do the migrated lock FIRST.** Confirm `scm.migrated_so_lock` is in place
(`docs/migrated-so-lock.md` §4) BEFORE running this. Lifting the freeze first,
even for a minute, is the window that lock exists to close: the instant sales
orders come out of the freeze, every migrated order is editable unless the other
row is already on.

### The statement

```sql
UPDATE scm.app_config
   SET value = '1 - scm.procurement.products, scm.sales.orders', updated_at = now()
 WHERE key = 'scm.write_freeze';
```

Or, without a database: Actions -> **SCM write freeze (on/off)** ->
`target=prod`, `state=on`, `companies=1`,
`areas=scm.procurement.products,scm.sales.orders`.

**`scm.procurement.products` is in that value on purpose.** `areas` is the
complete list of what is open, not a delta. The stage table above starts from a
blank `areas` and its stage-1 row reads `scm.sales.orders` alone — typed against
the row as it stands today, **that would silently close product setup again**,
a lift that takes something away. Both values are pinned as tests in
`backend/tests/writeFreezeScope.test.ts` ("the go-live lift for sales orders"),
including the wrong one, because the difference is invisible in the row and
expensive on the floor.

### What it opens — the whole list, and nothing else

`scm.sales.orders` is not only the Sales Order screen. It is every prefix mapped
to that area key in `backend/src/scm/lib/scm-areas.ts`, and a test pins that
table against the mounts in `scm/index.ts`:

| Prefix | What staff would be able to save |
|---|---|
| `/mfg-sales-orders/*` | Sales Orders — create, edit, confirm, hold, cancel, payments |
| `/so-amendments/*` | the amendment gates — supplier-confirm, approve-so, approve-po, send, reject, withdraw |
| `/so-handover/*` | reassigning a Sales Order's salesperson |
| `/quotes/*` | quotations |
| `/pwp-codes/*` | purchase-with-purchase codes |
| `/scan-so/*`, `/scan-payment/*`, `/slips/*` | the scan / slip intake that creates orders and books their receipts |

**What it does NOT open.** Everything else stays exactly as frozen as it is
today — purchase orders and PO amendments, goods receipts, purchase invoices,
purchase returns, MRP, suppliers, **delivery orders**, sales invoices, delivery
returns, all four consignment areas, inventory, stock adjustments, transfers,
stock takes, accounting, outstanding balances and delivery planning. Twenty-two
areas remain paused, plus every router with no area key at all (`/hr`, `/staff`,
`/reports`, `/document-flow`, `/pos-cart`, … — see `SCM_UNGUARDED_PREFIXES`),
which no exception can name and which stay shut until the company is unfrozen.

And migrated orders stay read-only regardless: that is the OTHER row, and it
does not move.

### Putting it back

```sql
UPDATE scm.app_config SET value = '1 - scm.procurement.products', updated_at = now()
 WHERE key = 'scm.write_freeze';
```

**Effective within 30 seconds** (the middleware's per-isolate cache TTL), no
deploy, no restart, reads never affected. That is the whole cost of changing
your mind. If something is wrong and it is not clear what, `'1'` freezes all of
Houzs — the bigger hammer, at the price of closing product setup with it.

### Did it actually work? — the read-only check

A switch flipped is intention; an order that saved is observation.

Actions -> **Sales orders open for NEW — status (read-only)** ->
`target=prod`, `hours=2`. It prints both switches and then the two facts they
are supposed to produce:

- **NEW orders saved in the window.** Zero after a lift means staff still cannot
  save and the lift did not work.
- **Migrated orders touched by a PERSON in the window.** Non-zero is the alarm —
  read WHO first, because an `*` account bypasses the lock by design. Rows the
  SYSTEM wrote are counted separately and are not an alarm: the stock-allocation
  recompute writes `UPDATE_LINE` / `UPDATE_STATUS` audit rows constantly.

**The pre-lift baseline, so the "after" reading means something.** Measured
2026-09-08 at 11:29 MYT (run `34183368917`):

| | |
|---|---|
| `scm.migrated_so_lock` | `"1"`, written 09:42:14 MYT — the lock IS in place |
| `scm.write_freeze` | `"1 - scm.procurement.products"`, written 2026-09-02 11:52 MYT |
| NEW orders saved by company 1, last 24h | **0** — and **0 ERP-created orders in all** |
| Migrated orders touched by a person, last 24h | **0** (50 rows, all `system (auto-allocate)`) |

That third row is the useful one: **company 1 has never created a sales order in
this ERP.** Every one of its orders came across from AutoCount. So after the
lift, the count going 0 -> 1 is unambiguous — there is no background traffic to
mistake it for.

The fourth row is the closest thing there is to proof that the migrated lock is
holding in production without borrowing somebody's login: nobody has touched a
migrated order in 24 hours, and the only writer that has is the cron.

It cannot save an order for you, and does not pretend to. The step it does not
replace is the runbook's own: **one ordinary member of staff — not an
`scm.admin` account — saves one real new order, and opens one `HC-…` order and
confirms it is view-only.** Measured 2026-09-08, 33 of 78 active people are in
the plain sales cohort and hold no bypass, so such an account exists in
quantity; picking one is the owner's call.

---

## 6b. GO-LIVE: 开 PO、DO、进 SO 和 edit SO — the one statement, PREPARED, NOT RUN

Owner 2026-09-08: 「**他们要开 PO DO 和进 SO 和 edit SO**」 — purchase orders,
delivery orders, creating sales orders AND editing them, migrated ones included.
That is bigger than §6a, and it is **two rows, in this order**.

**Nothing below has been executed.**

### The value, re-measured rather than recalled

Read live 2026-09-08 at **14:11 MYT** (Actions -> *SCM write freeze — status
(read-only)*, run `34193563758`):

```
scm.write_freeze = "1 - scm.procurement.products"      (written 2026-09-02 11:52 MYT)
areas still PAUSED (23) · areas REOPENED (1): scm.procurement.products
```

**Re-run that workflow before you type anything.** This paragraph is a
measurement with a date on it, and §1 of this file records the row being
documented as a bare `1` for six days after somebody opened product setup.

### The three area keys, taken from the ENFORCEMENT code

Not from a table in a doc — `backend/src/scm/lib/scm-areas.ts` is what the
middleware reads, and `backend/tests/writeFreezeAreas.test.ts` pins it against
the mounts in `scm/index.ts`:

| What he calls it | Area key | Mounted prefixes it opens |
|---|---|---|
| 进 SO / edit SO | `scm.sales.orders` | `/mfg-sales-orders`, `/so-amendments`, `/so-handover`, `/quotes`, `/pwp-codes`, `/scan-so`, `/scan-payment`, `/slips` |
| 开 PO | `scm.procurement.po` | `/mfg-purchase-orders`, `/po-amendments` |
| 开 DO | `scm.sales.delivery` | `/delivery-orders-mfg` |

### Step 1 — the freeze

```sql
UPDATE scm.app_config
   SET value = '1 - scm.procurement.products, scm.sales.orders, scm.procurement.po, scm.sales.delivery',
       updated_at = now()
 WHERE key = 'scm.write_freeze';
```

Workflow equivalent: **SCM write freeze (on/off)** -> `target=prod`, `state=on`,
`companies=1`,
`areas=scm.procurement.products,scm.sales.orders,scm.procurement.po,scm.sales.delivery`.

**`scm.procurement.products` is in that value on purpose.** `areas` is the
complete list of what is open, not a delta — leaving it out closes product
setup, which has been open since 2026-09-02.

**Reverse (step 1):**

```sql
UPDATE scm.app_config SET value = '1 - scm.procurement.products', updated_at = now()
 WHERE key = 'scm.write_freeze';
```

### Step 2 — the migrated-order lock, and ONLY after the sync guard is live

```sql
UPDATE scm.app_config SET value = 'off', updated_at = now()
 WHERE key = 'scm.migrated_so_lock';
```

**Reverse (step 2):**

```sql
UPDATE scm.app_config SET value = '1', updated_at = now()
 WHERE key = 'scm.migrated_so_lock';
```

Step 2 is what makes MIGRATED orders editable. Its precondition is
`docs/migrated-so-lock.md` §2a — the sync must be unable to overwrite a person's
edit before a person is invited to make one. Doing step 2 first, even for a
minute, is the window both rows exist to close.

### What that leaves shut — counted, not estimated

Twenty-four area keys exist (`SCM_AREAS`, derived from `SCM_AREA_MOUNTS`).
Four would be open, so **20 of 24 remain paused**:

`scm.procurement.grn`, `scm.procurement.pi`, `scm.procurement.pr`,
`scm.procurement.mrp`, `scm.procurement.suppliers`, `scm.sales.invoices`,
`scm.sales.returns`, `scm.warehouse.inventory`, `scm.warehouse.adjustments`,
`scm.warehouse.transfers`, `scm.warehouse.stock_take`,
`scm.finance.accounting`, `scm.finance.outstanding`,
`scm.transportation.drivers`, and all six consignment areas
(`orders`, `notes`, `returns`, `po_orders`, `po_receives`, `po_returns`).

Plus every router with no area key at all (`SCM_UNGUARDED_PREFIXES` — `/hr`,
`/staff`, `/localities`, `/currencies`, `/categories`,
`/state-warehouse-mappings`, `/pos-cart`, `/personal-quick-picks`,
`/sales-analysis` and the read-only ones), which no exception can name.

**Goods receipts are NOT in the list, and that is worth saying out loud.**
Opening `scm.sales.delivery` lets staff raise a delivery order; it does not let
them receive goods (`scm.procurement.grn`) or invoice
(`scm.procurement.pi`, `scm.sales.invoices`). If the floor needs the whole
PO -> GR -> PI chain, that is stage 5 of §6, not this step.

### How many write endpoints each of those opens — enumerated

From the committed route inventory `docs/generated/route-capability-matrix.csv`
(1,217 routes, gated in CI by `npm --prefix backend run audit:routes`), mapped
through `SCM_AREA_MOUNTS`:

| Area | write endpoints it opens |
|---|---|
| `scm.sales.orders` | **43** — `/mfg-sales-orders` 21, `/so-amendments` 6, `/scan-so` 6, `/quotes` 3, `/slips` 3, `/pwp-codes` 2, `/scan-payment` 1, `/so-handover` 1 |
| `scm.procurement.po` | **21** — `/mfg-purchase-orders` 17, `/po-amendments` 4 |
| `scm.sales.delivery` | **11** — `/delivery-orders-mfg` 11 |

**The migrated-order lock covers 27 of those 43**, not all of them: it is mounted
at `/mfg-sales-orders/*` and `/so-amendments/*` only
(`backend/src/scm/index.ts:327` and `:346`). See `docs/migrated-so-lock.md` §5a
for the sixteen that are outside it and which of them can touch a migrated
document.

---

### Verifying a lift took effect

1. **Wait 30 seconds.** The middleware caches the value for that long, per
   isolate. A lift that "did not work" has almost always just not expired yet.
2. **Read the state** (section 5). Confirm `openAreas` lists what you intended
   and `unresolvedTokens` is empty.
3. **Have one ordinary member of staff save one real record** in the module you
   just opened — not an `scm.admin` account, which bypasses the freeze and would
   have succeeded either way. This is the only step that actually proves it.
4. **Check a module you did NOT open still refuses.** If everything suddenly
   saves, the value is `off` when you meant it to be a lift — go to section 7.
5. Staff in a still-frozen module now see that module named:
   *"Saving purchase orders is still paused... Other areas have reopened."*

---

## 7. Putting it back

**Freeze Houzs completely again** (undo any lift):

```sql
UPDATE scm.app_config SET value = '1', updated_at = now()
 WHERE key = 'scm.write_freeze';
```

Workflow equivalent: `state=on`, `companies=1`, `areas` **blank**.

**Freeze everything, both companies** — the emergency stop, if 2990 has to halt
too:

```sql
UPDATE scm.app_config SET value = 'all', updated_at = now()
 WHERE key = 'scm.write_freeze';
```

**Release everything** — go-live is done:

```sql
UPDATE scm.app_config SET value = 'off', updated_at = now()
 WHERE key = 'scm.write_freeze';
```

In every case: effective within 30 seconds, no deploy, and reads were never
affected. Confirm with section 5.

### If something is wrong and you are not sure what

Set `value = '1'`. That is the known-good state this document was written
against. Then read section 5 and work out what happened.

---

## 8. Traps

- **Nothing here stops `scm.admin` or `*`.** Eight accounts hold one of those,
  including two whose wildcard comes from a god-tier POSITION (Super Admin /
  Owner) rather than a role grant, so a permissions-table query alone will not
  list them. Testing a lift with one of those accounts proves nothing.
- **`areas` is cumulative, not a delta.** See section 6.
- **The freeze only guards `/api/scm/*`.** Writes to other parts of the ERP
  (projects, PMS, HR outside SCM) were never in scope.
- **Reads were never frozen** and never will be by this switch.
- **THERE IS A SECOND SWITCH ON SALES ORDERS, and lifting this one alone is not
  what the owner asked for.** `scm.migrated_so_lock` (2026-09-08,
  「只开新单，旧单暂时不能改」) keeps the documents carried over from
  AutoCount read-only after `scm.sales.orders` is lifted here. **Confirm it is in
  place BEFORE running stage 1** — lifting the freeze first, even for a minute,
  opens every migrated order onto a balance the ERP knows is wrong. Runbook:
  `docs/migrated-so-lock.md`.
- **`scm.write_freeze`, `scm.autocount_writeback` and `scm.migrated_so_lock` are
  neighbouring rows in the same table with similar grammars.** Pasting one into
  the other is a real mistake to make. The write-back flag now refuses any value carrying a `-`
  clause rather than reading it as "on" — but do not rely on that; check the key
  you are editing.
- **The 30s cache is per isolate.** Different staff can briefly see different
  behaviour during the window. Wait it out before concluding a lift failed.
- **Lifting `scm.procurement.products` is broad** — 21 routers, including the
  fabric library and every picklist. It is the largest single lift on the list.

---

## 9. Where the code is

| What | File |
|---|---|
| The middleware, the grammar, the message | `backend/src/scm/lib/write-freeze.ts` |
| Path -> area mapping (mirror of the guards) | `backend/src/scm/lib/scm-areas.ts` |
| Status endpoint | `backend/src/scm/routes/write-freeze-status.ts` |
| Mount point | `backend/src/scm/index.ts` |
| Set the value | `backend/scripts/set-write-freeze.mjs` + `.github/workflows/set-write-freeze.yml` |
| Read the value | `backend/scripts/check-write-freeze.mjs` + `.github/workflows/check-write-freeze.yml` |
| Shared validation for both scripts | `backend/scripts/lib/scm-area-keys.mjs` |
| The table | `backend/src/db/migrations-pg/0272_scm_app_config.sql` |
| Grammar + decision tests | `backend/tests/writeFreezeScope.test.ts` |
| Area mapping / drift tests | `backend/tests/writeFreezeAreas.test.ts` |
| Middleware behaviour tests | `backend/tests/writeFreezeMiddleware.test.ts` |
| Message tests | `backend/src/scm/lib/write-freeze.test.ts` |
