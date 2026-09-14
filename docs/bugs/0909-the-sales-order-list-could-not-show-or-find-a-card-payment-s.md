## The sales order list could not show or find a card payment's approval code [low]

<!-- area: Sales orders + pricing -->
<!-- status: fixed -->

**Symptom.** Owner, 2026-09-14/15, on the Sales Order list: 「sales order 这边我
可以加一个 column 是显示 approval code 的吗 … 我要的就是这个 payment 的 approval
code」— the code the detail's Payments card prints on each card payment
(000384 on the 08/08/2026 MBB installment of his example) was on no column of
the list, and typing one into the search box found nothing.

**Root cause (traced).** The code lives on each PAYMENT
(`mfg_sales_order_payments.approval_code`); the list's payments read
(`payRowsProm` in `scm/routes/mfg-sales-orders.ts`) selected only
`so_doc_no, method, online_type` to build `payment_methods_summary`, so the
row never carried a code. The list's `?q=` is one PostgREST `.or()` over
header columns — `doc_no / debtor_name / debtor_code / agent / sales_location /
ref / customer_so_no / branding` + phone (docs/bugs/0755) — which cannot see a
payment row, so no term could match a code. The header's own `approval_code`
is the New-SO form's legacy single field, not the payments'.

**Fix.** `backend/src/scm/lib/so-list-approval-codes.ts`, two pure halves:
`approvalCodesByOrder` turns the page's payment rows into one string per
order — every code, in the order the money was paid (then the order keyed),
" + " joined, nothing for cash and online, absent when none; and
`approvalCodeOrPart` builds the one `doc_no.in.("…")` term that admits the
orders whose payments carry the searched code, or null when none matched
(an empty in-list is a PostgREST syntax error). The route reads
`approval_code, paid_at, created_at` on the same payments read, stamps
`approval_codes_summary` on each row beside `payment_methods_summary`, and —
only when searching — reads the orders whose payments carry EXACTLY the
typed code (an `eq`, not a substring, so no trigram index is owed;
`scopeToCompany`, capped at 500; a failed read refuses the list rather than
dropping the matches) and adds the term to BOTH the page query
and the money-KPI aggregate, which must filter the same set. The desktop
list (`MfgSalesOrdersListV2.tsx`) gains an **Approval Code** column after
Payment Method (hidden by default like it; the Columns drawer shows it), the
quick view a line, and the three search hints promise the code.

Proved RED on the unfixed tree (route and list stashed):
`backend/tests/soListApprovalCode.test.ts` (the read carries the code, the
row the summary, the term rides both queries, the lookup is scoped and
capped) and `frontend/src/pages/scm-v2/soListApprovalCode.test.ts` (the
column, its place and default, the quick view, the hints). The pure halves
are pinned by `backend/src/scm/lib/so-list-approval-codes.test.ts`.

**Ref.** feat/so-list-approval-code, 2026-09-15.
