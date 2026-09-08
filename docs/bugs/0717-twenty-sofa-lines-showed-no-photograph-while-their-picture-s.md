## Twenty sofa lines showed no photograph while their picture sat on a sibling row, and the row-level probe read it as 450 [high]

<!-- area: Sales orders + pricing -->
<!-- status: fixed -->

**Symptom.** The owner asked whether the photographs reached the sales orders,
the day sales orders went live to staff. The instrument answered that they
largely had not: `probe-line-photo-coverage.mjs`, run `34220784734`, company 1 —
**450 sales-order rows on 296 documents**, and about **184 purchase-order rows**,
where the account book holds a photograph, the ERP line exists, and the line
carries nothing. On a sofa or a bedframe the photograph IS the build
instruction; a line without it is a line somebody has to go and look up.

**Root cause (traced) — and the headline number was mostly the instrument.**
`probe-line-photo-coverage.mjs` counts **ERP ROWS**. One AutoCount line is one
photograph, a sofa build is one AutoCount line held as SEVERAL ERP rows, and the
importer hangs the picture on the FIRST piece only — the owner's rule,
2026-08-10 (「每个 SKU 的照片都一样，留第一个就可以了」). Every sibling
compartment therefore reads as a gap.

Asked per AutoCount LINE instead, with `probe-line-photo-gap.mjs` —
**run `34221745956`, prod, read-only, 2026-09-08** — the 450 splits exactly, and
the arithmetic closes with nothing left over:

| sales order | rows | lines |
|---|---|---|
| the book photographed | 2,762 images | 2,761 |
| never migrated (the cutover took OUTSTANDING documents only) | — | 2,121 |
| document IS in the ERP, no ERP row carries that book line | — | **3** |
| in the ERP | 1,122 | 637 |
| ARRIVED | 672 | 617 |
| sibling compartments carrying none BY DESIGN | **420** | — |
| **MISSING — no row of the line carries a picture** | 30 | **20** |

`420 + 30 = 450`. The purchase-order side splits the same way: 424 rows / 240
lines in the ERP, **175 by-design siblings**, leaving **7 lines** (9 rows), and
2,169 lines on documents that were never migrated at all.

**So there were three causes, not one, and they need three different answers.**

1. **20 SALES-ORDER lines — the photograph is in R2 and hangs on ANOTHER row of
   the same document.** All 20 are sofa builds. This is the residue of
   `docs/bugs/0624-…` (photos matched by item code, so a repeated code sent both
   pictures to the first row). Fixed here.
2. **7 PURCHASE-ORDER lines — the object was never uploaded.** The image
   decoded (the manifest names the file, e.g. `PO-010146__924289_1.jpg`) but R2
   holds nothing for that DtlKey — `po-items/HC-PO-010146/` contains **0**
   objects. 10 images across 7 documents: `HC-PO-010085`, `HC-PO-010086`,
   `HC-PO-010146`, `HC-PO-010150`, `HC-PO-010151`, `HC-PO-010160`,
   `HC-PO-010161`. Not fixed here — see *Deliberately not fixed*.
3. **3 SALES-ORDER book lines have no ERP row to hang anything on.**
   `HC-SO-013145` holds three rows and **not one carries an AutoCount line key
   at all**, so which row owns book line 891940 cannot be answered — refused,
   not guessed. Its two pictures are both already on the first row, so the
   document does show them. `HC-SO-013394`'s book line 917140 is carried by no
   ERP row (the ERP rows key to 919863–919870); its object is already attached
   to the `919868` row, so it too is on screen.

**A separate suspicion was measured and REFUTED.** `probe-line-photo-gap.mjs`
warns that 207 SO rows and 171 PO rows stand on a 2026-08-31-minted key "whose
upload has no recorded run" — the shape of `docs/bugs/0625-…`, where 64
addresses named an object that was never uploaded. Asked of the bucket rather
than of the log, on the operator machine, 2026-09-08:
`prune-dead-line-photo-keys.mjs` MODE=plan listed **2,271 objects** under
`so-items/` + `po-items/` and checked every importer-minted address on the 687
sales-order rows and 245 purchase-order rows that carry one: **0 dead
addresses, and 0 that would be left blank.**
Every importer-minted address on a live company-1 line resolves to a real
object. The upload did happen; the warning is stale and no prune is needed.

**Fix.** No code changed. `repoint-line-photos-to-owning-line.mjs` already
computes exactly this repair and `docs/bugs/0638-…` already built the plan-file
handoff to apply it; what was missing was the run. Plan generated on the
operator machine (the only place holding both the R2 token and a DSN), applied
through *Apply line photo repair (from a plan file)* against prod, **run
`34222921431`**: 20 lines gained 20 addresses.

