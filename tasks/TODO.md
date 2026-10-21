# TODO

One line per open item: what — waiting on — since. Delete the line when it is done. Older items were dropped on 2026-09-15; they are in tag `archive/docs-2026-09-15`.

## Waiting on owner
- HC-0125 Employees & Attendance: after phase 1 deploys, grant `hr.employees.manage` (or `hr.employees.read`) to Nico's role in Team > Roles & Permissions; until then only Owner / IT Admin (`*`) see HR > Employees & Attendance — 2026-10-21
- Lorry revenue / occupancy (Logistic Overview) reads the lorry from the DO crew, its lorry run, or the DO Vehicle field; on the local copy only 1 of 298 October DOs carries one. The owner says the team fills the plate on every DO: find WHERE (AutoCount, paper, another field) and read it from there — 2026-10-18
- Houzs POS go-live: create the Cloudflare Pages project `houzs-pos` (direct upload) and attach `pos.houzscentury.com`, then merge PR #4635; `deploy-pos.yml` fails until the project exists — 2026-10-15
- Houzs POS device QA (spec section 16, items 1 to 6, 9, 11): on a real tablet with the ESC/POS printer and the scanner after the deploy: install, Prepare, 3 days offline, hotspot sync, DATA LOST drill, 3-day pending drill, 58 / 80 mm prints, label scans — 2026-10-15
- IT Support (`/it-support`, requests live in the Houzs IT Hub): each company files into its own hub system, keyed by the Worker secret `IT_HUB_API_KEY_<company code>` (`IT_HUB_API_KEY_HOUZS` = hub system HC, `IT_HUB_API_KEY_2990` = hub system 2990) plus `IT_HUB_URL`; issue a key in the hub repo with `node scripts/issue-api-key.mjs <HC|2990>`. The menu row shows only in a company whose key is set. The old single `IT_HUB_API_KEY` secret is no longer read: delete it once the two new ones are in. — 2026-10-13
- Product request (新品 / 重新包装申请): after the PR deploys, grant `scm.product_request.approve` to the Procurement/Purchasing role in Team > Roles & Permissions — until then only the Owner / IT Admin (`*`) can approve; every Sales caller can already raise one — 2026-10-06
- 2990 price-lane amendments: after this PR deploys, assign Kris (only) to the new "Sales Director (Price Approver)" role in Team > Roles — his login e-mail is PII, so the migration creates the role but does not reassign the user. Until then a 2990 price-only SO amendment stays on the Purchaser's queue — 2026-09-21
- Outsourced transport in Members: remove the 3 invited accounts (JAN #94, SHAKTI #93, Cheah #92) in Team, then dedupe their Fleet driver rows under a 3PL company (all 0 trips, safe). Going forward the invite/profile Title picker now warns to build outsourced drivers in Fleet, not Members — 2026-09-17
- Roles & Permissions part B follow-ups: `crewScope.ts` keeps a position-name FALLBACK behind `org.crew.scoped` ON PURPOSE (owner 2026-09-17: it only styles the Projects filter bar, the real scope is server-side, and it is the fixture for the FE==BE referee test) — not to be removed. Phone Titles editor DONE (`mobile/MobileTitles.tsx`). Actions matrix stays desktop-only. — 2026-09-17
- Hookka supplier account 400-H004 belongs to another company in the book: A (recommended) map to 400-O002 and move 94 POs; B 400-H003; C keep. HC-GRN-2609-081 is refused until then — 2026-09-15
- Payment text: keep AutoCount's text and append ERP references (root fix), then restore 61 orders; the #3969 stopgap is live — 2026-09-15
- Carried-over balances: 6 payments on 4 orders (RM 9,047) exist only in AutoCount. A (recommended) staff key them in the ERP — 2026-09-15
- MRP: which of the 122 expired orders to close (Excel list 结单模拟清单20260915.xlsx); nothing is applied without his yes — 2026-09-15
- Schedule the office AutoCount host swap (turns on #3865 and #3922, the receipts route and the CreditorCode edit) — 2026-09-14
- Carried-over receipts → purchase invoices are refused; needs an accounting decision — 2026-09-15
- Option pools: clear only fabric/special restrictions (recommended), split the column, or leave — 2026-09-13
- Auto-derive product price: before the production reprice (replacing hand-typed Product Maintenance costs with the max-supplier value), owner must OK the before/after diff — plan stage 3 — 2026-09-16
- MRP go-ahead: apply the PO-line link repair, then recompute SO allocation — 2026-09-11
- Legacy relay it-houzs.dev serves the PO dump and debtor list with no key: take it down or add a key — 2026-08-12

## Waiting on others
- DEV-32 Edit SO after DO is desktop-only: the phone has no Override and `MobileNewSO.tsx` is at its size ceiling; port the after-DO mode (customer details + charge lines + DO pick) when Logistics needs it on the phone — Samuel — 2026-10-02
- Accountant: start date for the customer receipt (OR) write-back — 2026-09-14
- Office: Remark 2 run in AutoCount for receipts after 2026-09-10 18:25 — 2026-09-15
- Cloudflare account holder: staging Worker needs the staging service_role key (staging rehearsal red) — 2026-09-12
- Warehouse: 239 SQUARE + 14 LONG custom pillows have no colour (stock-take by colour) — 2026-09-14
- BUG-54 service case phone on the delivery sheet: paste `reference/ERPDeliverySync.gs` into the live "Delivery & Amend Updated" project and run `runErpAssrContactRefresh` once, then check Delivery Details R4124 col H — sheet trigger owner — 2026-10-05

## Dev
- Sales Orders list: server-side funnels for the derived columns (PO No., DO No., stock status, payment method, line columns) are on branch `fix/so-list-col-filter` (fa28f14c0), NOT shipped: its first request makes about 740 database calls against the Worker limit of 1,000 — measure on staging and cut the reads before merging — 2026-10-18
- Product request: after `scm.product_request_lines` is on production, re-run `probe-product-code-columns.mjs` so the hand-added `product_request_lines.item_code` line in `tests/fixtures/product-code-columns.snapshot.json` is read back from production (it was written from the migration; it replaced the `product_requests.item_code` line of 2026-10-07) — 2026-10-15
- AutoCount PO Doc No. repair: verify batch 3, then the last 243 rows, out of office hours — 2026-09-15
- AutoCount: an edit composed before a rebuild is refused "line not found"; recompose once — 2026-09-15
- AutoCount: size changes on 6 carried-over lines (4 orders) never reached the book; trace, then repair — 2026-09-15
- AutoCount: 7 carried-over invoices (HC-I-…) stay keyless; HC-DO-010936 DocDate differs — 2026-09-15
- Customer receipts (OR) write-back: build behind a switch (OFF), stop at a green PR — 2026-09-14
- Sofa: shared-bucket special refusals (HC-SO-010981, 013193 + 12); HC-SO-012046 / 013224 shipped SKUs differ from the factory build — 2026-09-14
- Phone/desktop parity defects B-6, B-7, B-8, B-10 to B-13, MD-3, one PR each — 2026-09-14
- Sales order list: right-click "Reopen" shows on cancelled orders but the server always refuses it — 2026-09-15
- Photos over 2 MiB are dropped (4 documents) — 2026-09-14
- Drop `public.project_sales_bills` (created by mig 20261014T1600, unused since the sales report is derived from the project chat; 38 saved rows are superseded by the chat they came from) — needs a migration with REVERSAL — 2026-10-14

## Plans in force
- One table component (owner 2026-09-25): done 2026-09-27. Every list renders `components/DataTable.tsx`, with resize-one-column, wrap, freeze-up-to, Title Case headers, auto-fit, footer totals, Ctrl+C, export of the ticked rows, header descriptions (`lib/columnDescriptions.ts`), fixed overdue/owing highlights (`lib/tableHighlight.ts`), column filters in the URL (`cf.<tableId>`), and one display format (yyyy/mm/dd, "RM 1,234.00" incl. PDFs, readable status). Left: quantity separators on document detail line tables and create-from pickers (in progress); mobile card lists have no totals / freeze / copy by design.
- Auto-derive product price from supplier (owner 2026-09-16, plan `PLAN-auto-derive-product-price-from-supplier.md`): Product Maintenance / sofa-combo / special cost prices stop being hand-typed and auto-derive = the MOST EXPENSIVE supplier taken as a WHOLE SET; supplier<->SKU link stays as the source. BACKEND-ONLY (zero frontend diff — recompute overwrites the stored column, no read-only field); effective-dating IS in scope (supplier price valid-from + as-of derivation). Only the SO-side budget cost changes; shipped DO FIFO history untouched. Staged: (1) binding-gap report DONE #4012, (2) pure derivation inert #4013, (1b) price-conflict report, (2b) reverse cost-anchor backend hook behind app_config flag + backfill, (3) supplier-price effective-dating, (4) production reprice behind owner go, (5) combo+specials.
- MRP: one global PO-grouping toggle (per-SO or combine); PO date = customer date − supplier×category lead time; sofa/bedframe/accessory/(SP) mattress lines are covered only by a linked PO line; an SO without a processing date is not allocated; no MRP convert on the phone.
- Six documents (SO/PO/GR/PI/SI/DO): effective status SUBMITTED (DO keeps DRAFT/LOADED/DISPATCHED); cancel approval on SO only; every document gets line delivery date, line remark, FOC, per-line warehouse and a change log; discount typed as amount or %.

## HC-0125 — Employees & Attendance, ported from Hookka (Nico, owner OK 2026-10-20)

Port Hookka's `/employees` page (Employees & Attendance) and its worker punch in/out for drivers and warehouse crew, desktop and phone. Owner: "fully migrate including Mobile version, after migrate then I will adjust". Source is `hookkadev/hookka-erp-testing` `origin/main` (about 35k lines: `src/pages/employees.tsx`, `src/api/routes/{worker,workers,attendance,working-hour-entries,payslips,payroll-hour-deductions,employee-advances,worker-penalties}.ts`, `src/pages/worker/*`).

Decided (Nico 2026-10-20):
- Phone login = the person's Houzs ERP account (option B), not Hookka's employee no. + PIN. Punch in/out is a screen in `mobile/MobileApp.tsx`, next to POD. Everyone who punches needs an ERP user; the employee row links to `public.users`, which already links to `scm.drivers` / `scm.helpers` (mig 0327).
- Round 1 = the HR parts only: Employee Master, Attendance, Working Hours, Labor Cost, Department Labor, Payroll, Advances, Worker Penalty, Public Holidays, time adjustment requests.
- Not ported until Nico says what she needs: Efficiency Overview, Employee Performance, Department Performance, "Extra production time" requests, phone job scan / QC / issue. They read Hookka's factory production orders, which Century does not have.

Kept from Hookka: selfie + GPS on every punch (geofence flags, never blocks); forgotten punch-out auto-closed at shift end by cron; degenerate-window rule; pay reads Working Hours + hour deductions, not the punch row; shift rules effective-dated.
Changed for Century: geofence per warehouse (`scm.warehouses` gets lat / lng / radius; no hard-coded Shah Alam point); punch photos in R2, not base64 in the row.

Phases, one PR each, `staging` first for Nico, then main:
1. Schema + Employee Master + Public Holidays + shift / pay rules: built on `feat/hc0125-hr-attendance` (`/hr/employees`, `/api/hr/*`, mig `20261021T0300_hr_employees`), not merged yet — 2026-10-21
2. Phone punch screen + Attendance tab + warehouse geofence + auto clock-out cron + time adjustment requests.
3. Working Hours + Labor Cost + Department Labor + hour deductions / settle period.
4. Payroll / payslips + Advances + Worker Penalty + phone "My pay".
5. Driver / helper monthly commission from delivered DOs (`scm.delivery_order_crew` driver_1/2, helper_1/2 + POD `delivered_at`) into payroll — waiting on Nico for the rate rules — 2026-10-20

## Purchase return, phase 2 — the receive-back leg (owner 2026-09-28)

Phase 1 shipped the two kinds (`CREDIT` / `REPAIR`), the mandatory reason code and the OUT→repair-warehouse stock pair. What a repair return still cannot do is come BACK:

- a **Received back** action on the same document: the date, the QC result (fixed / not fixed / scrapped), and the stock moving out of the repair warehouse into the warehouse it came from;
- **repeat rounds** when it comes back unfixed — `round_no 1..N`, the shape `public.assr_supplier_returns` already uses for the service side (pickup_at / returned_at / qc_result / ref_no);
- a list filter for **what is still at the supplier**, so nobody has to remember to chase it;
- decide then whether to back-fill documents for the 18 hand-made stock transfers into KL SERVICE (2026-09-18 → 09-24). They are real stock in the right place with no paperwork; the owner deferred this until the leg exists.

## Recurring
- Monthly: read every `docs/modules/*.md` against the code it describes and correct what drifted; the guides are orientation, the code is the authority (last done 2026-09-16) — dev

## Handoffs still in tasks/
Two remain until their work lands: `HANDOFF-exports-import-money-2026-09-15.md` (PR #3972, Delivery Orders export) and `HANDOFF-2026-09-15-mrp-stale-demand.md` (the owner's MRP close-out decision). Delete each when done. No new handoff files.
