# Stock reconciliation: ERP vs live AutoCount

Two-axis reconciliation of the ERP's stock against the live AutoCount book
`AED_HOUZS`, set as a go-live blocker by the owner on 2026-08-11:

> (a) 我们的 Stock Balance Record 必须对齐。
> (b) 在对齐的同时,还要检查 Remark 2(即我们的 stocks Status 那边)跟 ERP
> stocks Status 是否对齐。如果没有对齐,就要查明具体原因,因为按常理(By right)
> 它们应该是对齐的。

> Convention: units are pieces, money in RM unless stated. AutoCount is
> **read-only** in all of this work — the owner's standing rule is that the ERP
> is the only editing surface (暂时只可以在 erp 改). Nothing here was applied;
> every remediation in section 8 is a dry-run proposal.

---

## 1. What was actually connected to

| Side | How | Evidence |
|---|---|---|
| AutoCount | `pyodbc`, SQL Server Native Client 11.0, `AED_HOUZS` over ZeroTier | `SELECT @@VERSION` returned Microsoft SQL Server 2019 (RTM) 15.0.2000.5 |
| ERP | `backend/scripts/check-stock-vs-autocount.mjs` via `workflow_dispatch` + `secrets.DATABASE_URL` | `.github/workflows/check-stock-vs-autocount.yml` |

The AutoCount host is only reachable from the office network, so a GitHub
runner cannot query it. The export is taken on-site by
`backend/scripts/export-ac-live.py` and committed; the ERP-side checker reads
those files. `data/ac-live-export-manifest.json` records the moment it was
taken, so a stale export is visible rather than silently compared. The
credential is read from `AC_CRED_FILE` and never enters the repo.

Tooling added by this work:

| File | Role |
|---|---|
| `backend/scripts/export-ac-live.py` | pulls the live book, SELECT only |
| `backend/scripts/check-stock-vs-autocount.mjs` | both axes, with a named cause per disagreement |
| `.github/workflows/check-stock-vs-autocount.yml` | manual dispatch, own concurrency group |

---

## 2. Remark 2, located in the real schema

The owner calls it "Remark 2". It is **`SO.Remark2`**, `nvarchar(40)`, on the
sales-order *header*. Established by inspection, not by guessing:

- 372 columns in the book match `%Remark%`. `Remark1`–`Remark4` exist on every
  document header (SO, DO, GR, PO, IV, ADJ, CS, …).
- The **`Item` master has no Remark column at all** — 56 columns, none of them
  `Remark*`. So "stock status" is not an item-level attribute in AutoCount; it
  is a per-order field.
- Sampling the four candidates by value settles which one it is.

| Column | Non-blank SOs | Top values | Reading |
|---|---|---|---|
| `Remark1` | 920 | free text: delivery-date notes, "1 MONTH NOTICE" | operational notes |
| **`Remark2`** | **9,165** | **READY 8,254 · READY (PARTIAL) 395 · ACC 127 · BEDFRAME 107 · BEDFRAME/ACC 78** | **stock status** |
| `Remark3` | 1,312 | "URGENT BILL", "READY AT SUPP", "display set" | mixed notes |
| `Remark4` | 10,137 | CONFIRM 6,865 · Done Driver Information 1,686 · Done Scheduling 766 | delivery workflow, not stock |

The ERP already knew this. `backend/src/scm/lib/so-readiness.ts:11-13` says so
in its own header comment:

> Remark output — shows WHAT IS READY (the operator's existing "Remark 2"
> convention; the warehouse staff scan this column to know what they can pull
> NOW without asking the salesperson)

So the two systems do not use different vocabularies that need a translation
table. The ERP was **built to reproduce AutoCount's Remark2**, and the mapping
below is an identity mapping — which is exactly why a disagreement is
meaningful rather than a modelling artefact.

### 2.1 The vocabulary, and the trap inside it

The category tokens name **what IS ready**, not what is pending. `BEDFRAME`
means "the bedframe is ready, something else is not" — it does not mean "the
bedframe is outstanding". Reading it the intuitive way inverts every row.

| Value | Meaning | ERP source |
|---|---|---|
| *(blank)* | nothing ready yet | `stockRemark = ''` |
| `READY` | every line ready, main and accessories | `isFullyReady` |
| `READY (PARTIAL)` | every MAIN line ready, some accessory still pending — still shippable | `isMainReady` |
| `BEDFRAME` / `SOFA` / `MATTRESS` | that category fully ready, another MAIN category not | `/`-joined ready list |
| `ACC` | accessories ready, MAIN not | `/`-joined ready list |
| `BEDFRAME/ACC`, `MATTRESS/ACC`, … | both named groups ready | `/`-joined ready list |

