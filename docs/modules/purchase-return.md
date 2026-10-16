# Purchase Return

Stock received from a supplier sent back — damaged, wrong, or surplus. Mirror of the Goods Received Note: a GRN moves stock IN, a PR sends it OUT. The return names the GRN it came from, its lines name the GRN lines, and posting takes stock out at the cost it came in at. Mirror module: `docs/modules/delivery-return.md`.

## Statuses and flow

`DRAFT -> POSTED -> COMPLETED`, plus `CANCELLED` — but `POST /` always creates the row as **POSTED**, with inventory OUT already written; DRAFT is not used in practice. `PATCH /:id/post` survives for back-compat only and is idempotent (an already-POSTED/COMPLETED row returns 200 without re-writing movements; anything else 409s `cannot_post`). `PATCH /:id/complete` moves POSTED -> COMPLETED with an optional `creditNoteRef`; its tenancy check runs before the state guard, so a same-company non-posted return gets an honest "not posted" message rather than a company-mismatch 404.

| Method | Path | Purpose |
|---|---|---|
| GET | `/`, `/:id`, `/:id/linked` | List, detail, the source GRN + PO for the detail's links |
| POST | `/` | Create — lands POSTED with inventory OUT written |
| POST | `/from-grn`, `/from-grns` | Convert GRN line(s) into a return |
| PATCH | `/:id/post` | Back-compat, idempotent |
| PATCH | `/:id/complete` | POSTED -> COMPLETED, optional credit-note ref |
| PATCH | `/:id/cancel` | Cancel |
| PATCH/POST/DELETE | `/:id`, `/:id/items[/:itemId]` | Header update, line add/update/remove |
| GET | `/export/rows` | One row per line export, full match set |

