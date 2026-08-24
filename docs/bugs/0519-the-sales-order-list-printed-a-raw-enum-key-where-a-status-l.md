## The sales order list printed a raw enum key where a status label belongs [medium]

**Symptom.** The owner's own screenshot of the production Sales Order list,
2026-08-22: eighteen orders showing a pill that reads **`READY_TO_SHIP`** —
underscore and all — beside others reading a properly cased "Confirmed". Three
statuses did it: `IN_PRODUCTION`, `READY_TO_SHIP` and `SHIPPED`.

**Root cause (traced).** `frontend/src/pages/scm-v2/so-list-status.ts` —
`statusFor` ends:

```
STATUS_TONE[(s ?? "").toLowerCase()] ?? { tone: "neutral", label: s || "—" }
```

The fall-through hands back **`s`, the raw stored value**, so a status with no
row in `STATUS_TONE` is not merely uncoloured — it is UNTRANSLATED. The map held
seven entries against a ten-value vocabulary, and the three that were missing
are three of the four statuses a live order actually spends time in.

The file's own header says `STATUS_TONE` "IS NOT A FULL VOCABULARY and must not
be read as one" — true of the TONE, which legitimately defaults to neutral, and
false of the LABEL, which has no default worth having. One map answering two
questions with two different fall-through contracts is what hid this.

It is the same root as §1's OPEN note in
`docs/modules/document-status-vocabulary.md`: `status-pill.ts` claims to be the
one home for status labels and sixteen pages carry their own copy. This list is
one of the sixteen, and `status-pill.ts` has had all three labels the whole
time.

**Fix.** The three missing rows, with labels copied from `status-pill.ts`
verbatim — `In Production`, `Ready to Ship`, `Shipped`. `SHIPPED` gets one even
though it has no tab of its own (it folds into Delivered,
`so-tab-statuses.ts`): folding decides which TAB a row appears under, not what
its own pill says, and Postgres cannot drop the enum label.

Pinned by `frontend/src/pages/scm-v2/so-list-status.test.ts` — every status in
the vocabulary must render a label that is neither the raw key nor contains an
underscore. **Proved RED on the unfixed tree: 6 of 14 failed**, naming exactly
`IN_PRODUCTION`, `READY_TO_SHIP` and `SHIPPED`.

**Not fixed here, and it is the real root:** the other fifteen pages still carry
their own label maps, so a sixteenth status on a seventeenth page will print raw
again and nothing will say so. The durable fix is those pages reading their
LABEL from `status-pill.ts` and keeping only their own bucket and blurb.

**Ref.** fix/the-status-column-prints-a-label-not-an-enum-key, 2026-08-22.