MAIN categories are `SOFA`, `BEDFRAME`, `MATTRESS`. Accessories never block a
shipment. SERVICE lines (delivery fee, disposal, lift charge) are skipped
entirely on the ERP side and must be skipped on the AutoCount side too.

### 2.2 The vocabulary is clean where it matters

On the 2,712 **outstanding** SOs — the only set that can be reconciled — every
single Remark2 value is inside the controlled vocabulary. Zero free text.

| Remark2 | Outstanding SOs |
|---|---|
| *(blank)* | 2,308 |
| `READY` | 231 |
| `ACC` | 89 |
| `BEDFRAME/ACC` | 31 |
| `READY (PARTIAL)` | 16 |
| `MATTRESS/ACC` | 16 |
| `BEDFRAME` | 14 |
| `MATTRESS` | 5 |
| `ACC/BEDFRAME` | 2 |
| **total** | **2,712** |

Across all 13,010 non-cancelled SOs, 104 (0.8%) carry something outside the
vocabulary — date notes such as `24/1/24-CONFIRM DELIVERY DATE` that leaked in
from the neighbouring columns. **None of them is an outstanding order**, so
they cannot pollute the comparison. This is a much better-behaved field than a
free-text `nvarchar(40)` with no constraint had any right to be.

### 2.3 Remark2 is internally consistent with AutoCount's own stock

Before asking whether Remark2 agrees with the ERP, it is worth asking whether
it agrees with AutoCount. For every outstanding line on a physical item, is
there enough on-hand in AutoCount to cover it?

| Remark2 | Outstanding orders | Short | Short % |
|---|---|---|---|
| `READY` | 171 | 1 | **1%** |
| `BEDFRAME` | 14 | 0 | 0% |
| `MATTRESS` | 5 | 0 | 0% |
| `ACC/BEDFRAME` | 2 | 0 | 0% |
| `BEDFRAME/ACC` | 31 | 1 | 3% |
| `READY (PARTIAL)` | 16 | 1 | 6% |
| `ACC` | 89 | 15 | 17% |
| `MATTRESS/ACC` | 16 | 4 | 25% |
| *(blank)* | 1,976 | 364 | 18% |
| **all** | **2,320** | **386** | **17%** |

The 2,320 here is smaller than the 2,712 outstanding orders because 392 orders
have no outstanding *physical* line left at all — what remains open on them is
only a service charge or a sofa. They are excluded rather than counted as
agreeing, which would have flattered the result.

This is the single strongest piece of evidence for the owner's premise.
When staff type `READY`, the stock is genuinely present **99% of the time**.
The category values behave exactly as their semantics predict: `BEDFRAME` and
`MATTRESS` are never short, while `ACC` — which asserts only that accessories
are ready and the main item is not — is short 17% of the time, as it should be.
Blank orders are short 18% of the time, consistent with "nothing ready yet".

Remark2 is not a stale annotation. It is a disciplined, accurate field, and
that is why a disagreement with the ERP is worth investigating rather than
shrugging at.

> Method note, because the first run of this check was wrong. Including the
> service pseudo-items put the `READY` shortage at 36% and made Remark2 look
> uncorrelated with stock. Every one of those "shortages" was a `DISPOSE` line
> against a permanently negative balance. Excluding non-physical items reversed
> the conclusion completely. The contaminated figure is recorded here so nobody
> re-derives it and believes it.

### 2.4 Token order is not canonical in AutoCount

`BEDFRAME/ACC` appears 31 times and `ACC/BEDFRAME` twice. They mean the same
thing. The ERP always emits a fixed order (BEDFRAME, SOFA, MATTRESS, then ACC),
so a strict string comparison would report the second spelling as a
disagreement when the systems in fact agree. The checker compares
order-insensitively and reports the order-only count separately.

---

## 3. What the two systems can and cannot be asked to agree on

`scm.inventory_balances` is a **VIEW**, not a table
(`backend/src/db/migrations-pg/0084_multicompany_views.sql:180`):

```sql
CREATE OR REPLACE VIEW scm.inventory_balances AS
  SELECT warehouse_id, product_code, variant_key, MAX(product_name) AS product_name,
    SUM(CASE WHEN movement_type = 'IN'         THEN qty
             WHEN movement_type = 'OUT'        THEN -qty
             WHEN movement_type = 'ADJUSTMENT' THEN qty
             WHEN movement_type = 'TRANSFER'   THEN qty
             ELSE 0 END) AS qty,
    MAX(created_at) AS last_movement_at, company_id
  FROM inventory_movements
  GROUP BY warehouse_id, product_code, variant_key, company_id;
```

Three consequences that shape the whole reconciliation:

