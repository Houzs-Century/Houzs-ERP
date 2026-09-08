## Every ruling the owner gives LOCKS the order he just ruled on [high]

<!-- status: open -->

<!-- area: AutoCount sync + write-back -->

**白话.** 有些沙发的件数是老板看图定下来的。图和账本的字不一样时以图为准 —— 所以
ERP **本来就应该**跟账本的字不同。可是对账系统不知道有这回事：它拿 ERP 去比账本的
字，看到不同，就判这张单「不对」，锁住不给人改。**结果就是：老板每答一题，那张单
就被锁一次。** 今天早上 `HC-SO-013475` 有客人在等，他看图判了 `1+1+1`，我们改好了
—— 晚上同一张单被锁上，理由正是他自己给的那个答案。他的话：
「SO13475 我不是给你答案了吗？为什么你还在纠结？」**他答得越多，锁得越多。**

**Symptom.** Verdict run `34220621512`, the evening of 2026-09-08, after the
correctness lock went live (`scm.migrated_so_lock = verdict:1`, 19:32):

```
SO-013475 DtlKey 924983 (ERP HC-SO-013475 8030-1A(LHF)):
  AutoCount "2A(LHF)+1A(RHF)" vs ERP "1A(LHF)+1A(RHF)+1NA"
  — MISSING 2A(LHF) | EXTRA 1A(LHF), 1NA
LOCKED HC-SO-013475 (SO-013475) — sofa compartments
```

That is the order the owner had unblocked that morning, shut by the ERP holding
the answer he gave. `docs/bugs/0714` had already measured the class — five of
eight compartment differences on run `34212598908` were documents he had ruled
on — and recorded it as a REPORTING problem, deliberately not fixed. The lock
turned the same mechanism into a document nobody can edit, which is a different
severity, and it gets worse with every ruling he gives.

**Root cause (traced).** `lib/variant-reconcile.mjs` compares the ERP's
compartment multiset against the pieces decoded from the account book's Desc2,
and had **no input for a per-document override** — so a build the owner
deliberately set against the book's text could only come out `DIFFER`.
`lib/variant-report.mjs` then called `VERDICT.record(..., "sofa compartments",
...)`, which is a member of `LOCKING_AXES` in `lib/so-verdict-derive.mjs`, so the
document's row went out with `clean: false` and the migrated-SO guard shut it.

The rulings were not lost — they are rows in
`backend/scripts/data/sofa-compartment-corrections-2026-08.json` and
`-2026-09.json`, which is what `apply-sofa-compartment-corrections.mjs` WRITES
the builds from. `check-ac-erp-reconcile.mjs` simply never opened them. Measured
on this branch: 54 builds across 66 documents, `HC-SO-013475` among them with
`pieces: ["1A(LHF)","1NA","1A(RHF)"]` — the owner's answer, already committed,
sitting one `readFileSync` away from the checker that was locking the order for
disagreeing with it.

**Fix.** The reconcile reads the same rows the applier writes from, so the two
cannot disagree about what he ruled.

- `backend/scripts/lib/sofa-ruling-index.mjs` (new) indexes the correction rows
  by document and resolves ONE build through `desc2Contains` — the same
  normalising matcher the applier uses, so a needle that reaches a build when it
  is written cannot fail to reach it when it is checked. Two rulings reaching one
  build are REFUSED, never chosen between.
- `applyCompartmentRuling` in `lib/variant-reconcile.mjs` adds two verdicts.
  `RULED` — the ERP holds exactly what he ruled; not a difference, and it goes
  down the NOTE channel, which never touches `clean`. `RULING_LOST` — a ruling
  exists and the ERP does NOT hold it; that locks, on its own axis (`sofa build
  differs from the owner ruling`), because it means his decision was overwritten
  or never applied and it needs HIM, not a data fix.

**A ruling is a CHECK, not a blank cheque.** The exemption is not "ignore this
document", it is "this document must equal THIS": the ERP is asserted against his
stated pieces on every run, so a later edit that moves the build off his answer
stops being excused and is reported LOUDER than before.

**And it excuses one AXIS.** Compartments are his; the price, the quantity, the
line count and the colour on the same document are the book's and are compared
exactly as before. `tests/sofaRulingIndex.test.mjs` takes a ruled document,
injects a money difference through the real recorder, and asserts it is still not
`clean`; `tests/variantReport.test.mjs` puts a colour difference on a ruled sofa
line and asserts it still locks.

**Nothing is suppressed silently.** `RULED` is its own column in the variants
table, its own named list naming his pieces and the file the ruling lives in, and
its own row in the owner's report under "what this verdict excluded, and under
whose ruling". A suppression the reader cannot see is a suppression nobody
re-checks (`docs/bugs/0668`).

**Proved RED on the unfixed tree.** `tests/variantReport.test.mjs` carries the
control: the SAME three ERP rows with no ruling resolver report `DIFFER` and lock
on `sofa compartments`; with the ruling they report `RULED` and lock nothing.
The doc/data drift test was run red on purpose — a document added to
`docs/sofa-compartment-owner-rulings-2026-09-08.md` with no entry in the
corrections JSON fails with `expected [ 'HC-SO-099999' ] to deeply equal []`.

**Where the authority lives, and why it is not the prose.**
`docs/sofa-compartment-owner-rulings-2026-09-08.md` quotes his words and is
written for people — its table is the slip's shorthand (`1AL + 2AR + 1BR`), not
ERP piece codes. The machine authority is the corrections JSON, one row per
ruling. `tests/sofaRulingIndex.test.mjs` asserts every document ruled on in the
prose has an entry in the data, so a ruling cannot reach the doc and stop there.
What it deliberately does NOT do is compare the PIECES: translating his shorthand
is a judgement about a drawing, not a string operation. The pieces are checked
the only way they can be — against the ERP, at run time.

**Ref.** `fix/verdict-sees-rulings`, 2026-09-08. Status stays `open` until the
reconcile has been re-run with `publish_verdict=true` and the new open/locked
split recorded here.
