# Runbook: migrated sales orders are read-only — and the one switch that opens them

Owner, 2026-09-08, asked whether Sales Orders could be opened to staff now and
tallied later:

> **只开新单，旧单暂时不能改**

**New sales orders: open. Migrated sales orders: read-only, for now.** This
document is that sentence as an operational control. It is ONE row in ONE table,
it takes effect within 30 seconds, and it needs no deploy.

> **The one switch, if you read nothing else.** When collections are corrected:
>
> ```sql
> UPDATE scm.app_config SET value = 'off', updated_at = now()
>  WHERE key = 'scm.migrated_so_lock';
> ```
>
> Migrated orders become editable within 30 seconds. Nothing else has to change,
> and no code ships. Section 6 is how to put it back.

---

## 1. This is NOT the write freeze — they stack

Two switches, two questions, answered in this order:

| Row | Question it answers | Runbook |
|---|---|---|
| `scm.write_freeze` | May this COMPANY save in this MODULE at all? | `docs/write-freeze-staged-lift.md` |
| `scm.migrated_so_lock` | Given that it may, may it save THIS DOCUMENT? | this file |

The freeze is the coarse one and it runs first (`scm.use('/*', ...)`, ahead of
every sub-router). The migrated lock runs inside the sales-order router only.
So:

- Freeze ON for sales orders → nothing saves, and staff see the freeze sentence.
  This lock never gets a chance to speak.
- Freeze LIFTED for sales orders + this lock ON → **the state the owner asked
  for**: new orders save, migrated ones refuse with their own sentence.
- Both off → everything saves. That is the end of the cutover.

**Opening sales orders is therefore two runs, and the order matters.** Confirm
this lock is in place (section 4) BEFORE lifting `scm.sales.orders` out of the
freeze. Lifting first, even for a minute, is exactly the window this exists to
close.

---

## 2. What a migrated order is, and why it is different

A MIGRATED sales order is one the 2026-08 cutover carried across from AutoCount.
It is identified by `scm.mfg_sales_orders.linked_ac_docno` — the origin AutoCount
document number, written by `import-ac-outstanding-so.mjs`, and **NULL for every
order the ERP created itself**. Nothing was stamped on those rows to mark them:
the owner's rule is that adding a marker IS a change to the migrated data
(「你换不一样就代表我们的数据从 autocount 搬过来的就不一样了啊」), so the gate
reads the column the import already wrote.

Two risks, both live, neither of which touches a new order:

1. **`sync-ac-delta` will run again**, and it can overwrite a staff edit with no
   signal at all. Its input set is the migrated documents.
2. **Payments taken in AutoCount since 2026-08-28 have never reached the ERP**,
   and there is no automatic path. The 5-minute cron pull does carry AutoCount's
   outstanding balance in — into `public.sales_orders.balance`, a column with
   **zero readers**. So the balance a salesperson sees on a migrated order is
   wrong, and they would chase a customer who has already paid.

**Risk 2 is the one that lifts this lock.** When collections are corrected, run
the statement at the top of this file.

---

## 3. The grammar

```
value  :=  off | all | <company ids>
```

| Value | Meaning |
|---|---|
| `off`, `0`, `false`, empty | Migrated orders are editable. Nothing is locked. |
| `1` | **Today.** Company 1 (Houzs Century): migrated orders read-only. |
| `1,2` | Both companies. |
| `all`, `true` | Every company. |

Whitespace and case do not matter; a trailing comma is fine; duplicates collapse.

**There is no `-` clause.** That is the write-freeze row's grammar, and
`docs/write-freeze-staged-lift.md` records the two rows being confused. A value
carrying a `-` here is treated as **malformed**, not as "on" — see below.

### What a malformed value does

| What you typed | What happens | Why |
|---|---|---|
| `1 - scm.sales.orders` (a freeze value pasted in) | **Every company's migrated orders lock.** The value reports as malformed. | Reading it as "on" would be right by accident. Refusing to read it is right on purpose, and you can see the mistake. |
| `houzs`, `company 1`, `1;2`, `1.5`, `on` | Same — locks all, reports malformed. | We cannot tell who to lock. Over-locking is loud, visible in seconds, and undone by one UPDATE. Silently opening is invisible. |
| Empty, or the row is missing | **Open.** | An absent row parses as `off`. Note this is NOT the seeded default — see the next section. |

**The rule in one line: a value nobody can parse LOCKS. A typo can never open.**

Two things deliberately do NOT fail closed:

- **An unreachable `app_config`** (Supabase blip) fails **open**, exactly as the
  write freeze does. A database outage must not stop the shop floor, and the
  migrated documents still have the freeze underneath them.
