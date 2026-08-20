## The working-agreement gate measures narrower than the rules it enforces, in seven places [high]

**Symptom** — the gate from #2135 reports `OK` on pull requests that violate all
three MANDATORY rules in CLAUDE.md. Reproduced against real files on `main`, not
constructed: exit 0 in every case below where a control on the same content
exits 1.

**Root cause (traced, not guessed)** — each check tests a proxy for the rule, and
the proxy is narrower than the rule:

1. `ROUTE_RX` and `PERM_RX` require the string literal on the same line as the
   call. `mfgSalesOrders.post(\n  FORCE_UNLOCK_ROUTE,\n  requirePermission(FORCE_UNLOCK_PERM),` is
   the same endpoint and the same permission and detects as nothing. `main`
   already carries 20 registrations in that shape and 2
   `requirePermission(CONSTANT)` call sites in `tableLayouts.ts`.
2. Rule 2 passes when the guide is *touched*, not updated. One appended blank
   line to `docs/modules/sales-order.md` turned `FAIL` into
   `PASS ... the owning guide(s) were updated`. So does DELETING that guide —
   which also removes the coverage for every later PR, compounding with 7.
3. `addsBugHistoryEntry` matches any added `## ` line, so rewording an existing
   heading reports it as this PR's new entry — it reported
   "## The AutoCount write-back never told AutoCount which salesperson sold the
   order", which is #2148's bug, not the PR's.
4. `detectFixIntent` rests on the branch prefix. Of 61 merged PRs that added a
   ledger entry and touched code, 10 are not flagged at all (#2138, #2122,
   #2069, #2003, #1997, #1987, #1981, #2131, #2121, #2065) and 11 more are
   caught by the branch name alone, so renaming `fix/x` to `feat/x` clears them.
5. `SURFACE_PREFIXES` excludes `backend/scripts/` and rule 3 keys on the
   `migrations-pg/` path, so `ALTER TABLE ... ADD COLUMN ... NOT NULL` plus
   `ALTER TYPE ... ADD VALUE` in a `backend/scripts/*.mjs` one-off clears all
   three rules. That is the shape of #2118 and of the repair scripts #2138 was
   written about.
6. `findStatement` tests length (>= 12) and a placeholder list, not truth.
   `Reversal: revert this PR and redeploy` is false for an applied migration —
   that is the whole lesson of 0284 — and `Verified against: the staging
   database yesterday` is the 0284 failure verbatim. Both pass.
7. The self-checks are zero tripwires, not a ratchet. With 26 of 27 guides
   archived — which #2125 did once already — the index falls from 385 quoted
   paths to 2, every `FAIL` becomes a `WARN`, and the run still exits 0. Nothing
   asserts the index did not shrink. On this tree 1230 of 1472 (83.6%)
   surface-eligible files map to no guide and can only ever warn.

Two more, adjacent: `.gitattributes` marking a path `-diff` renders its content
invisible to every content-based rule while `files.length` stays non-zero, so
the ZERO-changed-files self-check never fires; and the gate is not in the
`main-protection` required checks (`backend-typecheck`, `frontend`), with
`required_approving_review_count: 0`, so a red run does not hold anything.

**Fix** — `scripts/lib/working-agreement.escapes.test.mjs` pins all seven as
executable tests asserting current behaviour, so narrowing any one of them turns
its test RED and forces a deliberate rewrite. The gate's own test step ran one
named file and would never have executed this suite; it is now
`node --test scripts/lib/*.test.mjs` — 30 tests across 2 files, exit 1 on any
failure, both verified. The seven measurement gaps themselves are NOT closed
here: each is a judgement about how wide the check should be, and widening them
is what a ratchet must not do in one step.

**Ref** — #2161. Gate under test: #2135.

# Bug history

Newest first. Each entry is one defect: what was seen, what caused it, what was
changed, and what class it belongs to. Entries are `##` (recent) or `###` under a
`## YYYY-MM-DD` date heading (older); nothing else in this file uses those levels.

**Before adding an entry, read [`docs/bug-classes.md`](docs/bug-classes.md).** It
holds the causes that have recurred here — with a count, the worst thing each one
cost, and **the name of the check that now fails on it**. If the bug you are about
to write up is an instance of a class listed there, the check should have caught
it: say why it did not, and widen the check in the same PR. If it is a new class,
add it there once it has recurred, with a check — or under *Classes with no check
yet*, saying what blocks one.

That file exists because this one was not enough on its own. On 2026-08-10 a
stringified value bound to a jsonb parameter corrupted 146 sofa lines three times
in an afternoon; it was written up here and given a COE; on 2026-08-13 the repair
script written to undo the damage reproduced it, turning seven production rows
string-shaped. The write-up was read. Nothing mechanical enforced it.