Why it cannot put a picture on the wrong line: the match is on the AutoCount
line key `(doc_no, linked_ac_dtlkey)` — never position, never item code — the
candidate object must already be in `photo_urls` somewhere on THE SAME document
and must resolve in R2, the group must be ONE model (`isOneModel`, the guard
from `docs/bugs/0684-…`), and the target is `firstRow(group)`, which
`docs/bugs/0690-…` measured on 2026-09-08 and deliberately kept: of its 419 multi-row groups (310 sales-order +
109 purchase-order), **419 are one model decomposed into compartments and 0 book
keys appear on two documents**. The apply then re-checked every row's
`photo_urls` against the plan and verified on a FRESH connection.

**This was the first real APPLY of the plan-file handoff.** `docs/bugs/0638-…`
proved its five refusals against production but recorded "Nothing was applied to
production"; the mixed case remains **UNTESTED**.

**Deliberately not fixed.** The 7 purchase-order lines need an R2 UPLOAD, which
is a different operation from writing a column and cannot run in Actions (the R2
token can never be an Actions secret — this repository is PUBLIC). All 10 source
JPEGs are present on the operator machine under `.ac-photos/po/`, so the remedy
is available and bounded; it is **UNTESTED and unrun** here. It must not be done
by re-running the whole importer — `docs/bugs/0668-…` is that exact failure
(30 keys written when 21 objects had been uploaded). Copying the SO line's
picture onto the PO line through `so_item_id` was considered and rejected: the
book holds a DIFFERENT image for the PO line, and a photograph on the wrong line
is worse than none.

**What did NOT move, asserted rather than assumed.** The write appends one text
array element. The write appends one text
array element to 20 sales-order rows. Measured on prod immediately before
(11:50Z) and after (11:54Z) the apply, company 1:

```
SO headers 2883  sub=0 rev=3122700 paid=1038468600 bal=945253100 dep=1021583400  UNCHANGED
SO lines   15072 qty=25416 unit=1845445200 total=1981629100 disc=97600 cost=145608  UNCHANGED
SO status  CONFIRMED:2352 IN_PRODUCTION:222 READY_TO_SHIP:208 DELIVERED:101  UNCHANGED
inventory_movements 3505 qty=6069                       UNCHANGED
movements behind a MIGRATED sales order  0  ->  0        UNCHANGED
inventory_lots 2517 remaining=10331                      UNCHANGED
SO photos  rows 687 -> 707,  addresses 1176 -> 1196      +20 / +20, exactly the repair
```

**One thing DID move that this repair did not touch, and it is named rather
than absorbed.** The purchase-order line count went 1,344 -> 1,345 and PO
photos 245 -> 246 across the same window. That is a CONCURRENT LANE, not this
one: the plan carried 20 operations, all on the `SALES ORDER` arm, and the run
log reads `PURCHASE ORDER: no operation in this plan`. The six newest PO lines
were created 11:53:13Z-11:53:34Z — 45 seconds AFTER this run finished at
11:52:28Z — and every one carries `unit_price_sen = 0` and
`line_total_sen = 0`, the signature of a sofa compartment insert
(`fix/unlock-146-sofas`, which was flagged as touching the same lines). No
sales-order line was updated by anything else in the window: 0 rows.

Because the PO side moved under it, the row-level PO figure of 184 is a reading
of a moving population and is quoted as such; the PO LINE figure of 7 is the
stable one.

**Verified — the owner's number, before and after, on production.**
`probe-line-photo-gap.mjs` run `34223033961` (after) against `34221745956`
(before):

| sales order, per AutoCount LINE | before | after |
|---|---|---|
| in the ERP | 637 | 637 |
| **ARRIVED — the line shows its picture** | 617 | **637** |
| **MISSING — no row of the line shows one** | 20 | **0** |

**Every sales-order line the ERP holds a book photograph for now carries it.**
The row-level instrument agrees and closes without remainder
(`probe-line-photo-coverage.mjs` run `34223037788`): 672 -> 692 rows carrying a
photo, 450 -> 430 without, and the gap probe accounts for all 430 as siblings
carrying none by design. **That number will never reach zero and should not**;
430 sibling compartments is what the owner's one-picture-per-build rule looks
like counted by row.

The purchase-order side is deliberately unchanged: 233 of 240 lines arrived,
7 still missing.

**Ref.** `fix/line-photos-missing`, 2026-09-08. Probe runs `34220784734`
(row-level, before), `34221745956` (line-level split), and the after-run quoted
above.
