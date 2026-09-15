# Phone vs desktop — permission and restriction parity audit (2026-09-14)

**Trigger (owner, 2026-09-14):** 「去查看houzs erp的RBAC和限制 我发现电脑电话版本好像有差别有些限制电话有而已 电脑没有」

**The rule it is measured against (owner, 2026-09-12):** the phone shows and does
everything the desktop does, opened per the person's permissions, and the
permissions are IDENTICAL on phone and desktop — 「Frontend、backend、database
全部都是要统一的」 (one rule set, one API, no phone-only logic).

**Audited tree:** `main` at `081a3fe72`. Every line number below is at that commit.
Main has moved since; re-grep before trusting a line.

**Status of this document:** findings + options, written 2026-09-14 at
`081a3fe72`. **Updated later the same day:** the owner answered §7 (answers in
that section: option C, and "follow the latest version" for D3-D5). Defects are
being fixed one PR each; §5 carries each one's state. The §4 rows still describe
`081a3fe72` and are not rewritten as they close.

---

## 0. Summary

1. **The server does not know which surface is calling (PROVEN, code).** The phone
   login (`frontend/src/mobile/MobileLogin.tsx`) calls the same `login()` as the
   desktop, which hits `/api/auth/login` and mints an ordinary session. The only
   session the server tells apart is the POS tablet PIN login
   (`backend/src/routes/pos.ts`). So **every divergence below is in the two sets
   of screens**, not in the permission data or the API.
2. **The DOORS are mostly shared already.** The phone menu reuses the desktop nav
   predicate (`frontend/src/components/navFilter.ts`), and several doors read the
   server-decided capabilities (`frontend/src/auth/capabilities.ts`). Existing
   pins: `frontend/src/mobile/mobileMenuGates.test.ts`,
   `frontend/src/auth/permissionDivergence.test.ts`.
3. **The divergence is INSIDE the screens.** Whether a button shows, when a
   document locks, which fields are required, which rows a picker lists. These
   are written separately in each surface's file, and the server mostly does not
   hold the rule. So a rule added to one surface is simply absent from the other.
4. **About 220 divergences** (seven parallel code-reading lines, deduplicated by
   hand — approximate, several rows mix two classes), as of 2026-09-14:

   | class | SO | PO/GR/PI/PR/DO/SI/DR | master data, team | service case | projects | menu, other screens | total |
   |---|---|---|---|---|---|---|---|
   | phone STRICTER than desktop | 9 | 11 | 7 | 11 | 12 | 3 | ~53 |
   | phone LOOSER than desktop | 5 | 5 | 7 | 7 | 1 | 7 | ~32 |
   | different condition | 11 | 6 | 6 | 3 | 12 | 2 | ~40 |
   | missing on phone | 17 | 18 | 10 | 16 | 10 | 8 | ~79 |
   | missing on desktop | 2 | 1 | 4 | 1 | 5 | 2 | ~15 |

5. **Three sources produce them** (§3): phone-only rules written from phone design
   specs (projects, July 2026); hand-copied locks and validations that drifted;
   and two different gates for one destination (desktop ROUTE guard vs the nav
   entry the phone borrows).
6. **Defects found in passing** (§5): a Sales Director could create a Super Admin
   from the phone (fixed, #3831); the phone's Purchase Invoice "Record payment"
   bypasses the finance payment-voucher approval and writes no GL entry, while the
   desktop's two payment buttons on the same invoice did nothing (B-15, found
   while fixing B-2); the phone's convert-from-Sales-Order picker lists only
   DELIVERED orders; the phone fabric list ignores the Model's allowed fabrics; a
   service-case sub-status that can never save.

## 1. Method and honest limits

- Seven read-only lines ran in parallel, one per area: SO detail, SO create/edit,
  the seven downstream documents, master data + warehouse + team, service cases,
  projects + calendar, menu/routes + remaining screens. Each compared phone code,
  desktop code AND the backend handler behind the control.
- **Read by lead** (column "by" = L): the lead re-opened the phone, desktop and
  server lines for the rows marked L. Rows marked A were read by an audit line
  only. Both grades are CODE reads — nothing here was clicked through.
- **Production was touched once, read-only:** Actions run 34817494633
  (`.github/workflows/diag-role-permissions.yml`, 2026-09-14 07:22 UTC) for the
  live population in §2.
- Not covered: a line-by-line diff of the SO line card internals beyond the
  fields listed; the public DO scan page; handler bodies marked UNVERIFIED in a
  row.

## 2. Who is affected — the live population

From run 34817494633: **79 active users**. The cohort column is what the CURRENT
code (`backend/src/services/positionPolicy.ts`) resolves them to.

| position | active | cohort in code | notes |
|---|---|---|---|
| Super Admin | 3 | wildcard (position) | |
| Owner | 1 | wildcard (position) | |
| Managing Director | 2 | wildcard (position) | |
| IT Developer Executive | 2 | 1 wildcard (role Super Admin), 1 full | |
| HR Manager | 1 | full | role "Position Preview" (no flat keys) |
| Finance Manager | 2 | full + money writes | director tier |
| Operation Executive | 5 | full | roles BD Exec, Ops Exec, Purchaser x2, Position Preview |
| Logistic Admin | 3 | full | role Logistic |
| Outsource Transporter | 13 | full | role Driver (no service-case keys) |
| Sales Director | 2 | sales (director) | |
| Sales Manager | 4 | sales | role Sales Person |
| Sales Executive | 27 | sales | role Sales Person |
| Driver | 5 | restricted | |
| Warehouse Crew KL | 8 | restricted (Storekeeper rows) | |
| (no position) | 1 | legacy role matrix | role Position Preview |

