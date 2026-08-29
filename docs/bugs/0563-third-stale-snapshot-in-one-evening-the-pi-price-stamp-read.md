## Third stale snapshot in one evening: the PI price stamp read 17-day-old invoice prices [medium]

**Symptom.** The fresh-map invoice dry-run (run 33182628482) refused 211
purchase invoices as "ours RM 0.00 — writable once the AutoCount invoice price
is stamped on the source lines". The stamping tool's own data,
`ac-invoice-prices.json.gz`, said `generatedAt: 2026-08-11` — running it would
have stamped 17-day-old prices and left every line invoiced since 8-11 blank.

**Root cause (traced).** Same mechanism as docs/bugs/0560 and 0561, third
instance in one evening: a committed snapshot whose mtime is a checkout
artifact while its content ages, consumed by a tool that printed the date and
enforced nothing. This one differs only in that its generator
(`export-ac-invoice-prices.py`) was already in the tree, so the refresh was one
command.

**Fix.** Regenerated live the same evening (17,976-line extract; its built-in
control: of 7,685 already-priced PO lines the invoice price agrees on 7,552 —
98.3%); `stamp-real-po-costs.mjs` now refuses a file older than 2 days.
Guard predicate proved against both real files: committed 8-11 copy → 17.9d
REFUSED, fresh disk copy → 0.0d PASS. Class rule now written in all three
tools: **the only honest age of a snapshot is the date inside it.**

**Ref.** fix/invoice-prices-refresh, 2026-08-28.
