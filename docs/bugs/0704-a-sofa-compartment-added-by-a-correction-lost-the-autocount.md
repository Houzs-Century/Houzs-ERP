## A sofa compartment added by a correction lost the AutoCount line key its build states [high]

<!-- area: AutoCount sync + write-back -->

**白话.** 我们帮沙发改件数的时候，如果要「加」一件，那一行会漏掉一个看不见的编号
——就是我们用来对回账本那一行的编号。少了它，整张单在系统眼里就「认不出自己是账本
的哪一行」：以后有人要在 ERP 改这张单，会被挡下来说「不知道 AutoCount 有哪几行」；
而我们每天在跑的对账，也会**看不到那一件**，把三件的沙发读成两件。

**Symptom.** `HC-SO-013475` was corrected on 2026-09-08 from `2A(LHF)+1A(RHF)`
to `1A(LHF)+1NA+1A(RHF)` — the drawing the account book carries, ruled by the
owner. The apply run (`34199823824`) verified the write on a fresh connection:

```
VERIFY — re-reading 1 document(s) on a fresh connection
  OK  HC-SO-013475  1A(LHF)+1A(RHF)+1NA  money 0/0
```

Five minutes later the go-live reconcile (`34199937397`) read the same document
as holding **two** compartments, not three:

```
SO-013475 DtlKey 924983 (ERP HC-SO-013475 8030-1A(LHF)):
  AutoCount "2A(LHF)+1A(RHF)" vs ERP "1A(LHF)+1A(RHF)" — MISSING 2A(LHF) | EXTRA 1A(LHF)
```

Two readers of the same three rows disagreed about how many there are. That is
the finding, and bridging it — "the reconcile must lag" — would have hidden it.

**Root cause (traced).** The reconcile compares a sofa's compartments **per
AutoCount DtlKey**, so it only ever sees rows that carry one. The `1NA` row does
not: `apply-sofa-compartment-corrections.mjs` builds its two INSERT statements by
naming columns one at a time, and neither statement named `linked_ac_dtlkey`
(the SO branch at `:393`, the PO branch at `:377` before this change). Every
compartment that script has ever ADDED, in every round since 2026-08, landed
keyless beside siblings that carry the key.

This is the third column to be lost the same way in the same two statements, and
the file's own comments record the previous two — `warehouse_id`, which made
seven lines PENDING forever in the 2026-08-11 run, and `description` /
`delivery_date`, which the reconcile then read as blank.

**The consequence is bigger than one invisible row, and the code says so
itself** — read, not assumed:

- `src/scm/lib/autocount-line-keys.ts:155` — *"Every ERP row behind this
  AutoCount line gets the SAME key. For a sofa that is the build's
  compartments; composeEdit later accepts the build only when all of them still
  agree on it."*
- `src/scm/lib/autocount-outbox.ts:244` — *"every compartment must carry the
  same DtlKey or the build has no line identity at all (composeEdit then
  refuses, loudly)."*
- `src/scm/lib/autocount-relink-lines.ts:8` — *"The ERP row stays keyless, and
  every LATER edit of that document is refused whole by composeEdit's keyless
  guard. The operator reads 'The ERP cannot tell which lines AutoCount already
  has'."*

So a build with one keyless compartment does not merely lack a key on that row:
the whole document loses its line identity. On top of that it joins the
UNJUDGEABLE bucket in `probe-cutover-so-do-lines`' section B, where
`topup-ac-so-lines.mjs` and the PO/SO link repairs then correctly refuse to
touch it.

**Fix.** Two halves, because the code fix does nothing for the rows already
written.

- **The write path.** Both INSERTs now carry `i.linked_ac_dtlkey` from the row
  the compartment is built from. It is a copy of what the sibling already
  states, never a derivation.
- **The rows already added.** `repair-sofa-added-compartment-line-key.mjs` +
  `.github/workflows/repair-sofa-added-compartment-line-key.yml`. Plan by
  default; the apply path needs `CONFIRM="I HAVE REVIEWED THE DRY-RUN"` and the
  workflow passes it. Four gates, each a refusal rather than a fallback: the row
  is a keyless sofa compartment on an IMPORTED document; its siblings agree on
  exactly ONE key; the book confirms that key is a line of THAT document; and
  the book's Desc2 for the key is the row's own text, compared through
  `lib/sofa-desc2-match.mjs`. A wrong key is worse than a missing one — a
  missing key is refused loudly by `composeEdit`, a wrong one silently edits a
  different line in a live account book — so nothing is inferred.
- Verification re-derives the BUILDS on a fresh connection and asserts each
  touched build now carries exactly one key and that the key is still the book's
  line for that document. A row count would have been equally true of keys
  written onto builds that now disagree with themselves.

**No AutoCount call is made and no outbox row is written.** The owner ruled the
write-back out of scope on 2026-09-08 (「写回autocount的你不需要理了」); this is
the ERP's own record of which book line each of its rows belongs to.

**No test pins the INSERT, and that is stated rather than hidden.** The
statement is raw SQL against a live schema in a one-shot ops script, which the
suite does not stand up. What replaces a test here is the repair's own
verification — it re-derives every build and would report the missing key again
on the next run.

**Ref.** `fix/staff-reported-flow`, 2026-09-08. Apply run `34199823824`;
reconcile runs `34199669066` (before) and `34199937397` (after), the second
carrying the misreading quoted above.
