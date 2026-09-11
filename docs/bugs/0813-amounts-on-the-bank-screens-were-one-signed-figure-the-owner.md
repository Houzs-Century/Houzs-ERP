## Amounts on the bank screens were one signed figure; the owner reads a ledger as Debit and Credit, a statement as Deposit and Withdrawal [low]

<!-- area: Accounting + GL -->

**Symptom.** Every table on the bank reconciliation screens carried one
"Amount" column with a signed figure: `RM -45,000.00` for a payment in the
books, `RM -2,500.00` for a withdrawal on the statement. The owner
(2026-09-11), reading the outstanding-items table and the entry chooser:
「为了方便看，你可以把这个金额分成 debit 和 credit 吗？这样我可能方便一点看，这里
也是一样」.

**Root cause (traced).** Not a defect — a presentation the screens inherited
from the reconciliation's own arithmetic, which works in one signed number
(`debitSen − creditSen`, money in positive). A person reading a ledger does
not: a payment is a credit to the bank account, and on the bank's own paper
the same money is a withdrawal.

**Fix.** `DrCr` and `DepWd` (`frontend/src/pages/scm-v2/BankStatementTab.tsx`).
The books' tables — *Outstanding items — in the books, not yet on the bank*
and *Choose the entry these movements are* — show **Debit | Credit** off the
entry's own `debitSen` / `creditSen`. The bank's tables — *Still to decide*
and *already dealt with*, on the statement and the month views — show
**Deposit | Withdrawal**, the words on the statement, with the split-payout
sub-line ("RM 875.00 less RM 3.94 charge") under the deposit. The
reconciliation panel's walk and the "Selected … of …" sums are untouched;
the printed statement keeps its bracketed deductions.

Pinned by `BankStatementTab.test.tsx` ("amounts in two columns": a credit
entry under Credit and a debit entry under Debit with the other cell empty
and no signed figure anywhere; a withdrawal under Withdrawal with Deposit
empty and no "Amount" heading; the chooser's columns). Proved RED on the
unfixed tree, then GREEN.

**Ref.** acc/bank-drcr-columns, 2026-09-11.
