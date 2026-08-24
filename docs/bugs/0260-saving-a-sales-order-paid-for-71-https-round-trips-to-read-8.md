## Saving a sales order paid for 71 HTTPS round trips to read 83 rows [high]

<!-- area: Sales orders + pricing -->

**Symptom.** Creating a sales order, and every line add / edit / delete, made
the salesperson watch a loading state. PR #1982 measured one such save at
**10.6s on production** and deferred the sweep behind it for the header PATCH
only; the create route and the three line routes still `await` it.

**Root cause (traced, measured — not derived).** All five routes `await`
`recomputeSoStockAllocation`, and the SCM client is supabase-js over PostgREST
HTTPS (`db/supabase.ts`), so every `sb.from(...)` is a full Worker→Supabase
round trip in series. `probe-so-save-cost` asked production what the sweep
costs (run `31937764356`, 2026-08-16):

```
   123  TOTAL read round trips
    71  delivery_order_items (chunkIn EVERY live line id)
    18  purchase_order_items (chunkIn bedframe/sofa line ids)
     6  mfg_sales_order_items allocated_batch_no (chunkIn sofa line ids)
```

Those 95 were not reading 95 requests' worth of data. `chunkIn` batches an id
list 200 at a time, so the cost was set by the **id count** — 14,169 live SO
lines — and not by the rows that exist. The `delivery_order_items` read made
**71 requests to retrieve 83 rows**. The `allocated_batch_no` pass re-read
1,123 rows the step-2 select had already fetched, for one extra column.

**Fix.** The three reads are INVERTED: they start FROM `mfg_sales_order_items`
with the live-SO lens as a one-level embedded filter (the shape `routes/mrp.ts`
already runs in production) and pull the child rows through a PostgREST
`!inner` embed, which returns only the SO lines that HAVE a child row — so no
id list is enumerated at all. `allocated_batch_no` moves into the step-2 select
that was already reading those rows, keeping its migration-0121 forward-compat
retry. **123 → 30 serial round trips.**

Equivalence was PROVEN against production before shipping, not argued
(`probe-so-sweep-inversion`, run `31941756087`):

```
  delivery_order_items  old 83 rows, new 83 rows — old EXCEPT new = 0, new EXCEPT old = 0
  purchase_order_items  374 rows                 — old EXCEPT new = 0, new EXCEPT old = 0
  delivery_order_items.so_item_id -> mfg_sales_order_items  [exactly one FK]
  purchase_order_items.so_item_id -> mfg_sales_order_items  [exactly one FK]
```

The FK check is not ceremony: PostgREST resolves an embed from a foreign key,
so no FK means a 400 in production and the change could not have shipped at
all. The row comparison is a symmetric difference row by row, never a count —
`res.count` answered the wrong question three times in
`jsonb-double-encoding-coe.md`.

The SO detail's Stock column is a whole global `computeMrp` run, and it stays
one: a line's coverage depends on what higher-priority lines already claimed,
so a single-order run answers a different question rather than the same one
faster. What changed is that it no longer BLOCKS the three per-line reads
beside it — `soCoverage` is awaited alongside them.

**What this did NOT do, deliberately.** The AutoCount outbox enqueue
(`queueAcSoEdit` → `composeSoState`, ~10 more serial round trips at the end of
every line write) was left ON the response path. Its result is discarded by
every caller, so it *could* move to `waitUntil` — but a lost `waitUntil`
leaves an SO edited in the ERP with no outbox row, and
`check-autocount-outbox-health` reads the outbox TABLE: it can see a `failed`
row, and cannot see a row that was never written. Deferring it would create a
silent-divergence class no check covers, three days after write-back went live.
The condition under which it becomes safe is stated in the module guide.

**Test.** `tests/soAllocationReadShape.test.ts` runs the real
`recomputeSoStockAllocation` against a PostgREST-shaped fake that APPLIES the
predicates (including embedded ones) and counts requests. On a 300-order /
1,200-line fixture it asserts the same allocation and **20 → 12** SELECT round
trips; on the parent commit the same file fails with
`expected 6 to be +0` for `delivery_order_items`.

**Ref.** perf/so-save-roundtrips, 2026-08-16.