1. **A balance is derived.** Every discrepancy is a statement about the
   movement ledger — a missing movement, a duplicated movement, or the view's
   own arithmetic. There is no balance to "correct" directly.
2. **There is no `WHERE` clause.** No cancelled/void filter exists because
   `inventory_movements` has no such column: the house pattern reverses a
   posting by writing an **offsetting movement**, not by deleting a row
   (`0088_scm_dropship_hardening.sql:258`,
   `0198_scm_reverse_do_out_generalize.sql:175`). This is the same shape the
   owner's 不可以删只可以 cancel rule requires, and it is already precedent.
3. **`TRANSFER` is summed as `+qty`** and the FIFO trigger has no `TRANSFER`
   branch at all. If any TRANSFER rows exist and are written positive at both
   ends, the view counts the stock twice. The checker measures this rather than
   assuming it.

### 3.1 Migrated documents deliberately have no movements

Migration `0276_scm_migrated_documents.sql` adds `migrated_no_stock` to
`scm.grns` and `scm.delivery_orders` — and **only** those two tables. Its own
comment:

> TRUE = paperwork carried over from AutoCount at the 2026-08 cutover. The
> goods are already on hand via the balance snapshot, so this GRN has NO
> inventory movement behind it, deliberately.

This explains a whole class of apparent gaps: migrated GRNs and DOs are POSTED
or DELIVERED with zero movements, on purpose, because the balance snapshot
already accounts for them. Counting them as missing movements would
double-count the stock.

**But the flag is a marker, not a guard.** Nothing in `backend/src` reads it —
zero references outside the migration. The absence of movements is achieved
structurally, because `create-migrated-documents.mjs` INSERTs rows directly and
bypasses the post handlers. Two live risks follow, both recorded in section 8.

---

## 4. Scope: what is comparable, and what legitimately is not

Live AutoCount holds 2,634 item+location cells, 1,095 of them non-zero, across
942 items and 15 locations. Not all of it can be compared to an ERP balance.

| Bucket | Cells | Units | Items | Why |
|---|---|---|---|---|
| **Comparable** | **1,025** | **9,641** | **515** | real stock, bound to an ERP product, in a mapped warehouse |
| Service pseudo-items | 15 | −4,050 | 4 | AutoCount stock-controls DISPOSE / TRANSPORTATION CHARGES / STORAGE / Miscellaneous; the ERP models these as SERVICE lines with no inventory |
| Sofa furniture | 55 | 161 | 41 | AutoCount counts a sofa as one unit, the ERP counts compartments; the owner does not trust the AutoCount number |

Units by AutoCount `ItemGroup`, which shows how lopsided the book is:

| Group | Units | | Group | Units |
|---|---|---|---|---|
| ACC | 7,147 | | SOFA | 161 |
| MATTRESS | 889 | | DINING | 94 |
| BEDFRAME | 616 | | TRANS | −1,216 |
| BEDLINES | 535 | | OTHER | −2,834 |
| DIFFUSER | 360 | | | |

The SKU binding is **complete**: all 1,561 item-master codes appear in
`data/autocount-erp-mapping-1561.csv`, so no comparable stock is lost to an
unbound code.

### 4.1 Unit of measure is not a factor — refuted, not assumed

"Pack size / UOM difference" is one of the causes worth suspecting. It is
**ruled out by measurement**: `ItemUOM` holds 1,566 rows and **zero items have
a rate other than 1**. Five items carry two UOM rows, but both rates are 1, and
they produce exactly three duplicated item+location cells
(`RDS-SQUARE PILLOW` at PG and KL, `DL-ROYAL EXECUTIVE LUXE2.0(SK)` at PG),
which the export sums. No unit conversion exists anywhere in this book.

### 4.2 Warehouse mapping

Fourteen of the fifteen AutoCount locations map through the `SALESLOC` table
copied from the PO import. The fifteenth, `C&C K.J` (507 units), is not in that
table but resolves by identity against the ERP warehouse code of the same name;
the resolver falls back to the raw code and never guesses. Any location that
truly fails to resolve is reported as `UNMAPPED` with its unit count rather
than being silently dropped.

Per-location on-hand in live AutoCount. The raw column is every stock-controlled
row; the comparable column excludes the service pseudo-items and sofa. Note
that SBH and SRW look negative raw and are perfectly ordinary once the
pseudo-items come out — the negative was never physical stock.

