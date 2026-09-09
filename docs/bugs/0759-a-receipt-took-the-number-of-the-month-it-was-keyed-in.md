## A receipt took the number of the month it was keyed in, not the month it is dated [medium]

<!-- area: Accounting + GL -->
<!-- status: open -->

**Symptom.** Owner, 2026-09-09, reconciling a bank statement and reading the
entry beside the movement: `2990-OR-2609-001` — a September number — on a
journal dated **2026-02-07**. His own account of it: 这个是因为之前receipt 没有
办法选月份，后来才发现.

**Root cause.** The general receipt minted its number from **today** rather than
from the receipt's own date. Backdating a receipt therefore produced a number
whose month names the day it was keyed in.

**Already fixed in code, on 2026-09-08.**
`backend/src/scm/routes/receipts.ts` now mints from the receipt's own date:

```js
const receiptDate = dateOrNull(body.receiptDate) ?? todayMyt();
const receiptNumber = await mintMonthlyDocNo(
  sb, 'acc_receipts', 'receipt_number',
  `${companyDocPrefix(c)}OR-${docMonthTag(receiptDate)}`);
```

The production data dates the fix without being asked to. Read on prod
(`anogrigyjbduyzclzjgn`) on 2026-09-09:

| created | count | number month vs receipt date |
|---|---|---|
| 2026-09-07 | 4 | all `2609`, dates Feb–May — **disagree** |
| 2026-09-08 | 3 | `2607` / `2606` / `2606` — **agree** |

**What was left behind.** Four papers, and they are the whole population:

```
2990-OR-2609-001  dated 2026-02-07
2990-OR-2609-002  dated 2026-03-12
2990-OR-2609-003  dated 2026-04-30
2990-OR-2609-004  dated 2026-05-07
```

None was ever issued to anybody. No money is wrong: every figure, every journal
and every balance is correct — only the month printed inside the number is not.

**Fix.** The owner's ruling, asked whether to leave them or renumber: **重编**.
`backend/scripts/repair-renumber-receipt-months.mjs` +
`.github/workflows/repair-renumber-receipt-months.yml` move each number into the
month its own date falls in — `OR-2602-001`, `OR-2603-001`, `OR-2604-001`,
`OR-2605-001`.

**This breaks the house number rule on purpose, once.** "A number always points
at the same document" is what an audit relies on. These four were never issued
and carry a month that is simply wrong. The half of the rule that still holds:
the four numbers they vacate are **never re-used** — the `2609` counter in
`scm.doc_number_counters` is left where it is (`next_n = 5`), so the gap is
permanent.

**What moves is more than the receipt, and this is the part worth reading.**
Each of the four carries **three** journal entries — the original (posted, since
reversed), its `RCT_REVERSAL` contra, and the re-dated `RCT` that stands today
— because a general receipt's edit reverses and re-posts rather than rewriting.
Counted on prod, the four numbers appear in **12** `source_doc_no` values and
**12** narrations. A rename that moved only the live journal would leave the
contra pair pointing at a number that no longer exists.

**Journal NUMBERS never move.** Anything keyed on `je_no` is untouched —
including the bank-statement movement matched to `2990-JE-2602-0002` earlier the
same day.

**How it is made safe.** Two-phase rename through a `-T##` temporary so
`UNIQUE (company_id, receipt_number)` is never crossed mid-way; one transaction;
verified on a FRESH connection for three things — no number still disagreeing
with its date, no receipt journal pointing at a receipt that does not exist, no
temporary left behind. Convergent: a second run reports nothing to do. `plan` is
the default and writes nothing.

**Verified against.** Rehearsed on staging (`minnapsemfzjmtvnnvdd`): prod's exact
shape rebuilt there — one wrong-month receipt carrying all three journal kinds —
the two-phase rename run over it, then asserted 1 receipt renamed, 3
`source_doc_no` moved, 3 narrations rewritten, 0 references to the old or
temporary number left. The rehearsal deleted its own rows; staging is back to 0
receipts.

**UNTESTED: the workflow itself.** A new `workflow_dispatch` cannot be
dispatched before it is on the default branch (404). The prod run is `plan`
first — it writes nothing and prints which four papers move and which twelve
journals follow — then `apply`.

**Status stays `open` until that apply run is green.** The tag is an assertion,
not a proof; move it to `fixed` with the run id when the four numbers are in
their own months on prod.

**Ref.** PR #3453. Repair: `backend/scripts/repair-renumber-receipt-months.mjs`.
The code fix it cleans up after: `backend/src/scm/routes/receipts.ts`
(`docMonthTag(receiptDate)`, 2026-09-08).
