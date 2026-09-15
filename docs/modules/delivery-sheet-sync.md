# Module: Delivery sheet sync (ERP ↔ HC Delivery Updated)

The dispatch team runs the day out of the **HC Delivery Updated** Google Sheet
(id `17xW6rIXQTh_KUVmg2uipoaNQG0Ps9x-DeWWB3IcpNq4`; tabs *Delivery Details* =
West Malaysia, *EM Order* = Sabah/Sarawak, *SG Order*). Until 2026-09-15 the
sheet's rows came from **AutoCount** through a sheet-bound Apps Script and an
ngrok middleware (`reference/GetAutoCountData.gs`); the owner ruled that day to
**stop the AutoCount sync and feed the sheet from the ERP**. This guide is the
whole of that surface.

Status: **backend shipped; the Apps Script side is `reference/ERPDeliverySync.gs`
and must be pasted into the live project "Delivery & Amend Updated" and armed
by `setupErpTriggers()`** (see *Cutover*). Until that is done the sheet still
pulls AutoCount.

## 1. What the sheet does (the contract this module honours)

`Helper.gs writeDataToTargetSheet` keys every row on **col B Doc. No.**, rows
from row 4, and writes three blocks from an object carrying AutoCount's field
names:

| Block | Columns | Fields, in order |
|---|---|---|
| 1 | B..P | `DocNo, TransferTo, DocDate, Ref, SOUDF_BRANDING, DebtorName, Phone1, SalesLocation, SalesAgent, Total, SOUDF_BALANCE, Remark2, SOUDF_PDate, SalesExemptionExpiryDate, Remark4` |
| 2 | Y..AE (SG: Z..AE, no Remark3) | `Remark3, SOUDF_Note, SOUDF_ToPONo, InvAddr1..InvAddr4` |
| 3 | Attention col + Sync Status col | `Attention` (forced `SEAMPIFY`), `SYNCED` |

**Col A (delivery message status) and Q..X are never written by any pull** —
they are the team's. `onEdit` copies A → P and Q → O and marks the row
`PENDING`; the push sends PENDING rows back. The ERP feed emits exactly the
field names above, so the script only changed its URL and its checkpoint.

## 2. API surface — `backend/src/routes/deliverySheetSync.ts`, mounted PRE-AUTH at `/api/delivery-sheet`

Both routes: header `X-Intake-Key` = **`SHEET_SYNC_KEY`** and nothing else
(the HC sheet's own key, which speaks for HOUZS — the 2026-08-18 rule in
`docs/modules/service-case.md`). Company id is read from `companies` under
code `HOUZS`; 503 `company_unresolved` when the master cannot answer. Wrong
key → 401 after a 250 ms penalty, 429 after 10 failures per IP in 15 min
(`checkRateLimit`, same as the form intake).

| Route | What |
|---|---|
| `GET /so-since?since=<ts>&limit=<n>` | Orders whose `LastModified` is **strictly after** `since`, oldest first, `limit` ≤ 1000 (default 300). Returns `{count, since, next_since, has_more, records[]}`. `next_since` is the last record's `LastModified` — store it once every row of the page is written. `since` accepts the old script's `yyyy-MM-dd HH:mm:ss` or Postgres's own `timestamptz::text`; anything else is 400. |
| `POST /updates` `{updates:[{DocNo, Remark4?, ExpiryDate?}]}` | ≤ 300 per call (413 over). Per row: `{DocNo, ErpDocNo, ok}` or `{DocNo, skipped: no_order \| nothing_to_write \| bad_date}`. A **present** `Remark4` is written as sent, blank included (clearing col A is an edit); an **absent** one keeps the ERP's. A **blank** `ExpiryDate` keeps the ERP's date (the old daily PO sync nulled text dates; this leg must not). The whole batch is ONE `UPDATE … FROM (VALUES …)` statement: the Worker serves Google's US servers, so each database round trip crosses to Singapore (~400 ms; 300 single-row updates took 116 s on the first seed, 2026-09-15). |

Pure logic in `backend/src/lib/delivery-sheet-feed.ts` (SQL, mapper, parsers).
`intakeCompany` moved to `backend/src/lib/intake-company.ts` and is shared with
`assrFormIntake.ts`.

## 3. Column semantics (owner rulings, 2026-09-15)

