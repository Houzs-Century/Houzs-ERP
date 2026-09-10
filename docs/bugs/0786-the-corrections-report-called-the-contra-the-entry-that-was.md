## The corrections report called the contra the entry that was reversed [low]

<!-- area: Accounting + GL -->

**Symptom.** The first correction made through #3549 (2990-SO-2606-043,
2026-09-10) produced three journal entries: `2990-JE-2606-0047`, the original
(RM 308); `0099`, the contra that voided it; `0100`, the entry booked in its
place (RM 307). The Corrections report's Ledger column printed
**"0099 reversed → 0100"**. Read plainly, that says 0099 was the entry
reversed — but 0099 *is* the reversal, and the entry that was reversed, 0047,
appeared nowhere. The owner, shown the sentence: 不明白.

**Root cause (traced).** `repostSoPaymentEdit` returned the contra's number
under the name `reversedJeNo` (it was `undone.jeNo`, which `reverseJournal`
answers with the contra it wrote), and never returned the original's number at
all — `reverseJournal` did not hand it back, though `orig.je_no` was in scope
at both of its `reversed` returns. `ledgerFieldChange` then wrote one audit
change, `ledger: reversedJeNo → jeNo`, so the row carried the contra where a
reader expects the original, and `ledgerText` rendered exactly that.

**Fix.** Three numbers, named for what they are, in the order the books moved.
`reverseJournal`'s `reversed` result gains `originalJeNo` (additive; nothing
deep-equals that result). `repostSoPaymentEdit` returns `originalJeNo` and
`contraJeNo`; `LedgerTouch` carries all three, and `afterSoPaymentRemoved`
fills the first two from the engine's answer. The audit row now carries TWO
changes — `ledger: original → new` (what replaced what) and
`ledgerReversal: null → contra` — so the SO's audit history reads correctly
too. `ledgerText` prints **"0047 → reversed by 0099 → 0100"**; a delete stops
at the reversal; a first booking prints "booked 0100".

The one row already written the old way is read as what it is:
`paymentCorrectionsReport` treats a `ledger` change with a `from` and no
`ledgerReversal` as LEGACY — contra known, original unknown — and prints
"reversed by 0099 → 0100", never presenting the contra as the original. It is
not rewritten: an audit row is evidence, and the report's job is to read it
honestly.

Proved RED on the unfixed tree: the test patch was applied first —
`payment-corrections.test.ts`, `payment-repost.test.ts` and
`paymentCorrectionsRoute.test.ts` failed 10 cases; `payment-corrections-pdf.test.ts`
and `PaymentCorrectionsTab.test.tsx` failed 5 — then the implementation, and
all 15 went green with the existing 98 around them.

**Ref.** acc/corrections-ledger-wording, 2026-09-10.