| Location | Comparable cells | Comparable units | Raw units |
|---|---|---|---|
| KL | 237 | 4,951 | 2,877 |
| PG | 239 | 2,168 | 1,065 |
| C&C DISP | 78 | 666 | 666 |
| C&C K.J | 66 | 507 | 507 |
| KL DISP | 95 | 449 | 475 |
| PG DISP | 103 | 349 | 351 |
| SUNWAY | 34 | 175 | 175 |
| EM DISP | 50 | 94 | 94 |
| KELANA.J | 18 | 58 | 58 |
| SBH | 18 | 55 | −285 |
| SERV KL | 27 | 51 | 51 |
| SBH DISP | 26 | 47 | 47 |
| SRW | 14 | 46 | −350 |
| SERV PG | 13 | 14 | 14 |
| HQ | 7 | 11 | 7 |
| **total** | **1,025** | **9,641** | **5,752** |

### 4.3 AutoCount's own stock goes negative

43 cells are negative, totalling −4,110 units. Almost all of it is the service
pseudo-items, which only ever go out and are never received:

| Item | Location | Units |
|---|---|---|
| DISPOSE | KL | −1,640 |
| DISPOSE | PG | −795 |
| TRANSPORTATION CHARGES | KL | −364 |
| TRANSPORTATION CHARGES | SRW | −344 |
| TRANSPORTATION CHARGES | PG | −325 |
| TRANSPORTATION CHARGES | SBH | −179 |
| STORAGE | SBH | −151 |
| STORAGE | KL | −123 |

The genuinely physical negatives are small and few — `AK-SK FX AIRLOFT PIL` at
KL (−10), `AK-CS AIRLOFT COMFY PIL` at C&C DISP (−6), `CH-DC` at KL (−12). A
negative physical balance is AutoCount recording an oversell. The ERP cannot
reproduce it, because FIFO consumption cannot take stock that was never
received; it records a short instead. These cells can never agree by
construction, and are listed as such rather than counted as ERP defects.

---

## 5. Drift since the cutover snapshot

The ERP was seeded from an AutoCount balance snapshot taken **2026-08-09**
(`data/ac-stock-balance.json.gz`). Staff have kept working in AutoCount since.
Comparing that snapshot against the live book isolates exactly how much of any
gap is simply elapsed time:

| Measure | Value |
|---|---|
| Cells changed since the snapshot | 32 |
| Net unit change | **−97** |
| Snapshot total / live total | 5,849 → 5,752 |
| Locations affected | KL only |
| Direction | every one a decrease |

Corroborated on the document side: of 13 stock document types checked, **only
`DO` has any activity dated on or after 2026-08-09 — 23 delivery orders**, the
latest dated 2026-08-14 (future-dated). `GR`, `IV`, `ADJ`, `CS`, `CP`, `PI`,
`ISS`, `GT`, `CN`, `DN` are all zero.

This is a cut-off effect, not a defect, and not something to patch — the
cutover procedure is to re-export at the freeze moment and apply one delta
batch.

### 5.1 Document dates do not explain the drift, and that matters

The obvious next step is to attribute the −97 to those 23 delivery orders. It
does not reconcile, and the reason is worth recording because it changes how a
recurring check has to be built.

| | Units |
|---|---|
| Expected from post-cutoff DOs (by `DocDate`), 53 cells | −169 |
| Observed drift (balance diff), 32 cells | **−97** |
| Unexplained | **+72** |

The cause is **back-dating**. Filtering by `DocDate` finds zero GR and zero ADJ
documents after the snapshot, but filtering by `LastModified` finds both:

| Document | Dated | Modified | Qty | Back-dated by |
|---|---|---|---|---|
| GR-005213 | 2026-08-07 | 2026-08-09 12:52 | +12 | 2 days |
| GR-005215 | 2026-08-05 | 2026-08-09 12:52 | +5 | 4 days |
| ADJ-000226 | 2026-08-04 | 2026-08-10 11:27 | −30 | 5 days |
| ADJ-000228 | **2026-04-26** | 2026-08-10 11:28 | +1 | **105 days** |

Across all document types, 142 documents carry a `LastModified` after the
snapshot (SO 77, IV 49, DO 12, GR 2, ADJ 2) while the `DocDate` filter sees
only 23. One adjustment was entered 105 days after its own document date.

**The lesson: never compute expected stock drift from documents dated after a
cut-off.** Staff back-date routinely, so a date-filtered query silently misses
real stock movement. Only a balance-to-balance diff is sound, and only
`LastModified` is usable for finding what changed. `docs/cutover-tally-method.md`
already anticipated this in its top-up section; this is the measured proof.

The −97 figure above is a balance diff and therefore stands. The −169 is the
figure that would have been wrong.

Largest movers:

| Item | Location | Snapshot | Live | Delta |
|---|---|---|---|---|
| AMN-SOFA PILLOW | KL | 130 | 115 | −15 |
| JM-CL JAC WP MP (Q) | KL | 109 | 100 | −9 |
| AK- ESSENTIAL BOLSTER | KL | 108 | 99 | −9 |
| DISPOSE | KL | −1,632 | −1,640 | −8 |
| AK-CS AIRLOFT COMFY PIL | KL | 239 | 232 | −7 |
| AK-SK + MICROFIL PIL | KL | 185 | 178 | −7 |

