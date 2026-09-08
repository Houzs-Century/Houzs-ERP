## Nothing carries an AutoCount payment back to the ERP once the order leaves the outstanding extract [high]

<!-- area: AutoCount sync + write-back -->

**Symptom.** `HC-SO-002309` (CHOW AH SIN, RM 6,049.00). Every line matches the
book. The book says the order is **SETTLED** — `UDF_BALANCE` 0, the header
edited in AutoCount **2026-09-04 14:03 local**. The ERP still shows
**RM 4,279.00 outstanding**, so it would chase a customer for money already
collected. `docs/bugs/0675` recorded that one order and named it the owner's
call. It did not ask the question this entry exists for: **how many more, and
why does the gap not close by itself?**

**Root cause (traced, not guessed).** Two facts, and only the second is new.

1. **`paid_sen` was never observed.** `import-ac-outstanding-so.mjs:328` wrote
   `const bal = centi(h.UDF_BALANCE); const paid = Math.max(0, total - bal);`.
   The BALANCE is the copied fact; the PAID is arithmetic against the ERP's line
   total at import time. `docs/bugs/0675` traced this and it is not re-argued
   here.

2. **The one lane that could refresh it is structurally blind to the orders in
   question.** `sync-ac-delta.mjs` section 3 (the `pay` lane, `:428-460`) does
   re-read `UDF_BALANCE` and does UPDATE `balance_sen`/`paid_sen`. But its book
   side is built at `:226` + `:245-248` from **`data/ac-outstanding-so.json.gz`**:

   ```js
   const soRows = gz("ac-outstanding-so.json.gz");
   const acSoHeader = new Map();
   for (const r of soRows) if (!acSoHeader.has(r.DocNo)) acSoHeader.set(r.DocNo, r);
   ```

   and the lane opens with `if (!bh || !lines) continue;` — a silent skip that
   is counted in NEITHER `payUpdates` nor `payConflicts`.

   That extract's population is the **DELIVERY**-outstanding one, not the unpaid
   one. `export-ac-reimport.py:172-180` defines it as
   `EXISTS(SELECT 1 FROM SODTL q WHERE q.DocKey=h.DocKey AND q.Qty > ISNULL(q.TransferedQty,0))`
   with `NOT (HAS_IV)` — a cash-sale exclusion, not a payment one. Measured on the committed cut: **2,789 documents, of
   which 620 already carry `UDF_BALANCE` 0** — so it is provably not a
   payment filter. `SO-002309` is **absent from it** (checked directly against
   the file) while being **present** in `ac-doc-headers.json.gz` with
   `UDF_BALANCE` 0.

   So: an order AutoCount has finished delivering has LEFT the extract, and a
   customer typically pays the balance **on delivery**. The lane that carries
   payments back cannot see the orders whose payment there is to carry. That is
   the mechanism, and it means the gap **re-opens every day** rather than
   converging.

   This also explains a reading that would otherwise look like a refutation.
   Delta run **34123720786** (2026-09-07 20:54 local, `MODE: apply`,
   `lanes=desc,pay,links,recv,do,dedi,hdr`) reported `orders whose book money
   moved 40` and wrote them; the next plan, run **34132396210** (22:20 local),
   reported `0`. That looks like convergence and it is not — it is convergence
   **over the extract**, which is a subset that excludes exactly the orders in
   question.

**Fix.** Two tools. Neither of them writes anything today, and that is the
point.

- `backend/scripts/check-so-payment-census.mjs` +
  `.github/workflows/check-so-payment-census.yml` — **READ-ONLY**, SELECT only,
  no writes, no DDL, no transaction, manual trigger, its own concurrency group,
  exit 0 for every legitimate answer. It counts the whole migrated company-1
  population into four buckets on ONE denominator: (a) the book says settled and
  the ERP says owing — **the bucket with a real-world consequence, listed in
  full with customer names**; (b) the ERP says settled and the book says owing;
  (c) both say owing, different amounts; (d) the stored `paid_sen + balance_sen`
  no longer equals `local_total_sen`. It prints both snapshot vintages and their
  ages BEFORE any finding, says in words that a payment recorded in the last N
  hours is invisible to it, refuses to subtract a non-MYR document
  (`docs/bugs/0665`, `0666`), and measures the blindness above **on bucket (a)
  itself** — how many of those orders are still inside the extract the delta
  lane reads, and how many have left it.
- `backend/scripts/repair-so-payment-from-book.mjs` +
  `.github/workflows/repair-so-payment-from-book.yml` — **PLAN BY DEFAULT, and
  no default ruling.** With `RULING` blank it explains the three choices and
  exits 0 without reading a single order. `balance-only` refreshes the stored
  column and says plainly that this does **not** stop the wrong chase;
  `settle-collected` is the payment write and is confined to the (a) shape;
  `both` is the pair. Guards that refuse rather than adapt: a snapshot older
  than `MAX_SNAPSHOT_AGE_DAYS` refuses the whole run, a non-MYR or cancelled
  document is skipped, an order a person has edited the money on or owns payment
  rows on is skipped, and **an order whose ERP total does not equal the book's
  is skipped as a PRICE question first** — if the two sides disagree what the
  order is worth they cannot agree what is left of it. Every UPDATE is guarded
  on the value the plan read; the read-back is on a FRESH connection.

**Which ERP number is "what we would chase", because there are two and they are
not the same.** `balance_sen` is the header column copied from `UDF_BALANCE` at
import. `balance_sen_live` is `local_total_sen - SUM(payments)` and it is what
the SO list, the delivery board (`delivery-planning.ts:481-484`) and the ASSR intake
(`assrFormIntake.ts:836-842`) actually show. The census buckets on the LIVE one
because that is the figure a customer would be chased for, prints the stored one
beside every row, and re-states the whole question against the stored column in
its own section so the two are never read for each other. The view clamps at
zero (`GREATEST(total - paid, 0)`, mig 0084/0189), so the census recomputes it
unclamped — an over-collected order is a real answer and must not be rounded
into "settled".

**What is NOT claimed here.** Whether any of this is corrected, and by which
ruling, is the owner's and not a script's. **Saying a customer paid when they
did not is worse than every other error on this cutover**, so no repair has been
run and the repair tool cannot run without a ruling named in full plus the
confirm phrase. The repair script's behaviour is therefore **UNTESTED** against
production; only its no-ruling path has been executed (it prints the three
choices and exits 0).

> **SUPERSEDED 2026-09-08 — both tools have now been RUN against production, and
> the paragraph above is kept only so the sequence reads correctly.** The census
> answered 45 of 2,882 (RM 171,400.00) in bucket (a); the owner ruled 一律跟账本;
> `settle-collected` was applied to 44 of them and bucket (a) fell to 1. Run ids,
> the per-order list, what was deliberately refused, and why the gap RE-OPENS are
> in `docs/bugs/0685-the-book-says-45-customers-had-already-paid-and-the-erp-stil.md`.
> The repair script is no longer UNTESTED; the sentence above was true when it
> was written and stopped being true, which is exactly the kind of stale claim
> this ledger exists to catch.

**A second finding, recorded because the sweep was cheap and nobody had
counted.** `docs/bugs/0675` noted that `HC-SO-004188` carries 2 ERP lines
against the book's 4 — DtlKeys `925621` and `925622`, both RM 0.00, both items
the customer is owed. The census now counts every book line with no ERP row
across the whole migrated population and splits them by price, so "is the
dropped give-away a pattern?" is a number instead of a worry.

**Ref.** `fix/payment-census`, 2026-09-08.
