## A money ceiling rested on a column no migration created — and a blip on the read that derives it raised the ceiling to infinity [high]

<!-- area: Delivery, DO, returns -->

Two defects, one mechanism: `remaining = delivered − invoiced − returned`, the
cap every DO → Sales Invoice and DO → Delivery Return write is checked against.
One defect made the `invoiced` term undeclarable; the other made it silently
zero.

**A — the column.** `grep -rn --include='*.sql' do_item_id
backend/src/db/migrations-pg/` returns rc=1 and ZERO hits, and
`backend/scripts/scm-schema/2990s-full-schema.sql` gives `sales_invoice_items` a
`so_item_id` and no `do_item_id`. Yet `lib/do-line-remaining.ts` sums
`sales_invoice_items.qty` linked by `do_item_id` to derive `invoiced`. A
`pg_dump --schema-only --schema=scm` of production (Actions -> "Dump scm schema
snapshot (read-only)", target=prod, run 32089111719) settles what is really
there: `do_item_id uuid`, nullable, no default, with
`sales_invoice_items_do_item_id_fkey` referencing `scm.delivery_order_items(id)`
`ON DELETE SET NULL`, and no index. Migration `0303_scm_si_items_do_item_id.sql`
declares exactly that and nothing else — `ADD COLUMN IF NOT EXISTS` plus a
`pg_constraint`-guarded `ADD CONSTRAINT`, so it is a no-op where the column
already exists. Note the sibling gap it does NOT close: `unit_cost_centi`,
`line_cost_centi` and `line_margin_centi` on the same table are undeclared too.
Same class, different change.

**B — the read.** Every read in `do-line-remaining.ts` destructured `{ data }`
and dropped `error`. supabase-js does not throw, so a failed select resolves
`{ data: null, error }` and arrived as ZERO invoiced rows — indistinguishable
from a delivery nobody has invoiced. `remaining` then came out at the FULL
delivered quantity on a line already billed in full. Six reads, each
individually sufficient: the two that ARE `invoiced`/`returned`, the two
cancelled-filter reads (lose them and every parent document looks cancelled,
which zeroes the term just as completely), and the two that build the ledger at
all. `resolveCandidateDoIds` had the same shape, and its empty list is what both
pickers render as "nothing left to invoice".

This was deferred out of #2374 with a stated reason — "a refactor with many
callers and its own blast radius" — which was right then. Every entry point now
returns `{ ok: true, … } | { ok: false, reason }`, and each of the ten callers
decides for itself:

- **write guards** (`checkSiOverRemaining`, `checkDrOverRemaining`, both
  convert pre-checks, the from-DO append) refuse with **503
  `remaining_check_failed`** — never 409 `over_remaining`, because the operator
  did not ask for too much;
- **display surfaces** (both pickers, the unbilled-deliveries report) answer
  **500 `load_failed`** rather than an empty list, because "nothing left to
  invoice" and "nothing came back" look identical on screen;
- **post-insert race rechecks** roll back and say **`remaining_check_failed`**,
  never `race_conflict` — nothing has escaped at that point (no revenue posted,
  no stock moved), so undoing costs a keystroke, and blaming a colleague who did
  not race would send the operator hunting for a duplicate that does not exist;
- **`doPendingItemCodesOf`** (the shadow guard) returns `ok: false`, which
  `unlinkedScanRefusal` already turns into a refusal at every call site. Its own
  header used to say this half was fail-open and filed separately. It is closed.

`checkDrOverRemaining` also carried an explicit `if (error) return null; // load
failure -> don't block; the insert will surface real errors`. It does not: the
insert has no cap of its own, so that read WAS the guard.

**Proof it is not vacuous.** `backend/tests/doRemainingFailsClosed.test.ts`
drives the real exported handlers with one table's SELECT failing. Against the
pre-fix tree six of its ten cases fail with `expected 201 to be 503` — the
invoice and the return were actually created for goods already billed. The two
rollback cases carry a CONTROL proving the same request succeeds when every read
works, so the 503 is the post-insert recheck and not the pre-check.
`audit:swallowed-reads` records the direction: `do-line-remaining.ts` 8 -> 0
(dropped from the baseline entirely), `delivery-returns.ts` 20 -> 19,
`sales-invoices.ts` 29 -> 27.

**C — the two doors the first pass left half-shut.** Review found the guard was
consulted at ten call sites but that two of them never reached it, because the
list they hand it was itself built from a swallowed read.

`PATCH /sales-invoices/:id/status` (REOPEN, CANCELLED -> SENT) read its own
`sales_invoice_items` with `const { data: reopenLines }` and no `error`, then
passed the result to `checkSiOverRemaining`, whose first act is `if
(wanted.size === 0) return null`. So a failed read produced an EMPTY line list
and the ceiling was never consulted — the 503 branch two lines below it was
unreachable by construction. The invoice went back to SENT and `postSiRevenue`
re-posted AR and GL revenue for goods a second invoice had already billed. This
is the worst of the set: it fails open on the money path, and it does so
silently, with a 200.

`POST /sales-invoices/:id/items/from-do/:doId` (APPEND) has the same shape one
table earlier. Its `delivery_order_items` read dropped `error`, so a failure
yielded zero candidate lines and the handler answered 409 `do_fully_invoiced` —
"this delivery has already been invoiced in full" — from a read that returned
nothing at all. A caller that believes it records delivered-but-unbilled goods
as billed.

Both now bind the error and refuse with the same 503 `remaining_check_failed`
the other eight callers use. Four cases in `doRemainingFailsClosed.test.ts`
pin it, two of them CONTROLs; against the pre-fix tree the two new assertions
fail `expected 200 to be 503` and `expected 409 to be 503`, which is the
reopen waving the double-bill through and the append claiming completion.