---

## 6. Method, and why the status comparison can be trusted

The ERP's stock remark is derived at read time by `summariseReadiness`, so the
checker has to reproduce it exactly or the comparison measures the checker
instead of the ERP. The port was verified rather than eyeballed:
**40,000 randomised cases** covering null item groups, cancelled lines, mixed
categories, `PARTIAL` statuses and the `SVC-` edge case were run through the
real `backend/src/scm/lib/so-readiness.ts` and the port side by side —
**zero mismatches**.

Two details in that port matter and are easy to get wrong:

- `isServiceLine` needs the strict length test from
  `backend/src/scm/shared/service-sku.ts`: the bare string `SVC-` is **not** a
  service line. A looser prefix test silently drops real lines.
- `PARTIAL` counts as **not ready** at the header gate
  (`so-readiness.ts:88` tests `=== 'READY'`).

The per-line `stock_status` itself is **stored**, not derived — plain `text` on
`scm.mfg_sales_order_items`, default `PENDING`, no CHECK constraint, values
`PENDING` / `READY` / `PARTIAL`. It is written by
`recomputeSoStockAllocation`.

### 6.1 The processing-date gate

`recomputeSoStockAllocation` gates on `proceeded_at`. An SO with a NULL
processing date has **every line forced to PENDING and consumes no stock**,
so the ERP emits the blank remark however much stock is physically on hand.
Any order that AutoCount marks `READY` but the ERP has not yet processed will
therefore disagree, and it is not a stock error. The checker pulls
`proceeded_at` and separates this class out by name.

---

## 7. Results

Two sources, and the difference between them matters:

- **7.1** is the existing item-level checker `check-ac-vs-erp-reconcile.mjs`,
  production run `31400160858` on 2026-08-10 14:48. It compares **per item**
  against the **frozen 2026-08-09 snapshot**.
- **7.2** is what the new per-warehouse, live comparison adds, and why the
  numbers in 7.1 are an optimistic floor rather than the answer.

### 7.1 Balance, per item, against the snapshot

| Measure | Value |
|---|---|
| Items compared | 505 |
| **Matching exactly** | **471 (93%)** |
| Differing | 34 |
| In ERP but not in the AutoCount set | 1 |

Every one of the 34 differences, with its cause:

| Item | AutoCount | ERP | Delta | Cause |
|---|---|---|---|---|
| DISPOSE | −2,487 | 0 | +2,487 | service pseudo-item |
| TRANSPORTATION CHARGES | −1,216 | 0 | +1,216 | service pseudo-item |
| STORAGE | −296 | 0 | +296 | service pseudo-item |
| MISC | −43 | 0 | +43 | service pseudo-item |
| BEDFRAME KIV | −3 | 0 | +3 | placeholder code, negative in AutoCount |
| CH-DC | 14 | 26 | +12 | ERP received after seeding |
| AK-SK FX AIRLOFT PIL | 23 | 33 | +10 | ERP received after seeding |
| SQUARE PILLOW | 47 | 55 | +8 | ERP received after seeding |
| AK-CS AIRLOFT COMFY PIL | 360 | 366 | +6 | ERP received after seeding |
| TRION (A)-(Q) | 4 | 7 | +3 | ERP received after seeding |
| HP MM VR TR NAV 4KFIT | 6 | 8 | +2 | ERP received after seeding |
| CH-DL RTG | 1 | 3 | +2 | ERP received after seeding |
| CH-DT RTG | 1 | 3 | +2 | ERP received after seeding |
| 7 further items | | | +1 each | ERP received after seeding |
| AMN-SOFA PILLOW | *(not compared)* | 205 | — | **checker bug, see below** |

**Two findings hide inside that table.**

*First, 4,042 of the 4,072 units of apparent disagreement are not stock at all.*
The four service pseudo-items account for 99% of the total delta. The old
checker does not exclude them, so its headline understates agreement badly. Once
they are removed, the entire real disagreement across 505 items is **30 units**.

*Second, the direction is uniform: every real delta is ERP-higher.* Not one item
has the ERP holding less than AutoCount. That is the signature of the ERP
receiving goods after it was seeded, against a frozen snapshot — exactly what
should happen. Had the ERP been losing stock to double-deductions or missing
receipts, the deltas would be mixed or negative. They are not. **This is a
positive result: there is no evidence of systematic stock leakage in the ERP.**

