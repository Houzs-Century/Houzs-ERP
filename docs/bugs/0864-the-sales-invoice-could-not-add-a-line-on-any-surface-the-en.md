## The sales invoice could not add a line on any surface - the endpoint and hook existed, nothing called them [medium]

**Symptom.** Of the six SCM documents, the sales invoice was the only one where
an operator could not add a line by hand, from any screen. Recorded as the
outstanding gap in `docs/bugs/0853-add-a-line-was-only-reachable-from-inside-edit-under-four-di.md`
and in `docs/modules/sales-invoice.md` on 2026-09-13, when the other four
documents got their **Add line** button.

**Root cause (traced).** Not a missing feature — a feature with no door.
Measured against `origin/main` @ `c6ce93745` on 2026-09-13:

- `git grep -n "salesInvoices.post('/:id/items'" origin/main` finds the route at
  `backend/src/scm/routes/sales-invoices.ts:1278` (`appendSalesInvoiceItemHandler`):
  tenancy-guarded, item-code validated, refuses CANCELLED and issued invoices,
  audited, resyncs GL revenue.
- `git grep -n useAddSalesInvoiceItem origin/main -- frontend/src` returns
  exactly ONE line — the hook's own definition in
  `vendor/scm/lib/sales-invoice-queries.ts:243`. Zero call sites.

It fell through the 0853 sweep because that fix is a HANDOFF: the detail page
links to a separate V1 editor page, and the editor opens its add row. The sales
invoice has no editor page — `SalesInvoiceDetailV2.tsx` is the only page — so
there was nothing for the handoff to point at, and the page's own Edit opens a
HEADER-only panel (invoice date, due date, notes) by design.

**Fix.** The add row opens IN PLACE on `SalesInvoiceDetailV2.tsx`, in the Line
items section header, labelled with the shared `ADD_LINE_LABEL`. No second
editor page: that would be a whole surface of new code and new drift to carry
one row. The logic lives in `frontend/src/pages/scm-v2/SalesInvoiceAddLine.tsx`
(`useSalesInvoiceAddLine`), because the detail page is ~30 lines under the
2,000-line cap; the detail page grew by 6 lines.

Offered only where the server would accept it — `pageAccess` edit/full (the
page's own Edit gate) AND status DRAFT, which is exactly what `isIssuedSi` and
the CANCELLED check in the handler allow. Every refusal the route can answer
(unknown item code, a line still pending on the source Delivery Order, over the
remaining quantity) is shown inline under the row, which stays open with the
typing intact; the hook's existing `onError: writeFailedAs('Line not added')`
stays as the shared floor.

Pinned by `frontend/src/pages/scm-v2/salesInvoiceAddLine.test.tsx`, which mounts
the real page under a router with only its data hooks faked. **Proved RED on the
unfixed tree:** `Tests 5 failed | 3 passed (8)` — the first failure was
`expected null not to be null` on the Add line button; the 3 that passed are the
"absent when issued / cancelled / read-only" cases, which an absent button
satisfies trivially and which only bite once the button exists.
`addLineHandoff.test.ts` now also asserts the invoice uses the shared word and
does NOT build an `addLineHref`, so a later sweep cannot "fix" it into a link to
a page that does not exist.

**What is NOT covered, said plainly.** This is DESKTOP only. Mobile DOES open a
sales invoice — the generic `frontend/src/mobile/MobileModuleDetail.tsx`
(`"sales-invoices"` module key) — and it still has no add-line affordance, for
the invoice or for any of the four documents 0853 covered:
`grep -rn "ADD_LINE_LABEL" frontend/src/mobile` returns nothing. Against the
owner's 2026-09-12 full-parity ruling that is an open mobile gap, not a design
choice; it is left out here because that file is itself 11 lines under the
2,000-line cap and is a generic detail for every module, so it needs its own
change. The DELIVERY ORDER still adds its lines on its create screen, unchanged,
as 0853 describes.

**Ref.** feat/si-add-line, 2026-09-13.
