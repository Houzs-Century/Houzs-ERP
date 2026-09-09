## The allocation recompute could not run from Actions because the shim served no embedded selects [high]

**Symptom.** `Recompute SO stock allocation (DRY-RUN gated)` refused with
`allocation DO-line load failed: pgrest-shim: unsafe identifier "so.status"` —
so the one dispatchable way to recompute or verify the SO stock projection from
CI had not worked since 2026-08-16, while the run reported success. The
"nothing changed" sections it printed were comparing a snapshot with itself.

**Scope, stated plainly so it is not over-read.** This is the ACTIONS path only.
`recomputeSoStockAllocation` runs in the Worker on ~38 triggers plus the cron
repair loop `drainStockAllocationRecompute` (`backend/src/index.ts`,
`backend/src/scm/lib/stock-allocation-job.ts`), where the real PostgREST client
serves the embed fine. Production allocation was not dead; the way to
RE-COMPUTE AND VERIFY it on demand was.

**Root cause (traced).** `recomputeSoStockAllocation` has two hot reads that
filter on an EMBED —
`.select('id, so:mfg_sales_orders!inner(status), do_items:delivery_order_items!inner(...)')`
with `.not('so.status', 'in', SO_TERMINAL_STATES_PGREST)`, and the PO-link read
with `.gt('po_items.received_qty', 0)`. Both arrived with `24b379034` (#2298,
2026-08-16, the SO-sweep inversion), verified with
`git log -S".not('so.status', 'in', SO_TERMINAL_STATES_PGREST)" --reverse`.
`backend/scripts/lib/pgrest-shim.mjs` was built 2026-08-10 for the
pre-inversion shape and documented itself as serving no embedded selects: `q()`
rejects any identifier outside `^[a-z_][a-z0-9_]*$`, so `so.status` threw.
Nothing tied the two together.

**Fix — the root one, not the stopgap.** The shim now translates ONE level of
`!inner` embedding, which is exactly the shape the canonical function uses.
The relationship is read from `pg_constraint` at run time, once per
(parent, embed) pair, the way PostgREST resolves an embed: zero or more than one
single-column foreign key between the two tables is a GAP with the count
printed, never a guessed join column. That matters here —
`mfg_sales_order_items` joins its header on `doc_no`, not on an id, so an
assumed `parent_id` convention would have joined nothing. A to-ONE embed becomes
an INNER JOIN with its filters in the main WHERE; a to-MANY embed becomes a
correlated `json_agg` subquery plus an `EXISTS`, so the PARENT row set is never
multiplied — `.range()` pages over parents, and a fanned-out join would both
repeat and skip them. A plain (non-`!inner`) embed and a second level of
embedding are both refused rather than guessed.

Chosen over the alternative — driving the recompute through the Worker, which
already holds PostgREST credentials — because that needs a new admin trigger
endpoint and an Actions-side token, and this repo is public: `SUPABASE_URL` /
`SUPABASE_SERVICE_ROLE_KEY` must never become Actions secrets. The shim keeps
the workflow on `DATABASE_URL`, which is the only database credential Actions
holds.

**Tests.** Seven added to `backend/tests/pgrestShim.test.mjs`, driving the two
REAL allocator selects: the DO-line load emits one parent-grained statement with
the `doc_no` join, the aggregate, the EXISTS, no `"so.status"` anywhere and
ascending placeholders; the PO-link load pushes `received_qty > 0` into BOTH the
aggregate and the EXISTS; an undeclared alias, a missing `!inner`, an ambiguous
relationship (with its count) and two-level nesting are each a loud gap; and a
non-embedded select still emits byte-identically the SQL it always did.

Proved RED against the unfixed shim before the change: with `main`'s
`pgrest-shim.mjs` checked back in, `npx vitest run --config
vitest.light.config.mts tests/pgrestShim.test.mjs` reported **6 failed | 10
passed (16)**, the first two failing with
`pgrest-shim: unsafe identifier "so.status"` — the production symptom itself.
The seventh new test is the regression one and passes on both trees, which is
the point of it. With the fix: **16 passed (16)**.

**Ref.** fix/pgrest-shim-inner-embeds, 2026-09-07.