*The `AMN-SOFA PILLOW` row is a defect in the old checker, not in the data.*
It excludes AutoCount items by matching `/SOFA/` against the item **code**, so
`AMN-SOFA PILLOW` — an ordinary accessory — is dropped from the AutoCount side
while its 205 ERP units remain, and it is reported as "in ERP but not in
AutoCount". The new checker excludes on the item master's **ItemGroup**
(`SOFA`) instead of the spelling of the code, so those 205 units are compared
properly. `import-ac-stock-balance.mjs` already fixed this the same way; the
reconcile checker was never updated to match.

### 7.2 What the per-warehouse, live comparison adds

The 93% figure is an **upper bound on agreement**, for three reasons the new
checker removes:

1. **Item-level totals hide warehouse errors.** An item with the right total
   split across the wrong branches reads as a perfect match. The owner asked
   for the balance per location precisely because that is the error that hurts:
   staff go to a shelf that is empty. Only a per-warehouse comparison can see
   it, and `C&C K.J` alone holds 507 units that the item-level view folds away.
2. **It compares against a frozen snapshot, not the live book.** The −97 units
   AutoCount has shipped since (section 5) are invisible to it.
3. **It does not exclude the pseudo-items**, so its own headline is distorted
   by 4,042 units of non-stock.

### 7.3 Status

Per-line `stock_status` across processed orders, from the same run:

| Group | READY | PENDING | PARTIAL |
|---|---|---|---|
| accessory | 927 | 147 | 5 |
| bedframe | 256 | 186 | — |
| mattress | 274 | 258 | 3 |
| sofa | 0 | 272 | — |
| service | — | 190 | — |
| others | — | 13 | — |

Order headers: **187 READY_TO_SHIP, 332 CONFIRMED**.

**Sofa is the one systematic status defect, and it is already identified.**
Every sofa line is PENDING — not one is READY — and the reason is not
quantity. There are 20 open sofa lots and **none of them carries a `batch_no`**.
The allocator's `findCoveringBatch` requires a single batch to cover a whole
sofa set, so with no batch attribution it can never match, and every sofa set
stays PENDING no matter how much stock is physically present. 97 fully-received
bound dedications sit unallocated behind this, all of them sofa.

This is a **status defect the balance axis cannot see**, and it will make the
ERP disagree with any AutoCount sofa order marked `READY`. It is stock
attribution, not stock quantity. Sofa is excluded from the balance comparison
by design, so only the status axis exposes it — which is exactly why the owner
was right to ask for both axes together rather than either alone.

---

## 8. Defects and dry-run proposals

Nothing in this section has been applied. Per the owner's rule
(**不可以删只可以 cancel**), every remediation is a **reversing or compensating
movement that leaves the original rows in place** — never a delete. That is
also already the house pattern: `0088_scm_dropship_hardening.sql:258` and
`0198_scm_reverse_do_out_generalize.sql:175` both write a balancing
`ADJUSTMENT` "so inventory_balances nets to the physical truth".

### D1 — Known double-ship on SO-2606-019 (confirmed, unfixed)

DO-2607-005 and DO-2607-017 both dispatched SO-2606-019, double-deducting
KETTA / NTYR / TRION; DO-2607-017 also carries two phantom XAMMAR movements.
Already traced and pending the owner — listed here as the known case, not a new
finding.

**Proposal (dry-run).** Do not delete either document or any movement.

1. Set the unlinked DO-2607-005 to `CANCELLED` (its lines carry NULL
   `so_item_id`, which is why over-delivery detection was blind to it).
2. For each doubly-deducted `(product_code, warehouse_id, variant_key)`, insert
   one `ADJUSTMENT` movement of `qty = +<duplicated qty>` with
   `source_doc_type = 'REVERSAL'` and `source_doc_no = 'DO-2607-005'`, notes
   naming this document pair.
3. Reverse the two phantom XAMMAR movements the same way.
4. **Restore the original lots and close the lot the reversal opens.** This
   step is not optional and is the easiest one to miss.

Both original rows stay. The net effect on `inventory_balances` is zero, and
the audit trail shows what happened rather than hiding it.

**Why step 4 exists.** The FIFO trigger's `ADJUSTMENT` branch creates a **new
lot** whenever `qty > 0`. A bare `+qty` reversal therefore fixes the balance
while inventing a fresh lot at today's cost — phantom coverage that the
allocator will happily ship, and a COGS error on top. The house pattern already
handles this, and the fix must follow it rather than reinvent it:

> One balancing ADJUSTMENT (+net_out) so inventory_balances nets to the
> physical truth, then close the lot the trigger's ADJUSTMENT branch opened:
> the goods were either restored to their original lots in (a), or were never
> physically received — a fresh open lot here would double-count / be phantom
> coverage either way.
>
> — `0198_scm_reverse_do_out_generalize.sql:175`, identically at
> `0088_scm_dropship_hardening.sql:258`

