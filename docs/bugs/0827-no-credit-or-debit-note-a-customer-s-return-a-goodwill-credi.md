## No credit or debit note — a customer's return, a goodwill credit or a supplier's credit had no document and no journal of its own [medium]

<!-- area: Accounting + GL -->

**Symptom.** A customer who returned a sofa leg, a discount given after the
invoice, a supplier who took goods back: Finance had no document to raise and
no journal to post, so the customer's balance and the supplier's balance stayed
wrong until somebody keyed a manual journal against a control account — which
the engine refuses (由模块过账). Owner (2026-09-05, the GL roadmap): CN/DN
approved — sales CN + supplier CN first, DN second, prefixes CN / DN / SCN, a
new number series; (2026-09-12): 「这个要做」.

**Root cause (traced).** The ledger knew invoices, payments and vouchers; it
had no document whose posting sat on the other side of a control account for
a customer or a supplier.

**Fix.** `scm.acc_credit_notes` + `scm.acc_credit_note_lines` (migration
`20260912T0100_acc_credit_notes.sql`) and `/scm/credit-notes`
(`backend/src/scm/routes/credit-notes.ts`): three kinds on one table — **CN**
to a customer (Dr each line's account, RETURN INWARDS by default / Cr AR,
party the customer), **DN** to a customer (Dr AR, party the customer / Cr
each line's account), **SCN** from a supplier (Dr the supplier's AP control,
400 or 405 by the supplier's code / Cr each line's account, PURCHASES RETURN
by default). A note is raised DRAFT — the customer from the sales order (the
party code a payment on it carries), the invoice, or the name typed; the
supplier picked — numbered `{co}-CN-YYMM-NNN` / `DN` / `SCN` (NEW series);
posted through `postJournal` once (source_type the kind, a second post
echoes); cancelled by contra; a posted note is not edited. Two roles join
`acc/rules.ts` for the defaults, `SALES_RETURNS` (510-0000) and
`PURCHASE_RETURNS` (612-0000). The page
(`frontend/src/pages/scm-v2/CreditNotes.tsx`, Money in group of the sidebar)
lists by kind and status, raises a note with lines whose account may stay
blank, opens one to its lines, posts and cancels.

Found on the way: `fetchMonthlyDocNos` (`scm/lib/doc-no.ts`) took the FIRST
string of each row as the document number; a driver that returns the whole
row (the test fake does) handed back the id, the floor read 0 and the second
note of a month minted `-001` again. It now reads the named column first.

Pinned by `backend/tests/creditNotes.test.ts` (numbering and the second
number of a month; the customer from the order, the invoice, the typed name,
and nobody refused; a supplier note's default account; a control account on
a line refused; CN / DN / SCN journal lines with the party; the second post
echoing; cancel's contra and a draft's none; a posted note not edited; the
list's filters) and `frontend/src/pages/scm-v2/CreditNotes.test.tsx`. New
surface: RED is the absence.

**Ref.** acc/credit-notes, 2026-09-12.
