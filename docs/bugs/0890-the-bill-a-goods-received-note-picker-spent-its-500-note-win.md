## The Bill a Goods-Received Note picker spent its 500-note window on billed notes and read their lines in one unpaged call [high]

<!-- area: Purchase orders + GRN + PI -->

**白话.** 「开采购发票（从收货单）」那个画面，系统先拿「最新的 500 张已过账收货单」，
**之后**才看哪些还有没开发票的货。已经开完发票的单也占掉那 500 个位子。HOUZS 现在有
541 张已过账的收货单，所以一张比较旧、还没开发票的单，只要被挤到第 500 名以后，就
**不会出现在画面上，搜索也搜不到，而且没有任何提示**。今天量到还没有被挤掉的单（201
张有未开发票的单，全部在 500 名以内），但另一个问题今天已经存在：那 500 张单的货品行一
次读完是 **1,018 行**，超过系统假设的每次最多 1,000 行。超过的部分会被悄悄截掉，所以
画面可能少了几行，也不会报错。改成：先问「哪些单还有东西要开发票」，再分批、一页一页读完。
读到上限就在画面上说「清单不完整」。

**Symptom.** Nobody reported a missing note. On 2026-09-14 the owner's screen read
494 outstanding lines across 197 GRNs, and asking for search on that screen
(PR #3834) put the read behind it under review: the guide section written for the
search had to say "past 500 posted notes the older ones are in neither the list nor
the search".

**Root cause (traced).** `GET /purchase-invoices/outstanding-grn-items`
(`backend/src/scm/routes/purchase-invoices.ts`) read

```
grns .eq('status','POSTED').eq('on_hold', false)
     .order('received_at', { ascending: false }).limit(500)
```

and only THEN kept the lines with `qty_accepted - invoiced_qty - returned_qty > 0`,
in JavaScript. The window was spent on every posted note, billed or not. The lines
were one `.in('grn_id', <up to 500 ids>)` with no paging. Same class as
`docs/bugs/0302` and `docs/bugs/0778`: a cap above a later filter is a cap on the
question, not on the answer.

**Measured, not inferred.** `backend/scripts/check-pi-grn-picker-window.mjs`
(Actions → *Bill-a-GRN picker window check (read-only)*, run 34831539272,
2026-09-14 10:07Z on `main` @ `85d01328`), counts only:

| | HOUZS (company 1) | 2990 (company 2) |
| --- | --- | --- |
| posted, not-held GRNs (lines) | 541 (1,069) | 68 (152) |
| GRNs with an unbilled line (unbilled lines) | 201 (509) | 11 (19) |
| unbilled GRNs outside the newest 500 | **0** (window edge 2026-01-17) | 0, window not full |
| `grn_items` rows the unpaged read asked for | **1,018** | 152 |
| id list on that read | ~19,500 bytes | ~2,652 bytes |
| line `company_id` different from its note's | 0 | 0 |
| notes where `v_grn_outstanding` disagrees with the line arithmetic | 0 | 0 |

- PROVEN: no unbilled note was hidden by the window at 10:07Z. It is only because
  every HOUZS note older than the 500th is fully billed; each newly posted receipt
  moves the edge forward.
- PROVEN: the unpaged line read asked for 1,018 rows.
- UNKNOWN: whether PostgREST actually cut that read at 1,000 — the ceiling has
  never been measured (`docs/bugs/0447`). The owner's 494 / 197 against the run's
  509 / 201 fits 18 rows cut, and it equally fits receipts posted between the
  screenshot and the run. Not settled.
- UNKNOWN: ~19,500 bytes is the size refused at the gateway on 2026-08-17/18
  (`backend/src/scm/lib/paginate-all.ts`), yet this picker loaded that morning, so
  this request's refusal line is not exactly there. The list is capped at 500 ids,
  so it was not going to grow.

The check itself was executed against real Postgres before it touched production:
`backend/tests-pg/piGrnPickerWindowSql.pg.test.ts`.

**Fix.** The read moved to `backend/src/scm/lib/outstanding-grn-lines.ts`
(`loadOutstandingGrnLines`) and is driven by what makes a note billable, not by
how new it is:

1. note ids from `scm.v_grn_outstanding` (mig 0267: POSTED, a line with accepted -
   invoiced - returned above zero), paged through `pageWithTruncation`, which says
   when it stopped at its ceiling;
2. those notes' headers in URL-sized batches (`chunkIn`), status and hold marker
   re-checked on the row;
3. their lines in URL-sized batches, each batch paged.

Every read carries the company predicate (`scopeToCompany`). On the lines that is
also what the create path checks (`assertSourceLinesInCompany` over `grn_items`),
so the picker cannot offer a line the create refuses; with 0 mismatched lines
measured, nobody sees a difference. Every read binds its error and answers 500
`load_failed`, never an empty list. Lines come back newest note first (received
date, then note number, then entry order): the old read had no `ORDER BY`, so card
order was whatever the planner produced. The response carries `truncated`; the
picker shows "This list is not complete" when it is true.

**Proof, RED by mutation.**
`backend/src/scm/routes/purchaseInvoiceOutstandingGrnItems.test.ts` drives the real
router over `lib/fake-postgrest.ts` with `maxRows` 1000, and replays the old query
shape against the same fixture as a control (it returns 0 of the 20 unbilled notes,
and 1,000 of 1,200 lines). The mutations were applied two per run (the first two
rows together, the last two together); each turned a different case red.

| mutation to `outstanding-grn-lines.ts` | what went red |
| --- | --- |
| note read = newest 500 posted notes (the old window) | `expected [] to have a length of 20 but got +0`; the view-error and ceiling cases |
| no company predicate on the line read | the other company's line appears on a HOUZS note |
| one unpaged `.in()` line read | `expected … to have a length of 1200 but got 1000` |
| line read error dropped | `expected 200 to be 500` |

Frontend: `PurchaseInvoiceFromGrn.search.test.tsx` pins the incomplete-list notice.

**Ref.** claude/pi-grn-picker-outstanding-read, 2026-09-14. Check: PR #3842.
