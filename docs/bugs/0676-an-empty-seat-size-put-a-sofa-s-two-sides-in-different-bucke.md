## An empty seat size put a sofa's two sides in different buckets so no dedication could ever be forced [medium]

**Symptom.** HC-SO-012277 was one of the three sofa builds left after the
2026-09-07 round took the chain audit's `piece multiset MISMATCH` from 29 to 3.
`repair-po-so-item-dedication.mjs` refused it, and the refusal did not look like
the others: it was not "N purchase lines and M sales lines could pair here", it
was that no bucket existed at all.

**Root cause (traced).** `lib/po-so-dedication-plan.mjs` buckets a line by
`(item_code, seat)`, and `seat` is `variants.seatHeight`. On this build the
seat was written on ONE row and absent from the rest:

- the document's own Desc2 reads `28 inch per seat`;
- the sales order's LEAD line already carried `seatHeight=28`;
- the purchase lines carried no `seatHeight` at all.

So `8051-1A(LHF) @28"` and `8051-1A(LHF) @(no seat)` are two different buckets
by construction, the purchase lines could never meet the sales lines they were
bought for, and the refusal was permanent rather than a pause. That matters for
the same reason as `docs/bugs/0674-two-identical-sofa-compartments-were-refused-a-dedication-so.md`:
a sofa line is hard-bound (`isHardBoundLine`,
`backend/src/scm/lib/so-stock-allocation.ts`), so a sales line with no
dedication can never read READY however many pieces the factory delivers.

The seat was blank because the correction that wrote this build said so. Its
own `why` in `backend/scripts/data/sofa-compartment-corrections-2026-09.json`
read *"no seat size written anywhere, so seat is left empty"* — which is the
right instinct (never invent a seat size) applied to the wrong evidence: the
size IS written, twice, in the book's own Desc2 and on the line the importer
already decoded. The correction file is what
`apply-sofa-compartment-corrections.mjs` writes from, so a stale reading there
does not sit still — it re-asserts itself on the next apply.

**Fix.** The owner read it and ruled `就是 28 寸` (2026-09-08). The entry now
carries `"seat": "28"`, so the seat is written into `variants.seatHeight` on
**both** documents — `HC-SO-012277` and `HC-PO-010040` — which the entry has
named since 2026-09-07. Both sides then land in the same bucket and the
existing planner pairs them; nothing in the planner changed. The entry's `why`
records the retired reading rather than deleting it, so the "left empty" note
cannot come back as evidence.

Two read-only probes ship with it, because the same shape of refusal had twice
been reported without its cause:

- `backend/scripts/probe-dedication-bucket-diff.mjs` prints, per bucket the
  planner could not settle, a COLUMN-BY-COLUMN diff of both sides and marks the
  columns that differ. It reads through the new
  `backend/scripts/lib/po-so-dedication-read.mjs`, which
  `repair-po-so-item-dedication.mjs` now imports too — the SELECT, the seat
  derivation and the fingerprint moved there unchanged, so a column the probe
  names is a column the planner actually compared. Eight tests in
  `backend/scripts/lib/po-so-dedication-read.test.mjs`, including a pinned
  literal of the fingerprint string so the extraction cannot silently change
  what "indistinguishable" means.
- `backend/scripts/probe-unordered-sold-lines.mjs` answers the other question
  the night raised — how many hard-bound lines are sold, released for
  purchasing, and never ordered at all.

**Ref.** fix/sofa-last-three, 2026-09-08.
