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

## Rules that must not break

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
- `frontend/src/pages/scm-v2/PurchaseReturnsListV2.tsx`, `PurchaseReturnDetailV2.tsx`, `PurchaseReturnNew.tsx` — desktop surfaces.
