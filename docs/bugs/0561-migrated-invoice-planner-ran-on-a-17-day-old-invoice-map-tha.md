## Migrated-invoice planner ran on a 17-day-old invoice map that was missing 985 newer invoices [high]

**Symptom.** create-migrated-invoices' 2026-08-28 dry-run (run 33181010525)
planned 39 invoices and printed "AutoCount map exported 2026-08-11T09:24:13" in
its own first line — a date nothing enforced and nobody had read. The plan was
computed against a 17-day-old world.

**Root cause (traced).** `data/ac-invoice-refs.json.gz` had a same-day mtime (a
git checkout) but `_exportedAt: 2026-08-11`, and its generator was not in the
tree at all, so it could never have been refreshed. Same class as
docs/bugs/0560, caught minutes after it by reading the header line 0560 taught
us to look for. Re-exported live the same evening: the book had gained **985
sales invoices and 435 purchase invoices** since 8-11 (ivMeta 9,245 → 10,230,
piMeta 4,789 → 5,224) — every one invisible to the stale map, inflating
`no_autocount_invoice` and comparing totals against superseded numbers. None of
the 39 stale-planned invoices were applied.

**Fix.** Three parts: (1) `create-migrated-invoices.mjs` now REFUSES a map
older than 2 days, naming the age — proved RED against the real stale file
(`exit=2`, "17.6 days ago") before the refresh, green after it; (2) the
generator now lives in the tree, `backend/scripts/export-ac-invoice-refs.py`
(read-only SELECT over PIDTL/PI + IVDTL/IV, byte-compatible shape); (3) the
refreshed map is committed with this entry. Rule confirmed twice in one
evening: **a snapshot file's mtime is a checkout artifact — the only honest age
is the exportedAt inside it, and a printed date nobody reads is not a guard.**

**Ref.** fix/invoice-refs-freshness, 2026-08-28.