| Sheet field | ERP source | Ruling / trap |
|---|---|---|
| `DocNo` | `COALESCE(linked_ac_docno, doc_no)` | The sheet keys on the **AutoCount** number: a migrated order is `HC-SO-013495` in the ERP and `SO-013495` in the sheet; natives (`HC-SO-2609-078`) match on both. Emitting `doc_no` would have duplicated all 2,882 migrated rows. `ErpDocNo` is sent alongside. |
| `TransferTo` | `scm.delivery_orders.do_number` (non-cancelled, comma-joined) | Owner accepted the ERP's `HC-DO-…` numbers. `mfg_sales_orders.transfer_to` / `linked_do_doc_no` are NULL on every order and are not read. |
| `Total` / `SOUDF_BALANCE` | `local_total_sen` / `local_total_sen − Σ payments` | Ringgit, 2 dp. The base-table `balance_sen` is NOT outstanding (see /so-export). |
| `SalesLocation` | `bookSpellingOrOwn(sales_location, LOCATION_MAP)` | `KL WAREHOUSE` → `KL`; the sheet routes on `KL/PG/HQ`, `SBH/SRW`, and `InvAddr3` containing SINGAPORE. The feed also sends `Region`. |
| `SalesAgent` | `resolveAcAgent(agent, staff.name)` | Same spelling the AutoCount write-back uses. |
| `Remark2` | `remark2`, else the readiness wording (`summariseReadiness` over the lines: `READY` / `PARTIAL` / `MATTRESS`…) | What /so-export sends 2990. |
| `SOUDF_PDate` | `processing_date` | |
| `SalesExemptionExpiryDate` (col O, the dispatch date) | **`customer_delivery_date`** | Owner chose this over `sales_exemption_expiry` (which nothing in the ERP writes) and over `amended_delivery_date`. The sheet's col Q edit writes back here. |
| `Remark4` (col P) | `remark4` | Written back from **col A**; **col A itself is never written by the ERP** (owner: 「A 列 → remark4，但是不要改 A 列」). |
| `SOUDF_ToPONo` | `purchase_orders.po_number` via `purchase_order_items.so_item_id`, cancelled dropped | The header has no PO column. |
| `InvAddr1..4` | `address1..4`; addr3 falls back to `postcode city`, addr4 to `customer_state` | |
| `LastModified` | `GREATEST(so.updated_at, MAX(payments.created_at), MAX(delivery_orders.updated_at))` | `updated_at` alone misses collections: on 2026-09-15, 116 of 2,958 orders had a payment newer than the header. |
| Not sent | DRAFT and CANCELLED orders | A cancelled order's row keeps its last state in the sheet. |

**The pull never blanks a cell the ERP does not know.** `ERPDeliverySync.gs
erpPreserveBlanks_` keeps the sheet's existing value for any block-1/2 field
the ERP returns as null — so an old migrated row keeps its AutoCount `DO-00xxxx`
until the ERP raises a DO, and a row whose ERP `remark4` is empty keeps its
Remark 4.

## 4. Cutover (in the live Apps Script project "Delivery & Amend Updated")

1. Nothing to configure while `ERPMain.gs` keeps `ASSR_SYNC_KEY` and the ERP is at `https://erp.houzscentury.com` — the script defaults to both. Otherwise Script properties `ERP_BASE_URL` and `SHEET_SYNC_KEY`
   (the same value the ERP holds; it is already in that project in plaintext
   for the ASSR sync — `docs/google-sheet-status-sync.md`).
2. Paste `reference/ERPDeliverySync.gs` as a new file. It reuses `Helper.gs`
   (`getTargetSs`, `getSheetConfig`, `writeDataToTargetSheet`,
   `recordExecutionLog`, `Log`) and `CONFIG.*_SHEET`.
3. Run **`erpSeedFromSheet()`** once. It pushes every row's col A and col O
   into the ERP (`remark4`, `customer_delivery_date`) — the sheet is the truth
   for those two columns today and the ERP's copies are older (import-time
   `remark4` on 339 orders; `customer_delivery_date` on 745). Without this the
   first pull would write the ERP's older values over the sheet's.
4. Run **`setupErpTriggers()`**: deletes the `scheduledPull` / `scheduledPush`
   (AutoCount) triggers and installs `scheduledErpSync` every 15 min (push
   first, then pull — a PENDING edit is never overwritten by the pull behind
   it). The first pull walks all ~2,958 orders over a few runs (4 pages × 300
   per run; the checkpoint advances per page).
5. Execution Log tab shows `ERP_PULL` / `ERP_PUSH` / `ERP_SEED` rows.

**Left on AutoCount for phase 2 (owner: 先换主表):** `runOverduePull`,
`runBalanceCollectionPull`, `runOutstandingPOPull` / `syncPODate`. The
AutoCount `ExpiryDate` push (col O → the book's `SalesExemptionExpiryDate`)
stops with the cutover; the ERP write-back does not send that header field.

## 5. Tests

- `backend/tests/deliverySheetSync.test.ts` (light project, fake D1): the
  guard, the 400/503/502 refusals, the company binds on both legs, the mapped
  record, the keep-vs-write rules of `/updates`.
- `backend/tests-pg/deliverySheetFeedSql.pg.test.ts` (real Postgres): the feed
  SQL — company scope, DRAFT/CANCELLED exclusion, `LastModified` moved by a
  payment / a DO, strict checkpoint, cancelled DO/PO not named, the write leg
  by AutoCount number and by ERP number, keep semantics, the order re-surfacing
  after a write.
- Proven on production 2026-09-15 (read-only, Supabase MCP): the feed SELECT
  runs in 25 ms over 2,958 orders.

## Related

- `docs/modules/service-case.md` — the sibling pre-auth intake endpoints and
  the secret-per-company rule.
- `docs/google-sheet-status-sync.md` — the ASSR leg of the same sheet, and
  how the live Apps Script project is edited.
- `docs/modules/autocount-writeback.md` — why `remark4` and the expiry never
  reach AutoCount from the ERP.
