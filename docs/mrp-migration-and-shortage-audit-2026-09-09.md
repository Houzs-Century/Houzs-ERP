# Is MRP telling the truth after the AutoCount cutover? — three questions, measured

**The owner asked on 2026-09-09**, looking at the Stock Status Report:

> 1. 你确定 2025 年 6 月跟 2026 年 1 月的单还没有出货吗？…在 MRP 里面还在占用着 stock，
>    这样会不会误导人？很多 state 和 processing date 都是空的…会不会是迁移过程中有一些缺陷？
> 2. 为什么我的界面看得到那么小而已呢？
> 3. 你确定在 MRP 显示出来的 sofa 跟 bed frame 都是 short、需要 order 的吗？
>    并且确定它们是没有开过 PO 的吗？或者还没开过 DO？

Measured against production, read-only, company 1, 2026-09-09. The book side is
the committed cut `backend/scripts/data/ac-outstanding-so.json.gz`, **exported
2026-09-08 08:00** (`ac-reimport-manifest.json`). The MRP figures in §3 are the
LIVE PAGE's own output, scraped from the rendered table — not a replica.

---

## 1. The migration is faithful. The old orders really are open in the book.

**Scope of the import, from the exporter itself** (`export-ac-reimport.py`,
`SO_OUT`): a sales order comes across when AutoCount says
`SODTL.Qty > ISNULL(TransferedQty,0)` on at least one line — i.e. **AutoCount's
own record says it has not been fully transferred to a delivery order** — and it
is not cancelled and was not invoiced directly. Whole documents, so already
delivered lines come too.

### 1a. Does our side ask for goods the book already shipped? — 2 units

Matching every ERP line to its book line by `linked_ac_dtlkey`, aggregating to
(document, item) so a duplicate-line pairing cannot fake a difference, and
excluding sofa (one book line becomes many ERP pieces):

| | |
| --- | ---: |
| like-for-like (document, item) groups compared | **13,217** |
| groups where the ERP still demands goods the book says went out | **2** |
| units | **2** |

Both are 2024 accessories: `HC-SO-001319` HB109NL (1), `HC-SO-002069`
AK-SLEEP ESSENTIAL 7 HOLES (1).

Whole-book control (`check-mrp-unreleased-demand.mjs`, run against prod):
orders older than 12 months still counted as live demand = **4,298 lines on 858
orders**, and the book says **nothing went out** on 4,143 of them.

**So the answer to "确定这些都还没出货吗" is: yes — because AutoCount says so.**
These are old orders whose tail was never closed in the book, not lost
deliveries.

### 1b. The blank Processing Date is AutoCount's blank

2,920 imported company-1 headers:

| | orders |
| --- | ---: |
| blank in BOTH systems | **2,194** |
| set in both, same date | 579 |
| set in both, different date | 0 |
| **blank in the ERP while AutoCount has one** | **1** |
| set in the ERP while AutoCount is blank | 15 |

### 1c. The blank State is a missing postcode in the book's address

194 imported headers carry no state. The importer derives it from the first
5-digit postcode in AutoCount's invoice address (`stateOf`,
`import-ac-outstanding-so.mjs`):

