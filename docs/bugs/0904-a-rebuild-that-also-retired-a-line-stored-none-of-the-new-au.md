## A rebuild that also retired a line stored none of the new AutoCount line keys, so every later edit named lines the book no longer had [high]

<!-- area: AutoCount sync + write-back -->

**Symptom.** The AutoCount outbox health check of 2026-09-14 (run 34850891130)
listed HC-SO-013209 and HC-SO-001463, each edit failing six attempts with
*"line 895067 not found on SO-013209"* / *"line 928086 not found on
SO-001463"*. Read-only in the book the same day, neither key exists anywhere:
SO-013209 holds 929863..929868 and SO-001463 holds 929536..929538, while the
ERP rows still carry 895064..895071 and 928086..928089.

**Root cause (traced).** Both documents were REBUILT: HC-SO-001463 at
2026-09-11 11:31:21Z, HC-SO-013209 at 2026-09-13 02:26:04Z and 02:26:06Z. A
rebuild clears the book's lines, lays the ERP's down, and reissues every key.
The drain then stores the new keys through `newLineTargetOf`
(`backend/src/scm/lib/autocount-line-keys.ts`, 0621), which pairs the book's
lines with the payload's lines.

Each of these rebuilds also carried a line the ERP had deleted, as
`Retire: true` with no `ErpLineIds`: TRANSPORTATION CHARGES on SO-001463;
AKEMI ULTIMATE MATT (Q), then AERO-MP (Q), on SO-013209. The host never lays a
retired line down on a rebuild (`if (rebuild && Bool(it, "Retire")) continue;`
in `AcSyncService.cs`). But `newLineTargetOf` counted it as a line to store,
found no ids on it, and returned null for the whole batch
("A declared-new line with no ids cannot be stored back"). Nothing was stored,
nothing was recorded on the row, and the next keyed edit named dead keys.

Measured read-only: of the 72 rebuild edits sent since 2026-09-07, 5 carried a
retired line. Those were HC-SO-001463, HC-SO-010741, HC-SO-012144 and
HC-SO-013209 (twice). SO-010741 and SO-012144 hold live keys again today (their
later edits re-keyed them); the other two did not.

**Fix.** `newLineTargetOf` skips a `Retire: true` line on a rebuild, the same
line the host skips. Pinned in
`backend/src/scm/lib/autocount-line-keys.rebuild-retire.test.ts`, using
SO-001463's payload. The test is RED on the unfixed tree
(`AssertionError: expected null not to be null`) and green after. Two controls
still hold: a laid-down line without ids still refuses the batch, and an
ordinary edit still names nothing new.

**Repair.** HC-SO-013209 and HC-SO-001463 were rebuilt again through
*rebuild-ac-document* from their current state. That state has no retired line,
so the unfixed drain stores the keys. The dry runs (34853802005, 34853806692)
reported 6 and 3 lines with no blank item code. The book showed nothing
transferred from either document, and no purchase line holding them.

**Ref.** fix/ac-rebuild-retire-keys, 2026-09-14.
