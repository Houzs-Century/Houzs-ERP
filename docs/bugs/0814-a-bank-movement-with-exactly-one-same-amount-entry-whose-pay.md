## A bank movement with exactly one same-amount entry whose payee it names still waited for a hand — the books' obvious matches were never applied [medium]

<!-- area: Accounting + GL -->

**Symptom.** 2990's June Hong Leong statement, line 23: 2026-06-06, RM
−45,000.00, *"Rental - Jun'26 PARVEEN AND NAVINDER"*. The books hold exactly
one entry of RM 45,000.00 — 2990-JE-2606-0060, HPV-2606-023, NAVINDER SINGH
GILL, the same day — and the screen offered it as the one candidate with a
**This is that entry** button. The owner (2026-09-11): 「你看着 45,000 为什么我
还需要自己 manual 匹配？」, and then the rule: 「隔几天的也可以放宽自动对，只要名字
金额一样就自动都对。名字不一样不确定我可以 manual 对」. Forty-four movements on
that statement waited for a hand; most of them read like this one.

**Root cause (traced).** By design. `entryCandidatesFor` (`backend/src/acc/bank-match.ts`)
ranks the books' same-amount entries within seven days and the comment
above it says *"Ranked, never auto-applied"*: the acquirer matcher books a
payout because a merchant report proves it, while "these two records are one
fact" was left to the person. Right as a default, wrong for the case where
the bank's own words name the payee and nothing else in the books could be
the movement — the person's press added nothing but time.

**Fix.** One narrow exception. `namesAgree` and `obviousEntryFor` in
`acc/bank-match.ts`: a movement is obvious when `entryCandidatesFor` returns
exactly ONE entry and the bank's text for the movement (description +
reference) shares a name word with that entry's payee (`party_name`, or the
entry's note) — words of three letters or more that are not company
boilerplate or the bank's vocabulary (a stoplist), with a five-letter prefix
allowed because Hong Leong cuts names short ("PENGURUSAN AIR SELANGO"). Days
apart within the window do not matter. The amount alone or the name alone is
never enough; two candidates are never obvious; a claimed entry is never a
candidate.

`applyObviousMatches` (`routes/accounting-bank.ts`) runs the rule over a
statement's OPEN, not-card movements against the account's ledger and every
statement's claims: a match row with reason `amount+name` (migration
`20260911T1500` adds the word to the `acc_bank_match_reason` check), the line
POSTED, listed under "already dealt with" as *"posted · JE · matched by amount
and name"* with Undo. It runs on upload (`autoMatched` in the reply; the
result line says *"N matched by amount and name"*) and on demand —
`POST /accounting/bank/statements/:id/auto-match`, the **Match the obvious
ones now** button above *Still to decide* — for a statement uploaded before
the rule existed (June); a closed month refuses.

Pinned by `bank-match.test.ts` (names agree on a payee word, survive a
truncated name, do not agree on boilerplate or when the books name nobody;
the obvious entry days apart; nothing when the name differs, when two entries
carry the amount, when the only one is claimed), `backend/tests/bankRoutes.test.ts`
("the obvious ones": upload matches the named transfer with reason
`amount+name` and leaves the unnamed charge open; the on-demand route matches
and is idempotent; a closed month refuses) and `BankStatementTab.test.tsx`
(the button and its answer; the dealt-with line says how). Proved RED on the
unfixed tree (10 backend + 2 frontend), then GREEN. The April lock test that
assumed the TNB line would wait for a hand now names nobody on the entry, so
it still waits.

**Ref.** acc/bank-auto-match, 2026-09-11.