Totals by cohort: wildcard 7, full 25, sales 33, restricted 13, positionless 1.

**The diagnostic's own classifier is stale** (a finding, §5 B-9):
`backend/scripts/audit-permission-grants.mjs` hard-codes
`GOD_POSITIONS = Super Admin, Owner` and a four-name restricted list, so it prints
Managing Director, Warehouse Crew KL and Calendar Viewer as "FULL". Quote the
per-position counts from it, never its cohort totals.

**Why the owner's own account still hits phone-only restrictions:** a `*` holder
passes every permission check on both surfaces, so what blocks him on the phone
is never a permission. It is a phone-only lock, validation or missing feature
(§4.1–4.3 below are mostly that kind).

## 3. Root cause

1. **Rules implemented per screen, not per document.** Locks (archived, status,
   downstream), required fields and list filters live in
   `frontend/src/mobile/MobileNewSO.tsx`, `MobileSODetail.tsx`,
   `MobileServiceCase.tsx`, `MobilePMS.tsx`, `MobileModuleDetail.tsx` on one side
   and `SalesOrderDetail.tsx`, `ServiceCases.tsx`, `Projects.tsx`, the V2 document
   pages on the other. Where a shared module exists
   (`frontend/src/vendor/scm/lib/so-detail-gates.ts`,
   `frontend/src/vendor/scm/lib/so-form-validate.ts`) the two surfaces still do
   not import the same parts — `so-form-validate.ts:249-250` says the required
   set is shared by `MobileNewSO`, but the phone imports only the date,
   stock-location and message helpers and keeps its own required-field copy.
2. **Phone-only specifications.** `MobilePMS.tsx:905-1099` encodes the owner's
   July 2026 phone card specs as cohort flags: BD-owned documents, tiles hidden
   per cohort, named editors matched by user id (`user?.id === 4`, `=== 44`).
   `Projects.tsx` and `backend/src/routes/projects.ts` have none of those rules.
3. **Two gates for one destination.** The phone asks "is the desktop NAV entry
   visible" (`MobileApp.tsx:595-601`). The desktop enforces the ROUTE guard in
   `frontend/src/App.tsx` (`PageGuard`, `ScmGuard`, `Guard`), which is often a
   different condition. Example: Service Cases — nav `anyPerm service_cases.read`
   (`Sidebar.tsx:270`), route `PageGuard page="service_cases" allowSales`
   (`App.tsx:461`).
4. **The generic phone engine has no permission layer.** `MobileModuleList` /
   `MobileModuleDetail` / `MobileModuleForm` render "+", Edit and status actions
   from `MODULE_CONFIGS`; only DO/SI/PO/GRN/PI creates pass through the
   `canOperate*` helpers (`MobileApp.tsx:857-881`).
5. **The server holds few of these rules**, so nothing forces agreement: in most
   rows below, the server allows what one surface forbids.

**How mainstream ERPs avoid this class.** SAP Fiori, Odoo and NetSuite decide
both "may this person" and "what can be done to this document now" on the
server; phone and desktop clients render the answer (Fiori action availability
from the OData service, Odoo access rules + record rules + button `groups`,
NetSuite roles evaluated server-side for every form). A client never carries its
own copy of a lock or a required-field rule.

## 4. Findings

Columns: **by** — L = re-read by lead, A = read by an audit line. Paths shortened:
M = `frontend/src/mobile/`, P = `frontend/src/pages/scm-v2/`, B = `backend/src/`.

### 4.1 Sales orders

