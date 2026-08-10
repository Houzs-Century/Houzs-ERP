# Module: ERP -> AutoCount write-back (SCM)

After go-live the ERP is master and every document it creates must appear in
AutoCount. This is the ERP half. The AutoCount half already exists and was
proven against the live `AED_HOUZS` book on 2026-08-07.

> **It ships OFF.** `scm.app_config` key `scm.autocount_writeback` is seeded
> `'off'` by migration 0277, and `AC_SYNC_URL` is unset. With either of those
> two, nothing is queued and nothing is sent.

> **It is also not ready to be turned on.** Section 11 lists thirteen places
> where the ERP's payload and `AcSyncService.cs` disagree, four of them
> blocking. Read it before anyone touches that toggle.

The one-time IMPORT that came the other way (AutoCount -> ERP) is a different
thing entirely and is recorded in `docs/autocount-cutover-ledger.md`.

---

## 1. The two halves

| Half | Where | What it is |
|---|---|---|
| AutoCount | `backend/scripts/autocount-service/AcSyncService.cs` | A .NET 4 HTTP service running ON the AutoCount host, driving the licensed 2.2 SDK. Eight POST routes. Reflected SDK surface in `sdk-api-reference.txt` — there is no published reference. |
| ERP | `backend/src/scm/lib/autocount-outbox.ts` + `backend/src/services/autocount-writeback.ts` | An outbox: routes enqueue, a cron drains, the returned AutoCount document number is recorded back onto the ERP row. |

AcSyncService's routes, and the outbox `op` that targets each:

| Route | `op` | ERP flow |
|---|---|---|
| `/create-so` | `create_so` | SO create |
| `/create-po` | `create_po` | PO create |
| `/so-to-do` | `so_to_do` | SO -> Delivery Order |
| `/po-to-gr` | `po_to_gr` | PO -> Goods Receipt |
| `/do-to-iv` | `do_to_iv` | DO -> Sales Invoice |
| `/gr-to-pi` | `gr_to_pi` | GRN -> Purchase Invoice |
| `/cancel` | `cancel` | SO / PO cancel |
| `/edit` | `edit` | header, lines, and variant/SKU changes |

---

## 2. Why an outbox and not a direct call

The AutoCount host is a Windows box on the shop floor behind a tunnel. It
reboots. The SDK opens a session per call. Three consequences decided the shape:

1. **A write to AutoCount must never fail a user's save.** Every enqueue
   function swallows its own errors and returns `false`; a salesperson pressing
   Save must not care whether the AutoCount box is up.
2. **A dropped push must be recoverable.** One row per intended operation, with
   `attempts` and `last_error`, drained by the existing 5-minute cron.
3. **A year later, "what did we tell AutoCount, and what did it answer" must be
   a `SELECT`.** Rows are never deleted.

The table follows `email_outbox` (migrations 0005 + 0269) and the drain follows
`amendment-command.ts` — deliberately the same two shapes this repo already
runs, not a third to learn.

---

## 3. The table — `scm.autocount_outbox` (migration 0277)

| Column | Meaning |
|---|---|
| `op` / `doc_type` / `doc_no` / `doc_id` | Which operation, on which ERP document |
| `payload` | **A snapshot**, taken at enqueue. It is the record of what the user's save actually produced; it is never recomposed at drain |
| `status` | `pending` / `sent` / `failed` / `skipped` |
| `attempts` / `last_error` | Retry bookkeeping. `MAX_ATTEMPTS` = 6 |
| `ac_doc_no` | What AutoCount answered with |
| `dedupe_key` | Unique among PENDING rows only. `NULL` = always enqueue |

Two things are resolved LATE, at drain, and only two:

