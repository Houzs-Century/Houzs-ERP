## Migration 0294 promised migrated invoices spend no customer credit, and nothing enforced it [medium]

**Symptom** - a migrated Sales Invoice mirrors an invoice AutoCount already
raised and already settled in its own book. Migration 0280's column COMMENT
promised "apply NO customer credit", because paying one out of the customer's ERP
credit balance spends a real balance a second time - the customer silently loses
money still owed to them, and the applied credit is indistinguishable from a
genuine one afterwards. No code enforced that promise.

**Root cause (traced, not guessed)** - the guard was written for the two money
paths that were obvious (`postSiRevenue`, `postPiAccounting`) and the credit path
was described in the migration comment but never coded. It looked safe because
all three reachable callers of `applyCustomerCreditToSi` happen to miss migrated
invoices today - and every one of those is an ACCIDENT of the current shape, not
a rule:

```
sales-invoices.ts:1164  POST /            create refuses a migrated source
sales-invoices.ts:1462  POST /from-dos    create refuses a migrated source
sales-invoices.ts:2295  PATCH status      requires prevStatus DRAFT; converter writes SENT
```

This is the same shape as migration 0276, which shipped a COMMENT saying "never
post movements for it" that nothing in the running system honoured. A promise
living only in a comment is the thing this ledger exists to stop.

**Fix** - the guard now lives INSIDE `applyCustomerCreditToSi`
(`backend/src/scm/lib/customer-credits.ts`), which re-reads the header, so every
caller is covered by construction rather than every call site being remembered. A
failed read REFUSES (`migrated_check_failed`) rather than proceeding blind:
fail-closed leaves the credit standing and the invoice merely unpaid, which an
operator can see and re-drive, while fail-open spends a balance that cannot be
un-spent. Migration 0280's comment now names the enforcement point, and states
what is deliberately NOT stopped - a payment recorded against a migrated invoice
behaves normally, and cancelling it still turns the paid amount into credit,
because that money moved in THIS book.

Counterfactual, both numbers: with the fix `customer-credits.test.ts` is
**35 pass / 0 fail**; strip the guard block and it is **33 pass / 2 fail**
(`migrated SI -> applies nothing`, `a failed migrated read REFUSES`). The third
test in the group - an ordinary SI still applies credit - passes BOTH ways on
purpose: it is the control proving the guard is not a blanket off switch.

**Ref** - PR #1975 `feat/migrated-chain-invoices`, 2026-08-11.
