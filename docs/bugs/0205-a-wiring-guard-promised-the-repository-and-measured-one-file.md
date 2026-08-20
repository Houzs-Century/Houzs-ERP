## A wiring guard promised the repository and measured one file — a third AutoCount enqueue was invisible to it [low]

<!-- area: Sales orders + pricing -->

**Symptom.** None in production. Found by verifying `docs/modules/sales-order.md`
against source, which is the point of that exercise: nothing was failing, and the
guide told a reader something that was not true.

The guide said the AutoCount create-enqueue invariant was held at *"exactly two
such places, and both are gated"*, and that
`backend/tests/soLocationGateWiring.test.ts` *"fails if a THIRD `enqueueSoCreate`
callsite ever appears un-gated"*. The test's own failure message said the same:
*"a new enqueueSoCreate callsite needs its own location gate"*.

There were **three** callsites. `scm/lib/autocount-requeue.ts:382` was the third,
and had been all along.

**Root cause (traced).** The guard imported ONE module —
`import rawRouteSource from '../src/scm/routes/mfg-sales-orders.ts?raw'` — and
asserted `routeSource.match(/enqueueSoCreate\(/g).length === 2`. A callsite in
any other file is structurally outside what it can see, so it could never fail
the way its message claimed. Same shape CLAUDE.md already records twice: *"a
checker that cannot match reports a clean run"* and *"a verdict computed over
nothing must never read as a pass"* — except here the verdict was computed over
a population narrower than the sentence citing it, which reads identically from
the outside.

**Why nothing broke.** The third callsite is safe, by a DIFFERENT mechanism than
the one the guide names. `autocount-requeue.ts` re-sends an outbox row that
already exists, so the document already passed a gated create; and
`enqueueSoCreate` itself catches `MissingLocationError` and writes a `skipped`
outbox row with the reason (`scm/lib/autocount-outbox.ts`) instead of sending a
create AutoCount would refuse. That second mechanism is the one that matters,
because it is what holds for an order created before the gate existed.

**Fix.** The guard now walks `backend/src` and holds the whole population: any
callsite that is neither the router nor a named exception fails, and a named
exception whose file has stopped calling it ALSO fails — a stale exemption is a
promise about nothing, and it hides the day the callsite reappears elsewhere.
The exception carries the mechanism in prose, so the next reader inherits the
reason rather than the permission. All three arms proven red before trusting
them (missing exception, stale exception, empty walk).

The guide and the test header now say the repo-wide sentence — *"every enqueue
has a settled location, by one of two mechanisms"* — and reserve *"the gate
covers every enqueue"* for the router.

**Ref.** 2026-08-15, module-guide verification of `sales-order.md`.
