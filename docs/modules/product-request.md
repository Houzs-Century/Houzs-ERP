# Product Request

A salesperson's request for a new product or a repack: an existing SKU, or a Model the catalogue does not have yet, in a fabric, seat size and leg size, for a use (showroom / customer order / sample), delivered where and by when. The Purchaser answers it — approve or reject, build the new Model + SKU from it, raise the Purchase Consignment Order from it, close it. Numbered `{co}PDR-YYMM-NNN`. Owner 2026-10-06.

## Statuses and flow

`REQUESTED -> APPROVED -> PCO_ISSUED -> CLOSED`, plus `REJECTED` (goes back to `REQUESTED` when the requester fixes and resends it) and `WITHDRAWN`. `WITHDRAWN` and `CLOSED` are terminal. The pure state machine is `backend/src/scm/shared/product-request.ts`.

| Method | Path | Who | Effect |
|---|---|---|---|
| GET | `/product-requests`, `/:id` | requester (own only), Purchaser (all; `?mine=1` for own) | list / detail, with the linked PC Order, delivery location and Model |
| POST | `/product-requests` | any Sales caller, or `scm.product_request.create` | raise, lands `REQUESTED` |
| PATCH | `/:id` | the requester | change while `REQUESTED` or `REJECTED`; a `REJECTED` one goes back to `REQUESTED`, decision cleared |
| POST | `/:id/withdraw` | the requester | `REQUESTED` / `REJECTED` -> `WITHDRAWN` |
| POST | `/:id/approve` | `scm.product_request.approve` | `REQUESTED` -> `APPROVED` (optional note); answer carries `needsModel` |
| POST | `/:id/reject` | `scm.product_request.approve` | `REQUESTED` -> `REJECTED`, note required |
| POST | `/:id/create-model` | `scm.product_request.approve` | `APPROVED` with no SKU: creates the Model (find-or-create) + first SKU, stamps `item_code` / `model_id`; status unchanged |
| POST | `/:id/close` | `scm.product_request.approve` | `APPROVED` / `PCO_ISSUED` -> `CLOSED` |

The PC Order is raised on PC Order New (`?fromProductRequest=<id>`), which seeds the header's Purchase Location + Expected Delivery and one line (SKU, qty, fabric / seat / leg as the variant bag, remarks in the notes). `POST /purchase-consignment-orders` takes `productRequestId`: it refuses a request not `APPROVED` (`request_not_approved`), already issued (`request_already_issued`) or without a SKU (`model_not_created`); once the order stands the request reads `PCO_ISSUED` with `pco_id`, and the order carries `source_product_request_id` (`lib/product-request-link.ts`).

## Permissions

- No area guard. `requireScmAccess` admits a Sales caller (position / department, `isSalesUser`) and either flat key for `/scm/product-requests` alone; the handlers check the real caller.
- Raise / edit / withdraw: any Sales caller, or `scm.product_request.create`. A requester sees only their own requests.
- Approve / reject / create-model / close: `scm.product_request.approve` (the Purchaser). Owner + IT Admin via `*`. Grant it to the purchasing role under Team > Roles & Permissions; nobody holds it by default.
- Desktop route `/scm/product-requests`: `ScmGuard area="scm" allowSales` (any `scm.*` grant, or Sales staff). Nav: a rep-only leaf, and an office leaf under Consignment shown by the two keys or the consignment / procurement areas. The phone row is gated by the same NAV_TABS entries.

## Rules that must not break

- A `REPACK` always names an existing SKU (`item_code_required`). A `NEW_PRODUCT` names an existing SKU or a Model by name (`product_required`); never neither (DB check `product_requests_names_product`).
- A SKU, fabric or delivery location not in the active company is refused by name (`unknown_item` / `unknown_fabric` / `unknown_location`); a picked SKU fixes the request's category and Model.
- An approved new-Model request cannot raise a PC Order until `create-model` has run: a PC Receive books stock by item code, and a code the catalogue has not got would be stock nothing can sell.
- `create-model` goes through `ensureModelForSku` (the one find-or-create every SKU-create path shares); the SKU lands `status ACTIVE`, `pos_active false`. A SKU code already in the company is refused (`duplicate_code`), never overwritten. SKU code defaults to `<MODEL>-<compartment>` for a sofa with a compartment, else the model code; 30 characters at most.
- Every status move is guarded on the status the row was read in (`request_moved` 409 on a race); the PC Order link claims the request only while `APPROVED`, so two orders raised at once cannot both claim it — the loser's order stays, unlinked, and the create answer says `requestClaimed: false`.
- Every write pre-flights the audit sink (`assertAuditWritable`) and records `PRODUCT_REQUEST` in `scm.entity_audit_log`.
- The service-role client bypasses RLS: the `company_id` predicate is the only boundary, on every read and write.

## Gotchas

- The PC Order form is desktop-only, so on the phone an approved request says to raise the order on the computer; the phone approves, rejects, builds the Model and closes.
- `decision_note` holds the Purchaser's words for approve, reject and close alike; a resubmit clears it.
- The request's `category` defaults to `SOFA`; compartment / seat-size pickers show only for a sofa, leg sizes read `sofaLegHeights` for a sofa and `legHeights` otherwise.

## Where the code is

- `backend/src/scm/routes/product-requests.ts` — API surface. `backend/src/scm/shared/product-request.ts` — state machine + product / PC-Order refusals. `backend/src/scm/lib/product-request-link.ts` — the PC Order's door.
- `backend/src/db/migrations-pg/20261006T0741_scm_product_requests.sql` — `scm.product_requests` + `purchase_consignment_orders.source_product_request_id`.
- `frontend/src/vendor/scm/lib/product-request-queries.ts` — hooks, status words, `pcoNewFromRequestPath`.
- `frontend/src/pages/scm-v2/ProductRequests.tsx` (desktop), `frontend/src/mobile/MobileProductRequests.tsx` (phone), `PurchaseConsignmentOrderNew.tsx` (`?fromProductRequest=` seed).
- Tests: `backend/tests/productRequests.test.ts`, `backend/src/scm/shared/product-request.test.ts`, `frontend/src/pages/scm-v2/ProductRequests.test.tsx`.