| id | business effect | class | phone | desktop | server | who | by |
|---|---|---|---|---|---|---|---|
| SO-1 | Once a Processing Date is set, the phone also demands **State and City**, on create AND edit | phone stricter | M MobileNewSO.tsx:1303-1311, 1867-1869 | so-form-validate.ts:304-312 (name, address 1, postcode, delivery date) | so-save-problems.ts:254-262 same as desktop | all phone SO users | L |
| SO-2 | Picking a **Delivery Date fills the Processing Date** on the phone, which proceeds the order and switches on the proceed checks | different | MobileNewSO.tsx:2375 | no auto-fill on create or edit | a Processing Date is the proceed signal | all phone SO users | L |
| SO-3 | A typed but malformed **email blocks save** | phone stricter | MobileNewSO.tsx:1291-1294 | no check | stored as typed | all | L |
| SO-4 | **Blank customer name** blocks an edit on the phone | phone stricter | MobileNewSO.tsx:1292, 1768-1769 | phone only required | only on a dated order | all | L |
| SO-5 | The **last line cannot be removed**; "Add at least one line" also on edit | phone stricter | MobileNewSO.tsx:2535, 1770 | any saved line removable | no minimum | all | L |
| SO-6 | A **second amendment** (the other lane) cannot be raised while one is pending | phone stricter | MobileNewSO.tsx:1195 `!hasOpenAmend` | SalesOrderDetail.tsx:1612-1616 blocks only legacy or both lanes | blocks only same lane | amendment raisers | L |
| SO-7 | **Request cancellation** missing on Shipped / Delivered / Invoiced / Closed orders; the phone shows "Items locked" there instead | phone stricter | MobileSODetail.tsx:452, 1325-1329 | SalesOrderDetailV2.tsx:1216-1226 any non-cancelled | document-cancel.ts:153-166 refuses only Cancelled/Closed/Draft; a live DO/SI 409s | all | L |
| SO-8 | Holder of `scm.so.attribute_other` cannot **change the salesperson on a locked order** | phone stricter | MobileSODetail.tsx:480, 1322 | SalesOrderDetailV2.tsx:657, 666 | salesperson is outside the identity lock; key checked | key holders incl. owner | L |
| SO-9 | Payment **"Collected by"** lists only Sales staff | phone stricter | MobileSODetail.tsx:324 `onlySales: true` | PaymentsTable.tsx:545 all active staff | no Sales rule | cashiers | L |
| SO-10 | Draft Edit / Create Sales Order / Add line hidden below `edit` | phone stricter | MobileSODetail.tsx:492-494, 1295, 1331 | no check (dead for L2 view users) | area guard edit for L2 | positions overridden to view | L |
| SO-11 | **Override** a status-locked order | missing on phone | none | SalesOrderDetail.tsx:2061-2097 (reason collected, never sent — §5 B-8) | no status lock on header/lines | editors | A |
| SO-12 | **Line discount** (RM or %) | missing on phone | MobileNewSO.tsx:3084-3097 qty + price only; gross subtotal | SoLineCard.tsx:976-1005 | accepted; a phone qty/price cut below a stored discount 422s (LIKELY) | all | A |
| SO-13 | **Fabric list not limited** to the Model's allowed fabrics — pick, then refused on save | phone looser | MobileNewSO.tsx:3289-3299 no pool filter | SoLineCard.tsx:1507-1522 pool applied | allowed-options-check.ts refuses `variant_not_allowed` | sofa/bedframe lines | L |
| SO-14 | Adding an **unpriced SKU**: desktop books RM 0 as free, phone lets the server price it | different (money) | MobileNewSO.tsx:406 `priceAuthored` | SalesOrderDetail.tsx:1510 always free | mfg-pricing-recompute.ts:299-304 | editors adding module-priced sofas | A |
| SO-15 | Save Draft **drops both dates** on the phone | different | MobileNewSO.tsx:1833-1834 | dates kept (SalesOrderNew.tsx:1605) | proceed gates run on drafts | all | L |
| SO-16 | Decimal **quantity** sent as typed → 422 | different | MobileNewSO.tsx:403 | whole numbers only | positive integer | phone | A |
| SO-17 | Venue check: desktop counts only a listed venue id; phone accepts the name | phone looser | MobileNewSO.tsx:1812 | SalesOrderNew.tsx:1416 | name or id | desktop reps | A |
| SO-18 | Delivery Date editable on a processing-locked order (not amending) | phone stricter (desktop dead, 409) | MobileNewSO.tsx:1216 | SalesOrderDetail.tsx:3481 | so-field-policy.ts controlled | editors | A |
| SO-19 | Processing Date on a past-dated DRAFT | phone looser | so-detail-gates.ts:154-158 skips Draft | SalesOrderDetail.tsx:3135-3137 | server skips Draft | desktop editors | A |
| SO-20 | Customer search + debtor code; copy order; guided/from-products create | missing on phone | — | SalesOrderNew.tsx:612-630, 148-153 | — | reps | A |
| SO-21 | Hold / unhold, hold marker; Close remaining; Transfer to DO from the SO; CSV/batch print; cost columns; refund vouchers; revisions tab; receipt print | missing on phone | — | row-menus.ts, MfgSalesOrdersListV2.tsx | — | office | A |
| SO-22 | Bulk confirm drafts; period filter | missing on desktop | MobileSalesOrders.tsx:449-485, 232-234 | — | per-order PATCH | — | A |
| SO-23 | Only the newest of two open amendments can be acted on; inbox opens the SO not the amendment | missing on phone | MobileSODetail.tsx:472; MobileAmendments.tsx:118 | Amendments.tsx:144-146 | per-amendment id | approvers | A |
| SO-24 | New SO "+" skips the edit-level check the desktop "+" applies | phone looser (403 at Create) | MobileSalesOrders.tsx:730 | QuickActionsFAB.tsx:58, 69 | area guard edit | view-level positions | A |

### 4.2 Downstream documents (PO, GR, PI, PR, DO, SI, DR)

