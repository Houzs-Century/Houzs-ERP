## Seven names for one date, and four of them could not be retired — the Processing Date is a purchasing release, not a production date [med]

<!-- area: Sales orders + pricing -->

**Symptom.** Owner, 2026-08-18: *"全部你都是要统一掉的，不要那么多个"*. One fact —
the SO's Processing Date — answered to **seven** names, and every discussion about
it had produced a new bug for months. In the same message he corrected what the
date MEANS, and the correction contradicts most of the comments in this repo.

**What the date actually is.** *"因为我们有时候开单，未必是要直接 Processing 这张
单的。所以 Processing Date 就代表这张单可以安排订货了，然后过了一天我们才会落下来，
然后采购才会去订货"* — **the date this order is RELEASED FOR PURCHASING TO ORDER
GOODS**. Raising an order is not acting on it. And: *"我们都没有排产的，我们都不是
Production"* — **there is no production scheduling in this business**. Every
comment calling this a "go-to-production" date or reasoning about a "factory
queue" described a company that does not exist. Twenty-three of them, across
thirteen files and two doc sections, now say what he said. **Two were user-facing refusal
strings** — an operator was being told to *"set the date the factory starts"* and
warned about *"a wrong factory queue"*.

**The ~1 day lag is NOT implemented, and is now recorded as not implemented.**
MRP does not read this date to decide when to order at all: it derives
`orderByDate = delivery date − category lead days` and only DISPLAYS the
Processing Date. `routes/mrp.ts:193` has commented the field as *"(drives when to
order)"* the whole time — a comment agreeing with the owner while the code below
it ignored the field.

**THE FINDING: four of the five retirable names are blocked by something OUTSIDE
this repository, and not one of those blocks is visible from the source.**

| name | verdict |
|---|---|
| `processing_date` | **KEEP** — the column |
| `processingDate` | **KEEP** — the payload key |
| `proceeded_at` | dying; #2396 took its last reachable reader (that work is on its own branch) |
| `target_date` | **LIVE. Retirement attempted and REVERTED the same day** |
| `internal_expected_dd` | **BLOCKED** — 2990's mirror outbox |
| `internalExpectedDd` | **BLOCKED** — amendment jsonb parked before the rename |
| `PDate` | **NOT OURS** — AutoCount's own UDF |

**`target_date`: the census was right about the source and wrong about the
world.** Every signal inside the repo said dead field. PR #140 dropped it from
the SO form (*"targetDate → replaced by Processing + Delivery Date"*);
`grep -rn targetDate frontend/src native e2e` returns **zero** — no client here
sends the key. It was nevertheless accepted on four write paths, selected into
three read shapes and typed on two frontend rows. So the sweep removed the name
from all eight sites.

Then the probe read production. `probe-rename-preconditions.mjs` section F:
**46 of 2826 SO rows carry a `target_date`, and ALL 46 were CREATED inside the
last 90 days** — newest **6.75 days** old, oldest 67.88. A row *born* with the
value was given it at create; the ERP has not written it at create since #140;
therefore **the POS handover is still sending it, now**. And `routes/reports.ts`
selects it into the sales-report export, so it has a live reader too.

**All eight removals were reverted the same day** — the eight files are now
byte-identical to `main`. Shipping them would have been the exact defect the
Processing-Date work exists to end: the POS keeps POSTing `targetDate`, the
create returns **201**, and the value vanishes with no error anywhere. *"No
writer in this repo" is not "no writer."* The source was complete and honest and
simply did not contain the producer.

**The first version of the probe would have said the same thing for the wrong
reason, and that was caught too.** It scored "still written" off
`coalesce(updated_at, created_at)` — but `updated_at` moves on ANY header edit,
so an order created in 2025 and re-saved yesterday for an unrelated remark counts
as a fresh write. `created_at` is the discriminator, and only because of a fact
about this column specifically: the write it used to do was at CREATE. Both
numbers now print, the weak one labelled weak.

**`PDate` is the name that must SURVIVE, and the owner asked which one it was.**
AutoCount's own UDF (`SO.UDF_PDate`) on AutoCount's document. AutoCount matches
UDFs by NAME: rename it and the connector drops an unknown key, the document
posts **200 without it**, and every Processing Date silently stops reaching the
account book. Both write sites read it from `SO_PROCESSING_DATE_AC_UDF` and carry
the warning.

**The two aliases that STAY.** Each is a name a **queue outside this deploy**
still carries, so removing it does not stop anything saying it — it only makes
the value vanish, quietly. `internal_expected_dd`: `applyMap` filters an inbound
mirror row against the destination table's columns and DROPS what it does not
recognise — no error, upsert returns **200**, company 2's date stops arriving.
`internalExpectedDd`: frozen inside `so_amendments.header_changes` written days
before it is replayed; `applySoAmendment` `continue`s past an unknown key, so the
amendment approves, audits, marks SO_APPROVED and never writes the date. Each
constant now carries the EXACT precondition, and section F *runs* the two
statements rather than describing them.

**The legacy native Sales module: same concept, staged.** The owner ruled
*"全部我们只有一个 Processing Date"*, overruling an earlier census. What differs
is the ROW, not the concept. The replay trap is respected: `applyEntryPatch`
builds `SET ${k} = ?` from an allowlist and one caller replays a payload parked
days earlier, so a dropped key is silently ignored on approve. **Stage 1 ships**
— `canonicaliseSalesEntryBody` folds the canonical `processingDate` onto the
stored key on all four roads in (create, direct PATCH, change-request QUEUE so
newly parked payloads are already canonical, and the approve replay), reusing the
SCM seam so the two modules cannot drift on "the body carries both spellings".
Nothing was removed. **Stage 2 is not shipped**; its precondition is a D1 count
this Postgres probe cannot reach, and section F **says so** rather than skipping
it.

**The guard, and the proof it is not vacuous.**
`backend/src/scm/shared/so-processing-date-names.test.ts` reads the real source
via `?raw` and now protects the DOORS rather than their absence — it fails if a
`target_date` write path is closed again, if a sweep deletes `PDate` or either
alias, or if the factory framing returns. Four regressions planted:

| planted | `tsc` | the guard |
|---|---|---|
| the `target_date` create accept removed (the near-miss, replayed) | **exit 0** | FAILS |
| `udf.processingDate = pdate` replacing the AutoCount UDF | **exit 0** | FAILS |
| `SO_PROCESSING_DATE_LEGACY_COLUMNS` emptied | **exit 0** | FAILS |
| *"may this order start production on the factory"* | **exit 0** | FAILS |

The compiler is blind to all four: every failure in this family is a name inside
a string. **It also caught a real one.** PR #2383 landed between the sweep and
the merge and brought three fresh *"the day the factory starts"* comments into a
file the guard already watched — and did not fire, because the patterns matched
the three phrasings that happened to exist rather than the idea. Widened to match
the idea; `IN_PRODUCTION` deliberately excluded, since it is a real status value
and a guard that fails on a live status name is a guard someone deletes.

**Deferred, named.** The `target_date` column drop (blocked on the POS). Both
alias retirements (each blocked on a queue outside this deploy). Stage 2 of the
native Sales module (blocked on a D1 count). And the rescheduling split the owner
raised in the same message — the board and PO coverage plan on the AMENDED
delivery date while MRP ranks against the ORIGINAL, two screens with two answers
and nobody told — which is a different fact from the naming and is not touched
here.
