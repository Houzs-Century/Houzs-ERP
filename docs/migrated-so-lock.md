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
value  :=  off | all | <company ids> | verdict:<company ids> | verdict:all
```

| Value | Meaning |
|---|---|
| `off`, `0`, `false`, empty | Migrated orders are editable. Nothing is locked. |
| `1` | **Today.** Company 1 (Houzs Century): EVERY migrated order read-only. |
| `1,2` | Both companies, same way. |
| `all`, `true` | Every company, same way. |
| **`verdict:1`** | **Company 1, BY CORRECTNESS.** A migrated order is read-only only while the published reconcile verdict says it still DIFFERS from the account book — or while there is no fresh verdict for it. One that matches is fully editable. See §10. |
| `verdict:1,2`, `verdict:all` | The same, over more companies. |

Whitespace and case do not matter; a trailing comma is fine; duplicates collapse.

**There is no `-` clause.** That is the write-freeze row's grammar, and
`docs/write-freeze-staged-lift.md` records the two rows being confused. A value
carrying a `-` here is treated as **malformed**, not as "on" — see below.

### What a malformed value does

| What you typed | What happens | Why |
|---|---|---|
| `1 - scm.sales.orders` (a freeze value pasted in) | **Every company's migrated orders lock.** The value reports as malformed. | Reading it as "on" would be right by accident. Refusing to read it is right on purpose, and you can see the mistake. |
| `houzs`, `company 1`, `1;2`, `1.5`, `on` | Same — locks all, reports malformed. | We cannot tell who to lock. Over-locking is loud, visible in seconds, and undone by one UPDATE. Silently opening is invisible. |
| `verdict:`, `verdict:off`, `verdict:houzs` | **Locks ALL migrated orders, by ORIGIN — not per document.** Reports malformed. | The hardest lock, never the softer one. Per-document IS an opening, so a typo may not reach it. |
| `verdict:1 - scm.sales.orders` | Same as `1 - scm.sales.orders`: locks all, malformed. | The `-` check runs on the part AFTER `verdict:`, so the freeze paste is refused identically in both spellings. |
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
  >
  > **How big was it? Zero documents.** Measured 2026-09-08 at 11:25 MYT
  > (Actions -> *Migrated-SO open amendments — status (read-only)*, run
  > `34183293402`): **0** open amendments on a migrated order, out of **18** open
  > amendments in all, across **2,882** migrated orders of **3,047**. The door
  > was open and nobody was standing in it. That is the count on the day, not a
  > property of the system — re-run the check before quoting it.
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
migrated order still has to be delivered, and the whole point of importing the
outstanding ones was that they would be.
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

---

## 10. CORRECTNESS MODE — open the orders that match the book (`verdict:1`)

Owner, 2026-09-08, once the tally was under way:

> **他们是要开 SO 和 edit SO 来 proceed 单;purchasing 要开 PO;logistic 要 convert SO to DO**

Sales proceed orders, purchasing raises purchase orders, logistics converts to
delivery orders — and **every one of those happens on the MIGRATED orders**,
which §2's rule forbids. Origin is the wrong grain: it shuts 2,882 documents to
protect the handful that are actually wrong.

`verdict:1` changes the question the guard asks from *where did this come from*
to **does this order match the account book**. Same switch, same table, same 30
seconds to take effect, same bypass cohort.

### The verdict is DERIVED, and it lives beside the data

`check-ac-erp-reconcile.mjs` already decides what "different" means — it is what
prints the summary in *AutoCount vs ERP reconcile (read-only)*. It now also
RECORDS what it found, per document, and `publish-so-reconcile-verdict.mjs`
writes those rows to **`scm.so_reconcile_verdict`**.

There is **no hand-maintained list and there must never be one.**
`sofa-compartment-corrections-2026-08.json` was a hand-written file stating what
a sofa was, with nothing grading it against the book, and three sofas were built
wrong. A "these ones are fine" list is that defect with the stakes moved onto
every migrated order at once.

**Nothing is stamped on the migrated rows.** The owner's rule (§2) holds:
「你换不一样就代表我们的数据从 autocount 搬过来的就不一样了啊」. The verdict is a
separate table keyed by document number, and `scm.mfg_sales_orders` is not
touched by any of it. The table can be truncated and rebuilt without a migrated
row changing.

### Absent means LOCKED — five states, and only one of them opens

| State | Answer |
|---|---|
| the verdict says CLEAN, measured within 48h | **OPEN** |
| the verdict says it differs | locked, and the sentence names the axis |
| no verdict has ever been published for this document | locked |
| the newest verdict is older than 48h | locked |
| the verdict read errored or threw | locked |

48h is not a third number: it is the AutoCount snapshot's own limit in
`check-ac-erp-reconcile.mjs`, because **a verdict cannot be fresher than the book
it was measured against.** The risk it bounds is one-directional — a document
REPAIRED since the run reads stale and stays shut (annoying, safe); a document
that has BROKEN since the run would read clean and OPEN, which is the direction
that costs something.

**So an expired verdict re-shuts every migrated order.** That is the intended
failure mode, not an outage. Re-run the check.

### What a salesperson sees

Not the class sentence any more — the document's own:

> HC-SO-010789 still differs from the AutoCount book on: document total. It
> opens by itself once that is corrected. Ask IT if it must change today.

And where we cannot presently prove it matches:

> HC-SO-010789 cannot be confirmed against the AutoCount book right now, so it
> stays view-only. Ask IT — the AutoCount check needs to run again.

**The operator `description` is NOT consulted in this mode**, deliberately: in
origin mode one sentence covered the whole population and retyping it was
useful; here the sentence must name the document and the axis, and an override
would erase exactly the part that makes the refusal actionable. Both sentences
stay under the 200-character cap both clients enforce — `migratedSoVerdictMessage`
drops AXIS NAMES until it fits rather than truncating one.

### Publishing a verdict

Actions -> **AutoCount vs ERP reconcile (read-only)** -> Run workflow, with
**publish_verdict** ticked. Two steps in one job: the reconcile measures and
writes a file, the publisher reads THAT file. A published verdict can therefore
only ever be one that run measured — there is no path by which a stale or
hand-assembled file reaches the table, and the publisher refuses a file measured
more than 48h ago anyway.

**Publishing changes nothing on its own.** While the switch reads `1`, every
migrated order stays shut exactly as it is today. The rows just sit there.

### THE ORDER OF OPERATIONS — this matters more than the code

1. **The `sync-ac-delta` authorship guard must be live FIRST.** `sync-ac-delta`
   can overwrite a staff edit with no signal at all (§2, risk 1), and its input
   set is the migrated documents. Opening edits before that guard exists risks
   losing a person's work. **Do not set `verdict:1` before it ships.**
   Note for whoever builds it: do NOT hang the authorship signal on
   `mfg_sales_orders.version` — it is an optimistic-locking token bumped by
   `advanceSoGeneration` from seven automated paths, and measured, 80 of 81
   "conflicts" were the automated stock-allocation sweep. The audit trail is the
   real signal.
2. **Publish a verdict** (above). Read the run's `SO VERDICT` line.
3. **Set the switch**, once the owner says so:

   ```sql
   UPDATE scm.app_config SET value = 'verdict:1', updated_at = now()
    WHERE key = 'scm.migrated_so_lock';
   ```

4. **Lift the write freeze** for the modules the three teams need. That is a
   DIFFERENT row with a DIFFERENT grammar — see §1 and the trap below.

### Keeping it true afterwards

The verdict expires in 48h, so **correctness mode needs the reconcile re-run and
re-published on a cadence** or every migrated order re-shuts. That is a real
operational cost and it is the honest one: the alternative is opening documents
on evidence nobody refreshed.

**A document can go from clean back to locked**, and that is not a bug. The
reconcile compares the ERP against the BOOK; a staff edit that reached AutoCount
through the write-back still matches, and one that did NOT reach it now differs —
which is exactly the document you want shut. The publisher prints the
clean/differ split every run, so a re-lock is never silent.

**This mode is a bridge, not a regime.** It exists to get from "all 2,882 shut"
to "only the broken ones shut" while the last differences are repaired. When
they are repaired and the AutoCount payments are reconciled, the answer is still
the one at the top of this file: set the value to `off` and retire the whole
thing.

### Where the correctness-mode code is

| What | File |
|---|---|
| The verdict contract, the 48h rule, the four unknowns | `backend/src/scm/lib/so-reconcile-verdict.ts` |
| The grammar (`verdict:`), the decision, the per-document sentence | `backend/src/scm/lib/migrated-so-lock.ts` |
| Which axes LOCK, and why the declared classes do not | `backend/scripts/lib/so-verdict-derive.mjs` |
| The recorder's call sites inside the comparison | `backend/scripts/check-ac-erp-reconcile.mjs` |
| The publisher | `backend/scripts/publish-so-reconcile-verdict.mjs` |
| The tables | `backend/src/db/migrations-pg/20260908T1420_scm_so_reconcile_verdict.sql` |
| Grammar + decision + guard tests | `backend/tests/migratedSoVerdictMode.test.ts` |
| The verdict contract's own tests | `backend/tests/soReconcileVerdict.test.ts` |
| Why the frontend had to stop overwriting the sentence | `docs/bugs/0700-a-per-document-refusal-reason-was-overwritten-by-the-curated.md` |

### The trap, restated because it has been walked into once already

`scm.write_freeze` is the OTHER row and it has the `- <areas>` grammar. Its
areas clause is **CUMULATIVE**: to open sales orders, purchase orders and
delivery orders you name all three PLUS whatever is already lifted. The live
value is `'1 - scm.procurement.products'`, and the area keys — verified against
`backend/src/scm/lib/scm-areas.ts`, the enforcement code, not against a doc —
are `scm.sales.orders` (SO + amendments + handover + quotes + scan-so),
`scm.procurement.po` (PO + po-amendments) and `scm.sales.delivery` (DO). So:

```sql
UPDATE scm.app_config
   SET value = '1 - scm.procurement.products, scm.sales.orders, scm.procurement.po, scm.sales.delivery',
       updated_at = now()
 WHERE key = 'scm.write_freeze';
```

A runbook once documented the live value as a bare `1`; using that would have
silently re-closed product setup.
