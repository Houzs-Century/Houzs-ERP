## AutoCount Sync printed the machine's own words as the page's plain language [medium]

<!-- area: AutoCount sync + write-back -->

**Four defects the owner read off the LIVE page on 2026-08-16, hours after
#2326 landed the "no coding words on this screen" rule. Every check that rule
has was GREEN throughout, and that is the finding: they all pin the strings
THIS codebase writes, and three of the four arrived from somewhere else.**

**Symptom.**

| what he read | where it actually came from |
|---|---|
| a held-back invoice: *"AutoCount builds a DO / GRN / Invoice only by transferring a source document's lines (**AddPartialTransferDetail is the SDK's only primitive**), so this document cannot be created in the account book at all…"* | `recordParentlessCreate`'s `last_error`. That identifier had been removed from the page's own copy the same day and came back through the SERVER. |
| a not-accepted delivery order: `Invalid transfer item. \|\| source SO lines as the book holds them: 905348 on SO HC-SO-2608-002 [AK-ULTIMATE MATT (K)] Qty=1.00000000 TransferedQty=0.00000000 Transferable=T docCancelled=F outstanding=1.00000000; 905349 …` | `AcSyncService.cs`'s transfer arm, added that night. The dump is genuinely valuable — it is what refuted the "two sales orders in one array" diagnosis — and it is four lines of the account book on a screen a warehouse clerk opens to ask whether a delivery went out. |
| the **To fix** line under it: *"Put right whatever AutoCount named, in AutoCount, then save the document in the ERP again."* | `AC_FAILED_COPY`. AutoCount named **nothing** — `Invalid transfer item.` identifies no field — and those lines had been measured against the live book that day and were correct on every count the book keeps. The page was sending him to repair something provably not broken. |
| fifteen rows, **six** of them "already sent again, this row is history", `HC-DO-2608-001` and `HC-DO-2608-002` each appearing twice | the outbox is append-only, so every refusal ever put right leaves one of these behind forever, inline and the same size as a live one. |

**Root cause, traced.** Not four bugs — one, wearing four hats. The rule as
written was *"no coding words in the strings this file writes"*
(`frontend/src/lib/autocountOutbox.ts`, and `autocountOutbox.test.ts`'s
`forbidden` list, which asserts over `Object.values(...)` of that file's own
maps). Server text was exempt by construction: `row.reason` was rendered
verbatim into the same opened block as the page's own prose, under a label, and
a label is not a container. Traced by grepping every writer of `last_error` in
`backend/src/scm/lib/autocount-outbox.ts` and every render site of a
server-supplied string on the two surfaces — seven sites, listed in the PR.

**Fix.**

1. **`acWhatWasSaid(row, pageHasItsOwnWords)`** in the shared layer. Nothing the
   server wrote is the page's own voice: it appears only under the label saying
   who wrote it, and the part a reader cannot act on goes behind a second,
   collapsed, labelled disclosure (`AC_TECHNICAL_LABEL`, `TechnicalNote`, both
   surfaces). The split is at `AcSyncService`'s own ` \|\| ` — **a separator the
   writer put there**, so this is splitting a string, not classifying a row — and
   the branch is on WHO spoke. The ERP's whole internal note folds where the page
   already has plain words; AutoCount's own sentence NEVER folds; `unrecognised`
   keeps its quote in view, because there the page has no words and the quote is
   the entire answer.
2. **The headline and the "AutoCount replied" / "AutoCount was not asked"
   distinction are untouched**, on the row, unclicked. He rejected a design with
   the reason behind a click; only the machinery moved.
3. **`acParentlessCreateReason`** moved to `autocount-outbox-status.ts`, beside
   the `no-source-document` needle it has to keep containing, with the SDK name
   gone. `backend/tests/autocountSyncReasonsCatalogue.test.ts` now pins both
   halves. **That alone fixes nothing on his screen** — `scm.autocount_outbox` is
   append-only and `last_error` is never rewritten (the re-queue marker is
   *prepended*, `isRequeuedNote`), so rows already written keep the old sentence
   for good. The render rule is what clears them; the writer fix stops new ones.
4. **`AC_FAILED_COPY.toFix`** covers both cases and, where AutoCount named
   nothing, says so and says who to tell. No code branches on the message — the
   server deliberately does not classify `failed` rows and pattern-matching them
   on the page side would be the third opinion that module exists to prevent.
   Words can hold an honest either/or; a guess dressed as a branch cannot.
5. **`acSplitSuperseded(rows, state)`** folds `requeued` rows under *"N
   superseded rows, kept as a record"*, closed on arrival, on both surfaces —
   except under the **Sent again** filter, where the reader asked for them and
   they are the list. The rows are not rendered at all until it is opened.

**Proven red before green.** `git stash` of the three source files, the two page
suites re-run against `origin/main`: **17 failed**, including
`Received: "…Held backHC-IV-2608-004…(AddPartialTransferDetail is the SDK's only
primitive)…"`. The fixtures are production strings verbatim, not invented worst
cases, and "not on screen" is asked structurally (`data-ac-technical` removed
from a clone) because jsdom applies no user-agent stylesheet and a closed
`<details>` still contributes its whole content to `textContent`.

**The lesson, and it is the reusable one.** *A rule that quantifies over the
strings you write is not a rule about the screen.* The gate now quantifies over
what the page RENDERS, given notes the server actually produces, so a refusal
class nobody has written yet is covered too.

**Ref:** PR #PRNUM, 2026-08-16.