The right-click menu offers Confirm only on a DRAFT and Cancel on any row the server would actually accept (more rows than the detail drawer's own if/else chain shows) — Complete is deliberately absent from the menu since it needs a credit-note reference the drawer's Complete tab collects. No dedicated mobile screen. Consignment purchase returns (`PurchaseConsignmentReturn*`) are a different module on different tables.

## Permissions

- One guard, `scm.procurement.pr`, over the whole router — covers read and write alike.
- No sales-scope row filter here — unlike Delivery Return, procurement documents are not scoped own+downline.

## Where a PO-sourced return draws its lines from

`GET /returnable-grn-lines?poId=` answers the POSTED receipt lines received against that purchase order, with `qty_accepted - returned_qty > 0`, plus the PO's own supplier. **It is keyed on the LINE link** (`grn_items.purchase_order_item_id`), not on `grns.purchase_order_id` — a receipt may be HEADED at one purchase order and carry lines from several others, which is deliberate here (one group, one lorry; owner 2026-09-28). Matching the header alone hid every unit received that way: HC-PO-010114 read RECEIVED with nothing returnable, because both its units sat on receipts headed at Hookka POs. Same header-FK-only blind spot #4199 fixed for the PO list and the relationship map.

The header link survives for ONE case: a line on this PO's own receipt that carries no line link (pre-link imports, a receipt raised without picking PO lines). The rules and that carve-out live in `backend/src/scm/lib/returnable-grn-lines.ts`.

**The supplier answered is the PO's**, not the receipt's. On a shared receipt the receipt's supplier is a different counterparty from the one the goods were bought from — sending the return to them would be the wrong company. `POST /from-grn` still takes the RECEIPT's supplier, which is right for a single-supplier receipt and is the known gap on a shared one.

## Money back, or goods back

A return is one of two things (owner 2026-09-28: 「purchase return - 是可以退货维修，然后supplier再送回来」), held in `scm.purchase_returns.kind`:

| kind | what it means | credit note | stock |
|---|---|---|---|
| `CREDIT` (default, every pre-2026-09-28 row) | goods go back for good | owed; `Complete` records its ref | OUT of the line's source warehouse |
| `REPAIR` | goods go to the supplier to be fixed and are expected BACK | none — the detail says *with the supplier, awaiting return* | OUT of the source warehouse **and IN to `repair_warehouse_id`** |

`repair_warehouse_id` is NOT NULL exactly when `kind = 'REPAIR'` (DB CHECK). In practice it is one of the `* SERVICE` warehouses ("RETURNED TO SUPPLIER FOR SERVICE"), which the form finds by `warehouses.type === 'service'` — the destination is master data, never a name match. Pairing the OUT with an IN is what keeps repair stock countable: before this the warehouse moved it by hand with a stock transfer (18 movements into KL SERVICE, 2026-09-18 → 09-24) which recorded the move and nothing else — not the supplier, the reason, the date, nor whether it ever came back.

**The receive-back leg is phase 2** (`tasks/TODO.md`): a *Received back* action on the same document, the QC result, and repeat rounds. Until it ships, a repair that comes back is received the way it always was; the return stays POSTED.

## The reason is mandatory, and it is a code

Owner 2026-09-28: 「when raise purchase return need input reason and put in remark」. `POST /` refuses `reason_required` / `reason_invalid` before any write (through `refuse`, so the idempotency claim is released and a corrected resubmit is not `idempotency_key_reused`). The catalogue is `backend/src/scm/shared/purchase-return-reasons.ts`, byte-mirrored to `frontend/src/vendor/shared/`: DAMAGED, WRONG_COLOUR, WRONG_ITEM, OVER_SUPPLY, QUALITY, REPAIR, OTHER. The operator's own words go in `notes` (the Remark box) and show on the detail; the per-line `reason` stays free text for the one line that differs.

The code is stored in the EXISTING `reason` column — no migration, no rewrite. Rows raised before this hold free text and `purchaseReturnReasonLabel` prints them verbatim rather than hiding them.

`REPAIR` is the one code that changes what the document does, so `kindMatchesReason` refuses the two ways the pair can lie (a CREDIT return reasoned REPAIR, a REPAIR return reasoned anything else) — 409-free, a plain 400 at submit.

## Rules that must not break

- The PO-sourced pool must never fall back to matching receipts by `grns.purchase_order_id` alone — that is the read that hid a fully received PO's units. Only an UNLINKED line may be claimed by the header.
- A REPAIR return must never chase a credit note, and its stock must land somewhere: the OUT/IN pair is written together in `writePurchaseReturnMovements`, and a failed IN is REPORTED (goods left the warehouse and landed nowhere is the one outcome a repair must not hide).
- The reason must stay a code from the shared catalogue, validated on the server. A second list — in the route, in the form, in a test fixture — is the drift this pattern exists to prevent (same shape as the stock-adjustment reasons).
- `PATCH /:id/post` must stay idempotent — re-running it on an already-POSTED/COMPLETED row must never re-write movements (double-debits inventory).
- `writeMovements` never throws; every inventory-touching write must read its result and surface `movementErrors` rather than assume success from a clean HTTP status.
- The create path only accepts a **POSTED** source: the header's GRN and the parent GRN of any caller-supplied line id must both be POSTED (409 `grn_not_posted`) — otherwise a return could write a second OUT for goods whose reversing OUT already ran.
- A post-insert over-return check re-derives the live returned-qty sum per linked GRN line; if it's broken, the insert is rolled back and the idempotency claim released (409 `qty_exceeds_remaining`) rather than left half-written.
- Every write accepting a `grn_item_id` must confirm the linked GRN line is the SAME PRODUCT (409 `link_material_mismatch`), checked before any quantity cap.
- A source row that cannot be read back is refused, not skipped; a failed identity/source check answers a server error, never a silent pass.
- Joined to-one FKs on `GET /:id/linked` come back as arrays from Supabase typegen and must be unwrapped — any new join needs the same treatment.

## Gotchas

- Do not build anything that waits for a PR to be "posted later" — it is POSTED at creation. A genuinely unposted/draft return is a different concept this module doesn't have.
- The unlinked-line guard (header names a GRN but the line doesn't link to it) only runs on `POST /` create — `POST /:id/items` never calls it, so a line added after create with no `grn_item_id` is not checked against the header's GRN.
- Unlike Delivery Return, there is no blanket "refuse every unlinked line" rule — a null `grn_item_id` line is legitimate and will be written; only the narrower already-on-this-GRN-but-not-linked case is refused.
- `DELETE /:id/items/:itemId` answers 200 with a body, not 204 — a caller assuming an empty 204 will miss a `movementErrors` payload.
- The desktop detail page has no line-editing UI today — the item POST/PATCH/DELETE routes are reachable by API only; don't assume a frontend caller exists when changing their contract.
- No mobile-specific screen — the generic `MobileModuleList`/`MobileModuleDetail` cover it.

## Where the code is

- `backend/src/scm/routes/purchase-returns.ts` — main API surface.
- `backend/src/scm/routes/purchase-return-exports.ts` — line-level export.
- `backend/src/scm/lib/return-unlinked-lines.ts` — unlinked-line detection.
- `backend/src/scm/lib/line-link-item-identity.ts` — same-product link guard.
- `backend/src/scm/lib/purchase-return-list-read.ts` — list read shape.
- `backend/src/scm/lib/returnable-grn-lines.ts` — the PO-sourced returnable pool (line link + the legacy header case).
- `backend/src/scm/shared/purchase-return-reasons.ts` (+ the `frontend/src/vendor/shared/` mirror) — the reason catalogue, the two kinds, and the pairing rule.
- `backend/src/db/migrations-pg/20260928T0800_scm_purchase_return_repair_kind.sql` — `kind` + `repair_warehouse_id`.
- `frontend/src/pages/scm-v2/PurchaseReturnsListV2.tsx`, `PurchaseReturnDetailV2.tsx`, `PurchaseReturnNew.tsx` — desktop surfaces.
- `frontend/src/pages/scm-v2/PurchaseReturnDetail.tsx` — the `?edit=1` editor, lazy-loaded by `PurchaseReturnDetailV2` (same pattern as PO / GRN / PI). It has no route of its own: do not delete it as "unrouted" — #794 did, and Edit silently stopped working. Only a POSTED return is editable.
- `frontend/src/pages/scm-v2/PurchaseOrderDetailV2.tsx` — the **Raise Return** button (RECEIVED / PARTIALLY_RECEIVED, gated on `scm.procurement.pr` page access). It lived only on the legacy PO detail, which no route renders, so a received PO had no way into a return at all until 2026-09-28.