| id | business effect | class | phone | desktop | server | who | by |
|---|---|---|---|---|---|---|---|
| DOC-1 | **Cancel a Delivered DO** with no invoice/return | phone stricter | MobileModuleDetail.tsx:1011 | DeliveryOrderDetailV2.tsx:1176 | refuses only cancelled or with SI/DR | DO operators | L |
| DOC-2 | **Cancel a Closed GRN** | phone stricter | MobileModuleDetail.tsx:1074 | GoodsReceivedDetailV2.tsx:600, 666 | no Closed refusal | GRN operators | L |
| DOC-3 | **Driver POD dead end:** the board leads a dispatch-capable driver to Proof of Delivery, then Confirm says "handled by the Office team" | phone stricter | MobilePOD.tsx:86, 435-444; MobileDeliveryPlanning.tsx:1175 | no POD screen | writeBypass admits scm.do.dispatch on own job | drivers holding the capability (UNKNOWN count) | L |
| DOC-4 | **Convert from Sales Order lists only DELIVERED orders** (DO status list applied to SOs) | phone stricter (bug) | MobileConvertWizard.tsx:307-317 | server-side deliverable lists | accepts all but Draft/Cancelled/On hold/Closed | anyone converting on phone | L |
| DOC-5 | PO / GRN / PI "+" and Add line require page level `edit` | phone stricter | MobileApp.tsx:870-874; mobile-add-line.ts:82-89 | no gate | non-L2 passes; L2 needs edit | positionless or view-level users | A |
| DOC-6 | Convert wizard step 1 reads the SOURCE list (e.g. PO list for GRN) | phone stricter | MobileConvertWizard.tsx:289-291 | destination endpoints | PO list needs PO view | GRN-only positions | A |
| DOC-7 | Converted documents always land as DRAFT | phone stricter (extra step) | MobileConvertWizard.tsx:528, 561, 596 | LOADED / confirmed | honours asDraft | operators | A |
| DOC-8 | Direct PO create sends no options (sofa/bedframe cannot confirm) and forces MYR | phone stricter | mobile-purchase-doc.ts:206-225, 245 | PurchaseOrderNew.tsx:622-655 | option check at confirm | purchasers | A |
| DOC-9 | DR "Mark inspected" only from RECEIVED; SI detail operate buttons for Sales-override positions; cancel of paid PI in UI | phone stricter | MobileModuleDetail.tsx:1088, 985, 1111 | DeliveryReturnDetailV2.tsx:766; SalesInvoiceDetailV2.tsx:596 | see row | operators | A |
| DOC-10 | **Purchase Invoice "Record payment" writes paid amount straight onto the PI** — no voucher, no Finance check/approve, no hold check, no GL | phone looser (money) | MobileModuleDetail.tsx:962-969, 1184-1192 | desktop path is Payment Vouchers (Finance) | purchase-invoices.ts:1142-1209 | the 25 full-cohort staff + wildcard | L |
| DOC-11 | SI "Record payment" shown to Sales, then refused | phone looser | MobileModuleDetail.tsx:962-969 | SalesInvoiceDetailV2.tsx:1331 | salesJdWriteDenial | Sales (33) | A |
| DOC-12 | PO amendments row shown to approvers without PO view, then "Couldn't load" | phone looser | MobileApp.tsx:595-601 | ScmGuard po | 403 | edge | A |
| DOC-13 | Status moves on a HELD DO | phone looser (vs desktop list) | MobileModuleDetail.tsx:1010-1031 | MfgDeliveryOrdersListV2.tsx:991-994 | no hold check | DO operators | A |
| DOC-14 | Driver "Mark arrived" writes a DO header PATCH a driver is refused | phone looser (dead) | MobileDeliveryPlanning.tsx:1304-1310 | none | bypass covers /status, /revert only | drivers | A |
| DOC-15 | Which DO steps are offered; DR cancel by status; map node taps; DO→SI entry permission | different | MobileModuleDetail.tsx:1022-1027, 1085; MobileApp.tsx:672-677 | do-next-step.ts:212-216; row-menus.ts | accepts forward moves | operators | A |
| DOC-16 | Revert DO; hold / hold marker; edit header/lines of PO/GRN/PI/SI; create PR/DR/direct DO/SI; GRN→PI, GRN→PR, DO→DR; print PO/GRN/PI/PR/DR; email PO; raise PO amendment; per-document history; PO/DO line photos; source-rack pick; finance columns; deep links; SI payment rows/delete; PR credit-note ref; /scm/do-load; allocations, bulk supplier date, batch print | missing on phone | — | see P DeliveryOrderDetailV2.tsx:1188 (revert), PurchaseOrderDetailV2.tsx:1202-1252 … | — | office | A |
| DOC-17 | POD evidence capture (signature, photo, GPS) | missing on desktop | MobilePOD.tsx:193-216 | none | delivery-orders-mfg.ts:5400-5425 | office | A |

### 4.3 Service cases

