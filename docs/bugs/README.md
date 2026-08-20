# The bug ledger

**Read the entries for a subsystem before you touch it, and add one in the same
PR that fixes a bug.** That rule is MANDATORY and unchanged — see CLAUDE.md,
*"Log every bug"*. What changed on 2026-08-20 is only where the entries live.

## One file per entry

Every entry is its own file: `docs/bugs/NNNN-slug.md`, opening with
`## Title [severity]` on line 1. The four-digit prefix is the ORDER — higher is
newer — and nothing else. The body shape is the one CLAUDE.md sets:
**Symptom → Root cause (traced, not guessed) → Fix → Ref.**

```sh
node scripts/new-bug.mjs "The confirm gate accepted a cancelled PO" --severity high
```

That writes the next-numbered file and prints its path. Fill it in and commit it
with the fix.

## How to READ it

| what you want | how |
| --- | --- |
| "have we hit this before, in this subsystem?" | `npm --prefix backend run gen:bug-index` → `docs/generated/bug-index.md`, grouped by area, one row per entry |
| the whole ledger newest-first, as one document | `npm --prefix backend run gen:bug-history` → `docs/generated/bug-history.md` |
| one entry | open its file — the path is the citation |

Both generated views are **gitignored**. They are rebuilt from these files in
under a second, and a generated copy in git would conflict on every pair of
concurrent PRs, which is the problem this layout exists to remove.

## Why it is a directory and not one file

Until 2026-08-20 the ledger was `BUG-HISTORY.md`, and every entry was prepended
to the same first line of it. `.gitattributes` carried
`BUG-HISTORY.md merge=union`, which resolved that silently — **but only when our
git performs the merge.** The attribute is applied by whichever git does the
merge, and GitHub's git does not read this repository's `.gitattributes`.

`main` runs a merge QUEUE, and the queue stacks entry 2 on entry 1's result using
GitHub's git. Measured on the live queue on 2026-08-20:

```
1  AWAITING_CHECKS  #2553   <- only position 1 ever builds
2  UNMERGEABLE      #2554
3  UNMERGEABLE      #2557
4  UNMERGEABLE      #2549
5  UNMERGEABLE      #2551
6  UNMERGEABLE      #2555
7  UNMERGEABLE      #2556
```

All six non-leading entries UNMERGEABLE, and **all seven touched
`BUG-HISTORY.md`.** The queue was serialised to one PR at a time — roughly eight
minutes each — by the repo's own mandatory rule.

Two PRs adding entries now write two different paths. There is nothing for any
git, ours or GitHub's, to call a conflict.

## What the split cost, stated rather than hidden

- **The combined file is no longer browsable on GitHub.** It is one command away
  locally, and the per-entry files ARE browsable — arguably better, since a link
  to an entry now points at one screen instead of a 23,000-line file.
- **Line-number citations are gone.** `BUG-HISTORY.md` line 5562 had drifted on every
  append anyway; a citation is now the entry's filename, which does not move.

## The gates over this directory

| check | what it refuses |
| --- | --- |
| `npm --prefix backend run audit:bug-history` | a file here that is not exactly one entry: no `## ` heading on line 1, two headings in one file, or a filename that is not `NNNN-slug.md`. Charged to the change that introduced it, never to whoever is holding the branch |
| `npm --prefix backend run audit:bug-index` | an `<!-- area: ... -->` tag that names no area, and a generator that parses zero entries |
| `scripts/check-working-agreement.mjs` | a PR that reads as a fix, changed code, and added no NEW file here. Waived by the `no-bug-history-needed` label, which prints the violation it waives |

## The migration, and its proof

471 entries were split out of `BUG-HISTORY.md`. The split is reversible and was
proved lossless before it landed — twice: once at `162e37f90` over the 461
entries that existed then, and again after merging `origin/main` at `95d51b100`,
which had added ten more. Rebuilding the combined view from these files and
comparing it against `origin/main`'s blob gives an identical SHA-256 once
blank-line runs between entries are normalised, and an identical SHA-256 of every
non-whitespace byte with no normalisation at all.

```
entries in docs/bugs        471
entries in main's ledger    471

sha256 normalise(original)  f2e6243da7a40444024db0da6f6e0c8451a2fe8abe172bffc8e18a5fe217f781
sha256 rebuilt              f2e6243da7a40444024db0da6f6e0c8451a2fe8abe172bffc8e18a5fe217f781

sha256 original, whitespace stripped  37d0cbd664bb5ee8baee3eb76196aed4422756d8290a191e347826ed0416d249
sha256 rebuilt,  whitespace stripped  37d0cbd664bb5ee8baee3eb76196aed4422756d8290a191e347826ed0416d249
non-whitespace bytes                  1,230,063
```

**The one normalisation is whitespace BETWEEN entries, and nothing else.**
Measured over the 471: the blank-line run before the next heading was 0 lines in
150 places, 1 line in 315, 2 in five and 3 in one, and the file ended on a
dangling heading with no trailing newline. The rebuild writes one blank line
everywhere and terminates the file. CommonMark renders all four the same, and the
second hash — every non-whitespace byte, in order, with no normalisation — is
what rules out any loss the first could have hidden.

`backend/tests/bugLedgerRoundTrip.test.mjs` keeps the round-trip honest from here
on: render these files into one document, split it again, and you must get the
same entries back in the same order.
