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
| Desktop detail (edit) | `frontend/src/pages/scm-v2/GoodsReceivedDetail.tsx` | The inline editor. Lock logic at `:244-248`. **"Add manual item" (Edit + `!isLocked`, owner 2026-09-10)** posts a free line — an item the source PO never ordered, a supplier extra, a sample — via `POST /:id/items` with `purchase_order_item_id` null, mirroring the New-GRN manual line (supplier-binding-aware picker); the primary path stays convert-from-PO ("From Purchase Order"). Refused by the same `unlinked_po_lines` guard (§6) when the material IS on the parent PO, and by the zero-cost gate (§7) — both surfaced inline. Softens the earlier in-code "never by free add-line" note. |
| Desktop new | `frontend/src/pages/scm-v2/GrnNew.tsx` | Uses `usePurchaseOrders()` (the legacy unpaginated PO hook, `:156`). **"Add another item" now shows in EVERY mode (owner 2026-09-10)** — manual, from-PO-picks and single-PO — gated `canAddManualLine = isManual || !!supplierId`, so an item the PO never ordered can be received in the same create step (previously the button was `isManual`-only, hidden once you arrived from a PO). The extra line carries `purchase_order_item_id` null; the create path's `unlinked_po_lines` guard still refuses a hand-added material that IS on the header PO. |
| Desktop from-PO | `frontend/src/pages/scm-v2/GrnFromPo.tsx` | Multi-select over `/outstanding-po-items`. Two display rules changed 2026-08-21, both shared and neither local: the Warehouse column reads through `warehouseLabel` (`frontend/src/vendor/scm/lib/warehouse-label.ts` — code first, then name; the picker rows carry FLAT columns, so a one-line adapter wraps them rather than a second rule), and the variant line under each row is now LABELLED `Description 2` by the shared `VariantDescription` component. Neither changes what is read or written. |
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

**The failure rule (2026-08-21):** `usePostGrn` is the commit chokepoint for
inventory IN, and until this date it had an `onSuccess` and NO `onError` — three
of its four call sites pass none either, and the global `MutationCache`
(`frontend/src/lib/queryClient.ts`) carries only `onSuccess`. A storekeeper who
confirmed *"Inventory will be received into the warehouse"* and was refused saw
nothing at all. It now carries `onError: writeFailedAs('GRN not posted — the
stock was NOT received')`.

It also reads the IN-BAND failure: `PATCH /grns/:id/post` answers **200** with
`{ grn, movementErrors }`, so a refused inventory write is a success as far as
`onError` is concerned. `usePostGrn` now calls
`reportInBandFailure('GRN posted, but the stock was not received', data)` in its
`onSuccess`, the same way `useCancelGrn` has read `cancelErrors` since
2026-08-13. Pinned by
`frontend/src/vendor/scm/lib/post-commit-failures.test.tsx`; the trace is in
`docs/bugs/0495-post-grn-and-post-purchase-invoice-had-no-error-path-and-the.md`.

**The stock-side invalidation rule:** every mutation that can move inventory also
invalidates `['inventory']`. That is `usePostGrn` and `useCancelGrn`, and — since
2026-09-10 — the whole GRN CRUD block, each of which re-syncs stock server-side:
`useGrnFromPos` (auto-posts a whole-PO convert → IN), `useUpdateGrnHeader`
(warehouse relocation on a POSTED GRN → OUT+IN), and `useAddGrnItem` /
`useUpdateGrnItem` / `useDeleteGrnItem` (POSTED GRN → IN / delta OUT+IN /
reversing OUT). Until then those five invalidated only `['grn-detail']` +
`['grns']`, so a mounted Stock Card / inventory list showed stale on-hand after a
posted-GRN line change or a From-PO convert; pinned by
`frontend/src/vendor/scm/lib/grn-stock-invalidation.test.tsx`, traced in
`docs/bugs/0780-grn-stock-moving-mutations-did-not-invalidate-the-inventory.md`.
`useCreateGrn` is NOT in the set: its only caller (`GrnNew.tsx`) follows a
non-draft create with `usePostGrn`, which carries the invalidation. And because a
GRN's stock IN changes the PO's `received_qty` and status, `useGrnFromPos`
invalidates `['mfg-purchase-orders']` too and force-refetches the picker key.

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

> **Right-click on a list row** opens the same actions — see
> `docs/modules/document-conversion.md` §8a for the shape, the table of what
> every list offers, and the two absences that are deliberate.

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
| PATCH | `/:id` | `:2210` | Header edit — **can move stock** (warehouse relocation, see §5). **Company-scoped on BOTH halves** since #2086, 2026-08-13. **Field-level inherited lock since 2026-08-20 (§8 GAP-1):** once a live PI/PR exists, `supplier_id` / `currency` / `exchange_rate` / `allocation_method` freeze (the invoice/return was billed/costed against them); `received_at` / `delivery_note_ref` / `warehouse_id` / `notes` stay editable. Rule in `backend/src/scm/lib/grn-inherited-lock.ts` (`grnHeaderInheritedChanges` + `GRN_HEADER_INHERITED_COLS`, whose columns are sourced from the ONE rulebook `shared/document-policy.ts` so they can't drift), 409 `grn_header_inherited_locked`. **The refusal's human LABELS come from the same rulebook** (`GRN_LOCK_LABELS`) as of 2026-08-20 — they used to be a second copy typed inside `grnHeaderInheritedRefusal`, so a column added to the rulebook would have read as a raw `allocation_method` here while its siblings said "cost allocation method". The FE (`GoodsReceivedDetail.tsx`) splits the same way — `identityLocked` disables supplier/currency, own-stage fields stay open. |
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
`PATCH /grns/:id/items/:itemId` rewrites a line's `item_code` and never calls
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
     `received_at | grn_number | status | total_sen` (`:869`) + `grn_number`
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
4. **Assemble** (`:974-980`) — `total_sen` is the **stored header value**, not a
   re-sum of the lines. The comment at `:926-933` explains why: the old per-line
   `qty_accepted * unit_price` sum ignored `discount_sen`, so the list Total
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
   must carry MYR, so `unit_cost_sen = toMyrSen(unit_price_sen, exchange_rate)`.
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
   header `allocation_method`, persisted as `allocated_charge_sen`.
6. **The IN movements** (`:412-448`) — see §5. Each IN is stamped with
   `movement_date` = the GRN's **received date** (GL redesign item 4,
   2026-09-05): the month-end stock close replays value on the business date,
   so a GRN keyed on Sep 2 for goods received Aug 30 still counts in August's
   closing stock. Rows from callers that pass no date get today (MYT) inside
   `writeMovements`.
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