| id | business effect | class | phone | desktop | server | who | by |
|---|---|---|---|---|---|---|---|
| SC-1 | **Archived case: stage fields locked** (resolution, supplier, pickup/return dates, QC, DO no./date, status update) | phone stricter | MobileServiceCase.tsx:1006 `dis = busy \|\| isArchived` | ServiceCases.tsx:4128-4187 no archived check | PATCH has no archived check; only set-supplier refuses | ops | L |
| SC-2 | Raising a case: the **SO must be picked from search** (no typed SO no., no "Pull from AutoCount") | phone stricter | MobileServiceCase.tsx:2041, 2180 | ServiceCases.tsx:2792-2796, 2865 | accepts an unknown SO | anyone raising a case | L |
| SC-3 | **"Other…" custom issue category** | missing on phone (stricter) | lookup list only | ServiceCases.tsx:3032 OTHER_SENTINEL | only non-blank | all | L |
| SC-4 | Service tab **locked for office staff whose role lacks service_cases.read** (page access full) | phone stricter (desktop via link / "+") | MobileApp.tsx:609 nav gate | App.tsx:461 PageGuard page | requireServiceCaseAccess: any company grant | 3 office users (Position Preview role) + 13 Outsource Transporters | L |
| SC-5 | Photo types by extension (.heic/.gif refused) | phone stricter | MobileServiceCase.tsx:2958-2963 | uploadDropZone.tsx:48-50 by MIME | extension list | uploads | A |
| SC-6 | Product category at intake; void with reason; restore archived; "opened" auto-advance; workflow prompts | missing on phone | — | ServiceCases.tsx:2718, 5737, 3561, 3228, 5366 | write / manage | ops | A |
| SC-7 | **Completed/archived case: items frozen on desktop, editable on phone**; notes and photo delete on archived | phone looser | MobileServiceCase.tsx:3051, 1312, 1758 | ServiceCases.tsx:3840-3889, 4860, 3781 | no lock | ops | L |
| SC-8 | Changing the salesperson asks for confirmation on desktop only; intake photo size/types | phone looser | MobileServiceCase.tsx:1505, 156 | ServiceCases.tsx:4571-4577, 2533 | — | editors | A |
| SC-9 | Sales rep's default list: phone shows the full company list, desktop My Cases | different | MobileServiceCase.tsx:413 | MyCases.tsx:86-87 | two predicates | 32 reps | A |
| SC-10 | Many desktop-only tools: address edit, pickup-by, GRN note, inspection visit, PO no./generate PO, logistics schedule/POD, stage document slots, timeline archive, portal/supplier/survey links, resolve supplier from AutoCount, letterhead choice, bulk tools, CSV, metrics/maintenance/lead time, open one case by link | missing on phone | — | ServiceCases.tsx (see audit line notes) | write / manage | ops | A |
| SC-11 | DO no. / DO date edit | missing on desktop | MobileServiceCase.tsx:1161-1162 | read-only | editable | ops | A |

### 4.4 Projects (PMS) and calendar

| id | business effect | class | phone | desktop | server | who | by |
|---|---|---|---|---|---|---|---|
| PMS-1 | **Checklist documents read-only per cohort**: Sales — Weekend/Permit/Decoration; office — every tile; management — all but the "BD tier" (owner, BD role, user id 4) | phone stricter | MobilePMS.tsx:1032-1086, 3627 | Projects.tsx:8912-8916, 9705 write or tick+badge | no "BD-owned" rule | the 31 Sales Person role holders with projects.write, HR, Finance, Ops, Logistic | L |
| PMS-2 | **Whole checklist items hidden per cohort** (License/Stamp Duty BD-tier only, Payment hidden from Sales Director, floor-plan tiles hidden from office/purchasers, crew views) | phone stricter | MobilePMS.tsx:985-1026, 1457 | every row the server sends | strips only Agreement for non-sensitive | all | L |
| PMS-3 | **Named editors by user id** (Lim id 4, Kingsley id 44) drive doc edit, schedule edit, P&L view/edit, contract edit | different | MobilePMS.tsx:961-977 | no id rules | no id rules | everyone else | L |
| PMS-4 | **Archived project: nearly everything locked** | phone stricter | MobilePMS.tsx:886, 1145-1593 | only the status dropdown (Projects.tsx:6510) | no archived guard | editors of archived projects | L |
| PMS-5 | Tick-only users' list opens on "assigned to me" | phone stricter | MobilePMS.tsx:408-474 | drivers only | filter applied | Purchaser role (2) | L |
| PMS-6 | No Done / N/A ticks except defect tiles; no payment-status pills | missing on phone | MobilePMS.tsx:3636 | Projects.tsx:9986, 9904 | status route | editors | A |
| PMS-7 | P&L visible/editable by role-name rules; Sales Director view-only | phone stricter | MobilePMS.tsx:976-977, 1589-1593 | FinanceLedgerSection by canFinancial | projects.write + denyFinance | finance viewers, SD | A |
| PMS-8 | Setup & Dismantle schedule edit: Logistic Admin edits on desktop, read-only on phone | phone stricter | MobilePMS.tsx:1370, 1503 | Projects.tsx:11439-11444 | projects.write | Logistic Admin (3) | A |
| PMS-9 | Floor plans: phone uploads Filled/Display only, delete = write only, Stock Out = purchaser only | phone stricter | MobilePMS.tsx:3730, 3966-3976, 1553 | checklist rows, write or badge | write or badge (+SD exception) | BD, designers | A |
| PMS-10 | New Project: state only from the venue; masters select-only | phone stricter | MobileNewProject.tsx:67, 78 | state overridable, add venue/organizer | — | creators | A |
| PMS-11 | Sales section on the phone shows finance lines (emptied for non-finance) instead of sales entries | phone stricter | MobilePMS.tsx:1572-1575 | /api/sales/entries | read admits Sales | Sales staff | A |
| PMS-12 | My Pending chip for the Sales/crew cohort | phone looser | MobilePMS.tsx:564-569 | hidden for that cohort | lanes exist | Sales, crew | A |
| PMS-13 | Header edit, PIC assign, crew definitions, schedule screenshots, service/phase photos, Quick Log rules, approve on gated rows | different | MobilePMS.tsx (rows 12-22, 27 of the audit line) | Projects.tsx | projects.write | editors | A |
| PMS-14 | Crew JSON, schedule remark, sections/comments/history, 3D approval block, event chat, list tools, print, Gantt, desktop-only views | missing on phone | — | Projects.tsx | — | editors | A |
| PMS-15 | Single driver/lorry quick-assign; phase photo upload; notes editing; legacy floor-plan files | missing on desktop | MobilePMS.tsx:3016-3030, 2933 | — | — | — | A |

