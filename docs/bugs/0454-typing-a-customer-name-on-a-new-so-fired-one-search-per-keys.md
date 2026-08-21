## Typing a customer name on a new SO fired one search per keystroke, most answered 503 [medium]

<!-- area: Sales orders + pricing -->

**白话.** 开销售单打客户名字的时候，每敲一个字母系统就去后台查一次旧客户。一个名字
敲完打了 35 次，其中 34 次后台顶不住回 503（服务器忙）。画面上看不到红字 —— 只是
「旧客户建议」那个下拉一直空着，人不会知道后台一直在报错。旁边一模一样的寄售单画面
早就做了「停手再查」，销售单漏了。

**Symptom (measured, not guessed).** Reproduced on prod 2026-08-20 in the Chrome
network panel while typing a customer name into New Sales Order (Houzs Century):
`GET /api/scm/mfg-sales-orders/debtors/search?q=…` fired once per character, 36
requests for one name, and **34 of them returned 503**. Only the final request,
after typing stopped, returned 200. Silent to the user — the failed requests just
leave the suggestion dropdown empty.

**Root cause (traced in source).** `SalesOrderNew.tsx` passed the raw
`debtorName` state — which updates on every keystroke — straight into
`useDebtorSearch`, with no debounce. Each character change re-ran the query. The
backend handler is a plain scoped SELECT that returns 500 on a query error, so
the 503 is not from application code: it is the serialized API tier shedding load
under the keystroke burst (same class as the 卡顿 root cause — many small requests
on a serialized connection). The consignment sibling already avoids this —
`ConsignmentOrderDetail.tsx:806` wraps the term in `useDebouncedValue(…, 200)`
before searching.

**Fix.** Debounce the SO form's debtor term at 200ms with the same
`useDebouncedValue` hook the consignment form uses, so one name is 2-3 requests
instead of one per keystroke. Behaviour-preserving: suggestions still appear,
just after a 200ms pause. Desktop-only — the mobile SO surface has no debtor
autocomplete (`grep -rn "debtors/search" frontend/src/mobile` is empty), so there
is no paired mobile file.

**Verified against.** Frontend `tsc -b` clean; the fix mirrors the already-shipped
consignment debounce. The 503 burst cannot recur because the query term can no
longer change faster than every 200ms.

Ref: 2026-08-20.
