# TODO — verified open items (rebuilt 2026-09-16)

One line each: what · waiting on whom · since when. Rebuilt by reading every
`tasks/HANDOFF-*.md` + owner-decision/plan doc and VERIFYING each item against
`gh`, the tree and a read-only production check — old handoffs list shipped work
as still-open (memory: "docs assert open after shipping"). Items proven done were
dropped (see bottom). Re-verify before quoting a number (CLAUDE.md R07).

## In flight (this session — do not re-assign)
- DO list per-line export (PR #3972, OPEN) — lands after the SO export branch; then merge origin/main, regen route matrix. · this session · 09-15
- MRP frontend fix #3978 (Edit keeps row order + MRP shortage rows get colour, 0940-0943, OPEN) — awaiting CI, merge, deploy verify. · this session · 09-15
- SO/DO per-line export = "export the whole filtered listing, not the page" (branch feat/so-do-line-export, WIP, no PR; PO pilot shipped #3967) — fix 3 branch CI failures, open PR, merge before #3972. · this session · 09-14
- Root cause: 12 orders AutoCount-delivered but no ERP DO (import/sync gap) + qty-0 DO lines — under investigation. · this session · 09-15
- MRP processing-date gate (branch feat/mrp-processing-date-gate, no PR yet) — only processing-dated SOs enter MRP; owner approved (option C). · this session · 09-15
- close-stale-sales-orders PLAN + Excel simulation to owner Downloads (branch chore/close-stale-sales-orders) — PLAN only, no apply without owner yes. · this session · 09-15
- Timeline answer for "why did 122 expired orders suddenly appear" — owner rejected "imported 08-28"; investigator tracing when they became dated MRP demand. · owner insists · 09-15

## MRP
- 23 remaining expired-but-never-delivered orders (13 >3mo, 10 in 2wk-3mo) — root cause = 08-28 AutoCount re-import of unsettled old SOs (mrp-3mo-open-rootcause doc). · owner: keep or remove · 09-15
- 14 pooled mattress/accessory lines PENDING that should be READY (Track D) — run the SO-allocation recompute (production write) to flip stale ones; trace any that don't. UNTESTED. · owner go-ahead · 09-11
- MRP mockup fuller UI: a global "分类 ⇄ 销售单" (By Sales Order) view toggle + per-SO 整单转 PO cards + bedframe multi-select 合并转 — needs backend all-category-per-SO shape. Standing rec: do nothing yet. · owner to commit · 09-11
- MRP DataTable: scope Proceed-PO / select-all to the per-column funnel-visible rows (Track F follow-up, `onFilteredRowsChange`). · dev · 09-11

## SO / PO
- Import SKUs category+model change #3976 (MERGED) — live import UNTESTED; OPEN owner question: a full export with one SKU's category edited is refused by the conflict rule (rec: changed row wins). · owner pick · 09-15
- HC-SO-2609-071: second round of Special Order edits was never saved; owner to redo now that #3977 is live. · owner · 09-15
- SO save lock residue: status-change / draft-discard / amendment-apply still refuse the caller's OWN live lease (only left by a crashed save now). · dev · 09-15
- Imported-order venue seeding sends a numeric project-venue id the header PATCH drops — the adoption does nothing for those orders (harmless to the lock). · dev · 09-15
- 504 on HC-SO-2609-071?edit=1 page load — unexplained. UNKNOWN. · dev · 09-15
- Amendment-added SO lines that get no PO and no warning (both warnings gated on scopeCoversAll, false when 2+ bound POs) — owner: 查到底并修掉; measure population first. (related open PR #3959 amendment lane) · dev · 09-10

## Sofa / supplier alignment
- 2 genuine sofa piece diffs vs supplier: HC-PO-010086 (2S vs 1A+1A), HC-PO-010041 (5 pieces vs 3). · owner/photo · 09-11
- HC-SO-012046 / HC-SO-013224: shipment consumed different SKUs than the factory built; owner chose to correct → stock-adjustment plan NOT written (must not OUT stock we don't hold, 0722). · dev+owner · 09-11
- 11 already-received-stock sofa builds + HC-PO-009784 (shared-bucket) — need a stock-aware re-key tool (moves lot+balance+movement+allocation atomically); NOT built. · dev · 09-11
- Re-check owner's 2026-09-10 self-read (confidence:owner) sofa direction batch for other lounger-read-as-arm errors (systemic gap 1). · dev · 09-11
- 10 sofa POs not in supplier export (9 Hookka 2609-04x/05x/06x + Ohana HC-PO-009554) — supplier hasn't keyed / never received. · supplier · 09-11
- HC-SO-012062 / HC-SO-012343: supplier built but ERP has no PO (ours is the mirror) — raise the PO or mark pre-cutover closed. · owner · 09-11
- Bedframe alignment: ~3 real size diffs (HC-PO-009990 etc.) + ~7 blank leg/gap — no proposer/apply channel; may be faster by hand. · owner call · 09-11
- Accessory category (66 supplier rows) never compared to ERP — build the equivalent check. · dev · 09-11
- Pillows: HC-PO-009981 (OTHER-PILLOW vs SQUARE naming) + HC-PO-010170 (random vs custom x3, unreceived) — check customer line first. · dev · 09-14
- 21 unstated-side drawers: 6 have a photo (3 read), 15 not proceeded — photo or leave per owner rule. · dev · 09-14
- Other-supplier proceeded sofas: 176 lines with a photo — read photos, backfill via TV rule. · dev · 09-14
- On-hand custom-pillow stock (239 SQUARE, 14 LONG) keyed with no colour — can't cover coloured orders unless owner stock-takes by colour. · owner · 09-14
- HC-SO-011160 colour looks truncated (book B0315-9,7,8,12 vs ERP B0315-9). · person · 09-10
- 9058-Console vs 9058-CONSOLE merge (owner decided: keep 9058-Console) — UNKNOWN whether applied (neither exact model_code found in prod today). · verify · 09-10

## Mobile / permission parity
- Apply D3 on phone: drop the July phone-only project-cohort rules so phone follows desktop+server. · dev · 09-14
- Option C phase 1 (Sales Orders): SO read returns `actions` computed by the write-route guards, both screens render from it, a check fails a screen that computes its own; then service cases/projects/downstream. · dev · 09-14
- Audit §5 permission defects B-6, B-8, B-10..B-14, MD-3 — one PR each. · dev · 09-14
- B-7 driver POD — a feature to build (re-trace backend path first), not a flag. · dev · 09-14
- D4 service-case archive parity (desktop banner vs phone disagree; 0 of 904 archived) — align if archiving starts. · deferred · 09-14
- Old Diag-role run logs (13 runs) print staff names — permanent deletion is a repo-admin call. · owner/admin · 09-14

## Perf / platform / security
- Staging Worker holds the ANON key (PROVEN live 09-16: /health rest_role=anon vs prod service_role) — owner puts staging project's service_role key via `wrangler secret put ... --env staging`; rehearsal red since 2026-08-21 (bug 0824). · owner · 08-21
- Option-pool `allowed_options` column mixes RESTRICTION (fabrics/specials) and CONFIGURATION (sizes/thickness) — rec: clear only restriction keys; long-term split the column. · owner decide · 09-13
- Owner: look at one 2990 sofa on the POS (e.g. Annsa) and confirm it offers his 28 colours (DB restore verified, screen not). · owner · 09-13
- A security item raised with the owner in chat 2026-09-15 (deliberately not detailed in this public repo). · owner · 09-15
- Tenant isolation: staging anon/authenticated roles have SELECT on scm tables; whether prod is the same is UNKNOWN (no prod probe). · dev · 09-12
- 16 pages still declare their own status `{tone,label}` map instead of status-pill.ts — guarded; collapse in progress (agent, ledger 0868). · dev · 09-13

## Fair P&L
- Rental / setup across the 568 PMS projects NOT reconciled (94 differ, 100 have rental with no source, RM1.86M) — accountant returns confirmed pid→rental list, then apply via polish-all task=align-figures. · accountant · 07-29

## Connect / Hookka
- Houzs Connect: owner fills business profiles, switches on auto replies, sets WHATSAPP_APP_SECRET (「剩下的我来」). · owner · 09-14

## Repo hygiene
- Cleanup PR #3995 (chore/cleanup-remaining, OPEN) removes dead modules/spent data/finished handoffs — includes deleting the buggy `compare-ac-erp-dates` tool still on main. · this session/dev · 09-15
- Leftover worktrees of merged PRs + temp branches: ac-so-po-doc-no-fill, ac-po-doc-no, so-consecutive-save, so-fair-others-venue, so-do-line-export, do-list-export, handoff-* , `.claude/worktrees/agent-*`. · dev · 09-15

## → AutoCount session (handled elsewhere — not detailed here)
- PO Doc No. repair: apply the remaining 243 rows out of office hours (0927).
- Hookka POs on the wrong creditor account (94 under book 400-H004 vs office's 400-O002) — owner picks A/B/C; needs a creditor-override + PO-account move.
- Payment-text stopgap #3969 → owner option A: root fix (keep book text + append ERP refs) + restore 61 orders.
- 5 carried-over orders miss office-keyed payments (6 payments, RM9,047) — staff to key in ERP after the text fix.
- Office host swap (AnyDesk) — turns on #3865/#3922, the CreditorCode edit and the receipts route.
- A big Remark 2 run in AutoCount for receipts after 09-10 18:25 local.
- Customer receipts (OR) build, switch OFF (PR #3996 acc/or-backfill open) — accountant picks start date.
- Carried-over receipts → purchase invoices refused wholesale — needs an accounting decision.
- ERP size changes on 6 carried-over lines never reached the book — not raised, not built (source fix from so-edit-header/composeEdit).
- Stale-key recompose source fix (branch fix/ac-stale-key-recompose) + relink sweep never cleared 5 keyless sofa docs.
- Photos over 2MiB (4 documents) went without them — image reduction not built.
- Data items: PO-009790 price 0, PO-010098 receipt on wrong line, PO-009979 no-item line, 24 RM1 placeholder lines, HC-DO-010936 stale DocDate, 73 carried-over receipts unkeyable.

---
## Dropped as already-done (verified this pass)
- SO consecutive-save lock #3977 — LIVE (deploy 34976768973, both jobs success).
- Fair→venue field #3982 — LIVE (shipped on deploy 34977524431).
- Sales-invoice add-a-line — SHIPPED (SalesInvoiceAddLine.tsx + MobileAddLine use useAddSalesInvoiceItem).
- MRP PO-line link repair (Track E) — APPLIED: prod shows HC-PO-010087 line now item_group=sofa+linked, HC-PO-010045 stool linked.
- Delivery-date backfill from the AutoCount book — repaired to zero (09-11, runs 34567236846/34569433132).
- STAGING_DATABASE_URL repo secret pointing at production — deleted 09-12.
- Sofa Accessories category (PLAN phases 1-4) — LIVE (fabric_accessory group in prod; #3861 swap live).
- Sofa leg-height fill + compartment/direction corrections + received-goods re-key — applied 09-11 (VERIFY OK).
- Import-SKU #3980 (SKU-code follow) and HC-PO-010086 realign #3974 — merged.
- MRP stale-demand: 43 orders cancelled/date-cleared this session (excluded per brief, neither open nor "done" line).
- Older 08-31/09-01/09-02/09-13 threads (venue loss, session-pass renewal/slowness, PO bedframe variant repair, coverage-state 3-state, option-pool restore COE, delivered-status resync, status "Submitted" rename) — all merged + deployed.
