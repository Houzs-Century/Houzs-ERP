## Transfer to Delivery Order vanished the moment stock arrived [high]

**Symptom.** The owner, 2026-08-21: *"为什么 2990 的公司有 Transfer to DO，
houzscentury 的 company 却没有呢？为什么不一样呢？"* — the Sales Order row drawer
offered **Transfer to Delivery Order** on one tenant's order and nothing at all
on the other's.

It was never a company difference. The predicate carries no company term; he
happened to be looking at a `CONFIRMED` order in 2990 and a `READY_TO_SHIP` one
in Houzs Century (HC-SO-2608-003). **Every `READY_TO_SHIP` sales order in both
tenants had no transfer button** — 17 of them in 2990 on the day it was reported.

The business effect is the bad part: `READY_TO_SHIP` is not typed by anyone. It
is written **automatically** by `recomputeSoStockAllocation` the moment an
order's stock is all in — that module is its only writer. So the sequence was:

> the goods arrive → the system promotes the order to READY_TO_SHIP
> → the "Transfer to Delivery Order" button DISAPPEARS

The button was gone at exactly the moment the order was most ready to ship, it
went by itself, and nothing on screen said why. The server would have accepted
the delivery the whole time.

The desktop SO **detail** page offers no transfer at all (zero hits for
`transferToLabel('do')` in `SalesOrderDetailV2.tsx`), so the only remaining
desktop routes were the Delivery Planning board's context menu and the
delivery-order side's own from-SO picker. Neither is where an operator looks.

**Root cause (traced).** One rule, written twice, in two shapes that are not
equivalent:

| | shape | members |
|---|---|---|
| server, `routes/delivery-orders-mfg.ts` | **DENY-list** | `DRAFT`, `CANCELLED`, `ON_HOLD` |
| client, `pages/scm-v2/MfgSalesOrdersListV2.tsx` | **ALLOW-list** | `confirmed` |

The server's own comment states the intent in full — *"The block set is a
DENY-list (not an allow-list) so any legitimate forward status (CONFIRMED,
IN_PRODUCTION, DELIVERED, …) stays deliverable."* The client's row-drawer CTA
was a `if (s === "confirmed")` arm in a switch whose final branch is
`return null`, so every forward status past CONFIRMED fell through to no button.

A deny-list of three and an allow-list of one are not the same rule, and the gap
is every forward status. `READY_TO_SHIP` is the one that cost the business,
because it is the one the machine writes.

**Fix.** The rule gets ONE home and both sides import it:

- `backend/src/scm/shared/so-deliverable-states.ts` — `SO_UNDELIVERABLE_STATUSES`
  + `soCanRaiseDo(status)`, case-insensitive and null-safe. A blank/unreadable
  status returns `true`: the server is the gate, this decides whether to OFFER,
  and offering something the server refuses in plain language beats hiding
  something it would have taken. That matches what the server already does —
  `firstUndeliverableSo` lets a row with no readable status fall through.
- `routes/delivery-orders-mfg.ts` deletes its local `Set` and calls the shared
  predicate. **No behaviour change on the server** — same three members, same
  fall-through.
- `frontend/src/vendor/shared/so-deliverable-states.ts` is the byte-identical
  vendored copy, refereed by `so-deliverable-states.canonical.test.ts` — a real
  byte comparison, not `check-shared-mirrors.mjs`'s text heuristic, for the
  reason `do-shipped-states.canonical.test.ts` spells out.
- The row-drawer CTA switches on `soCanRaiseDo(row.status)`.

**What was checked and is NOT affected.** The mobile SO list and SO detail offer
no transfer at all, so there is no mobile twin of this allow-list to fix;
`MobileConvertWizard` filters SO rows on `isProcessible`, not on a status
allow-list; `DeliveryOrderFromSo` carries no status gate of its own. The
Delivery Planning board's context-menu entry was already unconditional on SO
status.

**The class.** A frontend copy of a server rule, written in the opposite shape.
The repo already names this — `check-shared-mirrors.mjs` exists for it, and
`do-shipped-states.ts` is the same fix applied to the delivery side. What made
this one survive is that the two copies were not recognisable as copies: one is
a `Set` of three, the other a string comparison inside a JSX switch. Nothing
could have diffed them. The remedy is the shared module, not a sharper eye.

**Ref.** `feat/list-actions-and-vocab`, 2026-08-21. Reported by the owner in
chat; traced by source read, no production query needed (the predicate is pure).
