# TODO — what is still open (consolidated 2026-09-15)

Built from the tasks/ handoffs and plans, newest first (a 2026-09-15 file beats an older one; anything later marked done is left out).
Re-measure every count before acting on it. The handoffs behind each line are kept under the git tag archive/docs-2026-09-15 (git show archive/docs-2026-09-15:tasks/<file>). Format: item — waiting on — since.

## Waiting on owner
- Hookka supplier account: the ERP's 400-H004 is another company's creditor in the book. A (recommended): map to 400-O002, move 94 POs (+4 to their own supplier's account), void the empty HC-GRN-2609-079, re-send 079/081; B: 400-H003; C: keep. HC-GRN-2609-081 is the only refused document until then — owner — since 2026-09-15
- Payment text, option A: keep the book's PAYEMENT text in the ERP and append ERP references (root fix), then restore 61 orders (8 need a person); the #3969 stopgap is live — owner — since 2026-09-15
- Carried-over balances: 6 payments on 4 orders (RM 9,047) keyed only in AutoCount. A: staff key them in the ERP (recommended), B: script, C: leave. After the payment-text fix — owner — since 2026-09-15
- Security item raised in chat (deliberately not written in this public repo) — owner — since 2026-09-15
- Office host swap over AnyDesk: switches on #3865 (keys stored on drain) and #3922 (SO lines name their PO), carries the bridge CreditorCode edit and the receipts route — owner to schedule — since 2026-09-14
- Carried-over receipts → purchase invoices are refused wholesale; needs an accounting decision (goods received not invoiced), not raised yet — owner/accountant — since 2026-09-15
- Legacy read relay it-houzs.dev serves the purchase-order dump and debtor list with no key: take it down or key every route (Cloudflare) — owner — since 2026-08-12
- Staging Worker SUPABASE_SERVICE_ROLE_KEY holds the anon key (staging reads fail; rehearsal red since 2026-08-21): put the staging project's service_role key — owner — since 2026-09-12
- Option pools: clear only restriction keys (fabrics, specials; recommended), split the column, or leave as restored. Never clear sizes / mattress_thickness_cm — owner — since 2026-09-13
- Check one 2990 sofa (e.g. Annsa) on the POS offers his 28 colours, not all 58 — owner — since 2026-09-13
- The supplier built two orders the ERP has no PO for: HC-SO-012062, HC-SO-012343 (ours is the mirror). Raise POs or call them pre-cutover — owner — since 2026-09-11
- HC-PO-009784 8030-L(LHF) leg height: its stock bucket is shared with HC-SO-013229, HC-PO-009941, HC-GRN-2609-009. OK to move all four, or build a wider tool — owner — since 2026-09-11
- MRP production writes: re-plan and apply the PO-line link repair (last plan: 2 links + 1 category, 4 refused need a human), then recompute SO allocation (also re-walks 14 stuck pooled lines) — owner go-ahead — since 2026-09-11
- /api/scm/entity-audit-log has no area guard (parity B-14) — owner call — since 2026-09-14
- Bedframe (3 size diffs, 7 POs with blank div/gap/leg) and accessory (66 rows, never compared) alignment to the supplier listing — parked, owner said sofa only — since 2026-09-11

## Waiting on office or others
- Accountant, through the owner: start date for the customer-receipt (OR) write-back. Never ask the owner accounting details — since 2026-09-14
- Accountant: confirm per-project rental/setup for FAIR PNL (RENTAL_discrepancies.csv, 207 rows), then apply with polish-all task=align-figures; PMS rental figures are not reconciled until then — since 2026-07-29
- Office, in AutoCount: a big Remark 2 run for receipts after 2026-09-10 18:25 local (Remark 2 is AutoCount's own program) — since 2026-09-15
- Suppliers: 10 sofa POs missing from their listing — Hookka HC-PO-2609-043/044/045/046/053/054/062/063/064, Ohana HC-PO-009554 — since 2026-09-11
- Sales/customers: 51 not-proceeded sofas with no drawing, 13 undecided drawings — ask the customer or wait for proceed — since 2026-09-10
- A person: HC-SO-011160 colour text looks truncated against the book (B0315-9, 7, 8,12) — since 2026-09-10
- Repository admin: keep or delete 13 old "Diag role permissions" run logs that print staff names — since 2026-09-14
- Owner/warehouse: 239 SQUARE + 14 LONG custom pillows on hand carry no colour (stock-take by colour); 19 migrated lines name an unknown or double colour — since 2026-09-14

## Dev work not started
**AutoCount write-back**
- PO Doc No. repair (0927): verify batch 3, then run the last 243 rows (133 SO, 110 PO) out of office hours only — since 2026-09-15
- Stale-key recompose: an edit composed before a Rebuild is refused "line not found"; recompose once via enqueueEdit when the ERP re-keyed the line (brief in worktree ac-stale-key-recompose) — since 2026-09-15
- ERP size changes on carried-over lines never reached the book (6 lines on 4 orders; HC-SO-009202 unexplained): trace which path carries an item-code change on a keyed line, then repair — not raised with owner — since 2026-09-15
- Customer receipts (OR): switch OFF; bank cash→CASH, HLB→HLBB, voucher→VOUCHER RECEIVED, else MBB; dedupe per payment id; never send cutover "imported" payments; needs a host route; stop at a green PR (worktree ac-official-receipts) — since 2026-09-14
- Until the host swap, export + stamp conversion line keys periodically and requeue keyed DO/GR edits; after it, re-send one ERP PO, read SODTL.UDF_PONo, then re-send pre-swap ERP POs — since 2026-09-14
- 7 carried-over invoices (HC-I-…) stay keyless: the exporter's invoice lane reads only HC-SI- — since 2026-09-15
- HC-DO-010936: book DocDate still 2026-07-21 vs ERP 09-12 (the edit may not send DocDate) — since 2026-09-15
- Data: PO-009790 price 0 in book; PO-010098 receipt on the other same-item line; PO-009979 line with no item; 24 RM1.00 receipt placeholders; HC-GRN-2609-012/-057 look cross-assigned; 73 carried-over receipts with no book number; 1 keyless SO — since 2026-09-15
- Photos over 2 MiB are dropped (4 documents); image reduction not built — since 2026-09-14
- Delete the compare-ac-erp-dates tool (compares against mirrors, blind to delivery dates) — since 2026-09-11

**Sofa, specials, stock**
- Shared-bucket special refusals (HC-SO-010981, HC-SO-013193 + 12): move only chains whose lots trace to their own receipt — since 2026-09-14
- HC-SO-012046 / HC-SO-013224 shipped SKUs differ from the factory build: supplier code → documents → stock adjustment; never an OUT against stock not held — since 2026-09-11
- Sofa POs whose pieces differ from the supplier, follow the factory: HC-PO-010086, 010041, 2609-051, 010087 — since 2026-09-11
- Pillows: HC-PO-009981 OTHER-PILLOW vs SQUARE ×200; HC-PO-010170 random vs custom ×3 (check the customer line) — since 2026-09-14
- Read photos: 3 HB-FULLY-COVER drawer diagrams on HC-SO-012599; 176 other-supplier sofa lines — since 2026-09-14
- Re-verify the owner's 2026-09-10 self-read drawing batch for loungers read as arms — since 2026-09-11
- Merge 9058-CONSOLE into 9058-Console (owner decided; impact list of documents, stock, money first) — since 2026-09-10

**Screens, permissions, platform**
- Phone parity: drop the July phone-only project rules (D3); then the SO read returns actions computed by the write guards (design doc first) — since 2026-09-14
- Parity defects, one PR each: B-6 global search exposes service cases; B-7 driver POD finished by no screen; B-8 locked-SO Override reason never sent; B-10 line remarks stored two ways (verify live); B-11 phone line edits drop the header date; B-12 Sales Director word-boundary match; B-13 service-case CSV shows PO amounts; MD-3 driver mileage photo fails — since 2026-09-14
- 12 pages still declare their own status map instead of status-pill — since 2026-09-13
- Typed but unsaved payment rows: owner chose "page Save commits them" (2026-08-31); what shipped is a leave warning — build it or confirm the warning is enough — since 2026-08-31
- Mobile coverage cells (MobileModuleDetail, MobileRelationshipMap) not audited for "loading shown as an answer" — since 2026-09-02
- Venue master still spells "PJ Showroom": run backfill-canonicalize-venue, plan first — since 2026-09-01
- Probe whether production grants SELECT on scm tables to anon/authenticated (staging does); 6 production tables have no migration file — since 2026-09-12
- Remove worktree ac-so-po-doc-no-fill and the leftover folder ac-po-doc-no — since 2026-09-15

## Active plans
### MRP redesign (started 2026-09-11; shipped #3596 #3602 #3606 #3608 #3612–#3620 #3696 #3938)
- PO grouping, one global toggle. Per-SO: every (SO, category) gets its own PO. Combine: a sofa and its accessories on one PO; bedframes per SO (same supplier + one SO → one PO); mattresses merge within the delivery week; standalone accessories merge same-supplier across SOs.
- Lead time: a supplier × category override beats the category base; PO date = customer date − lead days; learned buffers add on top.
- Company 1 hard binding: sofa, bedframe, Sofa Accessory and (SP) mattress lines are covered only by a PO line linked to them; mattress and accessory lines allocate from pooled stock.
- An SO without a processing date is not allocated (owner rule 2026-08-10). SERVICE never enters MRP; extra categories share one Others tab.
- No MRP convert on the phone (owner 2026-09-11): a named exception to phone/desktop parity.
- Open: the owner-go-ahead writes above; Proceed-PO / select-all should follow the column funnels; a By-Sales-Order view, per-SO convert cards and a bedframe merge button are not committed (recommendation: wait).

### Six-document fill-in (owner decisions 2026-09-12; order: foundation → central gates → alignment)
- Principle: a fix that comes back gets a complete fix — every occurrence found, one central gate, CI refuses the old way.
- SO/PO/GR/PI/SI effective status is SUBMITTED (shipped #3759); DO keeps DRAFT/LOADED/DISPATCHED. Hold/downstream freeze on every document except PI/SI.
- Cancel approval on SO only; PO cancels directly in Purchase; anything that can Cancel can Reopen.
- All six documents get a line delivery date, a line remark carried downstream, FOC, per-line warehouse and a complete change log.
- Discount on SO/DO/PI/SI typed as an amount or a %, no toggle buttons; SO gets bulk delivery-date change.
- Conversions follow the SO/PO line; only SO/PO are amended and only they edit specs; SO payments show on DO/SI; PI shows payments and two prices (PO vs supplier) with a difference check.
- Model restrictions follow only what Modular sets; the system adds none. Email unchanged for now (later: SI auto-emails the customer, PO the supplier).
- Undecided: packing-list spec detail (PDF layout must match across the six); whether FOC line photos print (check first).
- Known gaps G1–G8: allowed-options snapshot on models; remark and 13 spec keys in two homes; GR/PI lines have no date; quoted item codes unescaped in ~76 reads; packing list prints no spec; MRP engine and its audit script are two implementations.

## Open bugs carried over from the old ledger
Status was open when the per-bug files were retired on 2026-09-15; check the code before starting one. Full entry: `git show archive/docs-2026-09-15:docs/bugs/<file>`.

- The sofa still short at the selling warehouses is 25 units with no purchase document, not missing stock — dev — `0684-the-sofa-still-short-at-the-selling-warehouses-is-25-units-w.md`
- The cost-stamping script priced a queen bed from a king's purchase line — dev — `0138-the-cost-stamping-script-priced-a-queen-bed-from-a-king-s-pu.md`
- The PostgREST page ceiling was asserted for weeks and never once observed — it is now measurable from the Worker, and the number is still UNKNOWN — dev — `0447-the-postgrest-page-ceiling-was-asserted-for-weeks-and-never.md`
- Nothing ever compared the ERP's transfer counters to AutoCount's own — "transfer to" was measured twice, never across the two systems — dev — `0705-nothing-ever-compared-the-erp-s-transfer-counters-to-autocou.md`
- Three migrated goods receipts overstate what we owe by RM 2,119.50 because the receipt inherits the purchase order's UNDISCOUNTED line price — dev — `0705-three-migrated-goods-receipts-overstate-what-we-owe-by-rm-21.md`
- The keyless sofa fold does not fire on a book code that is a sofa without saying SOFA — dev — `0709-the-keyless-sofa-fold-does-not-fire-on-a-book-code-that-is-a.md`
- A sofa the warehouse already holds cannot be delivered because its purchase line never split into compartments — dev — `0715-a-sofa-the-warehouse-already-holds-cannot-be-delivered-becau.md`
- A sofa purchase line lost its category on the SO to PO hop, and every sofa tool keyed on it goes blind — dev — `0716-a-sofa-purchase-line-lost-its-category-on-the-so-to-po-hop-a.md`
- Every operational document number takes its month from the Worker UTC clock, so the first eight hours of a Malaysian month mint into the previous month — dev — `0716-every-operational-document-number-takes-its-month-from-the-w.md`
- The sofa stock import opened a second set of lots for a build whose sales line gained a special after the first import — dev — `0721-the-sofa-stock-import-opened-a-second-set-of-lots-for-a-buil.md`
- The colour label spelt `Clr` swallows the piece beside it, so a correct sofa reads as a difference — dev — `0722-the-colour-label-spelt-clr-swallows-the-piece-beside-it-so-a.md`
- Three sofa builds hold stock of a model that is on no line of the order they claim to come from — dev — `0723-three-sofa-builds-hold-stock-of-a-model-that-is-on-no-line-o.md`
- An apply of every corrections file adds back a piece the owner removed a round later — dev — `0725-an-apply-of-every-corrections-file-adds-back-a-piece-the-own.md`
- Five RECEIVED purchase orders hold a sofa placeholder row that is not in the sofa item group, so every sofa tool is blind to it — dev — `0739-five-received-purchase-orders-hold-a-sofa-placeholder-row-th.md`
- The account book DOES record which line a document was raised from, in DocTransfer, and every checker was reading the wrong table — dev — `0746-the-account-book-does-record-which-line-a-document-was-raise.md`
- Changing only the salesperson rewrites every line of the document in AutoCount — dev — `0755-changing-only-the-salesperson-rewrites-every-line-of-the-doc.md`
- A receipt took the number of the month it was keyed in, not the month it is dated — dev — `0759-a-receipt-took-the-number-of-the-month-it-was-keyed-in.md`
- The merchant report found the payment, threw it away, then said there was none — dev — `0760-the-merchant-report-found-the-payment-and-threw-it-away.md`
- "Confirm all 9 matched" posted nothing, on its own path — dev — `0761-confirm-all-matched-posted-nothing-on-its-own-path.md`
- Every merchant fee was pointed at an account the chart had deactivated — dev — `0762-every-merchant-fee-was-pointed-at-a-deactivated-account.md`
- The staging Sales Orders list said permission denied on the payment-totals view for three weeks, and the repo-level STAGING_DATABASE_URL secret points at production — dev — `0824-the-staging-sales-orders-list-said-permission-denied-on-the.md`
- Two delivery orders the book links and the ERP cannot — the shop delivered a SUBSTITUTE item, so there is no sales-order line to point at — waiting on owner — `0706-two-delivery-orders-the-book-links-and-the-erp-cannot-the-sho.md`
- A sofa purchase order raised for an order left three of its lines unlinked, so MRP kept asking the buyer to order them again — waiting on owner — `0743-a-sofa-purchase-order-raised-for-an-order-left-three-of-its-l.md`
- The cutover copied the book's per-line delivery date and not the switch that makes it count — waiting on owner — `0750-the-cutover-copied-the-book-s-per-line-delivery-date-and-not.md`
- Scrap pillow SKU choice: nothing checks that a coloured pillow sits on the CUSTOM SKU — waiting on owner — `0780-scrap-pillow-sku-choice-nothing-checks-that-a-coloured-pillo.md`
