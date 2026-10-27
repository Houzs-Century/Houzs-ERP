# TODO

One line per open item: what — waiting on — since. Delete the line when it is done. Older items were dropped on 2026-09-15; they are in tag `archive/docs-2026-09-15`.

## Waiting on owner
- DEV-03 Mail Center: verify 2990shome.com in Resend (composing from it fails until then), and in Google Admin add each new personal address as an alias of one already-synced account; Team, Mailboxes lists the addresses still waiting (P3) — 2026-10-09
- Lorry revenue / occupancy (Logistic Overview) reads the lorry from the DO crew, its lorry run, or the DO Vehicle field; on the local copy only 1 of 298 October DOs carries one. The owner says the team fills the plate on every DO: find WHERE (AutoCount, paper, another field) and read it from there — 2026-10-18
- Houzs POS go-live: create the Cloudflare Pages project `houzs-pos` (direct upload) and attach `pos.houzscentury.com`, then merge PR #4635; `deploy-pos.yml` fails until the project exists — 2026-10-15
- Houzs POS device QA (spec section 16, items 1 to 6, 9, 11): on a real tablet with the ESC/POS printer and the scanner after the deploy: install, Prepare, 3 days offline, hotspot sync, DATA LOST drill, 3-day pending drill, 58 / 80 mm prints, label scans — 2026-10-15
- IT Support (`/it-support`, requests live in the Houzs IT Hub): each company files into its own hub system, keyed by the Worker secret `IT_HUB_API_KEY_<company code>` (`IT_HUB_API_KEY_HOUZS` = hub system HC, `IT_HUB_API_KEY_2990` = hub system 2990) plus `IT_HUB_URL`; issue a key in the hub repo with `node scripts/issue-api-key.mjs <HC|2990>`. The menu row shows only in a company whose key is set. The old single `IT_HUB_API_KEY` secret is no longer read: delete it once the two new ones are in. — 2026-10-13
- Product request (新品 / 重新包装申请): after the PR deploys, grant `scm.product_request.approve` to the Procurement/Purchasing role in Team > Roles & Permissions — until then only the Owner / IT Admin (`*`) can approve; every Sales caller can already raise one. The HC-0136 bell notice and sidebar count reach ONLY literal holders of that key, so Sim gets no alert until her role carries it — 2026-10-06
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
- HC-0149 Copy as new: phone entry not built (`MobileNewSO.tsx` at its size ceiling; it already seeds from `convertFrom.copyFrom`). Delivery Order copy dropped (owner 2026-10-23: not needed) — Samuel — 2026-10-23
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
- DEV-03 Mail Center personal mail (PRD T-011, Samuel 2026-10-09): one PR per phase. P1 threading headers out (Message-ID / In-Reply-To / References), company-scoped inbound dedup + threading, outbox keeps attachments for the retry, inbound size + rate limit, compose Cc/Bcc actually sent (A2 A6 A7). P2 per-person read (`message_reads`) + needs-acknowledgement (`message_acks`, reuse the announcement ack / overdue / reminder helpers) (A3 A4). P3 invite / accept-invite / create call `changePersonalMailboxAliasAtomically` (default first.last@company), Google side manual with a 'pending at mail host' list, personal mail reaches the ERP as aliases of one synced account (no per-person App Password), My mailbox first, 'what may I see' panel (A1). P4 recipient picker Department / My team / My managers on `services/orgScope.ts` (A5). P5 audit rows, written retention rule (archive, never destroy), the five alert switches + mute setter, mail log screen. Shared-mailbox visibility rules unchanged; sender stays the mailbox.

## Purchase return, phase 2 — the receive-back leg (owner 2026-09-28)

Phase 1 shipped the two kinds (`CREDIT` / `REPAIR`), the mandatory reason code and the OUT→repair-warehouse stock pair. What a repair return still cannot do is come BACK:

- a **Received back** action on the same document: the date, the QC result (fixed / not fixed / scrapped), and the stock moving out of the repair warehouse into the warehouse it came from;
- **repeat rounds** when it comes back unfixed — `round_no 1..N`, the shape `public.assr_supplier_returns` already uses for the service side (pickup_at / returned_at / qc_result / ref_no);
- a list filter for **what is still at the supplier**, so nobody has to remember to chase it;
- decide then whether to back-fill documents for the 18 hand-made stock transfers into KL SERVICE (2026-09-18 → 09-24). They are real stock in the right place with no paperwork; the owner deferred this until the leg exists.

## Performance — whole Century, after HC-0002 (owner 2026-10-22)