## 3a. `item_group` on a receipt line is the SKU's, not the request's (2026-08-22)

A GRN line's `item_group` is an **input to the stock bucket**, not a label:
`variant_key = computeVariantKey(item_group, variants)` composes a sofa's
fabric / seat / leg **only** for a sofa or bedframe group, so a line that reaches
`postGrnAndRollup` with a blank or `others` group keys its stock with the
PRODUCT CODE ALONE and the goods land in the unclassified bucket, where no sofa
order can ever see them (`docs/bugs/0514-…`).

**A receipt raised FROM a purchase order is now sent to AutoCount as one.**
`POST /grns` used to record every receipt it created as parentless — including
the ones the desktop "Transfer to Goods Received" screen produces, which is the
normal way a receipt is raised, since the picker navigates to the New form and
the New form posts here. It now asks `sourcePoIdsForGrn` (`lib/convert-parent.ts`)
whether the LINES name a purchase order, and enqueues a real `po_to_gr` when they
do. A receipt whose lines name none is still parentless and still says so. The
parent comes from `grn_items.purchase_order_item_id`, never from the request's
`purchaseOrderId` header hint — the line link is what `readConvertSourceKeys`
names, so the two cannot disagree (`docs/bugs/0524`).

Both hand-entry paths — `POST /grns` (the manual receipt) and
`POST /grns/:id/items` (a line added afterwards) — used to store
`it.itemGroup ?? null`, i.e. whatever the browser sent. They now resolve it from
`mfg_products.category` by item code through `lib/sku-category.ts`,
company-scoped for the reason `:287` gives (`code` is shared between the two
organisations). The caller's value survives only as the fallback for a
raw-material line, which has no product row. `description2` is built from the
SAME resolved value, so the printed text and the stock key cannot disagree.

The from-PO path (`:1897`) is unchanged and correct: it copies the PO line,
which is itself resolved from the SKU at PO-create time.

**The receipt also SAYS SO when a group throws attributes away.**
`keyedVariantWithWarning` logs the receipt number, the group it saw and the
attributes being dropped whenever a line carries a fabric or seat size that its
group does not compose. It reports and never repairs — composing regardless of
group would re-key every historical row in the ledger.

## 4. Database

Schema `scm`. Baseline DDL `backend/scripts/scm-schema/2990s-full-schema.sql:371`
(`grns`) and `:335` (`grn_items`); the live tables carry columns added later
(`warehouse_id`, `exchange_rate`, `allocation_method`, `company_id`,
`invoiced_qty` / `returned_qty`, `rack_id`, `allocated_charge_sen`). The
authoritative in-code lists are `HEADER` (`grns.ts:529-534`) and `ITEM` (`:535-549`).

| Table | Role |
|-------|------|
| `scm.grns` | GRN header. `grn_number` (UNIQUE), `purchase_order_id`, `supplier_id`, **`warehouse_id`** (where the IN lands), `received_at`, `delivery_note_ref`, `status`, `currency`, **`exchange_rate`**, **`allocation_method`**, `subtotal_sen` / `tax_sen` / `total_sen`, `posted_at`, `company_id`. |
| `scm.grn_items` | GRN lines. `purchase_order_item_id` (the PO link that drives `received_qty`, the batch and the receiving warehouse), `material_kind/code/name`, `supplier_sku`, `qty_received`, **`qty_accepted`** (the qty that actually becomes stock), `qty_rejected`, `rejection_reason`, `unit_price_sen`, `discount_sen`, `line_total_sen`, `unit_cost_sen`, **`allocated_charge_sen`**, **`invoiced_qty`** / **`returned_qty`** (downstream consumption), `delivery_date`, `rack_id`, variant columns. |
| `scm.inventory_movements` | Where the IN lands: `movement_type='IN'`, `source_doc_type='GRN'`, `source_doc_id`, `source_doc_no`, `warehouse_id`, `item_code`, `variant_key`, `unit_cost_sen`, **`batch_no`** (= the source PO number). |
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

### The migrated receipt's WAREHOUSE is copied from the book, not derived (2026-09-08)

The owner reads the receiving location on every goods receipt. Until 2026-09-08
the migrated ones did not carry AutoCount's: both writers COMPUTED it from the
purchase order — `create-migrated-documents.mjs:151`
(`g.items[0].warehouse_id ?? g.po.purchase_location_id`) and
`reshape-migrated-grns.mjs:653` (the same rule in the pair-grain shape). A
migration copies; it does not compute.

`backend/scripts/lib/ac-gr-location.mjs` is now the one place that answers "where
did AutoCount put these goods". Three rules live there and all three are load-bearing:

1. **Only real `GRDTL` rows count.** `data/ac-stock-layers.json.gz` carries
   `{ItemCode, Location, SrcDoc, Src:'GR'}` and looks like a receipt location; it
   is where the units are NOW. Of 274 cells carried by both it and a real `GRDTL`
   row, 16 disagree and **every one of the 16 moves KL/PG to a DISPLAY or SERVICE
   location** — a showroom transfer after the receipt. The layers are excluded.
2. **The location map is IMPORTED**, never re-typed — `SALESLOC` from
   `lib/ac-stock-compare.mjs`. The book writes `PG`; the ERP calls it
   `PG WAREHOUSE`. A second copy of a location map is how stock silently moves
   between branches.
3. **A miss is UNKNOWN, not agreement.** The GR export only started selecting
   `GRDTL.Location` on 2026-09-08 (`export-ac-reimport.py`, `grrefs`), so older
   cuts answer for part of the corpus. The writer falls back to the derivation
   and says so in its log; it never reports a fallback as a copy. An ambiguous
   receipt — two locations, and `scm.grn_items` has no warehouse column — falls
   back rather than taking the first.

Measured 2026-09-08 by the resolver itself: of 214 in-scope AutoCount receipts the
book can answer for **82**, and **all 82 equal the derived value — 0 differ**
(238 of 1,019 reference rows, 97 of 400 receipt x order pairs, same result). Of
the rest, 129 have no GRDTL location on this cut and **3 used more than one
location for one receipt** — `GR-003512` (KL + SRW), `GR-004812` (KL + PG),
`GR-005062` (KL + PG + SRW) — which the header cannot represent and the resolver
refuses by name. 0 of 318 in-scope purchase orders have received lines in more
than one location. Read-only probe: `check-gr-receipt-location.mjs` + Actions ->
**GR receiving location check (read-only)**. Rule pinned by
`backend/tests/acGrLocation.test.mjs`. Ledger `0677`.

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

## 4d. Migrated goods receipts carry the ACCOUNT BOOK's shape (2026-09-07)

