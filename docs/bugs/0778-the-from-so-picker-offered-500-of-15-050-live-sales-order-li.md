## The From-SO picker offered 500 of 15,050 live sales-order lines, chosen by document number [high]

<!-- area: Purchase orders + GRN + PI -->

**白话.** 开新采购单的时候，那个「从销售单挑行」的画面，一次只从系统里拿 500 行，
而且是**先按单号排好再切**，不是先问「这一行还需不需要下单」。公司第一家的活跃销售
单行数是 **15,050 行**（2026-09-08 量到的），所以画面最多只看得到 3.3%，其余的单
**不会出现**、也**没有任何提示**——操作员看到的是一句「没有未转的销售单行」，读起
来像工作做完了。旧的一批单号（HC-*）排在后面，正好是掉在外面的那一批。现在改成一页
一页读完，不再切。

**Symptom.** On the New Purchase Order page, *Pick Sales Orders for this PO*
offered only a slice of the book, and an order outside that slice could not be
turned into a purchase order from the screen that exists to do it. Nothing on
the screen said anything was missing — the empty state reads as completed work.
The owner reported the same shape on the GRN twin on 2026-08-17
(`docs/bugs/0299`, `docs/bugs/0302`), and `docs/bugs/0302`'s own root-cause
section NAMES this read as carrying the identical `.limit(500)`. It was left.

**Root cause (traced).** `GET /mfg-purchase-orders/outstanding-so-items`
(`backend/src/scm/routes/mfg-purchase-orders.ts`) read

```
.eq('cancelled', false).order('doc_no', { ascending: false }).limit(500)
```

and applied every filter that DECIDES the answer afterwards, in JavaScript: the
header-status gate, the hold gate, and the pooled MRP shortage. **A cap above a
later filter is not a cap on the answer — it is a cap on the question**
(`docs/bugs/0302`). So which lines could be offered at all was settled by
document number before "does this line still need ordering?" was ever asked.

The size is MEASURED, not inferred: **company 1 held 15,050 live sales-order
lines on 2026-09-08** (`docs/bugs/0677`, `check-ac-convert-symmetry` run
34142505986), and 13,907 SO lines came in from the AutoCount cutover alone
(`docs/autocount-service-deploy.md`). 500 of 15,050 is 3.3%. PostgREST's own
`db-max-rows` is not even needed to explain it — the author's `.limit(500)` sits
far below any server ceiling, so this holds whatever that unmeasured number is
(`docs/bugs/0447`).

`doc_no` DESC is a TEXT order, not a date one, and it is also not a total order:
every line of one sales order shares its `doc_no`, so the sort key alone cannot
place a row.

**Fix.** `backend/src/scm/lib/outstanding-so-lines.ts` — one home for the read,
`paginateAll` over `.range()` windows, ordered `doc_no` DESC then `id` so a
window is coherent, with every existing filter unchanged. The route keeps its
own JS gates byte for byte; only the window is gone. The read moved to a module
rather than being edited in place because the router is at its file-size ceiling
(4,485) and because `lib/outstanding-po-lines.ts` is the same rule for the GRN
twin — a second copy of "page it, order it totally" is what this class keeps
being caused by.

**The number was NOT raised.** A bigger `.limit()` is the same bug with a bigger
wrong number, and past `db-max-rows` it does not move at all.

**Proof, and it is proved RED by mutation, not by assertion order.**
`backend/src/scm/lib/outstanding-so-lines.test.ts` drives the real reader
through a fake that enforces a PostgREST response ceiling over 2,700 live lines
across 900 orders — three lines each, because 1,000 divides by five and
five-line orders would put every page boundary on a document edge, where a
missing tie-break is invisible. Three mutations, each red for its own reason:

| mutation | what went red |
| --- | --- |
| drop `.order('id')` | `expected 2699 to be 2700` — a real repeat across a page boundary |
| re-introduce `.limit(500)` in the handler | the wiring case, `not to match /\.limit\(/` |
| (control, in the suite) the pre-fix shape over the same fixture | returns 500 and does not contain the oldest order |

**Ref.** audit/rowcap-sweep, 2026-09-10.
