# Product Request

A salesperson's request for new products or repacks: a HEADER (new product or repack; use — showroom / customer order / sample / fair exhibition; delivery location; expected date; supplier if agreed; remarks to the Purchaser) plus LINES, one per product — an existing SKU, or a Model the catalogue does not have yet, in a fabric, seat size and leg size, a qty, the agreed unit price, a line remark. The shape a Purchase Consignment Order has (owner 2026-10-15, 方案 A: dozens of showroom pieces go in one request). Screen text is English only. The Purchaser answers the whole request — approve or reject, build each new-Model line's Model + SKU, raise ONE Purchase Consignment Order from it, close it. Numbered `{co}PDR-YYMM-NNN`. Owner 2026-10-06.

## Statuses and flow

`REQUESTED -> APPROVED -> PCO_ISSUED -> CLOSED`, plus `REJECTED` (goes back to `REQUESTED` when the requester fixes and resends it) and `WITHDRAWN`. `WITHDRAWN` and `CLOSED` are terminal. Approval is for the whole request, never per line. The pure state machine is `backend/src/scm/shared/product-request.ts`.

| Method | Path | Who | Effect |
|---|---|---|---|
| GET | `/product-requests`, `/:id` | requester (own only), Purchaser (all; `?mine=1` for own) | list / detail, each with its `lines` (and each line's Model), the linked PC Order, delivery location and supplier |
| GET | `/product-requests/supplier-options` | anyone who may open requests | ACTIVE suppliers of the company as id / code / name only — the requester's picker (a salesperson holds no `scm.procurement.suppliers`) |
| POST | `/product-requests` | any Sales caller, or `scm.product_request.create` | raise, header + `lines[]` (1 to 200), lands `REQUESTED` |
| PATCH | `/:id` | the requester | change while `REQUESTED` or `REJECTED`; header fields absent from the body keep their value; `lines`, when sent, REPLACES the set; a `REJECTED` one goes back to `REQUESTED`, decision cleared |
| POST | `/:id/withdraw` | the requester | `REQUESTED` / `REJECTED` -> `WITHDRAWN` |
| POST | `/:id/approve` | `scm.product_request.approve` | `REQUESTED` -> `APPROVED` (optional note); answer carries `needsModel` + `pendingModels` (lines still without a SKU) |
| POST | `/:id/reject` | `scm.product_request.approve` | `REQUESTED` -> `REJECTED`, note required |
| POST | `/:id/lines/:lineId/create-model` | `scm.product_request.approve` | `APPROVED`, a line with no SKU: creates the Model (find-or-create) + first SKU, stamps the line's `item_code` / `model_id`; status unchanged |
| POST | `/:id/close` | `scm.product_request.approve` | `APPROVED` / `PCO_ISSUED` -> `CLOSED` |

The PC Order is raised on PC Order New (`?fromProductRequest=<id>`), which seeds the header's Purchase Location + Expected Delivery + supplier, and ONE ORDER LINE PER REQUEST LINE (SKU, qty, fabric / seat / leg as the variant bag, the agreed price with `priceTouched`); the request's remarks and the line remarks ride the order notes. `POST /purchase-consignment-orders` takes `productRequestId`: it refuses a request not `APPROVED` (`request_not_approved`), already issued (`request_already_issued`) or with any line without a SKU (`model_not_created`); once the order stands the request reads `PCO_ISSUED` with `pco_id`, and the order carries `source_product_request_id` (`lib/product-request-link.ts`).

## Permissions

- No area guard. `requireScmAccess` admits a Sales caller (position policy cohort `sales`, else position / department, `isSalesUser`) and either flat key for `/scm/product-requests` alone; the handlers check the real caller.
- Raise / edit / withdraw: any Sales caller, or `scm.product_request.create`. A requester sees only their own requests.
- Approve / reject / create-model / close: `scm.product_request.approve` (the Purchaser). Owner + IT Admin via `*`. Grant it to the purchasing role under Team > Roles & Permissions; nobody holds it by default.
- Desktop route `/scm/product-requests`: `ScmGuard area="scm" allowSales` (any `scm.*` grant, or Sales staff). Nav: a `showForSales` leaf under Supply Chain for every Sales position (director included), and an office leaf under Consignment shown by the two keys or the consignment / procurement areas, hidden from Sales. The phone row is gated by the same NAV_TABS entries.

## Rules that must not break

- A request has at least one line and at most 200 (`lines_required` / `too_many_lines`). Every line refusal names its line (`Line 2: …`).
- A `REPACK` line always names an existing SKU (`item_code_required`). A `NEW_PRODUCT` line names an existing SKU or a Model by name (`product_required`); never neither (DB check `product_request_lines_names_product`).
- A SKU or fabric not in the active company is refused by line (`unknown_item` / `unknown_fabric`); a delivery location or supplier not in it by name (`unknown_location` / `unknown_supplier`). A picked SKU fixes the line's category and Model.
- The header's `supplier_id` and each line's `unit_price_sen` are the requester's named supplier and agreed prices (方案 C, owner 2026-10-08), all optional; PC Order New seeds the Creditor and each line price from them (`priceTouched`, so the binding's default does not overwrite the agreed figure). The Purchaser may still change them on the order.
- An approved request cannot raise a PC Order until EVERY line names a SKU: a PC Receive books stock by item code, and a code the catalogue has not got would be stock nothing can sell.
- `create-model` goes through `ensureModelForSku` (the one find-or-create every SKU-create path shares); the SKU lands `status ACTIVE`, `pos_active false`. A SKU code already in the company is refused (`duplicate_code`), never overwritten. SKU code defaults to `<MODEL>-<compartment>` for a sofa with a compartment, else the model code; 30 characters at most. The line update is guarded on `item_code IS NULL`, so two builds at once cannot both name the line.
- Every status move is guarded on the status the row was read in (`request_moved` 409 on a race); the PC Order link claims the request only while `APPROVED`, so two orders raised at once cannot both claim it — the loser's order stays, unlinked, and the create answer says `requestClaimed: false`.
- A PATCH that replaces lines deletes and re-inserts them after the header update; a refused body (bad line, unknown SKU) leaves the stored lines untouched because validation runs first.
- Every write pre-flights the audit sink (`assertAuditWritable`) and records `PRODUCT_REQUEST` in `scm.entity_audit_log` (`lineCount` and a `products` summary on create / edit; `lineNo` + `itemCode` on a build).
- The service-role client bypasses RLS: the `company_id` predicate is the only boundary, on every read and write — lines carry their own `company_id`.