### 4.5 Master data, warehouse, logistics, team

| id | business effect | class | phone | desktop | server | who | by |
|---|---|---|---|---|---|---|---|
| MD-1 | **Product "Cost Price" always shows "—"** | phone stricter (data) | MobileModuleList.tsx:1889 reads the list row | ProductModelDetail.tsx:132 | list select never carries cost (mfg-products.ts:151-155) | Purchasing, Finance, SD, wildcard | L |
| MD-2 | **Departments hidden from the Sales Director** | phone stricter | Sidebar.tsx:866 leaf lacks the SD bypass | Team.tsx:267, 283 | departments.ts:33 admits SD | Sales Directors (2) | L |
| MD-3 | **Driver mileage photo fails** — the upload rides the Sales Order slip path | phone stricter | MobileMileageCapture.tsx:82, 119 | no photo on desktop | scm/index.ts:871 `/slips` needs scm.sales.orders | in-house drivers (5) | L |
| MD-4 | Inactive drivers/helpers/lorries/warehouses not listed, no toggle | phone stricter | MobileModuleList.tsx:1394, 1424, 1965, 1310 | "Show inactive" | default active-only | admins | A |
| MD-5 | Supplier edit refuses blank code/name | phone stricter | MobileModuleForm.tsx:250-256 | SupplierDetail.tsx:2894-2901 no check | no check | editors | A |
| MD-6 | L2 users holding `scm.access` open SCM pages by URL on desktop (API 403s); phone hides | phone stricter (desktop dead) | navFilter.ts:95-97 | App.tsx:356 | area guard 403 | L2 roles carrying scm.access | A |
| MD-7 | Invite "+", member Edit, department "+"/Edit shown to everyone who reaches them | phone looser | MobileApp.tsx:879-881; MobileModuleDetail.tsx:1980 | Team.tsx:268, 1911; TeamDepartmentsV2.tsx:253 | users.manage / SD | users.read holders | A |
| MD-8 | **Sales Director invite with any role** | phone looser → **security, fixed #3831** | MobileModuleList.tsx:1055-1056 | no Role picker for SD | invite took the client role | Sales Directors (2) | L |
| MD-9 | Search opens Products list / Members list with no page gate | phone looser | MobileApp.tsx:713-720 | route guards | products openRead | reps, crew | A |
| MD-10 | Supplier currency from the live master; server silently replaces non-5 codes with MYR | different | MobileModuleList.tsx:913-914 | fixed list of 5 | suppliers.ts:54, 436, 508 | editors | A |
| MD-11 | Pending member edit sends status "invited" → 400 | different | MobileModuleForm.tsx:134-135 | status via enable/disable | active/disabled only | admins | A |
| MD-12 | Lorry identity edit, driver edit, supplier credit limit | missing on desktop | MobileModuleList.tsx:952-976, 928-947, 904-906 | none | PATCH accepts | fleet admins | A |
| MD-13 | Helpers create/toggle; warehouse and rack writes; stock take; transfer cancel; consignment writes; chart of accounts; MRP actions; regions; delivery planning board tools; supplier mappings; lorry compliance; team org chart, mailboxes, roles CRUD, capability matrix | missing on phone | — | see pages | — | admins | A |

### 4.6 Menu, routes and other screens

| id | business effect | class | phone | desktop | server | who | by |
|---|---|---|---|---|---|---|---|
| NAV-1 | Global search only inside the Calendar tab | phone stricter | MobileApp.tsx:1010-1013 | Cmd+K everywhere | auth only | calendar=none users | A |
| NAV-2 | Announcement audience ("To:") hidden from readers | phone stricter | MobileAnnouncements.tsx:1610 | InboxView.tsx:589 | returned | readers | A |
| NAV-3 | Sales Director manage buttons on other authors' notices | phone stricter (desktop dead, 404) | MobileAnnouncements.tsx:590 | ManageView.tsx:484-520 | sdBlockedFromRow | SD | A |
| NAV-4 | Activity inbox always shown; desktop page needs projects.read | phone looser | MobileApp.tsx:477 | App.tsx:905-910 | any signed-in user | — | A |
| NAV-5 | The phone checks only the LEAF nav entry; the desktop sidebar also hides children of a hidden group (Sales Report for SD, consignment/finance rows for reps, fleet mileage, amendment rows) | phone looser | MobileApp.tsx:599-600 | navFilter.ts:124-136 | per route | see audit line D-03/06/07/08 | A |
| NAV-6 | Projects row for Calendar Viewer opens then fails | phone looser | MobileApp.tsx:353 | Projects.tsx:1000-1005 | projects.list | Calendar Viewer (0 today) | A |
| NAV-7 | "SOP never expires" not applied; mark-as-read on every notice; Roles row shown then locked | phone looser | MobileAnnouncements.tsx:1413, 1208-1219; MobileApp.tsx:495 | ComposerModal.tsx:174-180 | no check | publishers | A |
| NAV-8 | Fleet Mileage vs Fleet Health; announcement targeting (positions vs divisions/exclusions) | different | MobileApp.tsx:422 | App.tsx:643 | fleet.read / fleet.write | — | A |
| NAV-9 | Open PO/GRN/DO/SI/PI from search; announcement publisher tools; dashboard cards; Sales Report export; mail admin/bulk; open project from inbox row; AutoCount host log/sweep; roles & permissions management | missing on phone | MobileSearch.tsx:126-131 … | — | — | — | A |
| NAV-10 | "Reset all read-receipts"; scan jobs of other reps + clear failed | missing on desktop | MobileAnnouncements.tsx:274-296; MobileScan.tsx:619-701 | — | — | — | A |

