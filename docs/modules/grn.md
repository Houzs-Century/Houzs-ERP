> ## Corrections — 2026-08-12 code-read sweep
>
> 1. The post flip is an atomic CAS on the observed status (grns.ts:375-411), not .neq(CLOSED) — the old predicate let two concurrent confirms double-book stock; GUARD 2 (:533-549) also skips the IN write when movements already exist.
> 2. /from-po-items buckets by SUPPLIER (:2196) — one GRN per supplier spanning POs; the “one per PO” cell copied a stale in-file comment (:2109-2117, itself wrong).
> 3. That path creates headers POSTED-by-default (payload carries no status; DDL default POSTED) — DRAFT never occurs on it.
> 4. The R2 422 message is fx-guard's three-remedies text (fx-guard.ts:84-92), not “Set the <CUR> exchange rate before posting this GRN”.
> 5. Post-guide surface omitted here: RECEIVABLE_PO_STATUSES gate on all create paths, warehouse_required 400, recountError surfacing, negative-guard on line edit/delete, entity audit, the AutoCount outbox, grnHasDownstream moved to downstream-lock.ts:145-151.

# Module: Goods Received Note / GRN (SCM)

Per-module technical doc — the data flow from the screen down to the database,
plus the performance characteristics. Sibling of `sales-order.md`. The GRN is the
receiving step of the buy chain and the document that **creates FIFO stock**, so
it carries more inventory machinery than the other three siblings combined.

> Convention: money is in **sen** (integer cents) end-to-end. Dates are stored
> UTC, displayed DD/MM/YYYY. All reads/writes go through `/api/scm/*`.
>
> **Line numbers here are INDICATIVE, not authoritative.** They were correct at
> `main` @ `c523a02f` and drift with every merge — an audit on 2026-08-13 found
> every `:NNN` in this directory stale while the paths, methods and permission
> keys were right. Resolve a route to its current line with the GENERATED
> artifact, which cannot go stale because it is rebuilt from the tree:
>
> ```bash
> npm --prefix backend run gen:route-locator   # then grep docs/generated/route-locator.md
> ```

Doc-flow position: **PO → GRN → PI**, with **GRN → PR** (Purchase Return) as the
send-back branch. The route file's own one-liner: *"PO → GRN → Purchase Invoice.
On POST, qty_received rolls up to PO items"* (`grns.ts:1-2`).

---

## 1. Frontend

### Screens
| Surface | File | Notes |
|---------|------|-------|
| Desktop list | `frontend/src/pages/scm-v2/GoodsReceivedListV2.tsx` | Server-paginated, `pageSize = 50` (`:455`). |
| Desktop detail (read) | `frontend/src/pages/scm-v2/GoodsReceivedDetailV2.tsx` | Read-only shell; `?edit=1` forwards to the legacy editor (`:240-248`), lazily loaded. |
| Desktop detail (edit) | `frontend/src/pages/scm-v2/GoodsReceivedDetail.tsx` | The inline editor. Lock logic at `:244-248`. |
| Desktop new | `frontend/src/pages/scm-v2/GrnNew.tsx` | Uses `usePurchaseOrders()` (the legacy unpaginated PO hook, `:156`). |
| Desktop from-PO | `frontend/src/pages/scm-v2/GrnFromPo.tsx` | Multi-select over `/outstanding-po-items`. |
| Mobile list | `frontend/src/mobile/MobileModuleList.tsx` | `MODULE_CONFIGS.grns` (`:1159-1192`). |
| Mobile detail | `frontend/src/mobile/MobileModuleDetail.tsx` | Config `:324`; status actions `:535-542`. |
| Mobile convert (PO→GRN) | `frontend/src/mobile/MobileConvertWizard.tsx` | `target = "grn"`, **no line picker** — a whole-PO convert. Offered only to a caller who passes `canOperateGoodsReceipts` — see below. |

**The mobile `+` is an OPERATE gate (2026-08-14).** `MobileModuleList` renders the
`+` on the presence of an `onNew` callback alone, and `MobileConvertWizard` imports
no auth of its own — so withholding `onNew` is the only thing that keeps the wizard
away from a caller who may not write. `MobileApp.tsx` gated the DO and SI convert
targets and then fell through to a literal `: true`, which covered this one: a
`view`-level holder of `scm.procurement.grn` was offered the `+`, filled in the whole wizard, and
met the area guard's 403 at the end of it. The gate is now
`canOperateGoodsReceipts(can, pageAccess)` (`frontend/src/auth/salesAccess.ts`), which mirrors
`scm/middleware/area-guard` — `edit` on the area for POST/PATCH/PUT/DELETE, with
`*` always passing. The target chain has no default arm, so a new ConvertTarget
that forgets its gate will not typecheck.


Desktop routes: `frontend/src/App.tsx:542-545`, behind
`<ScmGuard area="scm.procurement.grn">`.

### Data hooks
`frontend/src/vendor/scm/lib/grn-queries.ts`

- `useGrnsPaged({page,pageSize,status,q,sort})` (`:93`) — the desktop list.
  `queryKey: ['grns-paged', ...]`, `placeholderData: prev`, `staleTime: 30_000`.
- `useGrns(status?)` (`:77`) — legacy unpaginated, `['grns', status ?? 'all']`.
- `useGrnDetail(id)` (`:110`) — `['grn-detail', id]`.
- `useCreateGrn` (`:125`), `usePostGrn` (`:139`), `useCancelGrn` (`:215`),
  `useUpdateGrnHeader` (`:155`), `useAddGrnItem` / `useUpdateGrnItem` /
  `useDeleteGrnItem` (`:171` / `:185` / `:199`).
- `useGrnFromPos` (`:44`), `usePurchaseInvoiceFromGrn` (`:233`),
  `usePurchaseReturnFromGrn` (`:284`), `usePurchaseReturnFromGrns` (`:60`).

**The stock-side invalidation rule:** every mutation that can move inventory also
invalidates `['inventory']` — `usePostGrn` (`:146`) and `useCancelGrn` (`:222`).
And because a GRN's stock IN changes the PO's `received_qty` and status,
`useGrnFromPos` invalidates `['mfg-purchase-orders']` too (`:53`) and
force-refetches the picker key (`:55`).

