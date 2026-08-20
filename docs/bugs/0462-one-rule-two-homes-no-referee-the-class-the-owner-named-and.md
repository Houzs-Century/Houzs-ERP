## One rule, two homes, no referee — the class the owner named, and the audit script that now looks for it [high]

<!-- area: Repo tooling: tests, ratchets, generators -->

**The ask (owner, 2026-08-18).** *"同一条规则两个家 —— 又是今天那个形状 … 那这一个要
统一一下吧。然后系统也是要查看这些类型的问题，要统一掉."* Unify the instances, and
make the system check for the class.

**The shape.** One business question, answered independently in more than one
place. Nobody is careless: the second copy gets written because the first was in
the wrong layer to reach, or because a new path was added by somebody who did not
know the rule existed. Then it drifts, and the failure is always the same — the
rule is enforced at N-1 of N places and the missing one is invisible, because
nothing errors. Four instances in three days: the both-dates-or-neither rule in
FIVE files with the CO header PATCH carrying no copy at all; the unlinked-line
money guard on the INSERT path of five chains and the EDIT path of none (#2374);
the typographic-quote normaliser added to the pricing engine and never to the
allowed-options gate (#2379); the stock-readiness label built twice, so one
screen printed a retired label as a group header over rows using the corrected
one.

**What now exists.** `backend/scripts/check-duplicated-decisions.mjs`, wired as
`audit:duplicated-decisions` into the REQUIRED `backend-typecheck` job. Three
detectors:

- **D1** fingerprints every string-literal array (this covers `new Set([...])`,
  `as const` tuples and inline PostgREST `.in('status', [...])` filters) and
  every named enum-keyed constant map, and reports a fingerprint carried by two
  or more FILES. This is the class `check-shared-mirrors.mjs` declares itself
  blind to at its own lines 32-35 — a rule re-implemented under a different
  filename. **130 groups on main** (re-measured 2026-08-20; it was 124 when this was written).
- **D2** compares those fingerprints pairwise and reports NEAR MISSES (Jaccard
  ≥ 0.75, not identical) with the exact differing members. This is what sees a
  rule enforced at N-1 of N. **96 pairs on main**, among them the three live
  answers to "which SO statuses are done" — FOUR and FIVE as two constants with
  the SAME NAME and different contents inside `routes/inventory.ts`, and SIX in
  `shared/so-terminal-states.ts`.
- **D3** asserts a configured guard symbol appears inside the BALANCED-BRACE
  slice of each sibling route handler. The slice is the point: a file-level grep
  passes while the guard sits in a neighbouring handler, which is the
  INSERT-guarded / EDIT-unguarded shape behind #2374. It is the only one of the
  three that catches an ABSENCE.

**A REVIEWED ALLOWLIST, not a meaning detector** — the mechanism
`check-empty-state-claims.mjs` already uses. 226 entries, each with a reason a
person wrote; a NEW hit fails until somebody decides about it; a stale entry
prints and never fails, because a gate that punishes the fix is a gate that
stops fixes. Pre-existing hits pass, so nobody is failed for a duplicate they did
not write. **The seeding pass IS the census the owner asked for**, and it is the
deliverable rather than a side effect.

**What it found while being built.**

- `soMainMixIntroduced` guards BOTH the add and the edit path of a sales order
  and NEITHER path of a consignment order, while `ConsignmentOrderNew.tsx`
  enforces the same rule client-side via `hasSofaMixConflict` — which exists
  only in the vendored frontend `so-variant-rule.ts` and has no backend
  counterpart. So the sofa-mix rule is enforced at the form and nowhere behind
  it. Recorded as a dated question, not fixed: whether a consignment order may
  mix a sofa with a bedframe is the owner's call.
- `EXPLICIT_APPROVAL_KEYS` (the permission keys a `*` wildcard must NOT satisfy)
  and the Assistant's known/denied position lists are unrefereed cross-tree
  twins whose frontend copies call themselves mirrors. Recorded; each is the
  same twenty-line pin as the password pair.
- The **common-password check in `passwordStrength.ts` is unreachable.** The
  four character-class gates run first, so anything reaching the dictionary is
  ≥12 chars with an uppercase, a lowercase, a digit and a symbol; of the ~290
  entries the only one with a symbol is 8 characters and the only two of 12+
  characters carry neither a digit nor a symbol. Found by the drift test's own
  vacuity guard, which demanded every refusal message and could not produce the
  seventh. Recorded and pinned, not fixed — changing it is a password-policy
  decision.

**`check-shared-mirrors.mjs` widened, and a defect in it fixed.** It read
`backend/src/scm/shared` alone while the frontend vendors from `vendor/shared`
AND `vendor/scm/lib`, so every `scm/lib` pair was invisible to the one check
whose whole job is this class. Walking both directories took it from 48 modules
to 226 — and the first new pair exposed a bug in the extractor: for any function
whose RETURN TYPE contains a brace (`rulesByCategory(): Array<{ … }>`) it sliced
the type annotation instead of the body. That can report DIVERGED over two
spellings of a type alias, and — the dangerous direction — COSMETIC over two
genuinely different bodies under one identical annotation. Fixed, with a
self-test probe for the braced-return-type form. Baseline before: rc=0, 0
DIVERGED, 12 COSMETIC, 8 IDENTICAL. After: rc=0, 0 DIVERGED, 13 COSMETIC, 8
IDENTICAL, 2 NO-OVERLAP (`costing-enabled` and `slip` — filename collisions,
read by hand, not copies).

**What the FIRST HONEST RUN found, after `main` moved under it (2026-08-20).**
The gate went red on 25 findings. Two were real and are FIXED here; the rest were
the allowlist rotting, and one was this PR pinning a rule `main` has since
reversed.

- **Two lock-label maps re-typed beside the rulebook that exports them.**
  `document-policy.ts` calls itself "the single source" for which header columns
  freeze once a document has a live child, and both `grn-inherited-lock.ts` and
  `po-identity-lock.ts` already import their COLUMN set from it — then declare
  their own local `label` map of the human names for those same columns. Add a
  column to the rulebook and the refusal message reads "cost allocation method"
  in the PCO's 409 and a raw `allocation_method` in the GRN's. Latent today
  because the copies still agree; the N-1-of-N shape exactly. Both now read
  `GRN_LOCK_LABELS` / `PO_LOCK_LABELS` from the rulebook, and D1 stopped
  reporting them, which is the detector confirming its own finding.
- **Sixteen allowlist keys rotted on the `_centi` -> `_sen` money rename.** The
  key is the fingerprint's VALUES, so renaming 251 columns re-spelled every
  money-shaped entry and 16 recorded decisions read as brand-new findings while
  their originals read as stale. Re-keyed with the reason preserved, and the ten
  `why` texts that still named `deposit_centi` corrected too — a reason that
  cites a column which no longer exists is the same rot one layer up.
- **PIN 4 pinned the losing side of a ruling.** It asserted `computeVariantKey`
  must NEVER fold typographic inch marks. #2430 shipped exactly that fold on
  2026-08-18 and gave its reason: a curly `12"` priced correctly and then
  allocated to a bucket nothing could match, so the same physical item never
  pooled. The assertion is flipped and annotated, never deleted, plus a
  non-vacuity test proving the two keys are equal by FOLDING rather than by both
  collapsing to empty.

**One finding is NOT resolved and is the owner's**, recorded in the allowlist as
open rather than decided: the consignment order's identity lock still freezes
`salesperson_id`, and the Sales Order's stopped (owner 2026-08-17 — a DO or SI
snapshots the customer, the addresses and the money, never who sold it, and
freezing it stranded a resigning salesperson's delivered orders where the
replacement could not even see them). Whether that ruling extends to consignment
orders is a business judgement, so it is raised, not guessed.

**The pins, for rules that must keep two homes.**
`backend/tests/duplicatedDecisionPins.test.ts` and
`backend/tests/passwordStrengthDrift.test.ts` feed ONE corpus through BOTH
implementations and compare. The password pair is imported on both sides and run
over 26 cases; the crew-scope predicate likewise over 18 (position, permissions)
pairs. The SO "done" disagreement is pinned at exact membership for all three
spellings and fails if a FOURTH appears — the count cannot quietly grow while
the owner's ruling on DRAFT and SHIPPED is outstanding. `so-terminal-states.ts`
and `inventory.ts` both already say in prose that this must not be merged
without that ruling; the test is what makes saying it enough. The PO receivable
threshold (`['SUBMITTED','PARTIALLY_RECEIVED']` at four homes) is TWO members,
below the detector's floor and invisible to it — pinned by test instead, which
is the honest division of labour between the two mechanisms.

**One behaviour fix.** The desktop projects filter bar decided "is this user
force-scoped crew" with `/\bhelper\b/i || /storekeeper/i` and no permission
escape, while the server matches the EXACT position name against a three-entry
set and exempts anyone holding `*` or `projects.write`
(`services/projectGates.ts:30-45`, whose own comment forbids substring matching
because position names are owner-editable free text). Two consequences, neither
of which errors: an owner-created position like "Warehouse Helper" caged the UI —
slimmed filter bar, "You see your own events" — while the server returned
everything; and an admin holding the Storekeeper position lost controls the
server would have allowed, because `permissions.includes("*")` fed only
`_isDirector`, which gates `_isSalesExec` and not the crew arm. The predicate now
lives in `frontend/src/auth/crewScope.ts`, exact-match plus escape, and the pin
runs both copies over one corpus. `MobilePMS.tsx`'s `_isCrew` is deliberately
NOT changed: it folds drivers in, so it answers the filter-bar cohort question,
not this one.

**What the gate cannot catch, stated in its own header so a green run is not
over-read.** (1) A semantic duplicate whose copies share no literal — the
total-height family (divan + leg + gap, sixteen surfaces) shares every literal
and every regex and diverges only in CONTROL FLOW, so D1 and D2 call those copies
identical. (2) A rule expressed once in TypeScript and once in SQL. (3) Whether a
flagged pair is even the same QUESTION — `hr-commission.ts`'s
`COMMISSION_EXCLUDED_STATUSES` has the same three members as the SO deliverable
threshold and is a different question; that judgement is what the allowlist
`why` field exists to record. (4) Anything assembled at runtime, and anything
below the three-member floor. Test files are not scanned, deliberately: a test
that pins a set's membership is the REMEDY for this class.

**Proved not vacuous, ten times.** A violation was planted for each mechanism,
watched fail, removed, and watched pass: D1 (a fourth home for
`DRAFT/CANCELLED/ON_HOLD` → rc 1, and it re-opened the already-reviewed group by
naming the NEW home); D2 (a set one member off → rc 1, naming the differing
member); D3 (the guard deleted from ONE of the two guarded handlers in
`mfg-sales-orders.ts` → rc 1, while the symbol was still present twice elsewhere
in the same file, which a grep would have passed); the mirror widening (the same
planted `scm/lib` divergence is rc=0 with ZERO mentions on `origin/main`'s
checker and rc=1 DIVERGED on the widened one); and each of the six pins. The new
script's own startup self-test also fired twice for real during development,
refusing to report a number: once because the array parser dropped a member
carrying an escaped quote, and once because it dropped `["12'", …]` entirely —
the other quote character inside a literal defeated the regex, and a dropped
array is a duplicate the gate would then swear does not exist.