## 5. Defects found in passing

| id | defect | evidence | status |
|---|---|---|---|
| B-1 | **A Sales Director could invite an account into Super Admin** (and activate it with a password) from the phone | `backend/src/routes/users.ts` invite scoped branch defaulted the role only when absent; `backend/src/routes/roles.ts:29-41` | **FIXED, #3831 merged 2026-09-14 08:19Z**; production Worker `/health` reported sha `ba8a8642` (its merge commit) when re-checked the same afternoon. Ledger: `docs/bugs/0887-a-sales-director-could-invite-a-new-account-straight-into-su.md` |
| B-2 | Phone PI "Record payment" bypasses Payment Vouchers (Finance check + approve) and the GL; also skips the hold check | DOC-10 | **FIXED, #3841 merged 2026-09-14 09:59Z and in production** (the Worker's `/health` sha `b9d05153` contains its merge commit `10fd908b`). The route refuses every call; both surfaces send the operator to the AP Payment. Ledger: `docs/bugs/0889-supplier-invoice-payments-could-skip-the-payment-voucher-and.md`. Payments recorded through it before: **0 entries, RM 0.00** across the 53 purchase-invoice audit rows since 2026-07-23 (read-only run 34833260858); before 2026-07-23 UNKNOWN, no audit row exists |
| B-3 | Phone convert-from-SO picker lists only DELIVERED SOs | DOC-4, `MobileConvertWizard.tsx:307-317` | **FIXED, #3836 merged 2026-09-14 09:13Z and in production** |
| B-4 | Phone fabric picker ignores the Model's allowed fabrics — the 0836 class the owner asked to close permanently | SO-13 | **FIXED, #3838 merged 2026-09-14 09:13Z and in production.** The owner then reported fabrics repeatedly could not be picked at all; that root cause was the search cap applied before the retired / pool filters: **FIXED, #3856 merged 12:40Z, in production** (the live bundle's `fabric-queries` chunk sends `&itemCode=`), ledger `docs/bugs/0893-the-fabric-search-capped-at-50-before-hiding-retired-and-dis.md` |
| B-5 | Service-case sub-status "Pending Customer Pickup" can never save: offered on both surfaces, missing from the PATCH allowlist | `backend/src/routes/assr.ts:1863-1868`; `frontend/src/vendor/scm/lib/assr/stages.ts:143`; desktop swallows the 400 | **FIXED, #3843 merged 2026-09-14 09:59Z and in production**; the sub-status list has one home (`backend/src/scm/shared/assr-sub-statuses.ts`). Ledger: `docs/bugs/0890-a-service-case-could-never-be-switched-back-to-pending-custo.md` |
| B-6 | Global search returns service-case number, customer and complaint to any signed-in user of the company, no visibility rule | `backend/src/routes/search.ts:183-190, 268-272` | open (L) |
| B-7 | Driver POD is allowed by the server and finished by no screen | DOC-3 | open |
| B-8 | Desktop "Override" on a locked SO collects a reason that is never sent; the same-status PATCH writes no audit row | `SalesOrderDetail.tsx:2079-2090`; `mfg-sales-orders.ts:5757-5759` | open (A) |
| B-9 | `audit-permission-grants.mjs` classifier is stale (Managing Director, Warehouse Crew KL, Calendar Viewer) | §2 | **FIXED, #3858 merged 2026-09-14 12:27Z**: the classifier asks the policy modules (`docs/bugs/0894-...`). The same work found both diagnostics printing staff names into the public Actions log; they print user ids now (`docs/bugs/0895-...`). Earlier runs' logs still hold names — deleting them is a repository admin's call |
| B-10 | Line remarks stored inconsistently (create reads `variants.remark`, line edit reads top-level `remark`, add-line writes none for non-sofa) — phone and desktop each lose one side | `mfg-sales-orders.ts:4232-4235, 7954-8007, 8517-8523` | UNVERIFIED — needs a live test |
| B-11 | Phone line edits stop following the header delivery date (override flag never sent) | `MobileNewSO.tsx:1591-1601` vs `SalesOrderDetail.tsx:1487-1488` | open (A) |
| B-12 | `positionPolicy.ts:429` matches "Sales Director" by word boundary while capabilities use the exact name | `backend/src/services/positionPolicy.ts:429` | open (A) |
| B-13 | Desktop CSV export of service cases includes PO amounts for anyone who can open the list | `backend/src/routes/assr.ts:1205-1244` | open (A) |
| B-14 | `/api/scm/entity-audit-log` has no area guard | `backend/src/scm/index.ts:597-606` — its comment names narrowing an OWNER call | known, owner call |
| B-15 | Desktop PI payment buttons did nothing: **Record payment** navigated to `?tab=payments&record=1` on the same page, which reads neither; **Mark paid** showed only at RM0 owed and sent RM0, which the route refuses. Found while fixing B-2. Row DOC-10 was right that the desktop's working path is Payment Vouchers; it did not record that the invoice's own two buttons were dead | `PurchaseInvoiceDetailV2.tsx`, `PurchaseInvoicesListV2.tsx` at `ba8a86428` | **FIXED with B-2**: Record payment opens the AP Payment with the invoice ticked; Mark paid removed |

