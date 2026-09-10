## The sale the window could not offer could not be chosen by hand [medium]

<!-- area: Accounting + GL -->

**Symptom.** GHL's report for 2026-06-02 carries a RM 2,865.00 line (ref
615318040666). Merchant reconciliation filed it under *"no sale in the ERP"*
and the line's only door was **Set aside**. The owner (2026-09-10): 「只检查，
这个我要怎样选对应的 SO?」— because the sale WAS in the ERP: 2990-SO-2606-011,
Chou Mun Yee, an instalment of exactly RM 2,865.00, keyed on 2026-06-14 with
no bank on it. Nothing on the screen could reach it. The only workaround was
to edit the payment's date under the Finance amend right so the window would
find it — a false date written into the books to satisfy a screen.

**Root cause (traced).** `loadPaymentCandidates` (`backend/src/acc/settlement.ts`)
reads payments inside ± `date_tolerance_days` of the line, plus any carrying
the statement's own references (docs/bugs/0760). GHL's tolerance is 3 days;
the payment is 12 days off and GHL files no unique reference, so it was never
loaded and the matcher had nothing to offer. `SettlementLine`
(`frontend/src/pages/scm-v2/MerchantRecon.tsx`) then rendered its last
branch — *"No payment in the ERP explains this money"* — which was not true;
no payment **within the window** explained it. The window is the right
instrument for "what could plausibly be this money"; it is the wrong one for
"the person in front of the screen knows which sale this is", and there was
no second instrument.

A second gap sat underneath: `confirmSettlementRow` summed the amounts the
BROWSER sent and never read the chosen payments back. Harmless while the
browser could only tick what the server had just offered; not harmless once a
person may pick any payment of the company.

**Fix.** Two instruments, and the confirm trusts neither.

*Find the sale.* `findPaymentsForRow` (`backend/src/acc/settlement.ts`) lists
the company's card / instalment / migration-era payments **whatever their
date**, searched by document number, customer name, approval code, or an
amount typed as money; a payment another line has already claimed is left
out; the exact gross is marked `possible` and ranked first, the rest follows
newest first — offered, never withheld (owner: 你可以注明 possible，但不能不让我
选其他的). A cash or transfer payment is never listed: a merchant report
cannot be explained by one. Route `GET /accounting/settlement/rows/:id/find?q=`
(`accounting-settlement.ts`, behind the same area guard). On screen every
undecided line has a **Find the sale** button — the no-candidate branch now
says *"No payment within the matching window explains this money… find it
below"* — opening a search box whose results join the line's tick list; a
found sale alone is a full selection, and the same **Confirm and post** sends
it.

*The confirm reads the chosen payments back.* `confirmSettlementRow` now loads
every chosen payment by id within the company: one the books do not hold is
`payment_not_found`; one whose method is not card / instalment / imported is
`not_card_payment`; and the amount that must equal the gross is the ROW's
amount, not the browser's — the existing `amount_mismatch` now compares the
database's figures (owner: 金额要跟 report 上的 gross 一样才给确认). The route
answers both new refusals with 409 and the sentence.

*Salesperson on the watch table.* The "Card payments no merchant report has
reported yet" table names who sold each order (`salespersonName`, order →
`salesperson_id` → `staff.name`, two plain reads) — owner: 同时这里我想要看到
salesman 的名字.

Pinned by `backend/src/acc/settlement-find.test.ts` (search by document,
name, amount; possible-first order; cash and other-company payments never
offered; a claimed payment never offered; a read that fails refuses; the
confirm's three refusals read from the database) — proved RED on the unfixed
tree (11 failed / 1 passed: the functions did not exist), then GREEN;
`backend/tests/settlementRoutes.test.ts` (the route, the 404, the two 409s;
the old "does not add up" case rewritten to send a payment the books hold at
a different amount, and the re-confirm case corrected from a payment id the
fixture never held); `MerchantRecon.test.tsx` (the search opens on a lonely
line and on one with candidates, `possible` marked, ticking confirms with the
found payment, a wrong amount cannot post, the salesperson column).
`settlement.test.ts`'s world now seeds the payments its confirms claim, since
the confirm reads them.

**Ref.** acc/merchant-find-the-sale, 2026-09-10.
