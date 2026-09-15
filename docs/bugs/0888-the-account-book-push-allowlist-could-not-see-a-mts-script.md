## The account-book push allowlist could not see a .mts script [low]

<!-- area: AutoCount sync + write-back -->

**Symptom.** None in the book. Found while documenting how to re-push a sales
order after a direct SQL repair: the tool for that,
`backend/scripts/enqueue-so-writeback.mts` (#3583, 2026-09-10), builds its client
with `pgrestShim(pg, 'scm', { writeback: 'enqueue' })` — the opt-in that lets a
script write into the live AutoCount book — yet it is not on the pinned list of
scripts allowed to, and the test that pins the list was green.

**Root cause (traced).** `backend/tests/acWritebackPushAllowlist.test.mjs` exists so
that no script can gain `writeback: "enqueue"` without a deliberate edit to its
`MAY_PUSH` list (`docs/bugs/0753`). Both of its tests chose which files to read with
`.filter((f) => f.endsWith('.mjs') || f.endsWith('.ts'))`. A `.mts` file matches
neither, so the one script with that extension was never opened. Measured: widening
only the filter, with `MAY_PUSH` unchanged, fails the first test with
`+ 'enqueue-so-writeback.mts'` in the diff — RED on the unfixed list.

The tool itself behaved as intended: it is a deliberate push (re-sending
`HC-SO-2609-011` and `HC-SO-2609-049`; both rows read back `sent` on 2026-09-14).
What failed is the guard's claim that the list was complete.

**Fix.** Both tests now select files with `/\.[cm]?[jt]s$/` — every extension node
or tsx will run; today the only file at the top of `scripts/` that the old filter
skipped is this `.mts` — and `enqueue-so-writeback.mts` is on `MAY_PUSH`, with its
reason. GREEN after the entry; RED with the filter alone.

Found alongside a stale guide: `docs/modules/autocount-writeback.md` opened with
"It ships OFF … today exactly one [gate] is [on]" a month after production was
switched on. Read on production 2026-09-14 (read-only): `scm.autocount_writeback`
= `1`, `updated_at` 2026-08-13 02:48:27Z (Actions run 31661923475), 148 `sent`
outbox rows for company 1 in the preceding 24 hours; the Worker's secret list holds
`AC_SYNC_KEY`. The callout and the three-switch table are corrected, and §4b gains
*When a repair SHOULD reach the book* — the database has no trigger or function
that enqueues a write-back (same read), so a direct SQL fix to an ERP-owned figure
must be re-pushed by hand.

Local note: on Windows both tests exceed vitest's 5 s default reading ~800 files,
before and after this change; they pass with `--testTimeout`, and CI (Linux) runs
them inside the default.

**Ref.** docs/autocount-writeback-is-on, 2026-09-14. Sibling of
`docs/bugs/0753-cutover-repairs-queue-an-autocount-write-back-and-overwrite.md`.
