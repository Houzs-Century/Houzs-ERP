## The refusal named all five conditions and checked one — a free order was told it owed a deposit [high]

<!-- area: Sales orders + pricing -->

**Symptom.** Proceeding a Sales Order was refused with:

```
A Processing Date can only be set once the order has a customer name, a full
delivery address (line 1 and postcode), a delivery date, and the deposit its
company requires (Houzs 30%, 2990 50%).
```

The order was worth zero and nothing had been paid. The owner read "deposit",
concluded the system was demanding 50% of nothing, and spent a day on a money
bug that did not exist.

**It was never the deposit.** `meetsDepositGate` short-circuits at `total <= 0`
and its own docblock says why — *"Free order (total ≤ 0 …): nothing to collect,
so the gate is vacuously met"*. The deposit term PASSED. The order was missing
its **postcode**. `meetsProceedGate` weighs FIVE conditions
(`backend/src/scm/shared/order-rules.ts`) and `SO_PROCEED_GATE_RESPONSE`
(`backend/src/scm/routes/mfg-sales-orders.ts`) was ONE stored sentence naming all
five, returned whenever ANY ONE failed. The refusal could not distinguish the
condition it checked from the four it recited.

**Not a corner case.** Live population 2026-08-17: of 561 processing-dated SOs,
21 lack a postcode and 8 lack a delivery date. Every one of those refusals would
have said "deposit" too.

**Root cause, stated as a shape.** The verdict and the explanation were two
separate expressions over the same five facts — a boolean chain in one file and
a hand-written sentence in another. Two expressions for one rule is this repo's
repeat offender in its other costume: not "expressed at N sites, present at
N-1", but "checked in one place, described in another, and nothing keeps the
description true".

**Fix.**

- `meetsProceedGate` is now **defined as** `proceedGateFailures(i).length === 0`.
  One expression, read two ways: a caller wanting a boolean asks whether the list
  is empty, a caller wanting to explain itself reads the list. No input can make
  them disagree. `proceedGateFailures` returns stable condition KEYS, no prose —
  `order-rules.ts` owns the rule, `so-save-problems.ts` owns the words.
- The refusal is now the aggregated `problems` contract the save gate already
  used (owner 2026-07-18, "every reason at once"), under an **unchanged**
  `error: 'proceed_gate_unmet'` so clients matching on the code notice nothing.
  `reason` stays a plain sentence for surfaces that read only that key — it now
  names what failed instead of reciting all five. No frontend change was needed:
  `humanApiError` and `parseSaveProblems` key off the presence of `problems`,
  not off the `validation_failed` code.
- The completeness and deposit sentences are ONE table
  (`completenessProblem` / `depositProblem`), shared with
  `collectProcessingGateProblems`. Only a trailing clause differs — "before a
  Processing Date can be set" for the save path, "before this order can be
  proceeded" for the proceed paths, because the second operator has already
  pressed a button and his order already carries its date.
- `depositProblem` asks `meetsDepositGate` for its verdict instead of testing
  `totalCenti > 0` itself. A free order therefore CANNOT raise a deposit line —
  structurally, not by a guard that reads the same today and drifts tomorrow.

- `soDepositFacts`, `soProceedGateBlocked` and `soProcessingDateProblemsForDoc`
  moved out of `mfg-sales-orders.ts` into
  `backend/src/scm/lib/so-proceed-gate.ts`. Not tidying: that router sits under
  a file-size ceiling that may only FALL, and the detail the refusal now carries
  pushed it over. They were already one unit — docNo in, gate FACTS out, judged
  by the shared pure rules — so the ceiling picked the split, it did not invent
  it. The router lost 96 lines and is back under its ceiling.

**Outcomes did not move, and that is tested, not asserted.**
`so-save-problems.test.ts` runs a 576-input matrix (4 completeness booleans x 4
company codes x 9 paid/total pairs) and requires
`collectProceedGateProblems(f).length === 0` to equal the pre-change predicate
written out literally, and `meetsProceedGate` to equal it too. Only the words
changed.

**Watchers.**

- `backend/tests/soProceedRefusalNamesCondition.test.ts` — the owner's exact
  order through the real handler: total 0, paid 0, no postcode. Asserts the body
  names `Postcode` and that the string "deposit" appears NOWHERE in it. Fails on
  the pre-fix code (`problems` is undefined).
- `backend/tests/soProceedRefusalWiring.test.ts` — source-anchored, in the style
  of `soDatePairWiring.test.ts`: the gate is the empty-list expression, the five
  conditions are enumerated once, both refusing call sites go through the one
  builder, the routes mint no `proceed_gate_unmet` of their own, and no
  `message:` / `reason:` literal in the three modules names more than one gate
  condition. Eight of its nine tests fail on the pre-fix code.
- `frontend/src/vendor/scm/lib/authed-fetch.proceed-refusal.test.ts` — what the
  operator actually reads, composed by the real client code.

**The one `meetsProceedGate` caller with no problem list, and why that is
correct.** CREATE auto-proceed refuses nothing: a handover that misses the gate
is simply created un-proceeded, in Order Placed, for the salesperson to complete
manually. There is no refusal there to name a condition in. The wiring test
asserts that site returns no body, so if it ever starts refusing, it fails and
has to be classified rather than quietly shipping an anonymous sentence.
