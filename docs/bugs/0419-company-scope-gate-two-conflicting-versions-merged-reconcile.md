## company-scope gate: two conflicting versions merged, reconciled onto one ratchet [minor]

<!-- area: Repo tooling: tests, ratchets, generators -->

**Symptom.** `backend-typecheck` (required) HARD-FAILED. Round2 rewrote
`check-company-scope.mjs` (the shape scan that found the leaks above) and wired
`backend-typecheck` to run it `--strict`, whose invariant was "handler WRITE
findings must stay at ZERO". The improved scan surfaced **32 write findings**
(natural-key / upsert-key / rpc — 18 in `mfg-sales-orders.ts`, plus
`consignment-orders`, `fabric-tracking` bulk-upsert, `delivery-orders-mfg` crew,
`fleet-maintenance`, `so-amendments`) and the read-side ratchet (#2484's
`company-scope-baseline.json`) flagged **21 unscoped read handlers** it had not
grandfathered. Neither set was a new leak — the deep review traced this
money/stock surface as largely scoped (`selfScopedSalesBlocked` checks company
first) with the real leaks fixed on `main` (#2497) — they were shape-scanner
debt nobody had judged.

**Root cause (traced).** Two independently-correct gates collided in the merge.
`--strict` (round2) said writes must be zero; `--check` (main #2484) said the
current set must be a SUBSET of a committed baseline. `--strict` had no baseline
concept, so it could not grandfather the 32 writes; the shape-pass WRITES were
not even in the ratchet's `currentKeys` (only by-id + lib were), so `--check`
could not grandfather them either. The 32 writes and 21 reads therefore failed
one gate each with no honest way to ship the leak fixes without clearing an
unjudged backlog first.

**Fix (owner decision: grandfather as tracked debt, block NEW, shrink-only).**
Reconciled the two into ONE ratchet. `shapeKeyOf` gives each shape-WRITE finding
a line-free stable key (`file :: handler [kind]`); the shape WRITES now join the
ratchet's `currentKeys` (set-reads stay informational, as before — the owner
named 32 writes + 21 reads, not the ~89 set-reads). `--strict` and `--check` now
run the SAME gate: PASS when the current set is a subset of the baseline, FAIL on
a NEW finding (write OR read). The baseline was reseeded through the checker's
own `--update` path (no hand-editing) to **55 entries = 20 shape-write keys (the
32 write findings) + 35 read handlers (21 newly grandfathered + 14 carried
over)**. The matcher and the shape scan are unchanged — detection is not
weakened, the debt is merely locked and made blockable-on-growth. **This debt is
GRANDFATHERED, not cleared:** every entry in `company-scope-baseline.json` is a
site still owed a per-site review; the list may only SHRINK. The non-required
`company-scope-ratchet` job's `--ratchet-against origin/main` step is red BY
DESIGN on this reseed PR (baseline 17 -> 55) and self-heals on the next PR.

**Ref.** `fix/cross-tenant-leaks-round2`, 2026-08-20. Verified: `--strict` and
`--check` exit 0 on the reseeded baseline; a dropped write key AND a dropped read
key are each named as NEW (negative test); `test:light` 6070 green incl.
`companyScopeCheckerShapes` (9), `crossTenantLeaksRound2` (30),
`crossTenantUncoveredLeaks` (14); backend `tsc --noEmit` clean.
