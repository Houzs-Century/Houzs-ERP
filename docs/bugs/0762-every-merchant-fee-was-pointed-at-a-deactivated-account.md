## Every merchant fee was pointed at an account the chart had deactivated [high]

<!-- area: Accounting + GL -->
<!-- status: open -->

**Symptom.** Owner, 2026-09-09, confirming one PBB settlement line with its
payment correctly selected and balanced (`Selected RM 3,240.00 of RM 3,240.00`):

> Posted 0 of 1.
> Line 18: **account 930-0000 is deactivated**

This is the third and last thing standing between him and those thirteen lines,
and — unlike `0760` and `0761` — it is **not a code fault**. It is configuration
that the chart migration invalidated and nothing brought forward.

**Root cause.** `scm.acc_company_acquirers.fee_account_code` was seeded as
`930-0000` for every acquirer in every company by migration `0332`, when the
chart was the old one. The AutoCount code relay (`0346`) and the owner's
397-account seed (2026-09-03) replaced the chart underneath it. In the new chart
`930-0000` is **"MISCELLANEOUS EXPENSES XXX"** — a placeholder, and
`is_active = false` in **both** companies:

| company | code | name | active |
|---|---|---|---|
| 1 | 930-0000 | MISCELLANEOUS EXPENSES XXX | **false** |
| 2 | 930-0000 | MISCELLANEOUS EXPENSES XXX | **false** |

So every acquirer link in both companies pointed at a dead account — 12 rows —
and the posting gate refused, correctly, the moment anyone confirmed a line.

**Why it stayed hidden.** Nothing reads the fee account until a settlement is
CONFIRMED, and confirms had been blocked by `0760`/`0761` since before the chart
moved. Two faults masking a third: fixing the first two is what let this one
finally speak.

**Fix.** Migration `20260910T0147` repoints the links and the column DEFAULT to
**`900-T009` TERMINAL INTEREST CHARGES** — the owner's own choice, 2026-09-09,
asked between BANK CHARGES, PROCESSING FEES, COMMISSION and the TERMINAL
accounts. (He first typed `900-T010` and corrected himself; that one is
TRAVELLING EXPENSES - OTHER.) The route's two hard-coded `'930-0000'` fallbacks
become one `MERCHANT_FEE_ACCOUNT` constant beside the code that uses them, so
the default and the column cannot drift apart again.

**Guarded three ways,** because a config change that lands on the wrong account
is invisible until somebody reads a P&L: only rows still on the placeholder are
moved; the target must be an EXPENSE, ACTIVE and a LEAF **in that same company**
(the same three properties the posting gate checks, so this cannot swap one
refusal for another); and it refuses loudly rather than leaving a company
behind.

**Verified against.** Applied to staging (`minnapsemfzjmtvnnvdd`), which carried
the identical 12 rows on `930-0000`: **12 moved, 0 left on the dead account**,
and the column default now reads `'900-T009'::text`. `src/acc` + settlement
routes: 374 passing.

**And the screen can now pick it.** Told that the Setup page could not, the
owner asked for it (这个需要). Reconciliation setup offers each company its own
ACTIVE EXPENSE LEAVES, filtered by the server to the same properties the posting
gate checks, and the PATCH re-checks all four by name — in this chart, active, an
EXPENSE, a leaf — so a code that would fail at confirm time is refused where the
choice is made. A fee account the chart can no longer post to is NAMED on the
cell rather than shown as a blank select: that silence is how 930-0000 went
unnoticed.

**Status stays `open` until the owner's lines actually post on prod.**

**Ref.** `backend/src/db/migrations-pg/20260910T0147_acc_merchant_fee_account_to_terminal_charges.sql`,
`backend/src/scm/routes/accounting-settlement.ts` (`MERCHANT_FEE_ACCOUNT`).
The two faults that hid it: `0760`, `0761`.