## Gotchas

- The PC Order form is desktop-only, so on the phone an approved request says to raise the order on the computer; the phone approves, rejects, builds each line's Model and closes.
- `decision_note` holds the Purchaser's words for approve, reject and close alike; a resubmit clears it.
- A line's `category` defaults to `SOFA`; the compartment picker shows only for a sofa, seat sizes read `sofaSizes`, leg sizes read `sofaLegHeights` for a sofa and `legHeights` otherwise.
- `scm.product_requests` lost its one-product columns on 2026-10-15 (migration `20261015T0540`, 0 rows on production then); anything reading `product_requests.item_code` is stale.

## Where the code is

- `backend/src/scm/routes/product-requests.ts` — API surface. `backend/src/scm/shared/product-request.ts` — state machine + line / PC-Order refusals. `backend/src/scm/lib/product-request-link.ts` — the PC Order's door.
- `backend/src/db/migrations-pg/20261006T0741_scm_product_requests.sql` (header + `purchase_consignment_orders.source_product_request_id`), `20261015T0540_scm_product_request_lines.sql` (`scm.product_request_lines`, header columns dropped).
- `frontend/src/vendor/scm/lib/product-request-queries.ts` — hooks, status words, line helpers, `pcoNewFromRequestPath`.
- `frontend/src/pages/scm-v2/ProductRequests.tsx` (desktop), `frontend/src/mobile/MobileProductRequests.tsx` (phone), `PurchaseConsignmentOrderNew.tsx` (`?fromProductRequest=` seed).
- Tests: `backend/tests/productRequests.test.ts`, `backend/src/scm/shared/product-request.test.ts`, `frontend/src/pages/scm-v2/ProductRequests.test.tsx`.
