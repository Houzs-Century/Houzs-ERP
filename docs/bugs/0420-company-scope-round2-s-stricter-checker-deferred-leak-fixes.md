## company-scope: round2's stricter checker DEFERRED, leak fixes land on main's #2484 ratchet [minor]

<!-- area: Repo tooling: tests, ratchets, generators -->

**Decision (owner, 2026-08-20).** Round2's leak FIXES ship now; round2's
stricter checker rewrite does NOT. The entry directly below describes the
reconciliation that reseeded `company-scope-baseline.json` 17 -> 55 to
grandfather round2's **32 write findings + 21 read handlers**. That reseed GROWS
the baseline, which the owner's REQUIRED `company-scope-ratchet` (a no-growth
guard, `--check --ratchet-against origin/main`) forbids. Rather than weaken the
ratchet, the owner chose to keep main's strong #2484 gate and DEFER the stricter
checker + its write/read debt for a later per-site pass.

**What landed here.** Restored main's versions of the four tooling files
(`check-company-scope.mjs`, `company-scope-baseline.json` staying at 17 entries,
`.github/workflows/ci.yml`, and removed the round2-only
`companyScopeCheckerShapes.test.mjs` that tested the reverted checker). ALL of
round2's actual route/lib leak fixes and its tenant suites
(`crossTenantLeaksRound2`, `crossTenantUncoveredLeaks`) are kept — they are the
point. Because the fixes only REMOVE leaks, main's ratchet stays green: `--check`
and `--check --ratchet-against origin/main` both EXIT 0 (14 unscoped now, a
subset of the 17-baseline; 3 baseline entries — `sofa-combos PUT /:id`,
`suppliers POST /:id/bindings/batch`, `warehouse POST /racks` — even improved).

**Deferred (NOT adopted here), to be revisited per-site.** Round2's shape-scan
checker (`shapeKeyOf` shape-WRITE keys joining the ratchet) and the debt it
surfaced — 32 write findings (natural-key / upsert-key / rpc; 18 in
`mfg-sales-orders.ts`, plus `consignment-orders`, `fabric-tracking` bulk-upsert,
`delivery-orders-mfg` crew, `fleet-maintenance`, `so-amendments`) and 21 unscoped
read handlers. None is a proven new leak; each is a site still owed a per-site
review. Re-adopt the stricter checker only alongside clearing (not just
grandfathering) that backlog.

**Ref.** `fix/cross-tenant-leaks-round2`, 2026-08-20 (revert commit on the
branch). Supersedes the reconciliation entry below.