- **A document whose `linked_ac_docno` could not be READ** fails **CLOSED** — the
  opposite answer, and deliberately. "Not migrated" is the permissive answer, so
  a read that could not run must not be able to look like it. That is the
  position `scm/lib/so-is-migrated.ts` already takes, for the same reason.

### Why the row is seeded ON

Migration `20260908T0014_scm_migrated_so_lock.sql` seeds `'1'`, which is the
opposite of what 0272 did for the write freeze ("turning the freeze on is an
explicit act, never a side effect of running a migration"). The difference is
worth stating because it otherwise reads as a broken rule.

The freeze's default state protects nothing. This one's default state is the
owner's ruling. The very next operational step after this ships is to lift
`scm.sales.orders` out of the freeze — and at that instant every migrated order
becomes editable unless this row is already in place. A row seeded `off` would be
a row that opens the exact documents he just ruled shut, at the moment nobody is
reading this file. So it is seeded to the state he ruled, and turning it OFF is
the explicit act.

---

## 4. Reading the current state — do this before and after every change

```sql
SELECT value, description, updated_at
  FROM scm.app_config WHERE key = 'scm.migrated_so_lock';
```

Without a database: the write-freeze status surfaces do NOT report this key.
The observable check is the one that matters anyway — **have one ordinary member
of staff open one migrated order** (`HC-…`) and confirm the orange *"View only —
carried over from AutoCount"* banner is there and Edit is greyed. Not an
`scm.admin` account: those bypass the lock and would have succeeded either way.

Then check the other half in the same minute: **have them create a new sales
order end to end.** A lock that also stopped new orders is the failure this whole
design exists to avoid, and it is one click to disprove.

---

## 5. What staff see

**On a migrated order** — an orange banner at the top of the detail page (desktop
and mobile), the Edit button greyed with the same sentence as its tooltip, the
payments card read-only, and the list's right-click menu reduced to **Open** and
**Print**. The sentence, unless an operator has typed one into
`scm.app_config.description`:

> This order came from AutoCount and is view-only for now: its payments are still
> being reconciled, so an edit could be overwritten. New orders save normally.
> Ask IT if it must change today.

**If a write reaches the API anyway** (a stale tab, a deep link, the mobile
form's raw fetches) the server answers `409 so_migrated_readonly` and the client
renders a curated sentence — never the generic "refresh and check", which on a
migrated order is advice that loops.

**On a new order** — nothing changes at all. No banner, no greying, every button
where it was.

**An operator sentence must stay under 200 characters.** Both clients discard a
longer one and fall back to their generic line. The cap is enforced in
`migratedSoLockMessage`, so an over-long `description` degrades to the default
above rather than to an outage sentence.

---

## 6. Putting it back

**Lock migrated orders again** (undo an unlock):

```sql
UPDATE scm.app_config SET value = '1', updated_at = now()
 WHERE key = 'scm.migrated_so_lock';
```

**Lock both companies:** `value = 'all'`.

**If something is wrong and you are not sure what:** set `value = '1'`. That is
the known-good state this document was written against.

Note that the write freeze is still underneath. Re-freezing sales orders
(`scm.write_freeze = '1'`) stops every sales-order write for company 1 whatever
this row says, and is the bigger hammer if the floor has to stop.

---

## 7. Traps

- **`scm.write_freeze`, `scm.autocount_writeback` and `scm.migrated_so_lock` are
  three neighbouring rows in one table with similar grammars.** Check the key you
  are editing. This row refuses a value carrying a `-` rather than reading it as
  "on", but do not rely on that.
- **`*` and `scm.admin` bypass it.** Eight accounts hold one of those, two of
  them through a god-tier POSITION rather than a role grant, so a permissions
  query alone will not list them. Testing with one proves nothing.
- **The 30s cache is per isolate.** Different staff can briefly see different
  behaviour. Wait it out before concluding a change failed.
- **It guards TWO prefixes, and `POST /` (create) on neither.** A brand-new
  order carries no document in its path, so it never reaches the lookup — that
  is 「只开新单」 in one line of control flow, and it is the point.

  > **CORRECTED 2026-09-08 (`docs/bugs/0688-an-amendment-already-open-on-a-migrated-sales-order-could-st.md`).**
  > This bullet used to end: *"`/so-amendments/:id/*` is NOT gated by the
  > middleware either… An amendment already open on a migrated order when this
  > shipped can still be approved. If that matters, find them before lifting the
  > freeze."* **That hole is CLOSED.**
  > `scm.use("/so-amendments/*", migratedSoAmendmentReadonly())` applies the same
  > rule on the amendment prefix — same 409, same bypass cohort, same switch —
  > because `approve-so` is not a status flip: it runs `applySoAmendment`, which
  > rewrites the bound order's header and its lines. Writing a hole down is not
  > closing it, and the freeze lift that makes it reachable is the very next
  > operational step.
- **Reads were never affected** and never will be by this switch.

---

## 8. Where the code is

| What | File |
|---|---|
| The decision, the grammar, the sentence | `backend/src/scm/lib/migrated-so-lock.ts` |
| The two middlewares + the ONE shared state function | `backend/src/scm/lib/migrated-so-readonly.ts` |
| Mount points — BOTH prefixes | `backend/src/scm/index.ts` (`scm.use("/mfg-sales-orders/*", migratedSoReadonly())` and `scm.use("/so-amendments/*", migratedSoAmendmentReadonly())`) |
| How many amendments are open on a migrated order right now | `backend/scripts/check-migrated-so-amendments.mjs` — Actions -> *Migrated-SO open amendments — status (read-only)* |
| Did new orders start saving, and did anything touch a migrated one | `backend/scripts/check-so-open-for-new.mjs` — Actions -> *Sales orders open for NEW — status (read-only)* |
| Is this order migrated? | `backend/src/scm/lib/so-is-migrated.ts` |
| The switch's row | `backend/src/db/migrations-pg/20260908T0014_scm_migrated_so_lock.sql` |
| Shared frontend gate | `frontend/src/vendor/scm/lib/so-detail-gates.ts` (`migratedReadonly`) |
| Curated refusal sentence | `frontend/src/vendor/scm/lib/authed-fetch.ts` (`so_migrated_readonly`) |
| Grammar + decision tests | `backend/tests/migratedSoLock.test.ts` |
| Both guards in the production mount shape | `backend/tests/migratedSoReadonlyMiddleware.test.ts` |
| All-four-surfaces wiring test | `frontend/src/vendor/scm/lib/so-detail-gates.migrated.test.ts` |
| Module guide | `docs/modules/sales-order.md` |

---

## 9. Every other door onto a migrated order, and why it is open

Two routers WRITE a sales-order document and both are now guarded. Several
others write a COLUMN on one, and they are deliberately left alone — a
migrated order still has to be delivered, and 2,877 of them are outstanding.
Blocking those would stop the shop floor doing the one thing the cutover exists
to let it do.

The population was enumerated, not reasoned about. Eleven files in
`backend/src` hold a write statement against `mfg_sales_orders`,
`mfg_sales_order_items`, `mfg_sales_order_payments` or `so_amendments`; the
command that lists them is in the PR body for `docs/bugs/0688-…` and is
re-run by CI. What each one is:

| Door | Prefix | Guarded? | Why |
|---|---|---|---|
| Sales Order writes, incl. `PATCH /:docNo/hold` and `POST /:docNo/amendments` | `/mfg-sales-orders/*` | **YES** | the document itself |
| Amendment gates — supplier-confirm, approve-so, approve-po, send, reject, withdraw | `/so-amendments/*` | **YES** (2026-09-08) | `approve-so` rewrites the order's header and lines |
| Salesperson handover (`salesperson_id`, `agent`) | `/so-handover/*` | no | attribution, not the order's content or money; a manager action on resignation/transfer, gated by `scm.so.attribute_other`. **A judgement call, not an oversight** — if the owner wants it shut, it is one more `scm.use` line |
| Delivery scheduling (`amended_delivery_date`, `delivery_state`) | `/delivery-planning/*` | no | the delivery module's own flow. Shutting it would stop migrated orders being delivered |
| Delivery order / return / revert — line delivered quantities, status | `/delivery-orders-mfg/*`, `/delivery-returns/*` | no | same reason. `so-delivery-sync.ts`, `so-generation.ts` |
| `po_qty_picked` recount on SO lines | `/mfg-purchase-orders/*` | no | a DERIVED counter driven by PO activity, not a staff edit (`recomputeSoPicked`) |
| Stock allocation recompute (`stock_status`) | many + cron | no | derived from stock, never typed by anyone |
| Scan-to-SO intake, incl. its payment rows | `/scan-so/*` | no | it books only against an order it just CREATED — `docNo` comes from `createDraftSalesOrder`'s 201 (`scan-so.ts:4098`), so it can never reach a migrated one |
| 2990 mirror ingest | `/so-mirror/*` | no | writes company 2990's rows; the lock names company 1 |

**If this list is ever re-checked, check it the same way** — run the
enumeration, then read each member. The first version of this lock was written
by reasoning about which router mattered, and it got the count right and the
population wrong.