Owner, on being offered three shapes: 「不是说过了吗？是 A 的，不过只是把那些需要的搬
进来，不需要的不需要搬」 — if AutoCount received a purchase order in three
deliveries, the ERP shows three receipts, with the book's own dates and
quantities, for the in-scope set only.

**What it replaced.** `create-migrated-documents.mjs` wrote ONE goods receipt per
PURCHASE ORDER, built from `purchase_order_items.received_qty`, stamped
`received_at = CURRENT_DATE`. Measured on production 2026-09-07 (`check-gr-shape`,
run 34135520445): 320 documents, every one dated the day the migration ran,
against a book that received 318 in-scope purchase orders in **400 (receipt x
purchase order) pairs across 214 receipts** — 70 of those purchase orders in more
than one go, 61 of them on genuinely different dates.

**The grain is the PAIR, not the receipt, and that is structural.**
`scm.grns.purchase_order_id` is a SINGLE purchase order, and 51 of the 214
receipts cover more than one in-scope purchase order (`GR-000201` covers 17). One
ERP document per AutoCount receipt is therefore impossible without a schema
change. The pair delivers what was asked for WITHIN each purchase order: the
book's split, the book's dates, the book's quantities.

**Two columns, and they are not the same thing.**

| column | holds |
|---|---|
| `scm.grns.linked_ac_docno` | the **purchase order's** AutoCount number. Named as if it were the receipt's by mig `0276`; it never was, and ten scripts read it the true way. |
| `scm.grns.linked_ac_gr_docno` | the **receipt's** AutoCount number. Added by mig `20260907T2345_grn_linked_ac_gr_docno.sql`. Several rows may share a value — the pair `(linked_ac_gr_docno, purchase order)` is what identifies a document. |

**The writer is `backend/scripts/reshape-migrated-grns.mjs`** + Actions ->
**Reshape migrated goods receipts (plan by default)**. Plan by default, `CONFIRM`
phrase on apply, a restorable JSON dump of every migrated receipt written BEFORE
anything moves in both modes, and a fresh-connection verify that asserts each
document's date, line count and units rather than a row count.

**Never delete, only retire.** A receipt whose pair is in the plan is UPDATED IN
PLACE — same id, same number, same place in every relationship map. One whose
pair is not is CANCELLED by a **direct status flip**, not by
`PATCH /:id/cancel`: that route has zero occurrences of `migrated_no_stock` and
would write a reversing inventory OUT for every line (879 units across the 320).
Its guard `grnReverseWouldGoNegative` PASSES here, because the units really are
on the shelf — they came from the AutoCount balance snapshot, not from this
document, and the guard cannot see the difference. The route is the unsafe path,
not the outcome.

**The purchase-order LINE is left UNSET on the lines the book cannot decide.**
AutoCount records the receipt, the item and the quantity; it does not record
which purchase-order line was received (`GRDTL.FromDocDtlKey` is 0 of 21,746
rows, agreed by two independently-cut extracts). Where a purchase order carries
an item code ONCE the receipt line resolves exactly. Where it carries the same
code twice, `purchase_order_item_id` stays NULL and the line says so in its own
`grn_items.notes`, with the document's `notes` naming every such line. Owner
ruling on those lines: 「跟 autocount 一样」. Filling the first matching line
would be inventing an attribution, and the total quantity per (purchase order,
item) is identical either way, so stock and MRP are unaffected.

**But an unattributed line still carries the ERP's OWN item code, not the
book's** (2026-09-08). Leaving the purchase-order LINE unset is the ruling above;
leaving the item CODE untranslated was a defect. An attributed line copies
`purchase_order_items.item_code`, which the PO importer had already resolved
through `backend/scripts/data/autocount-erp-mapping-1561.csv`. The unattributed
arm had nothing to copy and fell back to AutoCount's raw `ItemCode`, so company-1
receipt lines read `HOK-1007 (HF)(W) (SP)` where the ERP catalogue spells that
product `CODY 2.0 (F)-(SP)`, and `material_name` inherited the same string. The
fallback now reads the same mapping file with the same two rules every other CSV
item-code writer applies — the **sofa alias fold at read time**
(`aliasFoldsForCatalog`; only a mapped code the catalogue LACKS folds, and only
onto one it HAS) and the **catalogue guard at write time** (`nonCatalogRefs` and
a non-zero exit, printed BEFORE the dry-run return so the plan is known
unwritable while it is being read). Where the map is silent the book code stands
and the guard decides. `material_name` comes from the ERP product where the code
resolves.

Two lookups deliberately keep following the RAW code: the money carry
(`carryByPo`) and the invoiced-quantity carry (`billed`) are keyed on what is ON
DISK, and rows written before this change hold the untranslated code — a
translated key would miss them and silently re-derive the price from the book.

**The rows already written are repaired by
`backend/scripts/repair-migrated-grn-item-codes.mjs`** + Actions -> **Repair
migrated GRN item codes**. It touches `item_code` and `material_name` only, on
company-scoped `migrated_no_stock` AutoCount-linked receipts, and ONLY where
`purchase_order_item_id IS NULL` — an attributed line's code has a source and is
not this script's to re-decide. A row is rewritten only when the mapping gives a
translation AND the catalogue carries it; anything else is LEFT and counted,
because replacing a wrong-but-traceable code with an orphan is a worse row
(`docs/bugs/0577`). No stock moves: the FIFO trigger is `AFTER INSERT ON
scm.inventory_movements`, migrated receipts have none, and no quantity, price,
date or status column appears in the `UPDATE` — asserted before the write and
re-asserted on a fresh connection after it. PLAN by default; `APPLY=1` +
`CONFIRM="REPAIR GRN ITEM CODES"` writes. Full trace:
`docs/bugs/0691-the-goods-receipt-reshape-wrote-autocount-s-own-item-code-on.md`.

**`purchase_order_items.received_qty` is NOT written by the reshape.** The plan
compares what the book's receipts add up to per purchase-order line against the
number the column holds today, and prints every difference — so an unattributed
line's effect on a future `recomputePoReceived` is visible now rather than
discovered later.

