## One entry paid by two bank movements, or one movement paying two vouchers, could not be matched — the index held one entry to one line [medium]

<!-- area: Accounting + GL -->

**Symptom.** 2990's receipt 2990-OR-2604-001 is RM 39,000.00 received from
HOUZS VENTURE HOLDING SDN BHD, posted as one entry (2990-JE-2604-0017). Hong
Leong shows it as two transfers on 2026-04-30, RM 29,000.00 (ref "2990 Home
PV-000050") and RM 10,000.00 (ref "2990 PV-000051"). On the April statement
each of the two lines could offer only **Not ours to reconcile**: no single
entry equals either amount, so nothing was a candidate, and the receipt sat
under "in the books, not on this statement". The owner (2026-09-11): 「像这一
笔 2990-OR-2604-001，他对应的是这两笔，你应该开发让我自由选」. The mirror
case — one transfer paying two vouchers — had the same dead end.

**Root cause (traced).** `acc_bank_statement_matches` carried
`CONSTRAINT acc_bank_je_once UNIQUE (company_id, je_no)` (migration 0336):
"one entry cannot be reconciled twice". Right as a guarantee, wrong as a
shape — it also meant one entry cannot be reconciled by two movements, and
the second line to name the receipt would have lost to the index. And the
only matching door, `POST /bank/lines/:id/match`, took one line and one
`jeNo`; the reconciliation (`StatementMovement.jeNo`) could hold one entry per
movement, so one movement paying two vouchers could claim only one of them.

**Fix.** *The index.* Migration `20260911T1000_acc_bank_match_group.sql` drops
`acc_bank_je_once` and adds `acc_bank_je_line_once UNIQUE (company_id, je_no,
bank_line_id)`: a pair is written once; that an entry is not accounted for
twice is now the route's job, and both routes do it by reading the match rows
of that `je_no` and refusing when any belongs to a POSTED line
(`already_matched`, "One entry cannot account for two" — the same sentence
the index used to produce).

*The group.* `POST /accounting/bank/lines/match-group { lineIds, jeNos }`
(`bankLinesMatchGroup`, `backend/src/scm/routes/accounting-bank.ts`): several
movements to ONE entry, or one movement to SEVERAL entries — several to
several is refused as two decisions (`one_side_only`). Every line must be
OPEN, of this company, on statements of one account, and in an open month
(`refuseIfLineLocked` per line); every entry must be a posted entry of that
account's ledger (`entry_not_found`) and not already claimed; and the two
sides must add up to the sen (`amount_mismatch`, naming both totals and the
difference — owner: 勾的总额必须等于那个 entry 的金额). Rows: several→one carry
each movement's amount; one→several carry each entry's amount; lines go
POSTED with `posted_je_no` = the first entry. `StatementMovement.jeNos`
carries every entry a POSTED line claims, and the reconciliation's claimed set
is the union — the detail, the month detail and `loadMonthForLock` (which now
reads the match rows) all feed it.

*Undo is the whole group.* Undoing one movement of a pair reopens every
movement sharing its entries and deletes all their rows (`linesReopened` in
the reply): a half-claimed entry is not a state the identity can hold.

*The screen.* `OpenLines` (`BankStatementTab.tsx`, shared with the month view)
gives every open movement a tick box; ticking opens **Choose the entry these
movements are** with the picked total and every entry the books still hold
for the account (this period's and the earlier months' still waiting, named
by who); the button **These are that entry** fires only when the two totals
agree and one side is a single item, and says the difference otherwise.

Pinned by `backend/tests/bankRoutes.test.ts` (two movements to one entry —
rows, states, the entry claimed once, the identity consistent; one movement to
two vouchers; the difference refused by name; several-to-several refused; an
entry already accounted for and one the books do not hold; undo reopens the
pair; a closed month refuses; the single match's "only once" now answered by
the route), `bank-reconcile.test.ts` (a movement claiming two entries claims
both) and `BankStatementTab.test.tsx` (ticking opens the chooser with the
total and the names; the button waits for the totals to agree and sends the
lines and the entry). Proved RED on the unfixed tree (9 + 2 failed), then
GREEN. The harness's je_no unique is gone with the index; the route's own
refusal is what the "only once" test now exercises.

**Ref.** acc/bank-match-group, 2026-09-11.
