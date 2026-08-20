## A merged migrated invoice took its supplier / debtor from whichever source document sorted first [high]

**Symptom** - one AutoCount invoice routinely spans several of our documents, and
the mirrored ERP invoice merges them. The merged header carries exactly ONE
supplier / debtor, and the writer took it from `plan.sourceDocNos[0]` - i.e. from
document-number sort order. If the sources disagreed, the invoice would be
billed to the wrong party with a total that reconciles perfectly, which is the
worst shape a wrong value can have.

**Root cause (traced, not guessed)** - this is not an edge case. Measured
read-only against live AED_HOUZS on 2026-08-11:

```
grToPi: invoices covering >1 source document = 309 of 4789
doToIv: invoices covering >1 source document = 568 of 9245
```

`planMigratedInvoices` grouped purely by AutoCount invoice number and never
compared the parties behind the group.

**Fix** - rule 5 in `backend/src/scm/lib/migrated-chain.ts`: each source carries a
`partyKey` (supplier on a receipt, debtor on a delivery) and a group whose
sources disagree is refused as `party_disagrees_across_sources`, checked BEFORE
the total gate and not buyable with the `allowTotalMismatch` override. A source
with no recorded party does not manufacture a disagreement. On today's
production data the rule fires on 0 documents - it is a guard against a shape the
data can take, not a repair of one it already has.

Counterfactual: **32 pass / 0 fail** with the rule, **29 pass / 3 fail** without.

**Ref** - PR for `feat/migrated-chain-invoices`, 2026-08-11.
