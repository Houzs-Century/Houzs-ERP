## An SO amendment left the PO Amendments queue when a bound-PO read failed [high]

<!-- area: Sales orders + pricing -->

**Symptom.** Both PO Amendments queues (desktop `PoAmendments.tsx`, the phone
queue) show an SO amendment as a "From SO amendment" row only when the row's
`bound_pos` from `GET /so-amendments` is non-empty. When the read behind that
field failed, the field came back empty for the whole page and read exactly as
"this order was never purchased": the SO-driven rows left purchasing's queue,
the SO amendments list still answered 200, and nothing on either screen said a
read had failed. Found 2026-09-15 by reading the handler after 0924 (#3929 made
the phone queue list the same rows as desktop); not reported by staff.

Whether production was at that edge, measured read-only on 2026-09-15T09:37Z
(`scripts/check-so-amendment-bound-po-reads.mjs`, counts only): HOUZS lists 69
amendments over 45 orders, of which the PO queue shows 48; the PO-line read's
request line was 10,654 bytes, over the 4,000-byte budget every batched read in
this tree keeps to and under the ~19.5KB the gateway refused on 2026-08-17
(docs/bugs/0317). 2990 was within limits. No line, PO binding or amendment
crossed companies. At a full 500-row page with the same mix the PO-line read
would send ~77KB, so the failure was ahead, not behind: about 188 days away at
the last 30 days' rate.

**Root cause (traced).** `GET /so-amendments` (`backend/src/scm/routes/so-amendments.ts`)
filled `bound_pos` from three PostgREST reads, `mfg_sales_order_items` by the
page's doc_nos, `purchase_order_items` by every line id the first returned, and
`purchase_orders` by every PO id the second returned. Each destructured `data`
only and never bound `error`; the comment above them said "fail-soft:
enrichment errors leave bound_pos empty rather than failing the list". Each
carried its whole id list in one `.in()` with no batching and no `.range()`,
so a refused request line or a response over PostgREST's row ceiling emptied
or truncated the field the same silent way. The Reference read added on
2026-09-14 already failed the list on error but sent one unbatched `.in()` too.

How it was observed: `backend/src/scm/routes/soAmendmentListBoundPos.test.ts`
runs the real router over the fake PostgREST client with one selected column
missing per read (PostgREST fails the whole read on 42703, the fake's way to
fail one read while the others answer). On the unfixed handler the three
failure cases answered 200 with `bound_pos: []` on every row. Production was
measured by the read-only check above, not exercised.

**Fix.** The three reads and the Reference read go through `chunkIn`
(`backend/src/scm/lib/paginate-all.ts`): each id list is split by URL budget and
each batch paged past the row ceiling, and each read binds `error` and fails the
list with `load_failed`, as the main read and the Reference read already did.
Pinned by `soAmendmentListBoundPos.test.ts`: every PO an order's lines were
bought on is carried and an unpurchased order gets none; a failure of any of the
three reads answers 500 `load_failed`. Proved RED on the unfixed handler: 3 of 4
failed, each expecting 500 and receiving 200.

The read-only check (`backend/scripts/check-so-amendment-bound-po-reads.mjs`,
Actions "SO amendment bound-PO reads (read-only)") stays, so the next person can
re-measure without a database console. Its Postgres suite
(`backend/tests-pg/soAmendmentBoundPoReadsSql.pg.test.ts`) grows its fixture
past the row ceiling, and creates `public.companies` in the widest shape any pg
suite uses: the suites share one database in cache order, and the narrower
`(id, code)` table this suite and `piGrnPickerWindowSql` left behind failed
`probeTransferCensusSql`'s insert of `name` (CI run 34948309132).

Not changed here: `GET /so-amendments/:id` builds its light bound-PO summary
from the same three reads, unbatched and with `error` unbound, so a failed read
shows the detail "no purchase orders". Its lists are one order's lines, so the
size edge is far; the silent-failure shape is the same.

**Ref.** fix/so-amendments-bound-po-reads, PR #3936, 2026-09-15.