### Caching / loading behaviour
Three layers as in `docs/modules/sales-order.md` §1. GRN specifics:

- `"grns"` is whitelisted for the localStorage snapshot
  (`frontend/src/lib/query-persist.ts:97`); `"grns-paged"` is a different first
  segment and is not. `'outstanding-po-items'` is in the `SUBRESOURCE` deny set
  (`:103`), so the picker is never persisted.
- Mobile's `sharedInvalidate.ts:72` maps `"grns"` to
  `["grns", "grns-paged", "grn-detail", ...STOCK_ROOTS]`, and `STOCK_ROOTS`
  (`:55`) folds in the **SO** roots. That is deliberate: posting a GRN re-walks
  `recomputeSoStockAllocation`, which flips SO lines READY/PENDING, so posting a
  GRN changes SO list rows that never mention the GRN.

---

## 2. API surface

`backend/src/scm/routes/grns.ts`, mounted at `/api/scm/grns`
(`backend/src/scm/index.ts:239`) behind `scmAreaGuard('scm.procurement.grn')`
(`:238`).

| Method | Path | Line | Purpose |
|--------|------|------|---------|
| GET | `/` | `:833` | List. `?page=` opts into pagination + `statusCounts`. |
| GET | `/outstanding-po-items` | `:1283` | PO lines with `qty - received_qty > 0` on SUBMITTED / PARTIALLY_RECEIVED POs; the from-PO picker. **Reads the FULL set** since 2026-08-17. Takes **`?poId=a,b,c`** (server-side scope) and returns **`scope`** beside `items` — see §2a. |
| GET | `/:id` | `:1173` | Header + items + convert/lock flags + per-line source PO + per-line downstream. |
| GET | `/:id/linked` | `:1229` | Parent PO + downstream PIs + PRs. |
| POST | `/` | `:1268` | Create. `asDraft: true` → DRAFT; otherwise created POSTED and immediately posted (`:1471`). |
| POST | `/from-pos` | `:1491` | Whole-PO batch convert. **Auto-posts** (writes stock at once). |
| POST | `/from-po-items` | `:1775` | Line-level multi-select convert; one GRN per source PO, each created DRAFT then posted via the shared helper. |
| PATCH | `/:id/post` | `:1764` (handler `:1682`) | **The stock chokepoint**: DRAFT → POSTED. |
| PATCH | `/:id/cancel` | `:2033` | → CANCELLED; reverses the receipt. |
| PATCH | `/:id` | `:2210` | Header edit — **can move stock** (warehouse relocation, see §5). **Company-scoped on BOTH halves** since #2086, 2026-08-13. |
| POST/PATCH/DELETE | `/:id/items[/:itemId]` | `:2363` / `:2569` / `:2839` | Line CRUD — each re-syncs inventory on a POSTED GRN. |

## 2a. The from-PO picker's read, and why an empty grid must name its cause

*Added 2026-08-17, with the fix for the owner's zero-row screen.*

He opened the picker scoped to one PO, got **0 rows**, and was told *"every line
has been received"*. The PO had never been received. Three mechanisms, all
silent, and the full trace is in `BUG-HISTORY.md`:

1. `.limit(500)` sat on the **raw** `purchase_order_items` select with BOTH
   filters running afterwards in JS, so the window was spent on every PO line in
   the company — received, draft or not.
2. It was ordered by `purchase_order_id DESC` — a uuid key order, not a date one.
3. `?poId=` was applied **in the browser**, to the already-truncated list, so
   scoping could only narrow the window and never recover a PO outside it.

**What the endpoint does now** (`backend/src/scm/lib/outstanding-po-lines.ts`):

| | |
|---|---|
| the read | **paged** via `pageWithTruncation`, not capped. Not `paginateAll`: that returns `{data, error}` and so cannot report that it stopped early, which is the whole distinction this endpoint got wrong. Ceiling `OUTSTANDING_MAX_PAGES × OUTSTANDING_PAGE`; hitting it sets `scope.truncated`. |
| dead statuses | filtered **in SQL**, `.not('po.status','in',…)` on the embedded alias — the form `mrp.ts:535` already proves in production on this same table and embed. Only DRAFT + CANCELLED (`PO_DEAD_FOR_RECEIPT`). |
| the exact receivable set | still the **JS** gate, `isReceivablePoStatus` in `grns.ts` — the SINGLE predicate the create paths share. The lib holds **no copy**; `explainOutstanding` takes it as a REQUIRED parameter so the picker cannot offer a line the converter then refuses. |
| `?poId=` | a **SQL predicate** on `purchase_order_id`. A scoped read is exact and bounded by one PO's line count. |
| ordering | the line's own `id` — paging needs a total order. |

**The response carries `scope`**, which is the WHY behind an empty `items`:
`requestedPoIds`, `pos[]` (each with `poDocNo`, `status`, `receivable`,
`candidateLines`, `outstandingLines`), `unknownPoIds`, `truncated`, `scanned`. A
requested PO that is DRAFT or CANCELLED yields no candidate rows, so the handler
does a second header read to learn its status — without it, *"your PO is a
draft"* and *"your PO does not exist"* collapse into one answer, and both used to
render as *"every line has been received"*.

**The rule this establishes, for every picker: AN EMPTY RESULT MUST SAY WHY IT IS
EMPTY, and must never claim a completion it has not verified.**
`frontend/src/lib/outstandingEmptyReason.ts` turns `scope` plus the two
client-side causes (toolbar filters, unsaved-draft subtraction) into one of eight
sentences, and only the two that VERIFIED completion may claim it —
`outstandingEmptyReason.test.ts` asserts that property by enumerating every
branch, not by reviewing the wording. Desktop `GrnFromPo.tsx` and
`MobileConvertWizard.tsx` share it; the mobile wizard had the same bug because it
fetched the unscoped endpoint and filtered client-side.

**`useOutstandingPoItems(poIds)` takes its scope as a REQUIRED argument** (pass
`[]` for the open picker), per CLAUDE.md's rule about a parameter that decides
something: optional, every forgetful caller silently gets the unscoped read,
which is the looser direction and is exactly how this shipped.

