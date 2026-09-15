## The bank reconciliation listed movements biggest first with the date and reference on one line, chose entries in a second list, and named an entry by its system source [low]

<!-- area: Accounting + GL -->
<!-- status: fixed -->

**Symptom.** Owner, 2026-09-15, on the HLB August statement (21 still to
decide, 11 outstanding): 「这里可以优化吗？日期一行，description 一行」;「我要
manual 用打勾 match 时为什么还要跳出来？下面不是有 list 了吗？」;「下面这个 list 我
需要看到 customer name，然后 source 改成 reference 吧，就是 or number, pv number
等等」— asked, 「日期，reference, description … these are that entry 要做到容易点，
不需要一张划上划下 … so number 我还是需要」; and 「排法，我发现不是根据日期往下
排的」. Four things on one screen: the movement cell ran the date and the
reference together with the description under them; the list ran biggest
first, not by date; ticking movements opened a SECOND table of the same
entries the outstanding list below already showed, with the button at its
foot; and the outstanding list's Source read "SOPAY · 0bb232ad-…" with a
Who of "Payment received (transfer) — 2990-SO-2608-067" — no customer, no
document a person holds.

**Root cause (traced).** `OpenLine` printed `{booked_on} · ref {reference}`
on one line (ISO date); `StatementView` and `BankMonthTab` ordered the open
lines by kind then `|amount|` ("most consequential first"); `OpenLines` held
the tick state itself and, on the first tick, drew its own chooser table of
`entries` — the same array `BooksNotOnBank` drew below — because the two
tables were two components with nowhere shared to keep a tick; and the
ledger entries carried only what `v_gl_entries` has (source type, source
document key, the bank line's party and note) — a sales-order payment's
customer sits on the order and its receipt number on the receipt, and
nothing read them.

**Fix.**

- `backend/src/acc/journal-refs.ts`: `resolveJournalRefs` names a batch of
  entries the way a person knows them, in a handful of reads — a sales-order
  payment by its official receipt number (when one exists) and ALWAYS its
  order number, who = the order's customer; a voucher by its number, who =
  the payee; a payout by "<acquirer> payout dd/mm/yyyy", who = the acquirer;
  a reversal as its original; anything else by its document number and its
  party or note. `withJournalRefs` writes `reference` and `who` onto the
  entries; both bank routes (`bankStatementDetail`, the month detail) name
  the account's ledger before the candidates and the outstanding list are
  cut from it.
- `frontend/src/pages/scm-v2/bank-reconcile-pick.tsx`:
  `ReconcilePickProvider` holds the ticks for both tables and draws a bar
  FIXED to the foot of the window with the two totals, the refusal and
  "These are that entry" — nothing scrolled to; `byDateThenLine` orders the
  movements by the bank's day, then the line.
- `frontend/src/pages/scm-v2/BankStatementTab.tsx`: the movement cell reads
  date (dd/mm/yyyy) · line, then the reference, then the description;
  `OpenLines` ticks through the provider and has no chooser; `BooksNotOnBank`
  carries the tick per entry and the columns Entry · Date · Reference ·
  Customer / payee · Debit · Credit (the reference falls back to the source
  where the server has none); a candidate under a movement names its
  reference and who. `BankMonthTab.tsx` orders and wraps the same way.

Proved RED on main's source (the five changed source files stashed, the two
new ones set aside): six tests in `BankStatementTab.test.tsx` failed — the
bar, the columns, the names, the cell, the order, the refusal's order — and
`journal-refs.test.ts` could not import. Green after; `BankMonthTab.test.tsx`
unchanged and green.

**Ref.** acc/bank-recon-screen, 2026-09-15.