Measured on prod 2026-10-22, warm: Overview `procurement-overview` 5.5 s, Inventory `inventory/products` 5.4 s, Delivery Planning 4.6 s, PO / GRN / PI `list-mrp-enrichment` 2.1-2.3 s, `projects/overview` 1.5 s, `logistic-overview` 1.2 s, SO / DO list 1.3-1.6 s, SO `funnel-values` 1.2-1.5 s (138 KB), `customers` 126 KB on the SO / DO / SI lists. #4856 shipped the SO / DO detail warm-up, the shared live MRP run and parallel Service Case pages. Each batch is one PR, measured on prod after merge.

- Batch A, no behaviour change (owner OK 2026-10-22): (1) persist the `*-paged` list keys in `lib/query-persist.ts` so a reopened list paints its last page; (2) PO / GRN / PI enrichment take `sharedLiveMrp` and stop reading the delivered ledger and PO header twice; (3) independent reads in `procurement-overview`, `logistic-overview`, `projects/overview` run together; (4) SO / DO list line-attach in waves, DO counts beside the page; (5) `inventory/products` filters finished SO demand in the database and runs its reads together; (6) Delivery Planning's serial PO-number loops go through `chunkIn` — dev
- Batch B, payload, changes what a screen offers — waiting on owner: `customers` names only; `funnel-values` without the near-unique columns (phone, e-mail, address, doc no., money, note), which become typed filters; Inventory rows without the SO / PO drill arrays, fetched on expand — 2026-10-22
- Batch C, needs a decision each — waiting on owner: list Stock columns from a 15-min MRP snapshot stored with undated lines; Overview procurement from a snapshot; Smart Placement for the Worker (browser served from NRT while the DB is in Singapore slowed every call 5-7x); `auth/me` on the signed-pass fast path; ETag / 304 on the app-wide polls; Server-Timing step timing — 2026-10-22
- SO / DO list repeated reads, batch 1 (owner OK 2026-10-23): DO pill counts from one grouped read (9 -> 1, falls back to the nine counts); DO lifecycle badge from the SI / DR rows the row builder already reads; the DO line attach hands its header read to the Pending ledger; the SO line attach reuses the row builder's base-table and warehouse reads. Same response, before/after page JSON compared on prod. Batch 2: delivery_order_items read four times per DO page (header sources, source SOs, line attach, ledger) — 2026-10-23
- MRP delivered per open SO line from DO lines embedded in the demand read + one read of unlinked DO lines (lib/mrp-delivered.ts), instead of soDeliverableRemaining in 200-doc batches over every open order (~70 of the engine's 94 round trips, prod 2026-10-23 15:31: live /mrp = 94 REST, 1.47 s). Batched path kept as fallback; GET /mrp?includeUndated=true&nettingCheck=1 runs both on the same rows and lists any differing line. Benefits every computeMrp consumer (SO list stock column, SO detail coverage, PO/GRN/PI enrichment, procurement overview, cron snapshot) — 2026-10-23
- PostgREST aggregates look OFF on prod (exact error code shows in Server-Timing `s-db-agg-*` once this ships; DO list search matching nothing = 12 round trips, 3 with them on), so every aggregate fast path (SO pills + money tiles, DO pills, Outstanding /summary) paid a refused request and then paged its fallback UNORDERED — the SO DELIVERED pill read 746 beside a list total of 747 in one response (2026-10-23). Fix: remember PGRST123 per isolate for 10 min (lib/postgrest-aggregate.ts, Server-Timing `s-db-agg-*`), order every fallback page, DO pills fall back to one ordered status read. Turning aggregates on (`pgrst.db_aggregates_enabled`) is Samuel's call — 2026-10-23

- Delivery Planning, done 2026-10-26/27 (#4958 #4961 #4962 #4963): working tabs read `state=OPEN` (1.5 MB, ~2.3 s, was 5.4 MB / 5-12 s); an edit re-reads only its order (0.4-1.0 s); a trigger-fed change log refreshes others' changes every 30 s (poll 84 ms). Left: All / Delivered still read every row (3.8 s, 5.4 MB); scroll renders ~10 ms per new row (inline editors) — 2026-10-27
- Staging migrations fail since 2026-10-26 02:31 (`Staging Migrations` workflow): staging holds 5 applied HR migrations not on main (`20261021T0300_hr_employees` … `20261022T1500_hr_trip_pay`), so pg-migrate stops on drift and staging gets no new migration. Production is unaffected (it applied #4963). Waiting on the owner of the HR branch: merge it, or retire those rows on staging — 2026-10-27

## Recurring
- Monthly: read every `docs/modules/*.md` against the code it describes and correct what drifted; the guides are orientation, the code is the authority (last done 2026-09-16) — dev

## Handoffs still in tasks/
Two remain until their work lands: `HANDOFF-exports-import-money-2026-09-15.md` (PR #3972, Delivery Orders export) and `HANDOFF-2026-09-15-mrp-stale-demand.md` (the owner's MRP close-out decision). Delete each when done. No new handoff files.
