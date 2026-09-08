## The reconcile could not see the owner's own sofa rulings, so his answers locked the orders they fixed [high]

<!-- area: AutoCount sync + write-back -->

**白话.** 有些沙发是老板亲自看图定下件数的 —— 账本的字和图不一样时以图为准，所以
ERP **本来就应该**和账本的字不同。对账程式不知道有这回事，把这些单一律当成「还没
处理的差异」。2026-09-08 单据锁改成「对得上账本才开」之后，这件事就不只是报告难看
了：**146 张锁住的单里，有 25 张是他自己已经批过的**。他批了，我们照批的做了，然后
系统因为「和账本不一样」把单锁起来，业务员还是不能改。现在对账会去读他的批示档，
**看 ERP 那一行有没有真的照批示做**；照做了就标 `ruled` 不算差异，没照做就照旧锁着。

**Symptom.** Reconcile run `34220621512` (2026-09-08 11:25 UTC, production,
company 1) published the per-document verdict the migrated-sales-order lock
reads: **2,736 of 2,882 open, 146 stay locked**. Every one of the 146 is a sofa:

| axis printed on the locked document | documents |
| --- | --- |
| `sofa build not verifiable` | 110 |
| `sofa compartments` | 35 |
| `specials` (always alongside another axis) | 1 |
| `a book line we do not have` | 1 |

**25 of those 146 documents are ones the owner has already ruled on** — his
answer is in `backend/scripts/data/sofa-compartment-corrections-2026-08.json` or
`-2026-09.json`, and `apply-sofa-compartment-corrections.mjs` has written it
onto the line. Counted by intersecting the run's own LOCKED list with the two
corrections files: 21 of them locked on `sofa build not verifiable`, 4 on
`sofa compartments`. (A 5th ruled document, `HC-SO-011099`, is in the same class;
it appears under `sofa compartments` too.)

**Root cause (traced).** `check-ac-erp-reconcile.mjs` never opened those files.
`lib/variant-reconcile.mjs` compares the decoded AutoCount Desc2 against the ERP
multiset and had no input for a per-document override, so a build the owner
deliberately set AGAINST the book's text could only come out as:

- `DIFFER` — the book states a build, the ERP states his ruling, and they are
  not the same. That is the ruling working.
- `UNREADABLE` — the book states a colour and a factory instruction and nothing
  about the shape, so the compartment axis is unanswerable no matter what the
  ERP holds. That is the majority case here, and it is the one
  `docs/bugs/0714-the-reconcile-reports-a-sofa-the-owner-has-already-ruled-on.md`
  did not reach: 0714 measured the DIFFER arm (5 of 8 PROCEEDED differences were
  rulings) and named the fix; the UNREADABLE arm is 21 of the 25 here.

Both LOCK (`lib/so-verdict-derive.mjs`, `LOCKING_AXES`). So the owner's own
decision was the reason the order stayed shut.

**What was RULED OUT — the decoder, and the parser fix.** The obvious theory is
that the 110 `sofa build not verifiable` documents are waiting on the colour-label
parser fix of `#3257`. They are not. **`#3257` merged at 11:07:46Z; the verdict
run's `headSha` `3e3385e5` has that merge commit `2dc0d7dd` as an ancestor**
(`git merge-base --is-ancestor`), so the 110 were counted **after** it landed.
The run's own unread census says why they are unread, and it is not the parser:

> `113 (37 proceeded, 76 not) keyed, but the book's build text cannot be decoded
> into pieces` — `=> 0 can be made comparable WITHOUT the owner (stamp the key)`

Measured independently, offline, over the whole committed book snapshot
(`data/ac-reconcile-truth.json.gz`, exported 2026-09-08T00:03:44Z) with today's
`parse-sofa.mjs`: of **2,160** sales-order sofa lines the binding calls
`category=SOFA`, **18** carry no Desc2 at all, **1,637** decode to a build, and
**505 do not**. Reading the 60 the run printed, the book's text on most of them
is a colour and a factory instruction — `"Col : tbc  Nilon bottom"`,
`"back rest change to 8030  Nilon bottom"`, `"tbc  wrap bottom to Nilon"` — with
no statement of shape at all. **The drawing is genuinely the only source for
those, exactly as the census says.** What the census could not know is that for
25 of them the owner has ALREADY drawn the conclusion and we already wrote it
down.

