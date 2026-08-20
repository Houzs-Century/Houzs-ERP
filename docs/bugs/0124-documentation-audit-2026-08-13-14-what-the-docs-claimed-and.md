## Documentation audit, 2026-08-13/14 — what the docs claimed and the code does not [high]

**Scope note.** This entry is a CORRECTION RECORD, not a bug fix. It is filed
here because the standing rule at the head of this file makes this file the
system's memory, and because two of the items below are LIVE, UNFIXED defects
found while testing doc claims against `origin/main` `0c2a4e88`. Nothing in the
accompanying change touches code — it is docs-only on purpose, so the diff is
reviewable as one thing.

**Symptom** - the owner, 2026-08-13: *"直接去查看源代码，不要再查看它的文档了，那些
文档已经很有问题了。"* Tested every load-bearing claim in the module docs, the
COEs, `README.md` and `CLAUDE.md` against the tree that ships today. Fourteen
claims were false in the present tense. Two of them describe behaviour that is
broken in production right now.

**Root cause** - three mechanisms, all mechanical, none of them carelessness:

1. **A hand-resolved 13-branch squash merge (#2121, `d33ac743`) kept the wrong
   side of several conflicts, in code AND in the doc, in one operation** — which
   is why the doc could not catch the code. `git log -S` on the exact strings
   names `d33ac743` as the commit that reintroduced them. It left
   `docs/modules/sales-order.md` carrying BOTH halves of an unresolved conflict,
   printed back to back: two contradictory definitions of the Processing-Date
   column in one paragraph, and a duplicated `elapses (so-field-policy).` line.
2. **A register written to survive a rename did not survive the rename it was
   written for.** `sales-order.md`'s "column registry" — authored in #2106 on a
   branch predating the rename branch — named the RETIRED column
   `internal_expected_dd` as *"the only storage this concept has. Use this one"*
   and closed with *"it is `internal_expected_dd`, full stop."* The same batch
   merged the migration that retired it.
3. **A doc that CACHED a production measurement as a durable sentence.**
   `docs/archive/autocount-sync-coverage-2026-08-11.md` warned *"Re-run the workflow before quoting
   these; they move with the data"* two lines above quoting them itself as
   settled state, in bold: toggle `off`, outbox *"zero rows of any status"*,
   *"No ERP document has ever reached AutoCount."* All three were falsified the
   next day by the two `skipped` rows recorded at the top of this file.

**Fix** - fourteen documents corrected, each with a dated correction block rather
than a silent edit, because the fact that the first version was believed is the
lesson. Full list in the PR body. The two LIVE defects found are recorded here so
they are not lost when the docs read clean:

**LIVE #1 — the Processing-Date rename is not finished, both proceed paths are
dead, and this is live in production.** Mig `0286` renamed
`scm.mfg_sales_orders.internal_expected_dd -> processing_date` and **applied on
prod at 2026-08-13T13:46:59Z** — Deploy run `31705868668`, `backend` job:
`APPLIED 0286_scm_processing_date_one_name.sql (6 statements)`. The old column is
gone. Six literals in `backend/src/scm/routes/mfg-sales-orders.ts` were left
behind by #2121's conflict resolution and no longer resolve:

| line | literal | effect |
|---|---|---|
| `:5922` | `.select('proceeded_at, internal_expected_dd, …')` | 42703 fails the whole query; the error is discarded, `curRow` is null, every gate below evaluates against nulls |
| `:5925` | row type declares the old name | agrees with the dead SELECT, so nothing type-complains |
| `:5938` | `stored: curRow?.internal_expected_dd` | always null |
| `:5958` | `patch.internal_expected_dd = resolved.date` | writes a column that does not exist |
| `:7187` | `effOf('internal_expected_dd')` | the camel→snake map at `:6715` is `['processingDate','processing_date']`, so the key cannot exist — `PATCH /:docNo` with `proceededAt` returns 422 `PROCEED_NEEDS_DATE` on an order that HAS a Processing Date |
| `:5059` | `body.internalExpectedDd` on create | no live client sends it — `SalesOrderNew.tsx:1646`, `MobileNewSO.tsx:1827/1898` and the create's own INSERT `:5254` all use `processingDate`. `autoProceed` is therefore always false: an order created WITH a Processing Date is created un-proceeded, the exact inverse of the owner's pinned rule *"只要有 Processing Date，就代表他 Proceed 了"* |

`backend/src/scm/shared/so-processing-date.ts` already exports
`SO_PROCESSING_DATE_COLUMN = 'processing_date'` and
`SO_HEADER_LEGACY_PAYLOAD_KEYS.internalExpectedDd -> 'processingDate'`. The fix
is to read those. **NOT FIXED — needs its own diff.**

**LIVE #2 — the delivery board's `job_date` field was deleted by the same merge,
and the doc still documents it.** `9fa8e0ff` added `job_date` so synthetic ASSR /
DP / project rows stop carrying their leg date in the SO's Processing-Date field.
`e1263558` (squashed into `d33ac743`) **removed every one of those lines** —
`git show e1263558 -- backend/src/scm/routes/delivery-planning.ts` deletes
`job_date: null`, `job_date: leg.date` (×2) and `job_date: date`. On `0c2a4e88`,
`grep -rn 'job_date' backend/src` returns one stale comment and no field;
`delivery-planning.ts:1169/:1333/:1470` still write `processing_date: leg.date`.
`docs/modules/delivery-tms.md` described the deleted version as shipped, and
`frontend/src/mobile/MobileDeliveryPlanning.tsx:177` and
`backend/src/scm/shared/so-processing-date.ts:28` still describe it as live.
**NOT FIXED — needs its own diff.**

**Lesson** - **a conflict resolution is a rewrite, and nothing re-derives the
invariant afterwards.** All three mechanisms above are the same shape: work that
was correct on its own branch, merged by hand against work that was also correct
on its own branch, wrong together, with no compiler and no test able to object
because every one of these bindings is a STRING — a PostgREST select list, a
`Record` key lookup, a doc table. The pattern that DOES work is already in this
repo and is proven: make the parameter required and let the compiler enumerate
the call sites. Six such parameters were swept and are required on `main` today.
A string literal has no such enumerator, which is exactly why
`so-processing-date.ts` exists — and why six sites that do not use it are the
finding.

**Also measured, and stated so it is not re-discovered:**
- `142` lines in this file carry the literal unsubstituted placeholder `#<PR>`
  in a Ref line, so those entries cannot be walked back to a commit
  mechanically. (`grep -c '#<PR>' BUG-HISTORY.md` on `0c2a4e88` = 142; it reads
  143 after this entry, which quotes the placeholder once as an example.)
- Measured on `0c2a4e88`, before this entry: 2.5 MB, 10,658 lines, 847 entries
  (134 `## ` + 713 `### `). This file's own instruction — *"read it before
  touching a subsystem"* — is no longer executable at that size.
- An independent coverage test on 2026-08-13 found ~15% of in-window `fix`
  commits have no entry here at all, concentrated in cutover / sofa-import /
  fabric-migration work. One of them, `70559354` (#1858), says sofa pillow stock
  *"was thrown away"* — a stock-loss incident with no entry in this log.

**Ref** - `docs/correct-lying-claims`, 2026-08-14. Audited against `origin/main`
`0c2a4e88`. No production database was queried; every figure here is from a
command run on that tree or from a cited commit message.

---
