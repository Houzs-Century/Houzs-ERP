## Three same-named constants across two purchase routers; two were copies, one was a real difference nobody had written down [low]

<!-- area: Purchase orders + GRN + PI -->

**Symptom.** None. Found while attempting to shrink
`scm/routes/mfg-purchase-orders.ts`.

**What was there.** Both purchase routers — the Purchase Order and the Purchase
Consignment Order — declared three constants under the SAME names:

```
VALID_CURRENCIES   identical in both
VALID_KINDS        identical in both
VALID_STATUSES     PO  : DRAFT, SUBMITTED, PARTIALLY_RECEIVED, RECEIVED, CANCELLED
                   PCO :        SUBMITTED, PARTIALLY_RECEIVED, RECEIVED, CANCELLED
```

A PCO has no draft state. **That difference is deliberate, and NEITHER file said
so.** It sat between two constants that were straight copies, under a matching
name — which is the arrangement that makes a real difference read as an
oversight, and an oversight read as a real difference. Either mistake is one
"tidy-up" away: hand a PCO a draft state it does not have, or take the PO's away.

**Fix.** The two that ARE the same move to `scm/lib/purchase-doc-vocab.ts`.
`VALID_STATUSES` stays LOCAL in both, each with a one-line note naming the other,
and `backend/tests/purchaseDocVocab.test.ts` asserts the two sets differ by
**exactly `DRAFT`** — so harmonising them fails a test instead of silently
changing a document model.

**The guard had a hole, found by proving it red.** Its first version asked
`declaredSet(...)` to come back empty, and `declaredSet` reads the quoted strings
inside the `Set` — so a re-declaration holding anything else (`new Set([1])`)
parsed as zero entries and PASSED. It now looks for the DECLARATION, and carries
a test asserting the matcher can still SEE one, so the two "must not be declared"
assertions cannot pass over a dead pattern. Both arms proven red afterwards.

Then it caught a real one within the minute: reverting a broken extraction on the
PO side left the PCO importing the shared module and the PO re-declaring its own,
and the guard failed on exactly that.

**NOT DONE, and why.** This was meant to be the seventh file-size payment.
`mfg-purchase-orders.ts` is 113 lines over its ceiling and it is NOT shrunk here:
an automated extraction of its inert half cut two blocks mid-expression
(`HEADER_COLS` is a multi-line concatenation whose COMMENTS contain braces, and
`parseBulkSupplierDateBody`'s return type spans lines before its opening brace),
and the result did not compile. It was reverted rather than patched. The file
ends this change at exactly the line count it started with — the note in the
router is one line, not four, because a file already over its ceiling may not
grow even by a comment.

**Ref.** 2026-08-15.