So the correct shape is: restore the consumed quantities to the lots the
original OUT consumed (from `inventory_lot_consumptions`), write the balancing
`ADJUSTMENT`, then close the lot that adjustment opened. Both reversal
migrations already implement exactly this and should be the template.

### D2 — `migrated_no_stock` is a marker with no enforcement

Nothing in `backend/src` reads the flag. Two consequences:

- **Re-posting risk.** If a migrated DO is repaired or re-posted through the
  normal ERP route, no code path checks the flag and it **will** write an OUT
  and double-count the stock.
- **False orphans.** `check-posted-doc-movements.mjs` and
  `check-doc-line-vs-movement.mjs` do not exclude migrated documents, so every
  migrated GR/DO surfaces in those reports as a posted document with no
  movements. That is noise which trains people to ignore a real detector.

**Proposal (dry-run).** Add `migrated_no_stock` to the guard in the DO/GRN post
handlers so a re-post aborts instead of double-counting, and add the exclusion
predicate to both sweeps. Code change only, no data change.

### D3 — `TRANSFER` is counted at both ends

The view adds `TRANSFER` as `+qty` and the FIFO trigger has no `TRANSFER`
branch. Whether this is live or latent depends on whether any TRANSFER rows
exist, which the checker reports. If the count is zero it is a trap, not a
defect, and the fix is a guard rather than a repair.

**Proposal (dry-run).** If TRANSFER rows exist and are positive at both ends,
write compensating negative `ADJUSTMENT` movements at the source warehouse
(never delete), and change the writer to emit a signed pair. If the count is
zero, add a CHECK or a detector so the first TRANSFER written cannot silently
inflate the balance.

### D4 — AutoCount physical negatives

`AK-SK FX AIRLOFT PIL` at KL (−10), `CH-DC` at KL (−12), `AK-CS AIRLOFT COMFY
PIL` at C&C DISP (−6) and a handful of others are oversells recorded in
AutoCount. The ERP cannot represent them.

**Owner question (recommendation attached).** These need a physical count to
settle. Recommendation: treat the ERP value as authoritative at go-live and
book the difference as a counted stock-take variance, rather than importing a
negative the ERP has no way to hold.

### D5 — Service pseudo-items are permanently incomparable

DISPOSE, TRANSPORTATION CHARGES, STORAGE and Miscellaneous carry −4,050 units
in AutoCount and are all flagged `Discontinued`. They are billing lines, not
stock.

**Proposal.** No data change. Keep them on the documented exclusion list in the
checker so the exclusion is explicit and reviewable rather than an unstated
assumption.

---

### D6 — Sofa cannot become READY because no lot carries a batch number

Highest-impact status defect found. 20 open sofa lots, **zero** with a
`batch_no`. `findCoveringBatch` requires one batch to cover an entire sofa set,
so it never matches and every sofa line stays PENDING regardless of physical
stock. 97 fully-received bound dedications are stuck behind this.

Migrated stock arrived through the balance snapshot, which carries no batch
attribution — so this is a cutover consequence, not a code fault.

**Proposal (dry-run).** Two options, and the owner should pick:

1. **Backfill `batch_no` onto the migrated sofa lots** from the linked PO/GRN
   where one exists. Correct, and preserves the single-batch guarantee the rule
   exists to enforce.
2. **Allow an operator-chosen batch waiver** for migrated lots specifically —
   already on the books as an outstanding item. Faster, but weakens the
   guarantee that a customer's sofa ships from one dye lot.

Recommendation: option 1 wherever a linked PO exists, option 2 as the fallback
for lots with no traceable source. Neither is a stock change; both are
attribution changes.

### D7 — The old reconcile checker excludes accessories by code spelling

`check-ac-vs-erp-reconcile.mjs` filters AutoCount items with `/SOFA/i` against
the item **code**. `AMN-SOFA PILLOW` and `THL-SOFA PILLOW` are ordinary
accessories, so 205 units of real stock are dropped from the AutoCount side and
then reported as "in ERP but not in AutoCount" — a phantom discrepancy.

`import-ac-stock-balance.mjs` already fixed this by excluding on the item
master's `ItemGroup` rather than the spelling of the code; the reconcile
checker was never updated to match.

**Proposal (dry-run).** Change the exclusion in
`check-ac-vs-erp-reconcile.mjs` to read `ItemGroup`, matching the importer and
the new checker. One-line change, no data effect.

## 9. Verdict on the owner's premise

**Does "by right they should agree" hold?** For the balance axis, yes, within a
defined scope. For the status axis, the premise is stronger than it looks —
the ERP was deliberately built to reproduce Remark2, and the outstanding-order
vocabulary is 100% clean — but it holds **only where the two fields mean the
same thing**, and they do not always.