| cause | orders |
| --- | ---: |
| the book's address contains no 5-digit postcode | **133** |
| the postcode is `00000` (the staff's "TBC" placeholder) | **54** |
| the book's address is empty | 2 |
| document not in this snapshot | 5 |

### 1d. But it IS misleading — for two reasons, both measurable

**(i) MRP does not read the Processing Date; the readiness engine does.**
`routes/mrp.ts` only DISPLAYS it (`shared/so-processing-date.ts` says so);
`lib/so-stock-allocation.ts` refuses stock to any order without one
(`allocGated`). So an order nobody released still competes for on-hand stock in
the plan.

| | |
| --- | ---: |
| pooled (mattress / accessory) lines on the default MRP page, past due, **never released** | **45 lines / 69 units on 11 orders** |
| of those, sitting in a bucket that HAS stock — so they take it first | **41 lines / 65 units** |
| of those, queued AHEAD of a released order with a later delivery date in the same bucket | **41** |
| how many read READY on the sales-order screen | **0 of 45** |

That is the contradiction the owner saw: the MRP row says *stock*, the order
itself says *not ready*, and the units are shown as unavailable to a newer,
released order.

**(ii) An undelivered line inherits the date its shipped siblings went out.**
The importer sets the header's `customer_delivery_date` to the EARLIEST line
delivery date, and AutoCount stamps that date on the lines it TRANSFERRED. A
line with no date of its own falls back to the header
(`shared/effective-delivery.ts` step 3), so the leftover tail of a partly
delivered order is dated by the part that already left — and sorts to the front
of MRP's oldest-first stock queue.

| | lines |
| --- | ---: |
| MRP-visible open lines with no delivery date of their own | **196** on 85 orders |
| of those, on a document that has already partly shipped | **38** |
| of those 38, whose inherited date is in the past | **38** (oldest 2023-11-05) |

Worked example — `HC-SO-004197`: the book delivered the Queen mattress, the
Queen protector and 2 pillows on 2025-01-25 and never delivered the King side.
The King mattress carries no date in the book, inherits 2025-01-25 from the
header, and therefore claims stock ahead of everything else on the page.

---

## 2. The small window is today's frozen-header change

`fix(mrp): freeze the Stock Status Report's column header` (#3430, `abfa12be7`,
2026-09-09 09:49 UTC) gave MRP the `useFrozenTableHeader` geometry. It is
CONTAINED in the deployed head `82c33ab52` (Deploy run success).

Measured on the live page (`erp.houzscentury.com/scm/mrp`, sofa tab):

```
window height                 879
--page-header-offset          151px
table box sticks at top       388px      (151 page header + 244 title/tabs/filters)
scroller max-height           443px      <- the rows you can see
content height              5,090px
main.scrollHeight             879        == main.clientHeight  -> THE PAGE CANNOT SCROLL
space below the table         ~98px      empty
```

The geometry assumes the page can scroll so the strip above the table scrolls
away first (its own comments say so). On MRP the capped table makes the page
exactly viewport-height, so nothing scrolls, 388px stays permanently reserved,
and the list is 443px of an 879px window. The bug doc for #3430 states plainly
that **no test asserts the freeze** — it was verified in a harness, not on this
page.

---

## 3. Bedframe is right to the unit. Sofa overstates by 40%.

Scraped from the live rendered table, default view (dated demand only):

| tab | rows | qty needed | STOCK | PO outstanding | **shortage** |
| --- | ---: | ---: | ---: | ---: | ---: |
| Bedframe | 415 | 478 | 30 | **0** | **50** (45 rows) |
| Sofa | 136 | 361 | **0** | 291 | **70** (28 orders) |

### 3a. Bedframe — correct

An independent census of the database — dated, undelivered bedframe lines with
no live purchase order linked through `purchase_order_items.so_item_id` —
returns **50 units**. The page says 50. They agree to the unit; every bedframe
row the page asks you to order genuinely has no purchase order.

(One display defect: the **PO Outstanding column reads 0 on all 415 bedframe
rows**, because a dedicated PO line is removed from the pooled supply that feeds
that column. The coverage is applied to the line; only the column is blind.)

### 3b. Sofa — 28 of the 70 units are already on order, and 26 are already in

Checking all 28 orders the sofa tab asks for:

| | orders | units |
| --- | ---: | ---: |
| the page says ORDER | 28 | **70** |
| really missing (no PO, or the PO is short of the order) | | **42** |
| **overstated** | | **28** |
| goods already RECEIVED against the order's own PO | **8** | **26** |
| a purchase order raised and still incoming | 5 | |
| genuinely no purchase order | 15 | |

26 of those sofa lines read **READY** on the sales-order screen at the same time
as the MRP page asks the owner to buy them again.

**Root cause (traced).** `routes/mrp.ts`:

```ts
const isDedicated = (r: PoLineRow): boolean =>
  boundCompany && !!r.so_item_id
  && (r.item_group ?? '').trim().toLowerCase() !== 'sofa'   // <- sofa excluded
  && isHardBoundLine(r.item_group, r.item_code);
```

`docs/bugs/0736` moved bedframe and `(SP)` mattress onto the dedicated-PO model
(section 7: a bound line draws from `dedicatedReceivedByLine`, then
`dedicatedOpenByLine`). **Sofa was deliberately left out**, and section 8 — the
sofa set walk — still plans on the pooled bucket key `(warehouse, item_code,
fabricCode|seatHeight|legHeight|specials)` alone. A fully received PO leaves
nothing outstanding (`if (left <= 0) continue`), and sofa has no
`dedicatedReceivedByLine` leg, so its receipt is only visible if the STOCK row
happens to carry the identical variant key.

It usually does not. Worked example — `HC-SO-011008`, 5 pieces, `HC-PO-009881`
fully received, and MRP says shortage 5:

```
order asks for   fabriccode=modenza-01 | seatheight=32 | special=nylon fabric
stock arrived as fabriccode=modenza-06 | seatheight=32 | special=bottom wrap by nylon fabric,nylon fabric
```

Company-1 sofa stock on hand is **246 units**, and the sofa tab's STOCK column
reads **0 on every one of its 136 rows**.

### 3c. Has a purchase order been raised in the BOOK that we failed to link?

Of the 98 hard-bound (bedframe / sofa / `(SP)`) lines the page shows with no
purchase order of their own, joining `linked_ac_dtlkey` to
`PODTL.FromSODtlKey` in the book:

| | lines |
| --- | ---: |
| the book has a purchase order against that same sales-order line | **2** |
| the book has none either | **95** |

The two: `HC-SO-008166` `9058-1NA` (book `PO-009974`; our `HC-PO-009974` linked
BOTH of its `9058-1NA` lines to the same sales line, orphaning the other) and
`HC-SO-013389` `8030-1A(RHF)` (book `PO-010087` is one whole-sofa line; our copy
carries only the LHF arm).

### 3d. Has a delivery order already been raised? — no

Zero hard-bound lines with anything left to ship carry any delivery-order line.
`HC-SO-012025`'s three unlinked sofa lines (open item 3 of
`docs/mrp-stock-vs-bound-rules-2026-09-09.md`) are now linked — that one is done.

---

## What is left open — the owner's call

| # | item | size |
| --- | --- | --- |
| 1 | Sofa: extend `docs/bugs/0736`'s dedicated-PO model to section 8 so a received sofa PO covers its own line | 28 of 70 units on today's page |
| 2 | Restore the PO Outstanding column for dedicated (bedframe) rows | display only |
| 3 | The frozen header leaves 443px of rows in an 879px window and the page cannot scroll | every MRP visit |
| 4 | Should MRP hide or mark orders with no Processing Date? Today they take stock the readiness engine refuses them | 45 lines / 65 units |
| 5 | Repair the two book-linked purchase orders: `HC-SO-008166`, `HC-SO-013389` | 2 lines |
| 6 | Close the 11 never-released past-due orders, or release them | 11 orders |

**Ref.** Measured 2026-09-09 against prod, read-only, plus the live rendered
page. Rules read from `routes/mrp.ts`, `lib/so-stock-allocation.ts`,
`shared/effective-delivery.ts`, `shared/variant-key.ts`,
`scripts/export-ac-reimport.py` and `scripts/import-ac-outstanding-so.mjs` — not
from summaries.