To measure what the cap hid on production: Actions →
**probe-transfer-census** (read-only), which replays the old window at any
`LIMIT` and counts the outstanding lines and whole POs it could not reach.

## 2b. Two open gaps this module carries, RECORDED not changed

*Added 2026-08-17. Both are for the owner to decide; neither was touched.*

**1. Two DRAFT GRNs can coexist on one PO line, and that is deliberate.** A DRAFT
GRN commits nothing — `recomputePoReceived` excludes DRAFT rows from a PO line's
`received_qty` (`grns.ts`), so the line stays fully outstanding and the picker
keeps offering it. That is what makes a draft a draft, and it is also what lets
two people draft a receipt for the same delivery. The confirm transition is a
compare-and-swap on the observed status, so only ONE of them can post; the loser
gets `already_posting` 409. The exposure is therefore duplicated WORK, not
duplicated stock. Refusing the second draft was considered and NOT done: it would
break the legitimate case (one person drafts, another revises) and there is no
report of it happening.

**2. `purchase_order_item_id` on `grn_items` is nullable with NO unique index**,
and the same is true of `grn_item_id` on `purchase_invoice_items` and
`purchase_return_items`. Every once-only rule on these chains is a running tally
recounted in application code — `received_qty`, `invoiced_qty`, `returned_qty` —
read-then-write, with no database constraint behind it. `grns.ts` says so in its
own words: *"with no DB unique index behind it to reject the second write (unlike
DO/DR, which have one)"*. The unlinked-line guards close the operator-facing door
(`grn-unlinked-po-lines.ts`, `return-unlinked-lines.ts`); a concurrent-write race
is held only by the CAS and the post-insert verifiers. Counting how much of this
shape is already in production is what `probe-transfer-census` is for.

Two corrections to this paragraph, both made 2026-08-17 when the BILLING side of
this chain was guarded. *"Two of those verifiers swallow their read errors on
purpose"* was true of `verifyGrnLinesNotOverInvoiced`; its three reads now bind
them, and each caller chooses — the CREATE paths log and proceed (they ran their
own pre-check moments earlier), the CONFIRM refuses, because there the pre-check is
the only check. And the sentence gave the impression the operator-facing door was
fully closed, which it was not: `purchase_invoice_items` had NO unlinked-line guard
at all until that day, so a hand-added goods line billed a receipt while
`invoiced_qty` stayed put and a second invoice billed the same delivery. That is
the money version of this shape, and it is closed on all three write paths — see
`docs/unlinked-line-duplicate-coe.md` §5a.

**3. On this side of the chain the same edit-path door is still open.**
`PATCH /grns/:id/items/:itemId` rewrites a line's `material_code` and never calls
`findUnlinkedPoLines`, so a receipt line added for a material the PO does not carry
(correctly allowed) can afterwards be retyped onto one it does — the refused shape,
assembled in two legal steps, with `purchase_order_item_id` still null so
`recomputePoReceived` never counts it. The identical gap is on
`purchase-returns.ts`, `delivery-returns.ts` and `sales-invoices.ts`. Only the
Purchase Invoice edit path was closed on 2026-08-17, because only that chain bills
money; these four move stock. RECORDED, not changed, for the owner to rank —
`docs/modules/document-conversion.md` §10.4 G5 carries the same list.

