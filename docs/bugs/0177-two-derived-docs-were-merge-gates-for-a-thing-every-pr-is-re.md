## Two derived docs were merge gates for a thing every PR is required to change [high]

**Symptom** — on 2026-08-14, five open pull requests failed `backend-typecheck`
simultaneously, all on the same line — `docs/generated/bug-index.md` [generated]
*is out of date (175 entries in BUG-HISTORY.md).*

None of them had touched the index. They were regenerated one at a time, and
were stale again after the very next merge. Separately, `audit:map` failed a
one-line fix for a **broken production deploy** while printing, in its own
message, *"This is an on-demand check. It is deliberately NOT a CI or deploy
gate."* — from inside `backend-typecheck`, where a non-zero exit is precisely a
gate.

**Root cause** — both files mirror something every pull request is *required* to
move:

- `bug-index.md` mirrors `BUG-HISTORY.md`, and the working agreement (#2135)
  makes every code PR append an entry to it;
- `codebase-map-facts.md` embeds LINE NUMBERS, which shift on essentially every
  backend merge.

`main-protection` sets `strict_required_status_checks_policy`, so merges are
strictly serial. The instant any PR merges, both files are stale on every other
open PR — through no act of their authors. Every author is charged for what the
previous author did, and the queue cannot converge.

**What the gate is actually for, and is kept** — `docs/staging-bench-rot-coe.md`
records `audit:map` crashing unnoticed for three weeks. That is a generator
DYING, not output drifting, and it is worth failing on. The two are now
separated: a generator that parses zero entries or scans zero route modules
exits **2**; drift prints both counts and the fix and returns **0**. `--strict`
restores the hard failure for a local run or a job that wants it.

**Pinned by** `backend/tests/derivedDocsDoNotDeadlock.test.mjs` (then
`.node.mjs`, in `test:scale-contract`, both since renamed away): it fails 3 of 3
on the previous scripts, and asserts
that the only `process.exit(1)` left in either check path is guarded by
`--strict`.

**Class** — *a gate whose blast radius is wider than its subject.* Fourth
instance in two days, after the fabric census counting deliberate tombstones and
the file-size ratchet twice. The tell is the same every time: the failure
message asks the author for something only somebody else can do.

**Ref** - `fix/derived-docs-deadlock`, 2026-08-14
