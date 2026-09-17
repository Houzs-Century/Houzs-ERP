# TODO

One line per open item: what — waiting on — since. Delete the line when it is done. Older items were dropped on 2026-09-15; they are in tag `archive/docs-2026-09-15`.

## Waiting on owner
- Roles & Permissions part B follow-ups: (1) phone has no Titles editor (desktop-only like the Actions matrix); (2) three frontend name lists remain (`assistantAccess.ts` denial list, `Sidebar.tsx` hideForPositions, `crewScope.ts` fallback) — fold onto capabilities; (3) owner to consider Duty = logistic for Logistic Admin (their renamed Title has resolved to OTHER on projects since the rename) — 2026-09-16
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
- Accountant: start date for the customer receipt (OR) write-back — 2026-09-14
- Office: Remark 2 run in AutoCount for receipts after 2026-09-10 18:25 — 2026-09-15
- Cloudflare account holder: staging Worker needs the staging service_role key (staging rehearsal red) — 2026-09-12
- Warehouse: 239 SQUARE + 14 LONG custom pillows have no colour (stock-take by colour) — 2026-09-14

## Dev
- AutoCount PO Doc No. repair: verify batch 3, then the last 243 rows, out of office hours — 2026-09-15
- AutoCount: an edit composed before a rebuild is refused "line not found"; recompose once — 2026-09-15
- AutoCount: size changes on 6 carried-over lines (4 orders) never reached the book; trace, then repair — 2026-09-15
- AutoCount: 7 carried-over invoices (HC-I-…) stay keyless; HC-DO-010936 DocDate differs — 2026-09-15
- Customer receipts (OR) write-back: build behind a switch (OFF), stop at a green PR — 2026-09-14
- Sofa: shared-bucket special refusals (HC-SO-010981, 013193 + 12); HC-SO-012046 / 013224 shipped SKUs differ from the factory build — 2026-09-14
- Phone/desktop parity defects B-6, B-7, B-8, B-10 to B-13, MD-3, one PR each — 2026-09-14
- Sales order list: right-click "Reopen" shows on cancelled orders but the server always refuses it — 2026-09-15
- Photos over 2 MiB are dropped (4 documents) — 2026-09-14

## Plans in force
- Auto-derive product price from supplier (owner 2026-09-16, plan `PLAN-auto-derive-product-price-from-supplier.md`): Product Maintenance / sofa-combo / special cost prices stop being hand-typed and auto-derive = the MOST EXPENSIVE supplier taken as a WHOLE SET; supplier<->SKU link stays as the source. BACKEND-ONLY (zero frontend diff — recompute overwrites the stored column, no read-only field); effective-dating IS in scope (supplier price valid-from + as-of derivation). Only the SO-side budget cost changes; shipped DO FIFO history untouched. Staged: (1) binding-gap report DONE #4012, (2) pure derivation inert #4013, (1b) price-conflict report, (2b) reverse cost-anchor backend hook behind app_config flag + backfill, (3) supplier-price effective-dating, (4) production reprice behind owner go, (5) combo+specials.
- MRP: one global PO-grouping toggle (per-SO or combine); PO date = customer date − supplier×category lead time; sofa/bedframe/accessory/(SP) mattress lines are covered only by a linked PO line; an SO without a processing date is not allocated; no MRP convert on the phone.
- Six documents (SO/PO/GR/PI/SI/DO): effective status SUBMITTED (DO keeps DRAFT/LOADED/DISPATCHED); cancel approval on SO only; every document gets line delivery date, line remark, FOC, per-line warehouse and a change log; discount typed as amount or %.

## Recurring
- Monthly: read every `docs/modules/*.md` against the code it describes and correct what drifted; the guides are orientation, the code is the authority (last done 2026-09-16) — dev

## Handoffs still in tasks/
Two remain until their work lands: `HANDOFF-exports-import-money-2026-09-15.md` (PR #3972, Delivery Orders export) and `HANDOFF-2026-09-15-mrp-stale-demand.md` (the owner's MRP close-out decision). Delete each when done. No new handoff files.
