## A gate enforced in two places, and a switch that opened only one of them [medium]

**Symptom.** `repair-mislabelled-sofa-po-lines.mjs` was given
`ALLOW_DELIVERED=1` (`docs/bugs/0750`) so the owner could correct five
purchase orders whose goods had already shipped. All five planned cleanly and
all five were rolled back:

```
=== APPLYING 1 BUILD(S) ===
ROLLED BACK HC-PO-009467 (PO-009467) 9028-1S <- HOK-5530 SOFA
            — HC-SO-012128 now carries 2 delivery-order line(s)
=== VERIFIED ON A FRESH CONNECTION ===
  builds applied 0 of 1; shapes verified 0
```

Runs 34327433537, 34327518796, 34327602216, 34327685367, 34327763573. **Nothing
was written on any of the five** — the transaction did exactly what it exists to
do.

**Root cause (traced, not guessed).** The delivery rule is enforced TWICE, and
deliberately so:

| where | what it reads |
|---|---|
| `lib/mislabelled-sofa-po-plan.mjs:118` | the plan's snapshot |
| `repair-mislabelled-sofa-po-lines.mjs:299` | a re-read INSIDE the write transaction |

The switch was wired to the first only. The second is not redundant — it catches
a delivery raised between the plan and the write, which is a real race — so the
answer is not to delete it but to have it read the same switch.

**Fix.** `ALLOW_DELIVERED` now gates both, and the transaction says so when it
proceeds: `proceeding on <doc> despite N delivery-order line(s) —
ALLOW_DELIVERED=1`. Unset, both throw exactly as before.

**The reading error, which is the part worth keeping.** The script prints its
PLAN counters before its RESULT:

```
purchase lines re-coded 1 · inserted 1 · receipt lines re-coded 1 · inserted 1
=== 0 LINE(S) REFUSED ===
=== APPLYING 1 BUILD(S) ===
ROLLED BACK ...
  builds applied 0 of 1; shapes verified 0
```

Five documents were run and the first line was read as the outcome for all five,
because it is the line that looks like a result. **`builds applied N of M` is the
verdict; every counter above it is an intention.** This repo already says a
version of that — "a checker that cannot match reports a clean run" — and this is
its mirror: a script that prints what it INTENDED, then what it DID, and only the
second is evidence.

**Why a grep for the gate would not have found it either.** The two sites do not
share a phrase: the plan returns `refuse(...)` and the transaction `throw new
Error(...)`. What they share is the QUESTION. When adding a switch to a rule,
look for every place the rule is asked, not every place its words appear.

**Ref.** PR for `fix/mislabelled-sofa-po-allow-delivered-2`, 2026-09-09.
Follows `docs/bugs/0750`.
