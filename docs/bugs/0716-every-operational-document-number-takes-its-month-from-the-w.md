## Every operational document number takes its month from the Worker UTC clock, so the first eight hours of a Malaysian month mint into the previous month [low]

<!-- area: Sales orders + pricing -->
<!-- status: open -->

**Found while answering a different question.** The owner, 2026-09-08, before
opening Sales Orders to the whole sales floor: 「确保检查看 document number 怎么跑
以免 30 个人同时开单的话号码大家撞」. The collision half of that is answered and
is fine (see the PR and `backend/tests-pg/docNoConcurrentCreate.pg.test.ts`).
This is the other thing the audit walked into.

**Symptom.** A Sales Order raised at 02:00 on the 1st of a month in Malaysia is
dated the 1st and numbered with the PREVIOUS month's tag — e.g. an order dated
`2026-10-01` numbered `HC-SO-2609-045`. Same for Delivery Orders, Purchase
Orders, GRNs and Sales Invoices. It is not a collision and nothing is refused;
the number simply files the document into the wrong month for anyone reading the
number.

**Root cause (traced, not guessed).** Each operational minter builds its `YYMM`
from `new Date()`:

```
backend/src/scm/routes/mfg-sales-orders.ts:1032    const d = new Date();
backend/src/scm/routes/delivery-orders-mfg.ts:403  const d = new Date();
backend/src/scm/routes/mfg-purchase-orders.ts:1183 const d = new Date();
backend/src/scm/routes/sales-invoices.ts:270       const d = new Date();
backend/src/scm/routes/grns.ts:700                 const d = new Date();
```

Cloudflare Workers run in UTC, so `d.getMonth()` is the UTC month. The
document's own DATE column on the same insert does not use that clock — the SO
header writes `so_date: dateOrNull(body.soDate) ?? todayMyt()`
(`mfg-sales-orders.ts`, the header insert). Malaysia is UTC+8 with no DST, so
from 00:00 to 08:00 MYT on the 1st of a month the two disagree by one month.

The identical bug in the same clock was already found and fixed for DATES —
`backend/src/scm/lib/my-time.ts` says so in its own words: *"before 08:00 MYT
that is YESTERDAY, so every document-date default (do_date, invoice_date,
received_at, entry_date, …) was stamped a day early each morning"*. The finance
side then got a month-tag fix of its own on 2026-09-07 — `docMonthTag` in
`backend/src/scm/lib/doc-no.ts` falls back to `todayMyt()` for exactly this
reason, and is used by AP invoices, payment vouchers, official receipts and
other-debtor documents. **The five operational minters above were not moved onto
it**, so the fix stopped one layer short of the documents the sales floor
actually raises.

**Not a collision, and it cannot become one.** The counter
(`scm.doc_number_counters`, migration 0316) is keyed on the series string, so a
document minted under `HC-SO-2609` takes the next free number in that series —
it can never re-issue one. The cost is filing, not integrity.

**Exposure — MEASURED?** NOT YET. The count of documents in the live book whose
number month disagrees with their own date is what settles how much this has
already cost, and it did not exist as a check. Section (C) of
`backend/scripts/check-doc-no-headroom.mjs` +
`.github/workflows/doc-no-headroom.yml` (both shipped in this PR) is that
measurement, read-only. **UNTESTED against production at the time of writing —
the workflow has to reach `main` before it can be dispatched.** Note when
reading it that an EDITED document date also lands in that count: the owner's
rule is that a number is an id and is never re-minted after a date change
(单据存了后改日期号码不要重发), so a mismatch is not automatically a minting
fault. The 1st-of-month cases are.

**Fix — NOT APPLIED. It is the owner's call, and here are the options.**
Nothing about the minters changed in this PR. What a mainstream ERP does is not
in doubt — AutoCount, SAP (NRIV), Odoo (`ir.sequence`) and NetSuite all take the
period from the DOCUMENT's own date, never from the server's wall clock — so
option B is the industry answer and option C is the one that also honours the
owner's 2026-09-07 ruling 「要根据文件日期，而不是文件几时 create 的日期」.

| | what changes | cost | what it breaks |
|---|---|---|---|
| **A. Leave it** | nothing | none | a handful of documents a year file under the wrong month; the number and the date on the same page disagree |
| **B. Malaysian TODAY** | the five `new Date()` blocks become `docMonthTag(null)`, which is `todayMyt()` | one line each, existing tested helper | nothing — a new month's series self-seeds at 001 and cannot collide. Only the 00:00-08:00 MYT window on the 1st behaves differently |
| **C. The DOCUMENT's date** | `docMonthTag(body.soDate)` — the number follows the date the user typed | one line each, same helper; matches what the finance side already does | back-dating an order into a closed month starts a series in that month. That is what AutoCount does too, and it is a business decision, not a defect |

**Recommended: B**, now, and C only if the owner wants back-dated documents to
carry their own month. B removes the disagreement between a document's number
and its own date at zero risk; C is a rule change and belongs to him.

**Ref.** `fix/so-number-concurrency`, 2026-09-08. Detection shipped; the minter
change is not in this PR.

Module guide: `docs/modules/sales-order.md`, *Document numbers*.