**`PATCH /:id` was unscoped on both its read and its UPDATE until 2026-08-13**
(PR #2086; BUG-HISTORY, *"The writes the read-hardening audit left"*). The GET at
`:1173` had been scoped by the 2026-08-10 audit and this write had not, so a GRN
id belonging to the other company could be loaded and edited here — and this
handler moves stock. The service-role client bypasses RLS, so the app-level
predicate is the only isolation there is; a scoped read does not gate the
unscoped write that follows it. Both statements now carry
`scopeToCompanyId(…, co.companyId)` behind `requireActiveCompanyId`, and the
update uses `maybeSingle()` rather than `single()` **on purpose**: the company
predicate can legitimately match zero rows, and `single()` renders that honest
404 as a 500. Out-of-company answers `NOT_THIS_COMPANY` / 404.

The `asDraft` flag is the only way to create a draft: `POST /` with
`status: 'DRAFT'` in the body is rejected outright with
`draft_status_not_supported` (`:1277`).

---

## 3. Backend

### The list handler — `grns.get('/')` (`:833-983`)

1. **Select** (`:856` / `:874`) — one query with three embeds:
   `supplier:suppliers(...)`, `purchase_order:purchase_orders(id, po_number)` and
   `warehouse:warehouses!warehouse_id(...)`.
2. **Two paths, chosen by `page`** (`:844-845`).
   - Legacy (`:854-862`): `order received_at desc`, `.limit(500)`, optional
     `status` / `supplierId`, `scopeToCompany`.
   - Paginated (`:863-923`): sort whitelist
     `received_at | grn_number | status | total_centi` (`:869`) + `grn_number`
     tiebreaker; bucket resolution via `GRN_STATUS_BUCKETS` (`:827-831`); `q`
     ilikes over `grn_number, delivery_note_ref, notes` only (`:892` — supplier
     name and PO number are embedded resources); `from`/`to` on `received_at`.
   - `statusCounts` = four `head:true count:'exact'` in one `Promise.all` (`:911-916`).
3. **Enrichment — a genuine SEQUENTIAL chain**, and this is what makes the GRN
   list the most expensive of the four:
   - `paginateAll` over `grn_items` for the listed GRN ids (`:942-947`) — a paged
     read, so more than one round trip when a page's GRNs carry many lines.
   - **then** `grnLineDownstream(sb, [...grnByItem.keys()])` (`:961`, helper at
     `:1122`), which needs the item ids the previous step produced. It cannot be
     parallelised with it.
   - `computeGrnFlags` (`:815-821`) turns the lines into `has_children`,
     `fully_invoiced`, `fully_returned`; the downstream map rolls up into a deduped
     per-GRN `downstream` doc-number list (`:959-973`).
4. **Assemble** (`:974-980`) — `total_centi` is the **stored header value**, not a
   re-sum of the lines. The comment at `:926-933` explains why: the old per-line
   `qty_accepted * unit_price` sum ignored `discount_centi`, so the list Total
   drifted from the detail Total. Each GRN also carries `assigned_sos` and
   **`delivered_dos`** — **since 2026-08-02 rolled up from the parent PO's
   PER-SKU data RESTRICTED to the GRN's OWN line codes**
   (`resolvePoSoCoveragePerSkuForPos` + `resolveDeliveredByCodeForPos` +
   `summarizeOrigins`), so a partial-receipt GRN's header cells show exactly
   what its drill lines can explain (header ≡ ∪(lines)) — not the whole
   parent-PO history it used to inherit. An unassigned GRN reads a "STOCK" tag,
   not a dash. See `docs/modules/document-traceability.md` §2.5 + §2.9 (owner
   2026-07-31 / 2026-08-02).

### `postGrnAndRollup` (`:338-527`) — the single post chokepoint

Called by the confirm handler (`:1733`), by `POST /` on the non-draft path
(`:1471`) and by `/from-po-items`. In order:

1. **Flip to POSTED FIRST, then recount** (`:346-355`). `recomputePoReceived`
   excludes DRAFT lines from a PO line's `received_qty`, so the confirm must flip
   the row before recounting or this GRN's own lines would not count. The update
   carries `.neq('status','CLOSED')`.
2. `recomputePoReceived(sb, touchedPoItemIds)` (`:363`).
3. **Authoritative receiving warehouse** (`:370-392`). When the GRN's PO-linked
   lines all share ONE warehouse, that warehouse **overrides** the header and is
   persisted. The comment records the incident: a frontend default once fell back
   to the first warehouse (CHINA) and silently received PO-bound goods into the
   wrong one, so MRP for the real warehouse still showed a shortage.
4. **FX** (`:393-400`). Line prices are in the GRN's own currency; the FIFO lot
   must carry MYR, so `unit_cost_sen = toMyrSen(unit_price_centi, exchange_rate)`.
   For an MYR GRN the rate is 1 and this is a byte-for-byte no-op.
   **R2 rate guard (audit `docs/inventory-costing-integrity-audit.md`).** Create
   now REJECTS a non-MYR GRN whose currency has no positive master rate and no
   operator-entered rate, rather than storing `exchange_rate = 1` and capitalising
   the raw foreign figure at 1:1 — `422 foreign_rate_unset` ("Set the &lt;CUR&gt;
   exchange rate before posting this GRN"). Fires at `POST /`, `/from-pos`, and
   `/from-po-items` (`assertForeignRatePostable`, `scm/lib/fx-guard.ts`). A
   deliberately-entered operator rate of 1 still posts; only an UNSET master that
   defaults to 1 is refused. MYR is never affected.
5. **Landed-charge allocation** (`:401-411`). A `service` line (freight — no
   supplier, just description + amount) creates **no** inventory movement; its
   amount is pooled and spread across the goods lines by QTY / VALUE / CBM per the
   header `allocation_method`, persisted as `allocated_charge_centi`.
6. **The IN movements** (`:412-448`) — see §5.
7. **Three post-receipt reconciles**, all best-effort, all after the IN:
   `reconcileDropshipBatches` (`:460`), `reconcileUncostedOuts` (`:492`, the
   oversell retro-cost, scoped to shipments before `receiptCutoffTs`), and for
   each affected DO a `restampDoActualCost` + `restampSiFromDo` (`:474-511`).
8. `placeGrnLinesOnRacks` (`:516-519`) and `recomputeSoStockAllocation`
   (`:522-525`).

### Other mutation paths worth knowing

- **Confirm handler** (`postGrnHandler`, `:1682-1763`). Idempotent no-op on an
  already-POSTED GRN, and it deliberately records **nothing** in that case
  (`:1707-1712`). Refuses CANCELLED / CLOSED (`:1713`). Re-runs the over-receipt
  check that draft-create skipped (`:1717-1728`).
- **Cancel** (`:2033`). A DRAFT GRN short-circuits: flip to CANCELLED and reverse
  **nothing** (`:2058-2080`) — a draft committed no IN and no PO rollup, so
  reversing would drive stock negative. A POSTED GRN then passes two locks and an
  atomic `.neq('status','CANCELLED')` update (`:2107`) before the reversal.
- **Header PATCH** (`:2210`). Has **no** `grnHasDownstream` lock. What it does
  have is the warehouse-relocation block (`:2235-2280`): changing the warehouse on
  a POSTED GRN physically moves the stock (OUT of the old + IN to the new,
  carrying the same cost and source-PO batch), guarded by
  `grnReverseWouldGoNegative` on the old warehouse (`:2257`). Also calls
  `recostFromGrn` (`:2356`) when the rate changes.
- **Line edit** (`:2569`). On a POSTED GRN a qty or bucket change writes **delta
  movements**: a bucket change is OUT(old key, prev qty) + IN(new key, new qty);
  a plain qty change is a single IN or OUT for the delta (`:2775-2806`). Then
  `recostFromGrn` if price or bucket moved (`:2828`).
- **Line delete** (`:2839`). Locked by `grnHasDownstream` (`:2844`); on a POSTED
  GRN it writes a per-line reversing OUT carrying the receipt's batch (`:2957`).

---

## 4. Database

Schema `scm`. Baseline DDL `backend/scripts/scm-schema/2990s-full-schema.sql:371`
(`grns`) and `:335` (`grn_items`); the live tables carry columns added later
(`warehouse_id`, `exchange_rate`, `allocation_method`, `company_id`,
`invoiced_qty` / `returned_qty`, `rack_id`, `allocated_charge_centi`). The
authoritative in-code lists are `HEADER` (`grns.ts:529-534`) and `ITEM` (`:535-549`).

| Table | Role |
|-------|------|
| `scm.grns` | GRN header. `grn_number` (UNIQUE), `purchase_order_id`, `supplier_id`, **`warehouse_id`** (where the IN lands), `received_at`, `delivery_note_ref`, `status`, `currency`, **`exchange_rate`**, **`allocation_method`**, `subtotal_centi` / `tax_centi` / `total_centi`, `posted_at`, `company_id`. |
| `scm.grn_items` | GRN lines. `purchase_order_item_id` (the PO link that drives `received_qty`, the batch and the receiving warehouse), `material_kind/code/name`, `supplier_sku`, `qty_received`, **`qty_accepted`** (the qty that actually becomes stock), `qty_rejected`, `rejection_reason`, `unit_price_centi`, `discount_centi`, `line_total_centi`, `unit_cost_centi`, **`allocated_charge_centi`**, **`invoiced_qty`** / **`returned_qty`** (downstream consumption), `delivery_date`, `rack_id`, variant columns. |
| `scm.inventory_movements` | Where the IN lands: `movement_type='IN'`, `source_doc_type='GRN'`, `source_doc_id`, `source_doc_no`, `warehouse_id`, `product_code`, `variant_key`, `unit_cost_sen`, **`batch_no`** (= the source PO number). |
| `scm.inventory_balances` | Read by `grnReverseWouldGoNegative` (`:788-792`) to decide whether a reversal is safe. |
| `scm.purchase_order_items` | Upstream: `received_qty` is written by this module (`recomputePoReceived`, `:672`). |
| `scm.purchase_invoice_items` / `scm.purchase_return_items` | Downstream: they draw on `grn_item_id`, which is what moves `invoiced_qty` / `returned_qty`. |

Status vocabulary: `DRAFT | POSTED | CANCELLED | CLOSED`. Filter buckets
(`GRN_STATUS_BUCKETS`): `draft` = DRAFT, `posted` = POSTED+CLOSED, `cancelled` =
CANCELLED.

> **CHANGED 2026-08-17 — and this one MOVES A NUMBER, so read it before you are
> surprised by it.** CLOSED was in NO bucket, so a CLOSED GRN appeared under
> "All" and nowhere else. It now files under `posted` because of what the STOCK
> did: a CLOSED GRN was posted first, so its inventory IN stands — a CANCELLED
> one had its receipt reversed. `GoodsReceivedListV2`'s `statusFor()` already
> bucketed it as `posted` by fallback and now says so explicitly, so the tab and
> the row chip stop disagreeing. Membership both ways is pinned by
> `backend/tests/statusBucketsEnumMembership.test.mjs`.
>
> **It is a COVERAGE JUDGMENT, not a defect repair, and it was NOT asked for.**
> Unlike `SI_STATUS_BUCKETS` and `DO_STATUS_BUCKETS`, no value in this map was
> ever a non-member: DRAFT / POSTED / CANCELLED are all real `grn_status`
> members, so no GRN tab 500d and no GRN count was ever wrong. What changes is
> that the **Posted pill rises by the number of CLOSED GRNs** and
> `?status=posted` returns rows it never returned before. The alternative — a
> fourth `closed` pill, which needs a `closed` entry here plus a `StatusTab`
> arm in `frontend/src/pages/scm-v2/GoodsReceivedListV2.tsx` — was not taken and
> is a one-line reversal if the owner prefers it.

**Who sets each, and what it blocks (2026-08-16).** DB type is the
`scm.grn_status` ENUM (base body in `backend/scripts/scm-schema/2990s-full-schema.sql`,
`DRAFT` added by `migrations-pg/0043_scm_grn_status_draft.sql`); column default
is `POSTED`. **Every GRN status move is MANUAL** — nothing derives a GRN status
from another document. (The reverse is not true: this module is the ONLY writer
of the PO's `PARTIALLY_RECEIVED` / `RECEIVED`, via `recomputePoReceived`.)

| Value | Set by | Blocks |
|---|---|---|
| `DRAFT` | create with `asDraft: true`. Passing `status:'DRAFT'` in the body is refused: `Use asDraft:true to save a GRN as a draft.` | no stock yet |
| `POSTED` | create-as-posted, or `PATCH /:id/post` — all through the one chokepoint `postGrnAndRollup`, which CASes the flip | this is where the inventory IN lands |
| `CANCELLED` | `PATCH /:id/cancel` (DRAFT short-circuits; the active branch is atomic) | terminal |
| `CLOSED` | **nothing in `backend/src` writes it.** Read-only legacy terminal that still blocks a re-post. Filed under the `posted` filter bucket since 2026-08-17 — its stock IN stands | terminal |

Refusals the operator sees:

| Guard | Message |
|---|---|
| confirm a dead GRN | `GRN is <status> — cannot confirm.` (`cannot_confirm`) |
| re-post a CANCELLED / CLOSED GRN at the chokepoint | `grn_cancelled` / `grn_closed` (409, bare reason) |
| lost confirm race | `already_posting` (409) |
| line add / edit / delete on a dead GRN | `This GRN is <status> — its lines can no longer be changed.` (`grn_locked`) |
| cancel after the stock was consumed downstream | `Received goods were already consumed downstream (shipped / used in production) — cannot reverse this GRN. Make a Purchase Return instead.` (`grn_consumed_downstream`) |
| the GRN's own downstream lock (any line invoiced or returned) | `GRN has a Purchase Invoice / Return — delete it first to edit` |
| receiving against a non-live PO | `po_not_receivable` — **error code only, no human sentence.** The payload carries the offending status; the operator sees a bare code |

Migration-number caution: several in-code comments cite the **2990 source repo's**
numbering, which does not line up with `backend/src/db/migrations-pg/`. Verified
matches in this module's chain: `0082_scm_fx_landed_cost.sql`,
`0154_scm_oversell_retrocost.sql`, `0057_scm_dropship_do.sql`. Do not trust a bare
"migration NNNN" in a comment without checking the filename.

### `grn_items.variants` is a SNAPSHOT, and nothing sweeps it (2026-08-11)

`grn_items.variants` is copied from the parent PO line at receipt
(`create-migrated-documents.mjs:157`, and the UI post path likewise). After
that **no script has ever written it again**. `refresh-so-variants.mjs` writes
`mfg_sales_order_items`; `refresh-po-variants.mjs` writes
`purchase_order_items`; neither touches this table, and no parity check
compared the two until `diag-so-po-variant-divergence.mjs` grew Section E.

The consequence is the one every snapshot column has: **repairing the PO line
does not repair the receipt taken from it.** A wrong value frozen at receipt
survives every later correction of its parent, silently.

That is usually correct - a genuine difference between a receipt and its order
is history and must be preserved. The exception is a figure that could never
have been a measurement. Production, 2026-08-11: of 442 GRN lines carrying
variants, 331 agree with their parent, 110 differ plausibly (left alone), and
**one** held `divanHeight 151"` / `totalHeight 160"` where the parent reads
14"/23". `repair-grn-variant-snapshot.mjs` + Actions -> **Repair GRN variant
snapshot** restores only that class: out of the observed range, or equal to a
digit run of the fabric code bound on the same row, AND the parent agreeing
with its own AutoCount text. Everything else is listed, never guessed at.

---

## 5. Stock direction

**A Goods Received Note moves inventory IN.**

**When:** at the DRAFT → POSTED transition, inside `postGrnAndRollup`
(`:412-448`). A DRAFT GRN commits **nothing** — no stock, no PO rollup
(`:1272-1276`). Three routes reach that same helper:

| Path | Behaviour |
|------|-----------|
| `PATCH /:id/post` (`:1764`) | The explicit confirm. |
| `POST /` without `asDraft` (`:1471`) | Created POSTED and posted in the same request. |
| `POST /from-pos` (`:1491`) | Whole-PO convert; **auto-posts**, which is why the mobile wizard deliberately uses `POST /grns { asDraft:true }` instead when it needs per-line received qty (`MobileConvertWizard.tsx:370-374`). |

**What is written** (`:418-442`):
- One `IN` movement per goods line with `qty_accepted > 0`.
- **Service lines are filtered out** (`:419-421`) — freight never enters
  inventory; its amount was already allocated into the goods lines' lot cost.
- `variant_key = computeVariantKey(item_group, variants)` — received stock is
  bucketed by attribute composition.
- `unit_cost_sen` = the landed MYR cost: base (FX-converted) + the per-unit
  allocated freight share (`:434-435`).
- `batch_no` = the **source PO number** (`:440`), so a sofa set's components share
  a dye lot. NULL for manual (no-PO) lines.
- The write result is captured, and a failure is surfaced as `movementErrors` in
  the response (`:443-448`) — it used to be silently swallowed, leaving a GRN
  POSTED with stock not booked.

**Reversal — three different OUT paths, all writing `movement_type: 'OUT'`:**

| Trigger | Where |
|---------|-------|
| Cancel a POSTED GRN | `:2150-2172` — per line, carrying each line's own PO batch so two lines of the same SKU from different POs each reverse their own dye lot |
| Delete a line on a POSTED GRN | `:2957` — a precise per-line OUT |
| Change qty / bucket on a POSTED GRN line | `:2775-2806` — delta movements (bucket change = OUT(old)+IN(new); qty change = one IN or OUT for the delta) |
| Change the warehouse on a POSTED GRN header | `:2235-2280` — OUT of the old warehouse + IN to the new, same cost + batch |

Every one of those is best-effort and never un-does the document
(`:2181` is the canonical example). Every one of them also re-walks
`recomputeSoStockAllocation`, because stock arriving or leaving flips SO lines
between READY and PENDING.

The OUT counterpart for goods sent back to the supplier is the **Purchase
Return** (`/purchase-returns`), a separate module.

---

## 6. What locks and when

| Trigger | What stops | Enforced at |
|---------|-----------|-------------|
| Any line has `invoiced_qty > 0` or `returned_qty > 0` (a PI or PR draws on it) | line add, line edit, line delete, **and cancel** | `grnHasDownstream` (`:741-748`) called at `:2373`, `:2577`, `:2844`, `:2084` |
| The received stock has already been consumed downstream (shipped / used) | **cancel**, and the warehouse relocation on the header PATCH | `grnReverseWouldGoNegative` (`:768-808`) called at `:2100` and `:2257`. It compares live `inventory_balances` per `(warehouse, product, variant)` against what the reversal would take out; short ⇒ 409 with *"Make a Purchase Return instead"*. Best-effort read: a balance-query error does NOT block. |
| Status CANCELLED or CLOSED | confirm | `:1713` |
| Status POSTED, DRAFT excluded | over-receipt beyond the PO line's remaining | `verifyGrnOverReceipt` (`:602`), re-run at confirm `:1725-1728` |
| Status not DRAFT / (POSTED without children) | the whole page read-only (frontend) | `GoodsReceivedDetail.tsx:246` — `isLocked = !(status === 'DRAFT' || (status === 'POSTED' && !hasChildren))`; the page drops out of edit mode automatically if it locks mid-edit (`:253-258`) |
| Source PO belongs to another company | all three create paths | `firstCrossCompanyPo` (`:30-48`) — receiving another company's PO would post the stock and its cost into the active company's books |
| An **unlinked line for a material the header's PO already orders** | `POST /` and `POST /:id/items` | `findUnlinkedPoLines` (`lib/grn-unlinked-po-lines.ts`) → 409 `unlinked_po_lines` |
| A line would receive stock at **zero cost** while that SKU has been received at a real price before | confirm, and all three create paths | `checkGrnZeroCost` → `lib/zero-cost-receipt-guard.ts` → 409 `zero_cost_receipt`, carrying the offending lines and each SKU's known cost |

**Why that last one exists, and what it is NOT.** `grn_items.purchase_order_item_id`
is nullable so a free/manual receipt can land stock with no PO behind it — that
stays allowed and untouched. What is now refused is receiving THIS PO's own
material while leaving the link off: the stock goes in, `received_qty` does not
move, `verifyGrnOverReceipt` sees nothing, and the same delivery can be received
again. It is the receiving-side mirror of the delivery-side defect in
`docs/unlinked-line-duplicate-coe.md` (owner: *"包括 GR 那边也是"*). A production
scan on 2026-08-04 found **no** GRN in this state (UNVERIFIED as of 2026-08-13:
needs production data) — the guard is preventative here, corrective on the
delivery side.

**Why the zero-cost refusal exists.** Houzs suppliers price the GOODS RECEIVED
document, not the purchase order, so an unpriced PO line is normal paperwork
(live AutoCount: HOOKKA 2,264/2,264 PO lines unpriced, OHANA and DORSETTLOFT
100%). Nothing downstream puts the cost back: the zero reaches the FIFO
trigger's IN branch, which is `COALESCE(NEW.unit_cost_sen, 0)` — the
weighted-average fallback exists only in the ADJUSTMENT branch — so the lot
opens at zero, the OUT consumes it at RM0 COGS, and the margin report reads
100%. Once the unit ships that COGS is settled and must never be rewritten, so
the receipt is the last moment the cost is still changeable.

The rule does not need a free-gift flag, and there is none on the purchase side
anyway (`default_free_gifts` is entirely sales-side). A SKU that has **never**
been received at a non-zero cost is genuinely free — GWP pillows, demo units,
display furniture — and posts silently; a SKU that **has** carried money before
is refused, because on that one a zero is a missing price. `grn_items.zero_cost_ack`
(migration 0280) is the per-line override for the rare genuine freebie of an
item that normally costs money; it exists so nobody types a fake price to get
past the gate. A GRN carrying a non-zero service/freight pool is skipped, since
the landed allocation can lift a zero-priced goods line off zero and the
allocation is computed after this point.

**How an operator clears the refusal.** Two ways, and the 409 body names both in
its `remedy` array so the answer travels with the refusal:

1. enter the unit price from the supplier's goods-received document, or
2. tick **Received free** on the line and say why.

The tick is a per-line field on the receipt screen (`GoodsReceivedDetail.tsx`,
which `GoodsReceivedDetailV2` loads as its inline editor) and renders only while
the line carries no price — a permanently visible waiver next to every line is
the control people learn to tick without reading. It is deliberately NOT a
button on the refusal dialog: one click waiving a whole receipt is the reflex
the gate exists to prevent.

| surface | field | route |
| --- | --- | --- |
| create a receipt | `items[].zeroCostAck`, `items[].zeroCostReason` | `POST /scm/grns` |
| add a line | `zeroCostAck`, `zeroCostReason` | `POST /scm/grns/:id/items` |
| tick an existing line | `zeroCostAck`, `zeroCostReason` | `PATCH /scm/grns/:id/items/:itemId` |

All three go through `zeroCostAckColumns` (`lib/zero-cost-receipt-guard.ts`), the
single place that writes the four columns together: the tick, the reason, and
**who** ticked it plus **when** (`zero_cost_ack_by` / `zero_cost_ack_at`, stamped
from the session, never from the request body). Removing the tick clears all
three — a name left on an un-ticked line is an audit trail that lies. Both
`POST /scm/grns` and `POST /scm/grns/:id/items` build their insert from an
EXPLICIT column whitelist, so a field missing from that list is silently dropped;
that is why the acknowledgement is spread into both rather than assumed.

The refusal renders in one place for every caller — desktop Confirm, the mobile
convert wizard and the from-PO batch receive — in `vendor/scm/lib/authed-fetch.ts`
alongside the sofa hard stops, which is what keeps desktop and mobile saying the
same thing.

**The header PATCH is the exception**: it is NOT gated by `grnHasDownstream`. A
GRN with a downstream PI can still have its header edited, including a warehouse
change that physically relocates stock — that path is gated only by
`grnReverseWouldGoNegative` on the old warehouse (`:2257`). Stated as observed.

**Amendment path — no revision mechanism.** There is no `grn_revisions` table and
no `revision` column (contrast `purchase_orders.revision` +
`scm.po_revisions`, `docs/modules/purchase-order.md` §6). A wrong GRN is
corrected by editing while it is still editable, or by cancel (which reverses the
receipt) + a fresh GRN. Once a PI or PR has drawn on it, the sanctioned route is a
**Purchase Return**, not an edit.

---

## 7. The cost / money columns — frozen vs live

Everything is integer sen. The GRN is where a purchase's cost becomes the
**inventory lot cost**, so this table is the one that matters most.

| Column | Where | Frozen or live |
|--------|-------|----------------|
| `currency` | header | Copied from the source PO. |
| **`exchange_rate`** | header | MYR per 1 unit of the GRN currency; 1 for MYR. Set at create (`resolveGrnFx`, `:241`), editable on the header PATCH — and changing it triggers `recostFromGrn` (`:2356`). **The PO carries no rate; the GRN is where FX enters the money chain.** A foreign GRN with no positive master rate and no operator rate is now REFUSED at create (`422 foreign_rate_unset`, R2 guard) rather than stored at 1. |
| `allocation_method` | header | QTY / VALUE / CBM basis for spreading freight. `normalizeAllocationMethod` (`:408`). |
| `unit_price_centi` | line | In the **GRN's own currency**, not MYR. Live while the GRN is editable. |
| `discount_centi`, `line_total_centi` | line | Live; `recomputeGrnTotals` (`:566`) sums `line_total_centi` into `subtotal_centi` = `total_centi` (a GRN carries no tax). |
| **`allocated_charge_centi`** | line | The freight share folded into this goods line. Written by `computeAndStoreGrnAllocation` (`:272`) at post, recomputed by `reallocateGrnCharges` (`:319`). |
| `unit_cost_sen` on the movement / FIFO lot | `inventory_movements` | **Snapshotted at post**: `landedUnitCostMyr` = FX-converted base + per-unit allocated freight (`:434-435`). This is the lot cost the whole downstream margin chain draws on. |
| `qty_accepted` | line | The qty that becomes stock. `qty_received` and `qty_rejected` are record-keeping; only `qty_accepted` produces a movement (`:422`). |
| `invoiced_qty`, `returned_qty` | line | Written by the downstream PI / PR. They are the lock (§6) and they net out of `received_qty` (`:684-704`). |

**The recost cascade.** `recostFromGrn` (`backend/src/scm/lib/recost.ts:211`)
re-derives the authoritative cost for a GRN's received buckets and pushes it down
lots → consumptions → movements → DO → SI. The GR price is only a **fallback**;
the **PI line price is authoritative** (`recost.ts:250-256`), weighted-averaged
across all live PI lines per `grn_item`. DRAFT and CANCELLED PIs are excluded
from that aggregate (`recost.ts:269-272`).

Two read-failure decisions in that file are load-bearing and deliberately not
`?? default`: a failed GRN-rate read aborts rather than defaulting to rate 1
(`recost.ts:242-247` — rate 1 on an RMB GRN capitalises the raw RMB figure as if
it were ringgit), and a failed PI-lines read aborts rather than folding to "no PI"
(`recost.ts:259-266` — that would silently revert every lot to the un-invoiced
estimate).

`recomputeGrnTotals` (`:566`) **fails closed and never throws** (`:570-580`): a
failed read leaves the header unchanged instead of zeroing it.

---

## 8. Desktop and mobile files that must change together

| Concern | Desktop | Mobile |
|---------|---------|--------|
| List columns / filters | `pages/scm-v2/GoodsReceivedListV2.tsx` | `mobile/MobileModuleList.tsx` config `:1159` |
| Server pagination opt-in | `useGrnsPaged` | `mobile/MobileModuleList.tsx` `SERVER_PAGINATED` (`:327`) |
| Detail fields | `pages/scm-v2/GoodsReceivedDetailV2.tsx` (read) + `GoodsReceivedDetail.tsx` (edit) | `mobile/MobileModuleDetail.tsx` config `:324` |
| Post / Cancel actions | `GoodsReceivedDetail.tsx:416-459` | `mobile/MobileModuleDetail.tsx:535-542` |
| PO→GRN conversion + per-line received qty | `pages/scm-v2/GrnFromPo.tsx` | `mobile/MobileConvertWizard.tsx` (`target: "grn"`) — note the surfaces differ **by design**: desktop can pick lines, mobile converts the whole PO (`:60-61`), and mobile posts `asDraft:true` rather than the auto-posting `/from-pos` (`:370-374`) |
| Cache invalidation after a write | the hooks in `vendor/scm/lib/grn-queries.ts` (must include `['inventory']`) | `mobile/sharedInvalidate.ts:72` (`grns` roots + `STOCK_ROOTS`, which includes the SO roots) |

---

## 9. Performance summary

Optimized:
- Detail loads header + items in one `Promise.all` (`:1175-1178`).
- The list's status counts are four `head:true` counts in one `Promise.all`
  (`:911-916`).
- `total_centi` on the list is the stored header value, not a re-sum.
- Desktop list is server-paginated (50/page) with server-side search, sort and
  status counts.

Watch as data grows — the GRN list is the **most expensive of the four sibling
lists**, and structurally so:
- Its enrichment is a real **sequential chain**: `grn_items` (via `paginateAll`,
  so potentially several round trips, `:942-947`) → `grnLineDownstream` (`:961`).
  The second read needs the first read's item ids, so unlike the DO list it cannot
  be collapsed into one parallel wave.
- `grnLineDownstream` fans out over every line id on the page, not every GRN.
- The legacy unpaginated path still `.limit(500)` (`:856`) and is what
  `GrnNew.tsx` reaches through the PO hook.
- **`GET /outstanding-po-items` used to be one of those caps and was the worse
  kind.** Until 2026-08-17 it read `.order('purchase_order_id', {ascending:
  false}).limit(500)` and applied BOTH of its filters afterwards in JS.
  `purchase_order_id` is a **uuid**, so that ordering is arbitrary rather than
  newest-first, and the 500 was an arbitrary SAMPLE of the company's PO lines —
  spent mostly on lines that were never candidates. Measured against production
  on 2026-08-17 (workflow *Why is a PO not receivable (read-only)*, run
  32028603860, company HOUZS): **875 PO lines, 356 genuinely outstanding, and
  the picker could see only 188 of them — 168 outstanding lines were
  unreachable through the screen that exists to receive them.** It now filters
  the dead parent statuses in the QUERY (`.not('po.status','in','("DRAFT","CANCELLED")')`
  through the `!inner` embed, which bounds the read to open work) and **pages**
  rather than capping, so nothing is dropped without an error. Raising the number
  would not have fixed it: PostgREST caps a response at 1000 rows whatever
  `.limit()` says. Only the remaining-qty test stays in JS, because it compares
  two COLUMNS and PostgREST has no filter for that. The read lives in
  `backend/src/scm/lib/outstanding-po-lines.ts`, where
  `outstanding-po-lines.test.ts` pins the three properties that keep it honest
  — no `.limit()`, the status filter in the query, and a total sort order — and
  §2a records the rest of that module's contract, including the `scope` block an
  empty grid needs in order to say something true.

  **On the two modules.** #2367 (main) and this branch fixed the same read in
  parallel, as `outstanding-po-items.ts` and `outstanding-po-lines.ts`. Only the
  `-lines` module survives: keeping both would have left a suite whose header
  says *"three properties this must keep"* asserting them about code with no
  callers. Its three assertions were carried over as **behavioural** tests of
  `loadOutstandingPoLines` (a recording PostgREST stand-in), which is strictly
  more than the source-text form they replaced.

  **What that probe RULED OUT**, both of which read as likely from the code and
  would have sent the next person down the wrong path:

  | theory | why it is false |
  |---|---|
  | the PO carries a status the picker does not open | the detail screen's "Submitted" is a rendered label, but the column really is `SUBMITTED`. The status gate passed. |
  | the SO-to-PO conversion did not stamp `company_id`, and the fail-closed scope dropped the lines | header `company_id = 1`, both lines `company_id = 1`. Table-wide, **0** `purchase_order_items` disagree with their PO header and **0** are NULL. The conversion stamps correctly. |
- Free-text search cannot reach supplier name or PO number (`:886-893`) because
  those are embedded resources.
- `postGrnAndRollup` does a lot inside one request: PO recount, movement write,
  drop-ship reconcile, oversell retro-cost, per-DO restamp + SI restamp, rack
  placement, and a **global** `recomputeSoStockAllocation` (`:522-525`). All are
  best-effort, but they are all in the confirm's request path.

Cross-module context: `docs/perf-optimization-plan.md`. Route/permission
inventory: `docs/generated/`.

How this document's lines relate to the SO / PO / GRN / DO it was copied from,
which columns the migrated writer did and did not copy, and what a correction
applied upstream does NOT reach: `docs/sofa-document-chain-map.md`.
