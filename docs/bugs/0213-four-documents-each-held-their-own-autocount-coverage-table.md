## Four documents each held their own AutoCount coverage table, and they contradicted each other [high]

<!-- area: Repo tooling: tests, ratchets, generators -->

**Symptom.** The owner asked what actually reaches AutoCount. He was given two
answers in one session, in opposite directions, both wrong, each read off a
different document. First: *"the four conversions have never run"* — false.
Then, after he said *"我记得是有的"*: `so-to-do` HAS run, `DO-011260`. He then
gave the instruction this entry exists for: *"过期的文件也是要删掉或者存起,
不要有这些问题. 然后去查看源代码, 不要查看这些文件了."*

**Root cause, traced by grepping for the claim rather than by reading any one
document.** Four files each carried a hand-written matrix of which operations
work, and no two agreed:

| file | said |
|---|---|
| `docs/archive/autocount-sync-coverage-2026-08-11.md` | "No cell anywhere is PROVEN", every EDIT cell `NOTHING` |
| `docs/autocount-migration-record.md` | "Five cells are PROVEN as of 2026-08-12"; PO create `REFUSED — FK_PO_PurchaseAgent` |
| `docs/autocount-service-deploy.md` | "`/create-po`, `/so-to-do` and `/po-to-gr` have never run end to end" |
| `docs/archive/AUTOCOUNT-GOLIVE-HANDOFF-2026-08-12.md` | "PROVEN \| ... so-to-do (**DO-011260**, cancelled)" |

`autocount-migration-record.md` had already noticed — it contains the sentence
"Both cannot be true, and it" — and left the two copies standing. Every one of
the four was accurate the day it was written. Three then rotted, in different
directions, because the thing they describe moves and prose does not.

`AcSyncService.cs` carried a fifth version in a comment: "DO and IV are PROVEN
with it, DO-011260 / DO-011262". Both cited numbers are DELIVERY ORDER numbers;
the IV half had nothing behind it and `/do-to-iv` has still never run.

**Fix.** One table, and three of its four columns are read out of SOURCE on
every run — so they cannot rot:

| column | derived from |
|---|---|
| operation, route | `AC_ROUTE` in `src/services/autocount-writeback.ts` |
| service implements it | the `case "/x":` labels in `AcSyncService.cs` |
| ERP triggers it from | the enqueue call sites under `src/scm/routes` + `src/scm/lib` |
| run against the live book | `backend/scripts/data/ac-live-proof.json` — the one thing no source tree can answer |

`backend/scripts/gen-autocount-coverage.mjs` writes
`docs/generated/autocount-coverage.md`; `audit:ac-coverage` gates it in `ci.yml`.
The generator self-tests every pattern and EXITS 2 rather than emitting a table
if a match count falls below the floor — a verdict computed over nothing must
not read as a pass.

An entry in the proof JSON is admissible only with a document number or a
re-runnable query. The two stale files are archived with banners rather than
deleted, since one holds the only record of `DO-011260`; the two live ones keep
their content and lose their matrix.

**The trap worth keeping.** The queue is not the whole record. `so-to-do` was
driven directly on the host by `qa-convert.ps1`, so `scm.autocount_outbox` has
no row for it — which is exactly how reading only the queue produced the first
wrong answer. The generated file says so in prose, next to the column.

**Ref.** 2026-08-15, PR #2230.