## 6. Options

| option | what changes | cost | what it leaves |
|---|---|---|---|
| **A. Patch the list** (stopgap) | make each row in §4 agree, one PR per module, following the server | ~1–2 weeks of small PRs | the next feature forks again; nothing stops it |
| **B. One rule module per document** | for SO / service case / project / each document: one shared file for locks, required fields, cancellable statuses, list filters, imported by BOTH screens (extend `so-detail-gates.ts` / `so-form-validate.ts`, which exist but are half-used); a source-scan test fails when a screen re-derives a rule | ~3–4 weeks | server still does not hold the rules; a third client would copy them |
| **C. Server-decided actions per document** (proper) | every document read returns `actions` (can edit / cancel / add line / change salesperson / record payment, lock reason, required fields) computed by the SAME functions the write routes enforce; both screens render only from it; a check fails a screen that computes its own; extends the capability registry pattern (`backend/src/services/capabilities.ts`) from user level to document level | ~5–8 weeks, module by module | matches how SAP / Odoo / NetSuite work; §4 rows disappear as each module moves |

**Recommendation: C, staged, starting with Sales Orders** (most used, most rows,
shared gates already half-built), then service cases, projects, the downstream
documents. B-1 to B-7 are defects and should not wait for the option: fix them
first, one PR each.

## 7. Decisions needed from the owner

| # | question | recommendation |
|---|---|---|
| D1 | Merge PR #3831 (Sales Director invite always gets the baseline role) to production now? It was not walked through on staging — there is no Sales Director session to walk it with. | yes — it only removes an ability; full admins unchanged |
| D2 | Which option in §6? | C, staged, SO first |
| D3 | The July phone-only project rules (BD-owned documents editable only by owner / BD / Lim / Kingsley; License, Stamp Duty, Payment hidden from some cohorts): keep them as the company rule on BOTH surfaces and the server, or drop them so the phone follows the desktop? | keep, but as a grantable permission in Roles & Permissions — no user ids in code |
| D4 | Archived projects and archived service cases: locked on both (restore to edit), or editable on both (today's desktop + server)? | editable on both (late costs and corrections arrive after an event closes) |
| D5 | Phone Purchase Invoice "Record payment" (B-2): turn it off so supplier payments go through Payment Vouchers? | yes |

Default for every row not listed in §7: **follow the server** — where the server
accepts, both surfaces allow; where the server refuses, both surfaces hide.

**The owner's answers (2026-09-14).**

| # | answer | what it means here |
|---|---|---|
| D1 | chose 「现在上线（推荐）」 | #3831 merged and deployed (§5 B-1) |
| D2 | chose 「C 服务器决定（推荐）」, then 「那就跟c」 | option C, staged, Sales Orders first |
| D3 | 「7月？几时的时候呢？要根据最新的啊」 | the latest rulings supersede the July phone-only project rules: 2026-08-19 made project visibility company-only, and 2026-09-12 made permissions identical on phone and desktop. The phone follows the desktop and the server. A BD-only edit rule, if still wanted, returns as a grantable permission under option C, never as phone-only code |
| D4 | 「根据最新的version」 | **Projects:** archived projects stay editable on both surfaces, as the desktop and the server do — the phone's lock was removed by #3851 (merged 10:32Z, in production). **Service cases: CORRECTED.** The premise was wrong: the desktop has shown "read-only. Use Restore to reactivate." on an archived case since 2026-04-20, yet still lets resolution, supplier and the supplier status update be edited, while the phone locks those and leaves items and notes editable (SC-1, SC-7), and the server locks nothing. Asked again, the owner could not place the question; measured instead (read-only, 2026-09-14): **0 of 904 service cases are archived** (company 1: 0 of 886; company 2: 0 of 18). Nothing is changed while no case uses it; if archiving starts, align both surfaces to the desktop banner's rule |
| D5 | 「根据最新的version」 | supplier payments go through payment vouchers (the 2026-09-02 flow): §5 B-2 and B-15 |

## 8. Re-running the evidence

- Population: Actions → "Role permissions diag (read-only)" → Run workflow
  (`.github/workflows/diag-role-permissions.yml`). Read per-position counts, not
  the cohort totals (B-9).
- A row: open the phone and desktop lines cited at `081a3fe72`, then the server
  handler via `docs/generated/route-locator.md`.
