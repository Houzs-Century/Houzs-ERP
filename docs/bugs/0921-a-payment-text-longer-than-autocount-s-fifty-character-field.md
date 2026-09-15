## A payment text longer than AutoCount's fifty-character field was refused silently and the field stayed empty [medium]

<!-- area: AutoCount sync + write-back -->

**Symptom.** On 2026-09-15 every sales order with a payment recorded since
go-live was checked against the book: 281 orders, 279 balances equal, none
different. But HC-SO-2609-011 showed an **empty** `UDF_PAYEMENT`, although the
ERP holds three payment references for it. The create on 2026-09-09, an edit on
2026-09-10 and a re-send on 2026-09-15 had all carried the text, and every one
of those rows reads `sent`.

**Root cause (traced).**

- `SO.UDF_PAYEMENT` is `nvarchar(50)` in the live book (INFORMATION_SCHEMA, read
  2026-09-15).
- `composePaymentUdf` (`backend/src/services/autocount-writeback.ts`) joined
  every reference with no limit. HC-SO-2609-011's three came to 63 characters
  and HC-SO-009093's two to 52. They are the only 2 of the 281 orders over the
  field.
- AutoCount refuses a value that long. The host applies UDFs inside `Set(...)`,
  which swallows the error, so the send succeeds with that one field unwritten
  and nothing records it.

The book's own long texts show how the office handled the limit. 538 orders
hold exactly 50 characters: references run together with no space, oldest first,
stopping at the field's end.

**Fix.** When the text would exceed 50 characters, `composePaymentUdf` runs whole
references together, from the first, and stops before one would overflow. Two
consequences:

- The cutover parser still reads the same first pair.
- A single reference longer than the field sends nothing, rather than half a
  reference.

A text that fits is unchanged, spaces included. The script-side mirror in
`backend/scripts/lib/ac-payment-udf.mjs` changes the same way. Both paths that
send the text use this composer: the full sales order edit and the payment's
header-only edit.

Pinned in `backend/src/services/autocountPaymentUdf.roundtrip.test.ts`.

- Two new tests fail on the unfixed composer: three payments over the field,
  which must fit and parse to the first pair; and one reference too long, which
  must send nothing.
- They pass after, with the control (a fitting text unchanged).
- The round-trip, payment-edit and write-back suites pass: 3 files, 161 tests.

**Ref.** fix/ac-payement-length, 2026-09-15.
