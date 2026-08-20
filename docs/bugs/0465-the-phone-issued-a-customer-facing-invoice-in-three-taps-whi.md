## The phone ISSUED a customer-facing invoice in three taps, while the desktop made it a deliberate act [high]

<!-- area: Frontend + mobile -->

The owner, 2026-08-20: **「以电脑为准 —— 手机也先出草稿」** — the desktop is the
standard, and the phone drafts first too.

**Symptom.** On the phone, DO -> Sales Invoice was: open the convert wizard, pick
the delivery order, press Create. The invoice that came out was **SENT** — issued
to the customer, dated today, with `sent_at` and `confirmed_at` stamped and
revenue posted. No due date, no terms, no review step, and no way back except
cancelling a document the customer may already have been given. Nothing on the
screen said an invoice was about to be issued rather than drafted; the button
said "Create Sales Invoice", the same words the other three targets use.

**Root cause (traced, not guessed).** `MobileConvertWizard.tsx`'s `si` arm posted
`{ picks }` and nothing else. `POST /sales-invoices/from-dos` reads its draft flag
STRICTLY — `const isDraft = body.asDraft === true` — and then lands
`status: isDraft ? 'DRAFT' : 'SENT'` with `sent_at` / `confirmed_at` set from
`nowIso` and `invoice_date: todayMyt()`. So an ABSENT flag is not a neutral
default; it is the issue path. The desktop never hit this because it cannot reach
that endpoint at all: it goes `SalesInvoiceFromDo` -> `SalesInvoiceNew` ->
`POST /` with a ~30-key header form, which IS the review step. (`useConvertDosToSi`
in `vendor/scm/lib/sales-invoice-queries.ts` is the hook that would have used the
convert endpoint from the desktop; it has zero consumers.)

The same wizard's GRN arm already had the correct answer for the identical
question — it sends `asDraft: true`, with a comment reasoning that posting writes
stock and should not happen automatically. Issuing an invoice writes AR and
revenue on confirm, so the argument transfers with money in place of stock. One
arm of one component had the reasoning and the arm beside it did not.

**Fix.** The `si` arm sends `asDraft: true`, mirroring the GRN arm. The operator
confirms from the document — the mobile detail screen already offered
`Confirm Invoice` (DRAFT -> SENT) and Cancel on a DRAFT, and the wizard already
returned to the convert home screen for every target including the draft GRN, so
no navigation assumed a sent invoice and nothing else had to move. Confirm stays
the single AR/revenue-writing chokepoint, exactly as `/post` is for a GRN.

**Test.** `frontend/src/mobile/mobileConvertDraftInvoice.test.tsx` drives the REAL
wizard with only `authedFetch` faked and asserts the POSTED BODY, not the source
text — a source assertion would pass on a flag some branch never reaches. Proven
red first: on the pre-fix tree `postedBody().asDraft` was `undefined`.

**Ref:** PR feat/owner-policy-rulings, 2026-08-20. Module guide:
`docs/modules/sales-invoice.md` "THE PHONE DRAFTS AN INVOICE, IT NEVER SENDS ONE".