- **The AutoCount document number of the parent** (a conversion's `FromDocNo`)
  and **of the subject** (a cancel/edit's `DocNo`). Neither exists until the
  create that makes it has drained. This is a foreign-key resolution, not a
  recomposition. A row whose parent is unresolved is left `pending` **without
  burning an attempt**; sweeps drain oldest-first, so the parent's create is
  ahead of it in the same batch.
- **The flag**, so a switch turned off after rows were queued stops the push.
  Those rows stay `pending` — off is not a failure.

### `linked_ac_docno` — the map, both ways

The drain writes the returned number onto the ERP row. 0277 adds the column to
`purchase_orders`, `delivery_orders`, `grns`, `sales_invoices` and
`purchase_invoices`; `mfg_sales_orders` already had it from 0271.

`purchase_orders.linked_ac_docno` is a **known recording gap being closed**, not
a new column: `import-ac-outstanding-po.mjs:314` added it at runtime with its
own `ALTER`, so it exists in production but appeared in no migration
(cutover ledger §1 "坑二"). `IF NOT EXISTS` makes 0277 a no-op against the live
database and makes the column real everywhere else.

---

## 4. The toggle

`scm.app_config` key `scm.autocount_writeback`, read by
`scm/lib/autocount-writeback-flag.ts`. Same table, grammar and 30s cache as the
go-live write freeze (0272 + `scm/lib/write-freeze.ts`):

```
'off' / '' / row absent  -> nothing is queued or sent
'all'                    -> every company
'1' / '1,3'              -> ONLY those companies
```

"Fails open" here means **the caller is never harmed**, not that an unreadable
flag turns the feature on: a read error re-serves the last known state, and the
seeded default is `off`. `isWritebackEnabled` never throws.

Checked twice — at enqueue (nothing accumulates while off) and again per row at
drain (the flag is per company and can flip mid-sweep).

---

## 5. The downstream lock — owner rule, 2026-08-10

> **"已经转到下游的单据, AutoCount 不许取消/改动 ... 是的 我们也是要这样"**

AutoCount's `CancelDocument` refuses a document it has already transferred
downstream, and its `Edit` cannot retract a line a DO already shipped. The ERP
enforces the same rule, or the first edit of a shipped order leaves the two
systems permanently disagreeing — with the ERP wrong, because the stock has
already moved.

`backend/src/scm/lib/downstream-lock.ts`:

| Function | Locks on |
|---|---|
| `soHasDownstream(sb, soDocNo)` | any non-CANCELLED `delivery_orders` or `sales_invoices` on that SO |
| `poHasDownstream(sb, poId)` | any non-CANCELLED `grns` on that PO |
| `doHasDownstream(sb, doId)` | any non-CANCELLED `delivery_returns` or `sales_invoices` on that DO |
| `grnHasDownstream(sb, grnId)` | any `grn_items` with `invoiced_qty > 0` or `returned_qty > 0` |

**Blocked:** line mutations and cancel. **Not blocked:** raising the NEXT
downstream document — an SO with one DO can still emit another (partial
delivery). That matches AutoCount, which keeps transferring but refuses to
rewrite history.

A **cancelled** child does not lock: an SO whose only DO was cancelled is free
again.

The rule is not new — it existed as four private copies inside four
multi-thousand-line route files, where no test could reach it. 0277's PR moved
it into one module with a pure `downstreamVerdict` underneath, and the four
routers now import it. Same signatures, same JSON, same 409s.

---

## 6. Where the routes enqueue

Each hook sits at the point the document becomes permanent — after the
`record*Create` audit row, past every compensating rollback.

| Flow | File | Anchor |
|---|---|---|
| SO create | `scm/routes/mfg-sales-orders.ts` | after `recordSoAudit(... 'CREATE')`, before `c.json({ docNo }, 201)` |
| PO create | `scm/routes/mfg-purchase-orders.ts` | after `recordPoCreate(...)` |
| SO -> DO | `scm/routes/delivery-orders-mfg.ts` | `POST /` (SO-linked only) and `POST /from-sos` |
| PO -> GRN | `scm/routes/grns.ts` | `POST /from-pos` and `POST /from-po-items` (per bucket) |
| DO -> SI | `scm/routes/sales-invoices.ts` | `POST /from-dos` |
| GRN -> PI | `scm/routes/purchase-invoices.ts` | `POST /from-grn` and `POST /from-grn-items` (per bucket) |
| SO cancel | `mfg-sales-orders.ts` | `PATCH /:docNo/status` when the transition is to CANCELLED |
| PO cancel | `mfg-purchase-orders.ts` | `PATCH /:id/cancel` |
| DO cancel | `delivery-orders-mfg.ts` | `PATCH /:id/status` when the transition is to CANCELLED |
| GRN cancel | `grns.ts` | `PATCH /:id/cancel`, after the atomic flip won the race |
| SO edit | `mfg-sales-orders.ts` | `queueAcSoEdit` from the header PATCH, line add/edit/delete, and `tbc-update` / `tbc-swap` / `tbc-swap-sofa` |
| PO edit | `mfg-purchase-orders.ts` | `queueAcPoEdit` from the header PATCH and line add/edit/delete |

A **variant or SKU change IS a line change** — AutoCount takes it as `Desc2` +
`ItemCode` on the same `DtlKey` — so the `tbc-*` routes need no operation of
their own. Those three run inside `runScmPgCommand`, so their enqueue sits
OUTSIDE the transaction and fires only on a 2xx.

`tests/autocountWritebackWiring.test.ts` pins every one of these anchors so a
refactor cannot silently unhook the queue.

### Two cases that need care

**Create then edit before the drain runs.** `enqueueEdit` first looks for a
still-PENDING create for the same document and REPLACES its payload. Queueing an
edit behind a stale create would push the pre-edit order into the live book and
then correct it, which is visible to whoever is looking at AutoCount.

**Cancel before the drain runs.** `enqueueCancel` marks the pending create
`skipped` and queues nothing. Creating a document in a live account book only to
cancel it is not a no-op to the people using that book.

### What each side is composed FROM

| Payload field | ERP source |
|---|---|
| SO header | `scm.mfg_sales_orders` — `debtor_name`, `agent`, `sales_location`, `ref`, `phone`, `address1-4`, and `branding` / `venue` / `po_doc_no` into UDF |
| SO lines | `scm.mfg_sales_order_items`, including `linked_ac_dtlkey` (migration 0273) — the AutoCount line an edit addresses |
| PO header | `scm.purchase_orders` — `po_number`, `po_date`, `notes`. **The creditor is a JOIN**: the table is supplier-keyed, so `CreditorCode` / `CreditorName` come from `scm.suppliers.code` / `.name` through `supplier_id`. It has no `agent` and no `ref` at all, so a create sends null for both and an edit omits `Ref` entirely rather than blanking AutoCount's |
| PO lines | `scm.purchase_order_items`, same `linked_ac_dtlkey` |

Every column these reads name is listed once at the top of
`scm/lib/autocount-outbox.ts`. That is deliberate: PostgREST does not ignore a
column a table does not have, it fails the whole query with **42703**, so a
phantom column silences an entire flow (see `BUG-HISTORY.md`, 2026-08-10).

---

## 7. What the ERP can express and AutoCount cannot

The SDK's only transfer primitive is
`AddPartialTransferDetail(fromDocType, fromDocKeys)` — **ONE source document**.
The ERP can merge several SOs into one DO, batch several POs into one GRN, and
so on. Those have no AutoCount shape.

They are written to the outbox with `status = 'skipped'` and the reason in
`last_error` (`recordConvertSkipped`). Inventing N AutoCount documents would
create records the ERP does not have; dropping it silently would leave a
shipment in one system and not the other with nothing to find it by. **A
divergence that is written down can be found.**

Find them with:

```sql
SELECT doc_type, doc_no, op, last_error, created_at
  FROM scm.autocount_outbox
 WHERE status = 'skipped'
 ORDER BY created_at DESC;
```

**A compose that FAILED is written down the same way.** If a read the payload is
built from errors — a column that is not there, a dead REST edge — the enqueue
logs `[autocount-outbox] <op> compose read failed` and writes a `skipped` row
carrying the database's own message, then returns false. It does **not** compose
what it managed to read. `data ?? []` on a failed read is an empty line list,
and an order pushed into a live account book with no lines on it is
indistinguishable, from the AutoCount side, from one the operator really did
leave empty.

---

## 8. Configuration

| Name | Kind | Notes |
|---|---|---|
| `AC_SYNC_URL` | `[vars]` in `wrangler.toml` | Base URL of AcSyncService. **Config, not a secret** — a hostname and a port. Absent = the drain is a no-op and says `ac_service_not_configured` |
| `AC_SYNC_KEY` | **wrangler secret** | The service's `X-API-KEY`. `wrangler secret put AC_SYNC_KEY`, never in `wrangler.toml` |
| `scm.app_config` / `scm.autocount_writeback` | DB row | The runtime toggle (§4) |

The AutoCount service reads its own key from `C:\Temp\ac-svc-key.txt` on the
host and its SQL connection string is injected at build time, so no credential
lives in this repository.

---

## 9. Operating it

**Turn it on** (after the write freeze lifts, and never before someone has
watched a single document land):

```sql
UPDATE scm.app_config SET value = '1', updated_at = now()
 WHERE key = 'scm.autocount_writeback';
```

**Turn it off** — set `value = 'off'`. Takes effect within 30 seconds (the cache
TTL). Queued rows stay `pending` and drain when it is turned back on.

**What to watch.** The cron logs `[cron ac-writeback]` per sweep, and logs at
ERROR level whenever a row reaches `failed` — a failed row means a document
exists in the ERP and does not exist in AutoCount, which is the exact divergence
this mechanism exists to prevent.

```sql
SELECT status, count(*) FROM scm.autocount_outbox GROUP BY status;
SELECT doc_type, doc_no, op, attempts, last_error
  FROM scm.autocount_outbox WHERE status = 'failed' ORDER BY created_at DESC;
```

---

## 10. Tests

| File | Covers |
|---|---|
| `src/scm/lib/downstream-lock.test.ts` | The owner's rule: one live child locks; a cancelled child does not; another document's children do not |
| `src/scm/lib/autocount-outbox.test.ts` | The toggle (off / absent / per-company / `all`), each of the six flows, cancel-and-edit against a still-queued create, the drain's sent / retry / give-up / refusal / waiting paths, and — over a fake PostgREST that answers 42703 for a column the table does not have — that a failed read is never composed into an empty document |
| `src/services/autocount-writeback.test.ts` | The master maps, sen -> decimal, Desc2 from variants, sofa parent collapse, `DtlKey` addressing, and the client's retryable/not-retryable read of a response |
| `tests/autocountWritebackWiring.test.ts` | That every hook is still attached to its route |
| `src/services/autocount-writeback.contract.test.ts` | The PAYLOAD CONTRACT — see section 11 |

---

## 11. The payload contract, and the eleven places the two halves still disagree

`src/services/autocount-writeback.contract.test.ts` does not test the composer
against itself. It reads `AcSyncService.cs` at build time (`?raw`), extracts the
keys that file actually parses, and holds the bytes `dispatchOne` would POST up
against them — for all eight routes. It also runs the ERP's own schema over the
queries: its fake PostgREST answers **42703 for a column `scm`'s schema dump
does not have**, exactly as Supabase does, which is what catches a write-back
that reads a column that was never there.

**The good news first, because it is the larger half:** every key the ERP sends
is a key the service reads. No typo, no renamed field, no wrong nesting, no
wrong type. Dates cross as `YYYY-MM-DD` from `date` columns and `DateTime.TryParse`
reads those the same in any culture; sen become the decimal AutoCount wants;
`DtlKey` survives as a JSON number into `Convert.ToInt64`; every `DocType` the
ERP can queue is a `case` the C# handles; and the response shape
(`{ok, docNo, error}`) is the one the client parses.

What does NOT agree is listed below. The register lives in the test file as
`DIVERGENCES`, and the test **fails if a twelfth appears and fails if one of
these is fixed without being removed** — so the list cannot rot in either
direction.

**Two of the original thirteen are STRUCK OFF, fixed in #1855: D11 and D13.**
They were the two that were plain bugs rather than decisions — a select naming
four columns `scm.purchase_orders` has never had, and a failed read becoming an
empty line list. Their ids are retired, not reused, and `BUG-HISTORY.md` carries
both. The eleven below are unfixed, and each needs a decision that is not a test
author's to make.

**Struck off — fixed in #1855. The ids are retired, not reused.**

| id | Field | What it was, and what closed it |
|---|---|---|
| D13 (struck) | `Details[]` / `Lines[]`, all of them | The line select named `linked_ac_dtlkey` before migration 0273 existed. PostgREST 42703s the whole query, `items ?? []` turned that into an empty array, and **every SO would have gone over with no lines at all**. Closed on both sides: #1819 landed 0273, and a failed read now throws, is logged, and is written down as a `skipped` outbox row instead of composed (§7). The contract test still takes the column away again, because the mechanism is what has to stay fixed, not that one column. |
| D11 (struck) | `CreditorCode` / `CreditorName` / `Agent` / `Ref` | `enqueuePoCreate` and `composePoState` selected four columns `scm.purchase_orders` does not have — 42703, `header` null, `return false` inside the function's own `try/catch`, so **PO create and PO edit were a silent no-op**. They now read the real columns and join `scm.suppliers` for the creditor code and name; the PO edit omits `Ref` rather than blanking the book's own, since the ERP has no ref of its own to send. |

**Blocking — the write-back cannot work correctly until these two are fixed**

| id | Field | The disagreement |
|---|---|---|
| D10 | `Details[].ItemCode` | `makeItemCodeResolver` is never called by anything but its own unit test — every `compose*` uses the default `identityResolver`, so the raw ERP `item_code` goes on the wire and AutoCount has no such item. |
| D9 | `Details[]` for a sofa | The ERP stores a sold sofa as one row PER COMPARTMENT (`so-sofa-split.ts:83`, grouped by `variants.buildKey`, each `qty 1` with a share of the price) and `toDetails` is a plain 1:1 map. With D10 fixed, all N rows carry the SAME AutoCount sofa code — **one sofa sold books qty N and takes N off AutoCount's stock.** The fold to mirror is `groupSoLinesForDisplay` (`so-line-display.ts:155`): sum the price, SUM the discount, `Qty 1`, ItemCode = model token, composition into `Desc2`. |

**Silent divergences — they will not fail, they will just be wrong**

| id | Field | The disagreement |
|---|---|---|
| D1 | `UDF.*` | The ERP sends `BRANDING` / `VENUE` / `ToPONo`. Every other record in this repo spells them `SOUDF_BRANDING` / `SOUDF_VENUE` / `SOUDF_ToPONo` — `services/pull.ts:164,177,182`, `types.ts:236`, and `services/autocount.ts:249` which WRITES `POUDF_EDate` to the live book today. `ApplyUdf` wraps every write in `Set()`, which swallows an unknown key and logs "set skipped", so the wrong spelling is a no-op nobody sees. **The source cannot settle this — the `udf-probe` step of the trial sends both spellings so one look at the book decides it.** |
| D4 | `Ref` / `Description` / `SupplierDONo` / `SupplierInvoiceNo` on a conversion | `Str()` returns `""` for an ABSENT key as well as a null one, and the conversion paths assign all four unconditionally. The ERP sends `{DocDate, Ref}` with both null at every call site, so a transferred DO/GRN/invoice has its `Ref` and `Description` blanked and a GRN/PI never carries the supplier's own document number. |
| D6 | `Lines[].ItemCode` on an edit | The service applies `ItemCode` only to a line it is APPENDING; for a line addressed by `DtlKey` it never reads it. `tbc-swap` and `tbc-swap-sofa` change the product and are hooked to `enqueueEdit`, and section 6 above says AutoCount "takes it as `Desc2` + `ItemCode` on the same `DtlKey`". **It does not.** A SKU swap changes the description and the price and leaves the old product. |
| D7 | A DELETED line | The service has no delete, deliberately (only `SalesOrder` exposes `DeleteDetail` in this SDK). The ERP hooks line delete to `queueAcSoEdit`, which composes the lines that still exist — so the deleted line stays in AutoCount for ever and nothing reports it. |
| D12 | line discount | `discount_centi` exists on both item tables and is never sent, so the AutoCount total is the undiscounted one. On a sofa the discount sits on ONE compartment row, which makes it easy to miss. |

**Smaller, but write them down**

| id | Field | The disagreement |
|---|---|---|
| D2 | `Details[].Location` | Always null, and a null is `""` to the service — so it blanks the line location rather than leaving AutoCount's. `mfg_sales_order_items.warehouse_id` and the PO items' `warehouse_id` are what it should carry. |
| D3 | `Details[].DeliveryDate` | Always null. `mfg_sales_order_items.line_delivery_date` and `purchase_order_items.delivery_date` both exist and are not selected. |
| D5 | `DocNo` on a conversion | The service uses the ERP's number when it is sent, which is exactly what the two CREATE routes do. Conversions never send it, so AutoCount auto-numbers every DO / GRN / invoice and four of the six flows carry two different numbers for one document. |
| D8 | `Header.Agent` / `SalesLocation` / `DocDate` / `UDF` on an edit | All four are in the C# allow-list and none is composed, so changing the salesperson, the sales location, the order date, the branding or the venue on a live order never reaches AutoCount. |

One trap that is NOT a bug, but has bitten once already: **`/create-so` reads
`Phone` and `/edit` reads `Phone1`** for the same ERP column. Both composers are
right; they just do not match each other.

---

## 12. The test-book trial

`backend/scripts/ac-trial-dry-run.mjs` posts
`backend/scripts/autocount-service/trial-payloads.json` — one document chain,
SO -> DO -> Invoice and PO -> GRN -> Purchase Invoice, plus an edit, a cancel,
and a cancel that AutoCount should REFUSE — printing every request and response.

**It does not run by default.** With no environment it prints the payloads and
makes no network call at all. To post, four independent gates must open:
`AC_TRIAL_CONFIRM=yes-testing-book`; `AC_TRIAL_URL` set; that URL not being the
one the Worker is configured with (`AC_SYNC_URL`, from the environment or
uncommented in `wrangler.toml`, plus `AC_PROD_URL`); and `GET /health` naming a
book that is **not** the production book and **is** `AC_TRIAL_EXPECT_BOOK`.

The last gate is the one that counts, because it is an observation rather than a
setting. It reads the production book name out of `AcSyncService.cs` itself, so
it cannot drift. Note that the service reports a compile-time constant there:
the build pointed at the test database must have had its `BOOK` constant changed
to match, and if it was not, the harness refuses — which is the right way round.

`AC_TRIAL_KEY` is a credential: it is sent as `X-API-KEY` and never printed.

---

## See also

- `docs/autocount-cutover-ledger.md` — the one-time import that came the other way
- `backend/scripts/autocount-service/AcSyncService.cs` — the AutoCount half
- `backend/scripts/autocount-service/sdk-api-reference.txt` — the reflected SDK surface
- `docs/modules/sales-order.md`, `docs/modules/purchase-order.md`