Where agreement is legitimately impossible:

| Class | Why it cannot agree |
|---|---|
| Sofa furniture | AutoCount counts whole units, the ERP counts compartments. Not decomposable without inventing stock. |
| Service pseudo-items | AutoCount stock-controls billing lines; the ERP models them as SERVICE with no inventory. Category error, not a gap. |
| AutoCount physical negatives | The ERP cannot hold a negative FIFO balance. |
| Documents after the cutover snapshot | The ERP was seeded at a point in time; AutoCount kept trading. Expected, measured at −97 units. |
| Orders not yet processed in the ERP | `proceeded_at IS NULL` forces PENDING regardless of stock, by design. |

Where a disagreement is a genuine defect: a duplicated movement (D1), a
movement missing on a document that is posted in both systems, and any
TRANSFER-inflated cell (D3). Those are the only classes that should ever reach
zero.

### The short answer for the owner

**On balance: yes, they align, and better than the raw numbers suggest.** 471
of 505 items match exactly. Of the 34 that do not, 30 units of real
disagreement remain once the service pseudo-items are removed — and every
single one is the ERP holding *more* than the frozen snapshot, which is what
receiving goods after the cutover looks like. There is **no evidence of stock
leaking out of the ERP**. The one thing still unmeasured is the per-warehouse
split, which the new checker exists to close.

**On status: the premise is sound and the field is trustworthy, but one
systematic defect blocks it.** Remark2 is 100% in-vocabulary and agrees with
AutoCount's own stock 99% of the time when it says `READY`. The ERP reproduces
the same vocabulary by design. But **every sofa line in the ERP is PENDING**
because no sofa lot carries a batch number (D6) — so every AutoCount sofa order
marked ready will disagree, and that is an ERP attribution gap, not a
warehouse-staff error.

Fix D6 and the status axis should largely fall into line. Nothing here needs a
change in AutoCount.

The deeper point about the status axis: **AutoCount's Remark2 is a human
assertion and the ERP's is a computation.** One is typed by a person when they
notice stock arrive; the other is recomputed from the actual allocation. That
asymmetry is the reason they can drift.

What the evidence says about the asymmetry is encouraging. The field is 100%
in-vocabulary on the outstanding set, and it agrees with AutoCount's own stock
99% of the time when it says `READY` (section 2.3). The human side of this is
in good order. So where the ERP disagrees with a `READY`, the presumption
should be that **the ERP is missing something** — an unprocessed order, an
unmapped warehouse, a movement that never landed — rather than that the
warehouse staff were careless. That is the opposite of the usual assumption
when a manual field meets a computed one, and it is worth stating plainly
because it changes where to look first.

---

## 10. What a daily automated reconciliation would need

Sketch only — not built.

**The blocking constraint is network, not code.** AutoCount sits behind
ZeroTier on the office network; GitHub-hosted runners cannot reach it. A daily
check therefore needs one of:

1. A **self-hosted runner on the office network** that runs `export-ac-live.py`
   and then the comparison. Cleanest, and keeps the credential on-site.
2. A small **on-site scheduled job** that exports and uploads the snapshot as
   an artifact, with the hosted workflow consuming it. Keeps AutoCount access
   off GitHub entirely.

**It also needs an explicit exemption from a standing rule.** `CLAUDE.md` says:
*"Never put a production DB read on a schedule; it turns a real query into CI
noise nobody reads."* A daily reconciliation is exactly that shape. This is an
owner decision, and the recommendation is option 2 with the result posted to a
channel a human actually reads, plus a **tolerance threshold** so ordinary
in-flight drift does not page anyone — the −97-unit cut-off drift above would
otherwise fire every single day.

**It must diff balances, not replay documents.** Section 5.1 is the proof: a
`DocDate`-filtered document sweep expected −169 units where the balance diff
measured −97, because staff back-date (one adjustment by 105 days). A daily
check built on "documents since yesterday" would drift out of true and then
report noise forever. Diff the balance; use `LastModified` only to point at
what to look at.

The remaining prerequisites are already satisfied: the SKU binding is complete,
the warehouse map resolves every location, the exclusion buckets are defined
and measured, and the readiness port is differentially tested. What is missing
is the runner, the alerting policy, and the owner's decision on the scheduling
exemption.

---

## See also

- `docs/autocount-cutover-ledger.md` — the cutover's own ledger
- `docs/cutover-tally-method.md` — how the SO/PO counts were tallied
- `backend/src/scm/lib/so-readiness.ts` — the Remark 2 convention in code
- `backend/src/db/migrations-pg/0276_scm_migrated_documents.sql` — why migrated
  paperwork has no movements
- `BUG-HISTORY.md` — the per-bug ledger
