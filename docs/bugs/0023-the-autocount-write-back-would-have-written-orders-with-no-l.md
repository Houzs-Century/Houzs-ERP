## The AutoCount write-back would have written orders with NO LINES, and no PO at all [critical]

**Symptom** — None yet, and that is the point: the ERP -> AutoCount write-back
(#1855) ships behind two off switches, so nothing it does can be seen until
someone turns it on. A contract audit against the AutoCount half found thirteen
places where the two programs disagree about the same JSON document, four of
them fatal, and none of them would have announced itself — `AcSyncService.cs`
reads a field with `Str(p, "X")`, which returns `""` for a field that is not
there rather than an error.

**Root cause** — Traced per finding, not guessed; all thirteen are listed with
both sides in `docs/modules/autocount-writeback.md` section 11 and pinned
mechanically by `backend/src/services/autocount-writeback.contract.test.ts`. The
four that block:

- **The line select asks for `linked_ac_dtlkey`**, a column PR #1819 has not
  landed. PostgREST does not ignore an unknown column — it fails the whole query
  with 42703 — so `items` is null, `items ?? []` is empty, and **every Sales
  Order would have gone into the account book with no lines at all.** #1855
  describes this state as "every line is new ... correct-but-degraded".
- **`enqueuePoCreate` and `composePoState` select `creditor_code`,
  `creditor_name`, `agent` and `ref` from `scm.purchase_orders`**, which has none
  of them (it is supplier-keyed). Same 42703, and both functions `return false`
  inside their own `try/catch`: PO create and PO edit are a silent no-op.
- **`makeItemCodeResolver` is never called** by anything but its own unit test,
  so every `ItemCode` on the wire is the raw ERP code, which AutoCount does not
  have.
- **A sofa goes over as one AutoCount line per compartment.** The ERP stores a
  sold sofa as N rows sharing `variants.buildKey`; `toDetails` is a 1:1 map; the
  resolver points all N at the SAME AutoCount sofa code. One sofa sold would
  book qty N and take N off AutoCount's stock.

The unit tests in #1855 pass because their fake PostgREST does not know the
schema — it returns whatever the fixture holds, whatever columns you ask for.

**Fix** — **Two of the thirteen are fixed, in #1855, and struck off the
register: D11 and D13** — the two above that are plain bugs rather than
decisions (the entry above this one carries them). **The other eleven stand.**
Each needs a decision that is not a test author's to make, and the mechanism is
off. What this PR ships is the means to see them: a contract test that reads
`AcSyncService.cs` at build time and extracts the keys it actually parses, a
fake PostgREST that enforces `scm`'s real column lists, and a divergence
register that fails if a fourteenth appears AND fails if one of these is fixed
without being struck off. Plus `backend/scripts/ac-trial-dry-run.mjs`, which
posts the same contract at a TEST book behind four gates and never runs by
default.

**The class, for next time** — a fake database that accepts any column name will
green-light a query against a table that does not exist. If a test double stands
in for a schema, give it the schema.

**Ref** — 2026-08-10, PR test/ac-writeback-trial. Findings against #1855
(unmerged); register in `docs/modules/autocount-writeback.md` section 11.
