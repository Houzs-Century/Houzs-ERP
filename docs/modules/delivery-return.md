# Delivery Return

Goods coming back from a customer — the mirror of the Delivery Order (a DO moves stock OUT, a DR brings it IN). The return names the Delivery Order it came from, its lines name the DO lines, and posting it puts stock back into a warehouse at the cost it left at. Mirror module: `docs/modules/purchase-return.md`.

## Statuses and flow

DB enum `scm.delivery_return_status`, default `PENDING` (no code path writes it — a DR is `RECEIVED` from the create insert, so it is never "pending" in practice). `RECEIVED -> INSPECTED / REFUNDED` (via `PATCH /:id/status`, stamps timestamps); `CREDIT_NOTED` / `REJECTED` are valid enum members with no special handling; `CANCELLED` is reachable from any state via the status PATCH and is **FINAL** — any transition out of it is refused (409 `dr_cancelled_final`); raise a new return instead of un-cancelling.

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | List, `?status=` filter, sales-scoped |
| GET | `/returnable-do-lines` | Picker for "from DO" — only `delivered` lines (a loaded, not-yet-delivered DO is not returnable) |
| GET | `/:id` | Header + lines |
| POST | `/` | Create |
| POST | `/from-do`, `/from-dos` | Convert DO line(s) into a return (same handler) |
| PATCH | `/:id` | Update header |
| POST/PATCH/DELETE | `/:id/items[/:itemId]` | Add / update / remove a line |
| PATCH | `/:id/status` | Status transition, incl. CANCEL |
| GET | `/export/rows` | One row per line export (all matching rows, not just the loaded page) |

No dedicated mobile screen — the generic `MobileModuleList` / `MobileModuleDetail` render it.

## Permissions

- One guard over the whole router: `scm.sales.returns` (`scmAreaGuard`), covers both read and write.
- List and detail are additionally row-scoped to the caller's **sales** scope (`resolveSalesScopeIds` / `salesDocOutOfScope`) — own + downline only, unless the caller can view all sales.

## Rules that must not break

