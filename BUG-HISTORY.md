# BUG-HISTORY.md moved — the ledger is `docs/bugs/`, one file per entry

**This file is a signpost, not the ledger.** It is kept because ~60 comments in
`backend/`, `frontend/` and `docs/` cite "BUG-HISTORY" by name, and a reader who
follows one of those should land somewhere useful rather than nowhere.

- **The entries** are in [`docs/bugs/`](docs/bugs/) — one file each,
  `NNNN-slug.md`, opening with `## Title [severity]`. All 471 that were in this
  file are there, unchanged.
- **Read by subsystem:** `npm --prefix backend run gen:bug-index` →
  `docs/generated/bug-index.md`.
- **Read the whole thing, newest first:** `npm --prefix backend run gen:bug-history`
  → `docs/generated/bug-history.md`. That file is byte-identical to what this one
  held, apart from blank-line runs between entries.
- **Add one:** `node scripts/new-bug.mjs "<title>"`. Do NOT append here — the
  working-agreement gate wants a new FILE under `docs/bugs/`, and a `## ` heading
  added to this file is not one.
- **Why:** [`docs/bugs/README.md`](docs/bugs/README.md) has the full trace. Short
  version: every code PR is required to add an entry, so with one file every open
  branch edited the same first line. `merge=union` hid that from us but not from
  GitHub's git, and when `main` got a merge queue — which stacks entries using
  GitHub's git — the queue serialised to one PR at a time. Measured 2026-08-20:
  seven queued, six UNMERGEABLE, all seven touching this file.

**A dated citation still resolves.** "BUG-HISTORY 2026-08-12" means an entry
written on that date; find it with `grep -rl 2026-08-12 docs/bugs/`.

**A LINE-number citation does not, and never reliably did.** Line numbers into an
append-at-the-top file move every time anyone appends, which was several times a
day. All 21 of them across `docs/` were resolved on 2026-08-20 against the ledger
as it stood at the commit that WROTE each one (`git blame` → `git show
<sha>:BUG-HISTORY.md`): exactly one still names an entry that exists today, and it
now cites that entry's file. The other twenty named date sections — `## 2026-07-20`,
`## Earlier (2026-06 → 07, backfilled…)` — that a later restructure of the ledger
removed, long before this split. Those keep the number as prose (`` `BUG-HISTORY.md`
line 3435 ``) so the fact survives and the false address does not; recover them with
`git show <sha>:BUG-HISTORY.md`.

**Cite an entry by its FILENAME from now on.** That is what the bug index links to.
