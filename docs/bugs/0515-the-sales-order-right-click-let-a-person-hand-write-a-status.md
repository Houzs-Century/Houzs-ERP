## The sales order right-click let a person hand-write a status the system derives [high]

**Symptom.** The owner, looking at the menu shipped the day before
(2026-08-22): 「它不应该能转到 Mark in Production、Mark Shipped 和 Mark
Invoiced ... 按理说不应该允许这样手动去转，否则我们的 transaction workflow 就全乱
了」 — and the consequence in his own words: 「如果它已经有 processing date 了，我
又把它换成别的状态的话，那不是代表我的状态全部都 wrong 完了、是错完了吗？」

**Root cause (traced).** `frontend/src/pages/scm-v2/row-menus.ts` offered three
entries that wrote a lifecycle status straight onto the row —
`Mark In Production`, `Mark Shipped`, `Mark Invoiced`, each a
`setStatus(r, '<STATUS>')`. All three are DERIVED elsewhere from a fact:

| status | the machine that writes it | the fact it reads |
|---|---|---|
| `IN_PRODUCTION` | `so-processing-date.ts` | a processing date exists |
| `SHIPPED` | `so-delivery-sync.ts` | a delivery order was raised |
| `INVOICED` | the sales-invoice coverage sweep | an invoice covers the lines |

Hand-setting one does not change the fact, so the next sweep overwrites it. The
lasting effect is not a wrong status — it is a WINDOW in which the list
disagrees with the documents underneath it, and nothing anywhere says so.

The same file had already argued this for `READY_TO_SHIP` and `DELIVERED` and
left them out on 2026-08-21, then shipped three siblings that fail the identical
test. The line was drawn in the right place and in the wrong position.

**Fix.** The menu offers exactly three moves, on every document: **Confirm** a
draft, **Hold**, **Cancel**. None is derived from anything — each is a decision
a person makes and there is nowhere else for it to come from, which is the rule
that decides membership rather than a list to remember. Same shape as SAP
(derived item status, a person gets a block and a rejection) and NetSuite
(computed fulfilment status, a person gets Close and Cancel).

`SHIPPED` also stopped being a Sales Order tab in the same change — owner:
「Sales Order 的 Shipped 跟 Delivered 是合起来的」 — and it FOLDS into
`DELIVERED` via the new `backend/src/scm/lib/so-tab-statuses.ts` rather than
being dropped from the list vocabulary. Postgres cannot `DROP VALUE`, so
`SHIPPED` stays a legal label for ever and `so-delivery-sync.ts` still writes
it whenever a delivery order is raised — a row carrying it arrives every day.

> **The first draft of this entry overstated the consequence** and the
> correction is worth keeping. It said a status left unbucketed is "reachable
> from no tab and subtracted from the count", citing the 2026-08-17 delivery-
> order incident. That is true of the DO / PO / GRN / PI lists, which have **no
> catch-all**. It is NOT true of the Sales Order list, which is the one list
> that does: its handler computes `other = allCount - known` and
> `MfgSalesOrdersListV2.tsx:2005` renders an **Other** tab whenever that count
> is non-zero. An unfolded `SHIPPED` order would have been reachable.
>
> The real reason to fold is the READER: an order whose goods went out belongs
> under **Delivered**, not under a tab called **Other**. That is a smaller claim
> and it is the one the evidence supports.

Pinned by `backend/src/scm/lib/so-tab-statuses.test.ts` — "SHIPPED is
reachable from a tab and is in exactly one" fails on a tree where the status is
dropped instead of folded.

**Ref.** feat/hold-is-a-flag, 2026-08-22.