**The money is CARRIED, never recomputed — and the price stamp runs AFTER.**
`stamp-migrated-source-prices.mjs` owns what a migrated receipt line is worth,
and the money it writes is on the AutoCount RECEIPT line, not on the purchase
order behind it (`docs/bugs/0674`: on all 180 zero-priced migrated receipt lines
the book's own purchase-order line reads `UnitPrice 0, SubTotal 0`). The reshape
decides no price: it carries `unit_price_sen` as-is and shares `discount_sen`
out by quantity, so a line split across two receipts keeps the same money per
unit. It looks the price up by `(purchase-order line, item code)` first and
`(purchase order, item code)` second — the second is what an unattributed line
uses, and it is not an invention, because every candidate line shares the code
and therefore the price. **Re-dispatch "Stamp migrated source prices" after the
reshape**: its selection is `unit_price_sen = 0`, and the new grain makes MORE of
it stampable, because its partial-mirror refusal exists precisely for the
one-document-per-purchase-order shape the reshape replaces.

**The run prints the BOOK's own total beside its own — and that is the only
number that settles anything.** For a full day the run ended on a bare
`RM 210,513.43 today; this plan writes RM 461,371.95`, and that unexplained 119%
blocked the apply three times (`docs/bugs/0682`). The two figures were not
comparable in two independent ways: `moneyBefore` sums `line_total_sen` over ALL
320 migrated receipts, while `moneyAfter` computes `qty x price` over the 400
PAIR documents — and 73 of the 320 are `untouched`, so they sit in the "before"
and **survive**, carrying RM 124,729.00, 59% of the whole "before". On top of
that, 276 of 591 lines hold a real `unit_price_sen` and a `line_total_sen` of
**0**, so the "before" read a broken column while the "after" read a product.
Like for like the 247 documents actually replaced are worth RM 249,691.95, not
RM 85,784.43.

So the MONEY section now states AutoCount's own `GRDTL.SubTotal` for exactly the
pairs it is writing, splits the headline apart, and prints a verdict. **A delta
between two states of our own system cannot tell a correction from a
double-count; only the book can.** Two offline tests decide it, both in
`backend/scripts/audit-gr-reshape-money.mjs` (no database, no network, no
`node_modules`, so it re-derives on a bare checkout):

| test | what it asks | measured 2026-09-08 |
| --- | --- | --- |
| **partition** | does any receipt line land on more than one pair? | **0 of 567** — each `GRDTL` row carries its own `FromDocNo`. Unlike `linked_ac_dtlkey`, where one book line owns several ERP rows (one per sofa compartment) and a repair nearly wrote RM 2,216,501 of invented revenue |
| **ceiling** | what does the book say those pairs are worth? | **RM 574,763.43** (214 receipts, all MYR at rate 1). The plan writes RM 461,371.95 — **RM 113,391.48 BELOW**. A double-count cannot land under the book |

If `moneyAfter` ever exceeds the ceiling the run says so in those words and the
plan is not to be applied.

**What it unlocked — measured, not predicted.** `check-ac-erp-reconcile.mjs`
printed *"GR DATA — line and money comparison NOT APPLICABLE"* and stopped,
because the quantity was derived and the grains did not match. Both reasons are
gone, so the GR section now compares line count, item code and QUANTITY at pair
grain. The unit PRICE is still taken from the purchase-order line and is reported
as DECLARED, not as a gap.

The reshape was **applied to production 2026-09-08 09:00 local** (run
34175100153: created 153, updated 247, cancelled 0), and the reconcile then read
**`GR DATA (400 documents on both sides, 506 lines paired)`** — absent 0, phantom
0, line-count differs 0 of 400, quantity differs 0 of 400, unit price differs
0 of 400; item code 103 of 400 and document total 109 of 400 remain, of which the
run attributes 100 to documents carrying zero money in the ERP against a valued
book line — `stamp-migrated-source-prices.mjs`'s to close. **44 of 400 could not
be line-matched and are UNVERIFIED, not verified-clean.** Full evidence with
denominators in `docs/bugs/0675`.

### The item-code count was measuring the CHECKER, not the receipt

**`scm.grn_items` carries no AutoCount line number.** Migration
`0280_scm_ac_line_keys_downstream.sql` added `linked_ac_dtlkey` to this table and
says in its own header that nothing backfills it; the reshape's
`INSERT INTO scm.grn_items` does not write it either, although the plan it writes
from holds the book's `DtlKey` on every item. So `check-ac-erp-reconcile.mjs`
hardcodes `NULL::bigint AS ac_dtlkey` for the GR lane and has nothing to pair a
receipt line on.

Its keyless fallback zips on `(qty, unit price)`, then `qty`, then document
order. A migrated receipt's price comes from the purchase ORDER by design, so the
first pass misses; two qty-1 mattresses then land in one `qty` bucket and
whichever row postgres returned first takes the first book line. **Every sample
the reconcile printed is a straight transposition** — `DtlKey 917594` is
`AK-IMMORTAL MATT (K)` and we answer `AKEMI ULTIMATE MATT (K)`, `917604` the
exact reverse.

The verdict that survives this is a SET question, and it is now computed and
reported per document: **is the book-side item-code multiset equal to the ERP-side
one?** Equal means both sides name the same products in the same quantities and
only the correspondence is unknown — those move to the summary's `same-goods`
column. **Unequal means a product is genuinely wrong, and it stays counted and is
printed louder as an impostor**, because the identical shape on the sales and
purchase side was NOT an artefact: 61 of 111 were the wrong product.

Sofa documents are excluded from the measurement outright — one book line becomes
one ERP row per compartment, so the two multisets are not commensurable — and
they keep the existing declared-decomposition path.

`docs/bugs/0693-the-reconcile-guesses-which-goods-receipt-line-is-which-and.md`
carries the trace.

### THE KEYS LANDED — 2026-09-08 14:22 (+08), and everything above is now HALF true

**The root fix named in the paragraph this replaces is DONE.**
`backfill-ac-downstream-line-keys.mjs` (run `34194376108`) stamps
`linked_ac_dtlkey` from the book, and `check-ac-erp-reconcile.mjs` reads the
column instead of the `NULL::bigint` constant. Production, measured on run
`34199483652` (2026-09-08 15:28 +08): **563 of 636** receipt lines carry a key,
**371 of 400** documents are fully keyed, and **0 stored keys disagree with the
derived one**. So a receipt's lines are now paired for real, not zipped, and the
write-back can name the line an operator changed.

**What did NOT go away is the reason to read this section: 73 lines are still
unkeyed, and the backfill refuses them on purpose.** It stamps only where the
book FORCES the pairing (`lib/ac-forced-line-pairing.mjs`), and the commonest
refusal is the book's own doing — *"the book has 2 lines of this item at this
quantity and they are NOT identical (2 distinct price/location/Desc2
combinations), so which is which is unknowable"*. 29 receipts are in that state.

**The state that did not exist before and now does is PARTIALLY keyed**, and it
broke the classifier: `splitGuessedItemCodePairing` asked the DOCUMENT whether it
had a key, so one keyed line answered for the unkeyed ones beside it and their
guessed differences were counted as wrong products — silently, not even printed.
It now asks the LINE. `docs/bugs/0704-*.md`; the whole goods-receipt / invoice
remainder is classified one row per document in
`docs/cutover-gr-iv-pi-remainder-2026-09-08.md`.

**A receipt's MONEY is a separate debt and it is still open.** Four migrated
receipts carry a non-zero total that is not the book's, three of them exactly
4/3 of it, because `grn_items.unit_price_sen` comes from the purchase-ORDER line
and AutoCount's line discount was dropped on import. **RM 2,119.50 more than the
supplier billed.** `docs/bugs/0705-*.md` names the shape of the repair and why it
is not this module's convert path.

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

**Every one of those four OUT paths is LINE-derived, and that is the trap.** They
read `grn_items` and write the opposite of what the lines say. That is correct
for a receipt whose post wrote the matching IN, and wrong for one whose post
wrote nothing — see 5b.

---

## 5a. `ON_HOLD` — a paperwork pause, never a stock event (mig 0319)

Added 2026-08-21 (owner: 「GR ... also hold」).

**It moves no stock, and that is the point of preferring it to a cancel here.**
The inventory IN fires at the DRAFT -> POSTED transition and a CANCEL writes the
reversing OUT; holding a posted GRN changes no movement at all. The goods are in
the warehouse either way — what stops is the paperwork.

**What it blocks:** a held GRN cannot become a Purchase Invoice.

> **THAT BLOCK USED TO COME FREE AND NO LONGER DOES — mig 0324, 2026-08-22.**
> This paragraph said the billable-GRN read `.eq('status','POSTED')` excluded a
> held GRN "with no new code", and that was true only while the hold OVERWROTE
> the status. Since the hold became a MARKER beside the status (owner:
> 「我们的hold是给我们知道一个 order hold这的」) a held GRN reads `POSTED`, so
> `purchase-invoices.ts` checks `on_hold` explicitly on all three billing paths —
> `/outstanding-grn-items`, `from-grn-items` and `from-grn`, the last two
> refusing with `grn_on_hold` (409). Missing one bills a supplier for a receipt
> somebody deliberately stopped.
>
> The GRN's hold is written by `PATCH /:id/hold` — its first working hold of any
> kind, because the status added on 2026-08-21 had no writer anywhere. A held
> POSTED GRN is still POSTED, so the "paperwork pause, never a stock event"
> promise above is now literally true rather than approximately.

`GoodsReceivedDetailV2`'s `effectiveOf` names it explicitly. Its fall-through is
`draft`, so a held receipt would otherwise have read as an un-posted DRAFT — the
opposite of the truth, since a held GRN has already posted and its stock is in.

---

## 5b. `migrated_no_stock` — a POSTED receipt that posted no stock (mig 0276)

The 320 goods receipts carried over from AutoCount at the cutover are **POSTED
with no inventory movement behind them, deliberately**: on-hand entered the ERP
once through the AutoCount balance snapshot, which already counts every past
receipt as IN. Measured on production 2026-09-07 (Actions -> *GR shape check*):
**0 movement rows, 0 units** behind all 320.

So this module carries a second document class that commits no stock, alongside
DRAFT — and unlike DRAFT it is POSTED, so every status gate lets it through.
`migrated_no_stock` is now read at **five** sites in `grns.ts` and the stock
effect is skipped exactly as it is for a draft:

| Site | What is skipped |
|---|---|
| `PATCH /:id/cancel` | the reversing OUT per line, and the rack reversal |
| `PATCH /:id` | the warehouse-relocate OUT + IN |
| `POST /:id/items` | the IN for the added line |
| `PATCH /:id/items/:itemId` | the delta IN / OUT (`inventoryChange` stays false) |
| `DELETE /:id/items/:itemId` | the reversing OUT for the removed line |

**Paperwork is NOT skipped** — the PO `received_qty` recount, the audit row, the
AutoCount outbox enqueue and the header money recompute all still run. Only the
stock moves are suppressed, and the cancel audit note says so instead of claiming
a reversal that did not happen (`qtyReversed` is stamped 0, not the line total).

**`grnReverseWouldGoNegative` is NOT a second line of defence here, and reading
it as one is what let this ship.** It asks whether the units are on hand; for a
migrated receipt they are, having arrived by the snapshot rather than by this
document. It PASSES, so the phantom OUT is written and every guard in §6 reads as
satisfied. It is now skipped for these documents for the same reason it already
skips service lines: with no IN to reverse, *"the goods were already consumed
downstream"* names a cause that does not exist.

Was it ever hit in production? **No. Measured 2026-09-08 — stock is CLEAN.**
`backend/scripts/check-migrated-cancel-exposure.mjs` + Actions -> *Migrated
cancel exposure (read-only)*, run
[34189651181](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34189651181):

```
movements behind the 473 migrated goods receipts:   0 row(s), 0 units
movements behind the 173 migrated delivery orders:  0 row(s), 0 units
STOCK — CLEAN. 0 movement rows behind 646 migrated documents.
CANCEL audit rows on migrated documents: 0
```

So the guard above is **preventive, not a repair** — there is nothing to
un-post. Had it fired, the run's Q5 puts the cost at 1,334 units on the receipt
side and 1,245 on the delivery side.

**Read the probe's history before trusting a past "we checked".** It had never
once been dispatched, and the first dispatch CRASHED on the movement query —
`COALESCE` over the `scm.inventory_movement_type` enum is refused by Postgres
before any row is read, so it could never have answered. Fixed 2026-09-08
(`::text` at both sites). Ledger:
`docs/bugs/0675-a-migrated-goods-receipt-cancelled-reversing-879-units-it-ne.md`
and `docs/bugs/0698-the-migrated-cancel-exposure-probe-could-never-have-answered.md`.

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

**Both remedies exist on the phone too (2026-08-20).** They did not until then,
and that is the shape of the defect: `zeroCostAck` appeared NOWHERE in
`frontend/src/mobile`, `MobileModuleDetail.tsx`'s `grns` case offered only Post
and Cancel, and `MobileConvertWizard.tsx`'s own copy of the message ended "open
the receipt on desktop". A receiver on the warehouse floor got a correct,
readable refusal naming two fixes and neither of them on the screen in their
hand. The refusal itself rendered fine on both surfaces — the gap was the remedy.

- `frontend/src/mobile/MobileGrnZeroCost.tsx` is the phone's remedy: the 409
  opens a bottom sheet with ONE CARD PER REFUSED LINE carrying a unit-price box
  and a "Received free" tick with its reason, then writes each through the same
  `PATCH /scm/grns/:id/items/:itemId` and re-runs `PATCH /scm/grns/:id/post`.
  The per-line rule above is preserved literally: there is no waive-all control,
  and Post stays disabled until every listed line carries a price or a tick.
- `frontend/src/vendor/scm/lib/zero-cost-refusal.ts` is the one reader of the
  409 body. `authed-fetch.ts` composes the operator's sentence through it
  (moved, not rewritten) and now also attaches `status` + the raw body to the
  thrown error — parsing the refusal and discarding the parse is what left a
  surface able to show it and nothing else.

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

**Every refusal that precedes a write RELEASES the idempotency key.** `GrnNew`
sends one `Idempotency-Key` per mount, so a refused submit CLAIMS that key
against the payload it was refused for — and the corrected payload then no
longer matches it. Until 2026-08-18 that meant the two remedies above were
unreachable: acting on "enter the unit price" produced 409
`idempotency_key_reused`, and the only way out was a page reload that threw the
whole receipt away. Every deterministic refusal in `grns.ts` had the same dead
end, not just the zero-cost one — `warehouse_required`, `qty_exceeds_remaining`,
`po_not_receivable`, `grn_locked`, the child and consumed locks.

Every refusal at or above one of this file's nine audit pre-flights now answers
through `refuseWithoutWriting(c, body, status)`
(`backend/src/scm/lib/no-write-refusal.ts`), which calls
`markIdempotencyNoWrite(c)` (`backend/src/middleware/idempotency.ts`) and makes
the middleware DELETE the claim. The pre-flights are the boundary because they
already sit "strictly before the handler's FIRST mutating call"; the zero-cost
exits, which sit past a write, keep the narrower
`refuseZeroCostReceipt(c, body, { nothingWritten })` wrapper, where
`nothingWritten` is a required argument: the three single-document routes pass
`true` (each deletes its `grn_items` and `grns` rows first), and
`POST /from-po-items` passes `created.length === 0`, because it raises one GRN
per supplier bucket and an earlier bucket can have committed its document, its
stock IN and its AutoCount conversion before a later one was refused.

**The release is never inferred from the status**, because several routes here
return a 4xx after a partial write. And the client must never infer it either:
the middleware answers `idempotency_key_reused` on a payload-hash mismatch
alone, so that code is also what a caller gets after a COMMITTED 201 — the body
carries `completed_status` saying which. A changed payload sent while the first
request is still running answers `idempotency_in_flight`. The operator copy for
`key_reused` therefore says refresh and check, never "press Save again".
Pinned by `backend/tests/grnPreWriteRefusalsReleaseKey.test.ts` (no pre-write
refusal missed) and `backend/tests/idempotencyRefusalRelease.test.ts` (the
release, the replay-after-success and the collision answers, at runtime).

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
| `currency` | header | Copied from the source PO (`resolveGrnFx`). **`CNY` is a valid value since 2026-09-07** (mig `20260907T2330`) — the migrated purchase order `HC-PO-009335` is a Chinese-yuan document and the ERP used to label it MYR. `CNY` and the older `RMB` are the same currency under two names and BOTH are accepted; the migration copies the AutoCount book's code rather than translating it. `GoodsReceivedDetail.tsx`'s currency select lists CNY for a reason that is not cosmetic: a stored value missing from the list renders the select BLANK and the next header save silently rewrites it. **No `scm.currencies` row exists for CNY on purpose**, so `assertForeignRatePostable` reads a null master rate and REFUSES the receipt (`422 foreign_rate_unset`) until a real rate is entered — a seeded rate of 1 would have let a yuan figure capitalise as ringgit, which is the R2 mis-cost that guard exists to stop. Ledger `0674`. |
| **`exchange_rate`** | header | MYR per 1 unit of the GRN currency; 1 for MYR. Set at create (`resolveGrnFx`, `:241`), editable on the header PATCH — and changing it triggers `recostFromGrn` (`:2356`). **The PO carries no rate; the GRN is where FX enters the money chain.** A foreign GRN with no positive master rate and no operator rate is now REFUSED at create (`422 foreign_rate_unset`, R2 guard) rather than stored at 1. |
| `allocation_method` | header | QTY / VALUE / CBM basis for spreading freight. `normalizeAllocationMethod` (`:408`). |
| `unit_price_sen` | line | In the **GRN's own currency**, not MYR. Live while the GRN is editable. |
| `discount_sen`, `line_total_sen` | line | Live; `recomputeGrnTotals` (`:566`) sums `line_total_sen` into `subtotal_sen` = `total_sen` (a GRN carries no tax). |
| **`allocated_charge_sen`** | line | The freight share folded into this goods line. Written by `computeAndStoreGrnAllocation` (`:272`) at post, recomputed by `reallocateGrnCharges` (`:319`). |
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

## 7b. The AutoCount outbox helper — and why its client is explicit

`queueAcGrnEdit` is the thin wrapper every GRN write uses to tell AutoCount the
document changed. Four call sites: the header PATCH, line add, line edit, line
delete.

It lives in **`backend/src/scm/lib/ac-grn-outbox.ts`**, not in `grns.ts`. It was
moved out on 2026-08-20 because the file-size ratchet refused the growth its
explanatory comment added — and the gate's own message names moving new code
into a module as the way out, which is the better answer anyway: the next GRN
route to be converted imports the same helper instead of re-deriving the rule.

**Its signature is `(c, sb, id, retire)` and the `sb` is REQUIRED.** It used to
read `enqueueEdit(c.get('supabase'), …)` — it reached past its caller for the
ordinary PostgREST client.

That is invisible and harmless while every caller is an ordinary route body. It
stops being harmless the moment a caller runs inside `runScmPgCommand`: the GRN
row would be written INSIDE the transaction while the outbox row committed
OUTSIDE it, so a rollback leaves AutoCount instructed to edit a line that still
exists. The two must land together or not at all.

Required rather than optional is deliberate, per `CLAUDE.md`: a parameter that
DECIDES something is never optional. This one decides which transaction the row
belongs to, and optional would let a future transactional caller silently keep
the wrong client with no compile error — the `optional-param-noop` class —
`docs/bugs/0098-bug-class-optional-param-noop-an-optional-argument-that-deci.md`.

Two checks watch this and both have already fired on it:
`backend/tests/autocountWritebackCells.test.ts` pins the ARGUMENTS of all four
call sites (a signature change cannot slip past), and `audit:ac-coverage`
regenerates `docs/generated/autocount-coverage.md` from where the calls actually
live.

**How those four GRN cases are anchored, and the trap next to them.** Each one
slices the source from `grns.patch('/:id',` (or the sibling route line) to that
handler's own tail. That works while the route is registered with its body
INLINE — which all four GRN handlers still are. The DO case in the same file was
not: its add-line handler became a named export on 2026-08-23, which moved the
`deliveryOrdersMfg.post(...)` registration to a one-line call BELOW the body, so
the start anchor matched and the end anchor no longer followed it. The pin failed
on a handler whose `queueAcGrnEdit`-equivalent had not moved. If a GRN handler is
ever exported for a test to drive, repoint its anchor to the `export const` line
at the same time. Full note: `docs/modules/autocount-writeback.md`.

Background: `docs/ALLOCATION-DURABILITY-PLAN.md`.

## 7c. Two GRN routes run in a TRANSACTION - line DELETE and CANCEL

`DELETE /:id/items/:itemId` and `PATCH /:id/cancel` are each wrapped in
`runScmPgCommand` (both 2026-08-20). They are the first two of the six GRN
write paths to get there.

### The line DELETE

Everything it writes — the line delete, the reversing stock OUT, the entity
audit, the AutoCount outbox row and the SO-allocation recompute request — **commits
together or not at all**.

**What that fixes.** The recompute used to be a best-effort call after the
write: `recomputeSoStockAllocation(sb)` in a try/catch. A Worker that died
between the stock reversal and that call left stock moved and SO lines still
marked READY, with **no queue row and no retry** — wrong, silently, until an
unrelated mutation happened to sweep. Now the queue row is written by
`scheduleStockAllocationAfterCommand` inside the same transaction, so that state
is unreachable.

**What it costs, for BOTH routes.** `runScmPgCommand` answers **503
`scm_pg_command_required`** where `DATABASE_URL` is absent. Deliberate: refusing
is the honest failure when the alternative is half-writing a stock reversal.

A second consequence to know before converting the next one: a NON-2xx response
from the body also rolls the transaction back and is then returned unchanged
(`if (!response.ok) throw new CommandRollback(response)` in
`pg-supabase-transaction.ts`). So every `refuseWithoutWriting` in a converted
route keeps its body, its status and its idempotency-release header, and any
partial write it made is undone for free.

**Where the body lives: INSIDE the route.** This paragraph used to say the body
sat in a named `deleteGrnLineCommandHandler` above a one-line route. That was
the FIRST attempt, reverted before merge: hoisting broke three checks, because
`grnPreWriteRefusalsReleaseKey.test.ts` and `autocountWritebackCells.test.ts`
scan `grns.ts` BY ROUTE BLOCK - delimited by lines starting `grns.<verb>(` - and
a hoisted body sits outside every block they can see. Wrapping needs no hoist.
Verify with `grep -rn "deleteGrnLineCommandHandler" backend/src`, which matches
nothing. Two tests anchor on the route line rather than on a function name —
`autocountWritebackCells.test.ts` for the outbox row and the retired-key read.

**Proof.** `backend/tests-pg/grnLineDeleteAtomicity.pg.test.ts` drives real
Postgres: commit leaves the line gone AND the request queued; a throw after the
enqueue leaves **neither**; a throw before it leaves the line intact; and the
queue stays a singleton across two deletes.

### The CANCEL

The second route through, same shape. What now commits as one unit: the atomic
ACTIVE->CANCELLED status flip, the reversing stock OUT per line, the rack
reversal, the CANCEL audit row, the AutoCount cancel outbox row (`enqueueCancel`
already took its client explicitly) and the allocation-recompute request.

**Its reversal-row builder moved out** to
`backend/src/scm/lib/grn-cancel-reversal.ts`. The file-size ratchet charges
GROWTH on `grns.ts`, which already sits ~90 lines above its ceiling, and the
gate's own message names moving new code into a module as one of the two ways
out - the same move `ac-grn-outbox.ts` made (7b). It is a MOVE, not a rewrite,
and the two rules it carries are now pinned by
`backend/tests/grnCancelReversals.test.ts`: a SERVICE line is never reversed,
and each line reverses its OWN dye lot (mig 0120). Deliberately NOT shared with
the line-DELETE reversal, which builds one row for one line and does not filter
service lines - folding them together would silently change that behaviour.

**The enqueue sits OUTSIDE the best-effort catch**, behind a `stockReversed`
flag, so a failed enqueue fails the cancel. That is the point of the exercise:
"stock pulled back, allocation never re-walked" is exactly the state the
transaction exists to make unreachable, and a swallowed enqueue recreates it.
The line DELETE shipped with its enqueue INSIDE that catch and a comment
claiming otherwise; fixed the same day (`BUG-HISTORY.md` 2026-08-20).

**Proof.** `backend/tests-pg/grnCancelAtomicity.pg.test.ts` drives real Postgres
through the REAL shim, the REAL `writeMovements` and the REAL
`enqueueStockAllocationRecompute`: commit leaves the GRN cancelled, the OUT
written and the request queued; a throw after the enqueue leaves **none of the
three**; a throw before it leaves the GRN POSTED; a FAILED enqueue takes the
cancel down with it; and the queue stays a singleton.

**The other four GRN routes are unchanged** and still best-effort — header
PATCH, line add, line edit, and the create paths, with `postGrnHandler`
deliberately last because it is the largest handler in the file. One PR each.
`docs/ALLOCATION-DURABILITY-PLAN.md`.

## 8. Desktop and mobile files that must change together

| Concern | Desktop | Mobile |
|---------|---------|--------|
| List columns / filters | `pages/scm-v2/GoodsReceivedListV2.tsx` | `mobile/MobileModuleList.tsx` config `:1159` |
| Server pagination opt-in | `useGrnsPaged` | `mobile/MobileModuleList.tsx` `SERVER_PAGINATED` (`:327`) |
| Detail fields | `pages/scm-v2/GoodsReceivedDetailV2.tsx` (read) + `GoodsReceivedDetail.tsx` (edit) | `mobile/MobileModuleDetail.tsx` config `:324` |
| Post / Cancel actions | `GoodsReceivedDetail.tsx:416-459` | `mobile/MobileModuleDetail.tsx:535-542` |
| Zero-cost refusal → the remedy | the per-line "Received free" tick + price box on `GoodsReceivedDetail.tsx` | `mobile/MobileGrnZeroCost.tsx`, opened by `mobile/MobileModuleDetail.tsx`'s action footer. The 409 body is parsed once, by the SHARED `vendor/scm/lib/zero-cost-refusal.ts`, which `vendor/scm/lib/authed-fetch.ts` also uses for the sentence — so the message and the remedy cannot name different lines |
| PO→GRN conversion + per-line received qty | `pages/scm-v2/GrnFromPo.tsx` | `mobile/MobileConvertWizard.tsx` (`target: "grn"`) — note the surfaces differ **by design**: desktop can pick lines, mobile converts the whole PO (`:60-61`), and mobile posts `asDraft:true` rather than the auto-posting `/from-pos` (`:370-374`) |
| Cache invalidation after a write | the hooks in `vendor/scm/lib/grn-queries.ts` (must include `['inventory']`) | `mobile/sharedInvalidate.ts:72` (`grns` roots + `STOCK_ROOTS`, which includes the SO roots) |

---

## 9. Performance summary

Optimized:
- Detail loads header + items in one `Promise.all` (`:1175-1178`).
- The list's status counts are four `head:true` counts in one `Promise.all`
  (`:911-916`).
- `total_sen` on the list is the stored header value, not a re-sum.
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

## The transfer says at SAVE time what it could not carry (2026-08-20)

This document reaches AutoCount by **TRANSFER**, not by a create, and the
transfer route applies a **strictly narrower** set of header fields than an edit
does — `SalesHeader` / `PurchaseHeader` only, plus one extra assignment on each
purchase arm. So the account book can hold this document and still be missing
fields it has: until 2026-08-20 the conversion payload carried the ERP's number
and the account and nothing else, so every one of these landed under the DRAIN's
date with a blanked reference.

The payload now derives from `AcDownstreamSpec.facts` — the ONE description of
this document, projected onto the keys this route can apply — so a field added
there reaches the transfer with no further edit. What it still cannot carry, or
what the ERP has no value for, is **said on the save**: the create handler
returns `acNotSent` on its 201 and the New screen calls `notifyAcNotSent` before
navigating, exactly as the sales- and purchase-order creates do (#2499). The
problems carry `AC_SENT_INCOMPLETE`, not `AC_NOT_SENT`, and their title says the
document ARRIVED and part of it did not — the other wording would send someone
to raise it a second time into a book that already holds it. It never blocks.

Full reasoning, and the per-field table of what each conversion used to drop:
`docs/modules/autocount-writeback.md` §7c5.

## Right-click Print, for the whole chain (owner ruling, 2026-08-22)

**The list's right-click Print prints the chain (2026-08-23).** A GRN row offers
`Print`, `Print Purchase Order <no>` and `Print Sales Order <no>` for each order
its supply is bound to — in place, no navigation. The row already carries
`purchase_order` and `assigned_sos`, so no payload change was required; an
`assigned_sos` entry whose `source` is `'mrp'` builds no entry.
`document-conversion.md` §8b has the rule.

## A line added here reaches the account book (since 2026-08-31)

Adding a line to a document AutoCount already holds used to refuse the WHOLE
document's edit: a line with no AutoCount key is indistinguishable from one the
backfill missed, and guessing "new" appends a duplicate into a live book. The
route now DECLARES the row it inserted (`newLineIds` -> `IsNewLine`), so the book
appends it. A keyless line the route did not name is still refused.

Full rule and the matrix: `docs/modules/autocount-writeback.md`,
`docs/bugs/0588-a-line-added-to-a-delivery-order-receipt-or-invoice-never-re.md`.

## Drill-down columns and "still loading"

A cell fed by a SECOND query renders **WORKING…** while that query is in flight
and **NOT LOADED** if it fails — never `STOCK` or a bare dash, which are
answers. `coverage` is a required prop on the shared drill-down; the rule, the
five surfaces that fetch separately, and how to add a sixth are in
`docs/modules/coverage-state.md` (trace: `docs/bugs/0603-a-drill-down-printed-stock-while-the-answer-was-still-loadin.md`).

## The source line must be the SAME PRODUCT — 409 `link_material_mismatch`

Added 2026-09-08, `docs/bugs/0682`; bug class `docs/bugs/0672` site 15.

Every write path here that accepts a **Purchase Order line (`purchase_order_item_id`)** id from the request body proved
three things about it — the source line's COMPANY, its parent document's STATUS,
and that the QUANTITY fits. It never proved the two rows name the same product.
A line for product B naming a source line for product A therefore passed
everything: the foreign key is valid, nothing dangles, no constraint breaks, and
no coverage count drops.

That matters because the quantity ledgers are addressed BY THE LINK
(`recomputePoReceived`, `recomputeGrnInvoiced`, `adjustGrnReturnedQty` and
`doLineRemaining` all key on it), so a wrong link draws down the WRONG source
line and leaves the right one open to be received a second time.

**The rule** is `backend/src/scm/lib/line-link-item-identity.ts` — one home,
reached three ways depending on what the path already has in hand:
`assertSourceLinesInCompany(..., { lines, linkField, source })` where the company
read is already happening, `lineLinkItemMismatch(...)` where the source rows are
already held, `assertLinkedLineItemsMatch(...)` otherwise. Codes are compared
trimmed, upper-cased and with inner whitespace collapsed — the same
normalisation as `soLinkTargetRefusal` and `normItemCode`.

**Two refusals worth knowing before you debug one:**

- A source row that **cannot be read back** is refused, not skipped. An id that
  resolved to nothing cannot be asserted equal to anything.
- A **failed read** answers 503 `link_identity_unavailable`, never a pass. "We
  could not check" must not be spelled the same way as "we checked and it was
  fine".

Identity is asserted **before** the quantity cap wherever both run: a ceiling
computed against the wrong line is a number about the wrong thing, and reporting
it sends the operator to fix a quantity when the real fault is the source they
picked.

## The Special Order panel is not a bedframe/sofa feature (2026-09-10)

The owner, the day the Custom / other free text opened on the Sales Order:
「POGR 是不是也是要能看得到这些数据？…全部都是要带过去的哦，要不然你有 column 的话也
带不过去」.

Half of it already worked, and the halves are different things:

- the text ALREADY reached the supplier's document. `description2` is stamped
  server-side from `buildVariantSummary`, which appends the `SPECIAL:` segment
  AFTER the per-group attribute branch — so a category contributing no
  attributes still carries its note.
- the text was NOT on this document's SCREEN. The editor was gated on bedframe
  or sofa, and on `maint`, which `SpecialOrders` does not need — so a mattress,
  accessory or dining line was excluded twice over, and the operator could
  neither read the spec nor correct it.

The gate is now the shared module `frontend/src/vendor/scm/lib/special-order-surface.ts`,
read by the Sales Order, both mobile surfaces and every cost document, so the
rule cannot drift per document. **The add-on pool passed here is EMPTY on
purpose**: this document carries no catalogue for those categories, and choosing
WHAT to build belongs to the sales order, not to the buyer or the receiver.

Because of that empty pool, `SpecialOrders` no longer labels a carried pick
*"retired — untick to remove"* when it has no options list to judge it against —
a catalogue we do not have cannot call anything retired, and on a purchase order
that label told the buyer to delete what the factory is building. With no pool
the picks render read-only under *"from the Sales Order"*. See
`docs/bugs/0779-the-special-order-text-reached-the-supplier-pdf-but-was-invi.md`.
