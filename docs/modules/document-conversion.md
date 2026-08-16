# Module: Document conversion (SCM) — the link contract

> **Scope of this file.** It documents ONE thing: how a "Convert to X" button
> tells the destination picker which source document the operator came from.
> The full conversion GRID — which pairs exist, which have "Convert from",
> which have "Convert to", which have neither — is being written separately in
> PR #2325 (`docs/status-and-conversion-matrix`), which was still open when this
> was added. If both have landed, this section belongs inside that guide; merge
> them rather than keeping two files.

> Written 2026-08-16 against `main` @ `c38a5f842`.

---

## 1. Why there is a contract at all

Every conversion in this ERP is a **picker page owned by the DESTINATION
document** — `/scm/grns/from-po`, `/scm/sales-invoices/from-do`,
`/scm/delivery-orders/from-so`, and so on. A source-side "Convert to X" button
navigates to that picker, and it has to say WHICH source document it came from
or the operator lands on a global list of everything and hunts for the document
they were just looking at.

Every call site used to spell that parameter itself. Two failure modes followed,
both found on 2026-08-16 and both invisible to the compiler:

1. **The picker never read it.** `?do=`, `?grn=` and `?so=` were constructed,
   navigated with, and discarded. The button worked, the URL was right, and the
   screen was the unscoped global picker.
2. **The two sides spelled it differently.** The GRN screens sent `?fromGrn=`
   while `PurchaseReturnNew` read `grnId`. "Convert to PR" always opened a blank
   free-form Purchase Return with no note attached, and said nothing.

## 2. The contract

**`frontend/src/lib/convertScope.tsx` holds the only spelling.** Both sides
import it, so there is nothing to remember and a typo is a type error:

| side | what it calls |
|---|---|
| the source button | `convertToLink(pair, keys)` → the URL |
| the destination picker | `readConvertScope(pair, searchParams, alsoKnown)` → `{ keys, unknown }` |
| the destination picker | `<UnrecognisedScopeNotice unknown={scope.unknown} />` |

The rules the two working pairs (`GrnFromPo`, `PurchaseOrderFromSo`) already
followed, now written down and enforced:

- **The parameter is named for what it CARRIES**, not for a shape it might have.
  `soDocNo`, not `soId`: the SO→DO picker's rows come from
  `/delivery-orders-mfg/deliverable-so-lines`, which returns `docNo` and no
  order id. A parameter called `…Id` holding a document number is the same
  drift wearing a different hat.
- **One or many.** The value is a comma-separated list. Single convert and the
  PO list's bulk "Convert to GRN" use the same parameter; a picker that reads it
  gets multi-source for free.
- **No parameter means the FULL picker.** That is a legitimate entry point (the
  list toolbar's "From PO" / "From Delivery Order" buttons), not a broken link.
- **A scoped picker pre-ticks the source's remaining lines** at full quantity,
  and shows a "Show all …" escape link. Nothing is created — Continue only
  carries the picks to the New-document form.
- **A scoped picker's EMPTY state says the scoped thing is empty**, not that the
  system is. "Nothing left to invoice on the Delivery Order you came from" and
  "no invoiceable lines exist" are opposite facts and the operator acts on the
  second one by walking away.
- **An unrecognised parameter is SHOWN, never dropped.** `readConvertScope`
  returns it and the picker renders it. A silently ignored parameter is exactly
  what let `fromGrn` survive: the screen looked like a normal blank form.
- **`alsoKnown` is REQUIRED, never optional** (CLAUDE.md's rule about a
  parameter that decides something). It decides whether a parameter counts as
  unrecognised. Optional, every caller that forgot it would shout about its own
  legitimate parameters, and the guard would be switched off by hand one screen
  at a time. Pass `[]` when the screen takes nothing else.

### `appendTo…` is a different concept, deliberately outside the table

`/scm/grns/from-po?appendToGrn=<id>` and
`/scm/purchase-orders/from-so?poId=<id>` name an existing **destination**
document to append the picked lines INTO. That is the opposite direction to a
source scope, and mixing the two in one table is how the next reader gets it
backwards. They stay hand-written and are declared to `readConvertScope` via
`alsoKnown`.

## 3. The pairs that carry a scope

| pair key | source-side button | destination picker | parameter |
|---|---|---|---|
| `poToGrn` | PO detail, PO list row, PO list **bulk bar** | `GrnFromPo` | `poId` |
| `grnToPi` | GRN detail, GRN list row | `PurchaseInvoiceFromGrn` | `grnId` |
| `grnToPr` | GRN detail, GRN list row | `PurchaseReturnNew` | `grnId` |
| `poToPr` | PO detail "Raise Return" | `PurchaseReturnNew` | `poId` |
| `doToSi` | DO detail, DO list row | `SalesInvoiceFromDo` | `doId` |
| `soToDo` | SO list row "Deliver" | `DeliveryOrderFromSo` | `soDocNo` |

## 4. What enforces this

- `frontend/src/lib/convertScope.test.tsx` — the contract, **plus a tree scan
  that fails on any site hand-writing a query onto a convert path.** That scan
  is the anti-drift guard: a convention people must remember is what failed
  here, so the check is the memory.
- `frontend/src/pages/scm-v2/convert-scope-pickers.test.tsx` — mounts each of
  the three repaired pickers under a real router at the real URL its real
  caller builds, and asserts the operator sees the document they came from and
  not the one next to it.

## 5. Pickers with no scope parameter, and why

Five pickers read no scope, and that is correct today: **no caller sends them
one.** They are the "no Convert to button exists" half of the grid, not the
"button exists and is broken" half.

`DeliveryReturnFromDo`, `ConsignmentNoteFromOrder`, `ConsignmentReturnFromNote`,
`PurchaseConsignmentReceiveFromOrder`, `PurchaseConsignmentReturnFromReceive`.

Adding the button is a product decision (see PR #2325 §8), not a repair. When
one is added, it uses `convertToLink` and the picker uses `readConvertScope` —
that is the whole cost.

## 6. There is no Sales Order → Sales Invoice conversion

`SalesInvoicesListV2` carried a "New from Sales Order" menu item that navigated
to `/scm/sales-invoices/from-so`. **No such route is registered** in `App.tsx`
(only `/new`, `/from-do`, `/:id`), so it fell through to the detail route with
`id="from-so"`. It was removed on 2026-08-16 rather than pointed somewhere,
because there is nothing to point it at: the only SI converter the backend
exposes is `POST /sales-invoices/from-dos`, fed by
`GET /sales-invoices/invoiceable-do-lines`. A Sales Invoice is built from
DELIVERY ORDERS. SO → SI does not exist in either direction.

## See also

- `docs/modules/sales-invoice.md`, `docs/modules/grn.md`,
  `docs/modules/purchase-return.md`, `docs/modules/delivery-order.md`
- `docs/modules/document-traceability.md` — what the converted link means afterwards
