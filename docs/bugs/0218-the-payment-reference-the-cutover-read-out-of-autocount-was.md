## The payment reference the cutover read out of AutoCount was never written back [high]

<!-- area: AutoCount sync + write-back -->

**Symptom.** Told that the account sheet and the approval code had nowhere to go
in AutoCount, the owner said: *"我记得之前 autocount 拉数据进来是有的，你查看一下，
怎么 extract 的，然后原路返回怎么写。"* He was right and the answer given was
wrong. The field exists, the cutover read it, and nothing ever wrote it back.

**Root cause of the wrong answer.** The search was `SOUDF_` and the field is
`UDF_PAYEMENT` — no `SO` prefix in the importer's query, and AutoCount's own
spelling of "payment" is `PAYEMENT`. Two misses in one name. The conclusion
drawn from an empty grep was "there is nowhere to put it", which is the shape
CLAUDE.md warns about: a verdict computed over nothing reading as a pass.

`import-ac-outstanding-so.mjs:16` says it plainly:

```
balance = UDF_BALANCE, paid = total - balance; UDF_PAYEMENT -> account_sheet
+ approval_code
```

So the AutoCount sales order has SIX UDFs, not five — `BALANCE`, `BRANDING`,
`Note`, `PDate`, `ToPONo`, `VENUE` **and** `PAYEMENT` — and the write-back sent
five of them.

**Fix.** `composePaymentUdf` is the INVERSE of the cutover's own `parsePayment`,
and the format is not a choice: it is whatever that function reads, since that
function is what ran over 13,015 headers. `parsePayment` moved out of the
runnable importer into `backend/scripts/lib/ac-payment-udf.mjs` (no shebang — a
test imports it) so it sits beside its inverse; a format written in one file and
read in another is how the two stop agreeing, and this field is free text with
no schema to catch it.

`autocountPaymentUdf.roundtrip.test.ts` composes with the shipped TS function and
parses with the CUTOVER'S, in one assertion. Asserting a literal string would
have pinned what the format was assumed to be; this pins what the importer can
actually read.

Three properties the tests exist for:

- **Omit, never blank.** No references sends no key. `Str` turns a present-null
  into `""`, which would erase the cutover's own text on an order whose payments
  predate the ERP.
- **The delimiters are the format's.** `(`, `)` and `/` become spaces, or a bank
  name like `MBB/CIMB` parses back as acct `MBB`, appr `CIMB` and drops the
  approval code. Lossy and predictable; a human typing into the field in
  AutoCount's own UI is under the same constraint.
- **The read is ORDERED** — `paid_at` then `id`. `paid_at` is a DATE, so a day
  with two payments has no order of its own and the text would reshuffle between
  edits, rewriting the account book for no reason.

`paymentRefs` is a REQUIRED parameter on `composeCreateSo` and `soEditHeader`,
not optional. The compiler then enumerated the four call sites, which is the
whole point of that rule.

No C# change and no host rebuild: `ApplyUdf` writes whatever keys it is given
and is already called on both create (`:403`) and edit (`:923`).

**Ref.** 2026-08-15, PR #2247.