**Fix.** `backend/scripts/lib/sofa-owner-rulings.mjs` (new) indexes the same
corrections files `apply-sofa-compartment-corrections.mjs` writes from, through
the same loader (`lib/sofa-corrections-source.mjs`), so the writer and the reader
can never disagree about what he ruled. `compareLine` takes a `ruling` and the
compartment axis gains a verdict of its own, **`RULED`**.

Four properties, each with a test:

1. **A ruling is honoured only when the LINE CARRIES IT.** The piece list is
   compared against the ERP's own multiset; a ruling that was never applied — or
   was applied to another document — leaves the multiset different, the branch
   does not fire, and the line stays locked on whatever axis it was locked on.
   A file is not evidence; the row is (CLAUDE.md: *"Evidence is not a setting"*).
   Those lines are also PRINTED, under `RULED BUT NOT CARRIED`, because a ruling
   on the wrong document is worth a human.
2. **`RULED` is never folded into `AGREE`.** 0714 states the reason and this
   obeys it: the ERP really does differ from the book's words, and hiding that
   removes the only signal that would catch a misfiled ruling. It gets its own
   column in the variant table and its own count in the roll-up.
3. **A ruling reaches one BUILD, not one document.** The needle is
   `desc2Match`, matched with `lib/sofa-desc2-match.mjs` — and matched against
   the **BOOK's** Desc2 from the committed snapshot, not against
   `scm.…_items.description2`, which is server-generated on write and can answer
   with our own summary (`docs/bugs/0639`).
4. **Two rulings that reach one line and disagree yield NOTHING.** Same brake
   the desc2 matcher already applies to an ambiguous needle. `_held` builds —
   ones the operator deliberately did not write — are never indexed.

**Proved RED on the unfixed tree.** `origin/main`'s `variant-reconcile.mjs` with
the new tests against it: **3 of the 4 new `0714:` tests fail, 19 of the 22 pass**.
The fourth — *"a ruling the LINE does not carry changes nothing"* — passes before
AND after, which is what makes it a regression guard rather than a restatement of
the fix. `node --test backend/scripts/lib/*.test.mjs` is 187 green after.

**Predicted effect, computed OFFLINE and stated as a prediction.** For the 4+1
documents locked on `sofa compartments` whose ERP side the run printed, the
lookup was run for real against the committed snapshot and the corrections files:
all five find exactly one ruling, its needle matches the book's own text, and the
ERP holds exactly the ruled pieces —

| document | book says | ERP holds | ruling | verdict after |
| --- | --- | --- | --- | --- |
| `HC-SO-010209` | `2A(LHF)+L(RHF)` | `1A(LHF)+1NA+1A(RHF)` | same | `RULED` |
| `HC-SO-013475` | `2A(LHF)+1A(RHF)` | `1A(LHF)+1A(RHF)+1NA` | same | `RULED` |
| `HC-SO-013327` | `1S` | `1A(LHF)+2A(RHF)+1NA` | same | `RULED` |
| `HC-SO-013329` | `1B(LHF)` | `1B(LHF)+CNR+2A(RHF)` | same | `RULED` |
| `HC-SO-011099` | `2S` | `1A(LHF)+1A(RHF)` | same | `RULED` |

The other 20 ruled-and-locked documents are locked on `sofa build not
verifiable`, where the run does not print the ERP side, so whether each one
carries its ruling is **UNKNOWN until the reconcile is re-run**. The measured
answer belongs in the PR, not here.

**What this does NOT do.** It writes nothing. Not one production row moves, no
stock moves, no `linked_ac_dtlkey` is touched — the whole change is what the
reconcile READS before it decides. It also does not repair the sofa lines the
cutover never decomposed (`docs/bugs/0715`); those still hold a bare `-1S`
against a build the book states plainly, and that repair is a write against live
sales orders and its own PR.

**Ref.** `fix/unlock-146-sofas`, 2026-09-08. Evidence: reconcile run
`34220621512` (the 146 and their axes), the offline census over
`ac-reconcile-truth.json.gz`, and `node --test backend/scripts/lib/*.test.mjs`.
Closes `docs/bugs/0714`.
