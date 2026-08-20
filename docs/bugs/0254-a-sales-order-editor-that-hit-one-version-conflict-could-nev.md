## A Sales Order editor that hit ONE version conflict could never save again [high]

<!-- area: Sales orders + pricing -->

**Symptom.** Owner 2026-08-16, on his own (non-POS) account: an open SO editor
stopped being able to save. Not intermittently — permanently. Every Save
answered "Someone else updated this order while you were editing", including
saves seconds apart with nobody else on the order. The only way out was to
leave edit mode or reload, retyping whatever had not been saved.

**Root cause (traced, four parts, each read on `origin/main`).**

1. `advanceSoGeneration` (`backend/src/scm/lib/so-generation.ts:44`) does
   `version + 1`, and `so-stock-allocation.ts` calls it from the **5-minute
   cron** (`backend/src/index.ts`) that flips CONFIRMED <-> READY_TO_SHIP. It
   declines while an edit LEASE is held — but the lease exists only for the
   duration of a save, so while the operator TYPES the version moves freely.
   That is legitimate background work.
2. The Save's first persisted write is the version reservation, which 409s
   `so_version_conflict` (`mfg-sales-orders.ts:6804`).
3. The catch in `SalesOrderDetail.tsx` put the sentence in a banner and never
   touched `loadedVersionRef`, so the next Save re-sent the same stale number.
4. And the refetch effect is forbidden from healing it —
   `if (!isEditing || loadedVersionRef.current == null)` deliberately refuses to
   move the CAS baseline under an in-flight edit. **That guard is correct and
   stays**: a baseline that advances on its own turns CAS into
   last-writer-wins. The defect was that it was the ONLY door.

The recovery datum had been arriving the whole time. `soVersionConflict`
(`mfg-sales-orders.ts:356`) puts the server's real version in the 409 body, and
`authed-fetch.ts:411` preserves that body verbatim on `err.body`. It is **not**
discarded — a `grep -rn currentVersion frontend/src` returned only the
assertions in `authed-fetch.version-conflict.test.ts`. The datum was delivered
and never opened.

**Fix.** `so-version-conflict.tsx` reads `currentVersion` off `err.body` and the
editor renders a banner with two doors: *See what changed* (opens the order's
own history panel; writes nothing) and *Save my changes on top* (adopts the
server version as the new CAS baseline, then saves). Deliberately NOT a silent
adopt — that converts a safe refusal into a lost update, which is the exact
thing CAS exists to prevent — and deliberately not a forced refetch, because
the edit-mode seed effect re-seeds every line draft from `items` and would throw
away the very edits the banner promises are still on screen. Same read added to
the amendment submit path, whose direct-half header PATCH carries the version
too.

**Not changed, on purpose.** `authed-fetch.version-conflict.test.ts:14` asserts
the operator-facing sentence does NOT contain `currentVersion`. That assertion
enforces the house 白话文 rule (`authed-fetch.ts:406`) and relaxing it to "fix"
this would have leaked internals into a banner. The sentence stays clean AND the
body gets read; `so-version-conflict.test.tsx` pins both halves against the same
body string.

**Ref.** feat/so-multi-add-lines, 2026-08-16.