- Every non-service return line with `qty_returned > 0` moves stock IN — this is not paperwork.
- Returnable quantity per DO line = `delivered − returned`, **independent of invoicing**: a fully-invoiced — even fully-paid — DO can still have a Delivery Return raised against it. Only prior returns and total delivered cap it. Computed by `doReturnableRemaining` → `returnableRemainingFrom` (`do-line-remaining.ts`); the invoice pool stays `delivered − invoiced − returned` and is untouched, so returned goods still cannot be invoiced.
- A return moves **stock only** — posting it does **not** reduce the linked Sales Invoice, its AR, or GL revenue; `sales_invoice_id`, `refund_centi` and the `CREDIT_NOTED` status are display/state only. The money side is a **customer credit note raised from the return** (backlog A1, 2026-11-09; `docs/modules/accounting.md`): Finance opens it from the return's page (**Create credit note** → `/scm/credit-notes?form=new&fromReturn=<id>`), each returned line priced at what the issued invoice charged per unit (line total after discount and tax ÷ qty), never the return line's list price.
- `GET /:id` carries `creditNote: { state, notes }` (and `deliveryReturn.credit_note_state` for the phone's meta row), worked from the notes actually linked, never stored: `NOT_INVOICED` (no issued invoice billed any returned line — no note needed), `AWAITING` ("Awaiting credit note" — an invoiced unit is on no live note), `DRAFTED`, `ISSUED`; `UNKNOWN` when the read failed. The DR status is not written by any of this.
- A return line's units on a live (draft or posted) credit note hold the return: cancelling the return, deleting that line, or cutting its qty below the credited units is refused (409 `dr_credit_noted`; 503 `credit_check_failed` when the notes cannot be read) — cancel the credit note first.
- A line naming no DO line (`do_item_id` null) is refused outright on create and add-item (409 `do_link_required`) — the column stays nullable in the DDL for legacy rows only.
- `resyncInventoryForReturn` is a delta walk to a computed TARGET per `(warehouse, product, variant_key, batch_no)`, not an incremental adjustment — a CANCELLED return's target is zero, draining every bucket back out.
- A returned company-1 hard-bound line (not sofa) re-enters under the `batch_no` its DO OUT was stamped with (its bound PO); a DO shipped un-batched returns un-batched.
- SERVICE lines never write stock IN, checked via `isServiceLine` (item_group + code) with a catalog fallback (`findServiceLineCodes`); if that check itself fails, all four write paths refuse the line (409 `service_check_failed`) rather than admit it unchecked.
- `variant_key` is built from the line's stored `item_group`, which write paths rewrite server-side from `mfg_products.category` (company-scoped) rather than trusting the request — keeps a return's stock in the same bucket the goods left from. For a variant-tracked company (`lib/binding-mode.ts`, not company 1) `lib/stock-bucket-key.ts` also writes a canonically equal stocked bucket's own string.
- Every write path accepting a `do_item_id` must confirm the linked DO line is the SAME PRODUCT (409 `link_material_mismatch`), checked before any quantity cap — a valid but wrong-product link would draw down the wrong source line.
- Source-cost reads and the "live documents" pickers (`checkCrOverRemaining`, returnable/deliverable line lists) must be company-scoped and paginated — an unpaged or unscoped read can leak another tenant's cost or let an over-return guard silently pass.
- The incoming status is normalised (trim + uppercase) once before any gate reads it — comparing the raw request value against gates that expect the persisted (already-normalised) shape misses the idempotent CANCEL echo entirely.
- Every status write in `PATCH /:id/status` is compare-and-set: the UPDATE carries `.eq('status', <status it read>)` plus the company predicate. Zero rows updated means another request moved the return first; the handler re-reads and answers 409 `status_changed` (plain-sentence `message`, plus `currentStatus`), nothing written. The one exception is two cancels racing: the loser finds CANCELLED and echoes it without a second stock reversal. A cancel that read RECEIVED but finds INSPECTED/REFUNDED is refused, not applied over it.

## Gotchas

- `do_item_id` is nullable in the schema but treat it as required — the API refuses a null on every write path regardless of what the DDL allows.
- Never add an incremental `+qty` inventory write beside `resyncInventoryForReturn` — the two will double-apply.
- Use `c.get('houzsUser')?.id` for scope checks inside `/api/scm/*`, never `c.get('user').id` (the bridge's pinned identity, not the caller's).
- There is no mobile-specific screen for this module — don't build one assuming the desktop/mobile parity rule applies here.
- No status whitelist is enforced beyond the DB enum, and there is no line-level status lock — a CANCELLED or REFUNDED return's lines are still editable through the item endpoints; don't assume the status protects them.
- The cancel-final refusal puts its message in `reason`, while DO/CN/PC siblings use `message` — a generic error-body reader will show blank for one of them.

## Files and photos (`/delivery-returns/:id/files`)

Since 2026-11-09 (backlog A3, sister Conts-ERP#278) a delivery return keeps attached files: the supplier's paperwork, an invoice scan, photos of the goods. Images (JPEG / PNG / WebP) and PDFs, 20 MB each, many per document.

- `POST /:id/files` `{fileName, mime, dataBase64}`, `GET /:id/files` (rows + `locked`), `GET /:id/files/:fileId` (streams), `DELETE /:id/files/:fileId`.
- Write = `edit` on `scm.sales.returns`, the same `scmAreaGuard` that gates every other write here; the router passes `mayWrite` because this document has no flat permission key.
- `CANCELLED` takes no more files. A file stops being removable once the document is finished: `REFUNDED`, `CREDIT_NOTED` or `REJECTED`. The load applies the same own/downline sales scope as `GET /:id`, so a scoped seller cannot reach another salesperson's return through its files. Not at posting, on purpose.
- Index `scm.delivery_return_files` (mig `20261110T0300_scm_flow_doc_files.sql`), bytes in the SLIPS R2 bucket under `delivery-return-files/<company>/<doc>/<uuid>.<ext>`. Company-scoped on every read and write.
- UI: the Files card (`FlowDocFilesCard`) on the desktop detail page and on the phone's generic detail screen (`MobileModuleDetail`), both through `vendor/scm/lib/flow-doc-files.ts`.
- Code: `backend/src/scm/routes/flow-doc-files.ts` (one spec per document over `lib/doc-files.ts`). Tests: `backend/tests/flowDocFiles.test.ts`, `frontend/src/vendor/scm/components/FlowDocFilesCard.test.tsx`.

## Where the code is

- `backend/src/scm/routes/delivery-returns.ts` — main API surface.
- `backend/src/scm/routes/delivery-return-exports.ts` — line-level export.
- `backend/src/scm/lib/return-unlinked-lines.ts` — unlinked-line detection.
- `backend/src/scm/lib/line-link-item-identity.ts` — same-product link guard.
- `backend/src/scm/lib/delivery-return-list-read.ts` — list read shape.
- `backend/src/scm/lib/source-cost.ts` — company-scoped source cost lookup.
- `backend/src/scm/lib/cn-from-return.ts` — the credit-note side: invoice pricing, credited units, the state, the hold.
- `frontend/src/pages/scm-v2/ReturnCreditNoteCard.tsx` — the credit-note card on the desktop detail; labels in `frontend/src/vendor/scm/lib/return-credit-state.ts` (also the phone's "Credit note" meta row).
- `frontend/src/pages/scm-v2/DeliveryReturnsListV2.tsx`, `DeliveryReturnDetailV2.tsx`, `DeliveryReturnNew.tsx`, `DeliveryReturnFromDo.tsx` — desktop surfaces.
- `frontend/src/pages/scm-v2/DeliveryReturnDetail.tsx` — the Edit page. No route of its own: `DeliveryReturnDetailV2` lazy-loads it on `?edit=1`. Do not delete it as "unrouted".
