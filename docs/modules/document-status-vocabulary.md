# Module: Document status vocabulary — the WORDS on the pills and the date labels

The one home for a question that had no home, which is why it drifted for a
year: **what word does each document show for the step where it stops being a
draft, and what is the delivery date called?**

> Written 2026-08-21 from the owner's two rulings that day. This guide owns the
> DISPLAY layer only. What each status MEANS, when it moves and what it blocks
> stays in the per-document guides — `sales-order.md` §0, `delivery-order.md`,
> `grn.md`, `sales-invoice.md`, `purchase-order.md`.

---

## 1. One word for "this document is real"

**The owner, 2026-08-21:** 「为什么会有这么多不一样的名词」 — and, choosing
between changing the screens and changing the database: 「那就 A」.

The step where a document stops being a draft and becomes committed is **stored
under five different words**, because each document type was written at a
different time and each one picked its own:

| document | STORED value | shown on screen |
|---|---|---|
| Sales Order | `CONFIRMED` | Confirmed |
| Purchase Order | `SUBMITTED` | Confirmed |
| GRN | `POSTED` | Confirmed |
| Purchase Invoice | `POSTED` | Confirmed |
| Purchase Return | `POSTED` | Confirmed |
| Stock Transfer | `POSTED` | Confirmed |
| Stock Take | `POSTED` | Confirmed |
| Payment Voucher | `POSTED` | **Approved** — the one exception since 2026-09-02: the owner's four layers (payment-voucher.md §0b) make approval the step that posts, so the pill wears his word for it; the stored value stays `POSTED` like the rest of this table |
| Sales Invoice | `SENT` | Confirmed |
| Delivery Order | `LOADED` | Confirmed |

**The stored values are UNCHANGED and must stay unchanged.** That is the whole
reason option A was recommended over renaming the columns: AutoCount, every
report, every export and every historical document read the stored value, and
none of them is affected by a label. Renaming the columns was costed at two to
three weeks against one to two days, on the money-and-stock path.

### What deliberately keeps its own word

These are **different events**, not second names for the confirm step. Do not
sweep them into "Confirmed" in a later tidy-up:

| value | word | why it is not "Confirmed" |
|---|---|---|
| DO `DISPATCHED` | **Loaded** | the goods are physically ON the lorry. `LOADED` is the DO's confirm step and reads Confirmed: document real, stock already out. See the relabel note directly below |
| SI / PI `PARTIALLY_PAID`, `PAID` | Partially Paid, Paid | money, not commitment |
| PO `PARTIALLY_RECEIVED`, `RECEIVED` | Partially Received, Received | progress, not commitment |
| GRN `CLOSED` | Closed | finished, not committed |

### `DISPATCHED` reads **Loaded**, not "Shipped" (owner, 2026-08-26)

**His question:** 「dispatch就是出发了啊?」 — does dispatch mean it has left?

**On the three-scan flow he settled the same week, no.** DISPATCHED is written by
the STOREKEEPER when the goods go ON the lorry; DEPARTURE is the driver's next
scan, and that is `IN_TRANSIT`. "Shipped" claimed the truck had gone, one step
early, on every list and every pill.

**The obvious word was taken.** `LOADED` is the DO's confirm step and reads
**Confirmed** (the table above), so DISPATCHED could not simply be called by its
own value's name — the two would collide. Hence: stored `LOADED` shows
*Confirmed*, stored `DISPATCHED` shows *Loaded*.

| stored | shown | who writes it |
|---|---|---|
| `LOADED` | Confirmed | the office, raising the delivery order |
| `DISPATCHED` | **Loaded** | the storekeeper's scan — goods on the lorry |
| `IN_TRANSIT` | In Transit | the driver's scan — the lorry leaves |
| `DELIVERED` | Delivered | the driver's scan at the address, or Proof of Delivery |

**The STORED value did not change and must not.** Postgres enum labels are
permanent, and every report, export and AutoCount read goes to the stored value.
Same option A as the "Confirmed" sweep above, same reasoning.

**Pinned, because a hand-aligned sweep is what drifted last time.**
`frontend/src/pages/scm-v2/doDispatchedReadsLoaded.test.ts` asserts the two label
maps AND source-scans every `frontend/src` file for a line naming `DISPATCHED`
beside a `Shipped` / `Dispatch`-shaped label. That scan is the half that covers a
page nobody has written yet, and it found a site the hand-sweep had missed
(`frontend/src/mobile/MobileModuleList.tsx`'s DO filter chip) while it was being
written.

**Deliberately untouched: the SALES ORDER's `SHIPPED`.** Different document,
different enum, folded into Delivered separately by #2655.
`frontend/src/mobile/MobileSalesOrders.tsx` still lists a Shipped chip — stale for
its own reasons, and a separate item.

### The delivery order's three scans (owner, 2026-08-25/26)

**His words:** 「(a) Storekeeper 扫码确认货物装上罗里 (b) 司机出发（IN TRANSIT）
(c) 送达（DELIVERED）」 and 「就是我状态只要一点，它基本上都只能剩最后一个状态（下
一个状态）」.

One QR on the delivery order print, scanned three times, each scan moving the
document exactly one rung. `frontend/src/pages/scm-v2/DoLoadScan.tsx` shows the
next rung and only the next rung — no picker, no skipping, no way back.

| the document is | the button | it writes |
|---|---|---|
| `DRAFT` | Confirm loading | `LOADED` |
| `LOADED` (shows Confirmed) | Confirm Loaded | `DISPATCHED` |
| `DISPATCHED` (shows Loaded) | Confirm Departure | `IN_TRANSIT` |
| `IN_TRANSIT` | Confirm Delivered | `DELIVERED` |
| `SIGNED` / `DELIVERED` / `INVOICED` | none — "Nothing left to do on this document." | — |
| `CANCELLED` | none — a refusal telling them to call the office | — |
| on hold | none — it says it is on hold | — |

**Stock is not touched by any of it.** 「只要我一开 DO，我就扣库存。In transit、
Delivered，这些都只是状态，看一下情况而已。」 The inventory OUT fires on the first
entry into a shipped state and `LOADED` is already one, so every rung past the
confirm finds the deduction done.

**`SIGNED` is never written by this ladder, and that is enforced by the TYPE.**
`DoScanStep['status']` is an `Extract<DoStatus, …>` over four labels, so a fifth
target does not compile. `SIGNED` counts as delivered everywhere
(`doCountsAsDelivered`), which is exactly why a bare button writing it was bug
`0481`; nothing has written it since 2026-08-21 and this does not reopen it. A row
that already holds SIGNED is answered as finished.

**Scan ③ is NOT a signed receipt, and the screen says so before it is pressed.**
It writes `DELIVERED` and collects no signature, no photo and no location. Bug
`0481` is the record of what that costs when it is left unsaid —
*"the status is literally named for the evidence it does not collect"* — so
`DO_SCAN_DELIVERED_EVIDENCE_NOTE` names all three losses and names Proof of
Delivery (`frontend/src/mobile/MobilePOD.tsx`) as the screen that captures a real
one. Capturing a second time here was rejected on bug `0480`'s reasoning: a second
capture path is the divergence that entry was written about.

**The on-hold refusal is the SCREEN's, not the server's.** `PATCH /:id/status`
does not read `on_hold` — mig 0324 gave the delivery order the marker columns and
left the handler alone — so a held document can still be advanced from elsewhere.
Worth knowing before anyone cites this screen as the guarantee.

### Where the rule is enforced, and where it ISN'T

`frontend/src/vendor/scm/lib/status-pill.ts` carries the canonical map and the
rule in its header. **It is not the only copy, and pretending otherwise is how
this drifted.** Sixteen list and detail pages declare their own
`{ tone, label, bucket }` map, because they need the bucket and the blurb that
`status-pill` does not carry. Those copies were aligned by hand on 2026-08-21.

> **OPEN — the root fix is not done ON THE SCREENS.** Those sixteen pages should
> read their LABEL from `status-pill` and keep only their own bucket/blurb. Until
> they do, a seventeenth page can invent a sixth word and nothing will say so.
> Adding a document type today? Its confirm step reads **Confirmed**, in
> `status-pill.ts` AND in that page's own map.

> **DONE ON THE PAPER — 2026-08-26.** The printed documents were a
> seventeenth-to-twenty-fifth surface of exactly this shape, and worse than a
> stale copy: they had no map at all. Nine generators each ran their own
> `replace(/_/g,' ').toLowerCase()…` over the RAW STORED VALUE, so a delivery
> order stored `LOADED` printed **LOADED** while every screen said Confirmed —
> and after the `DISPATCHED` → "Loaded" relabel directly above, the word *Loaded*
> named one rung on paper and a different rung on the list. Ten of the vocabulary's
> values printed the wrong word; the full table is in
> `docs/bugs/0548-every-printed-document-title-cased-the-raw-stored-status-ins.md`.
>
> All nine now call `statusLabel(docType, status)`. The document types they map
> to are `do`, `dr`, `grn`, `pi`, `pr`, `si`, `so`, `stockTake`,
> `stockTransfer`; the purchase order sheet prints no status at all, by design.
> The SO / PO amendment document reads `simplifiedAmendmentPill` — it printed
> "Requested" on a REJECTED amendment until this change.
>
> **Adding a printed document? It reads its status from `status-pill.ts`, and
> `frontend/src/vendor/scm/lib/pdf-status-label.test.ts` is what makes that
> non-optional.** It renders every generator for EVERY member of its vocabulary
> and compares what `doc.text` painted; a source scan over `*-pdf.ts` catches a
> generator that is not in its table yet.
>
> **One word is still unsettled and it is the owner's to pick.**
> `status-pill.ts` says SO `IN_PRODUCTION` reads **Proceed**;
> `frontend/src/pages/scm-v2/so-list-status.ts` says **In Production** while its
> own comment claims the two match exactly. Both are live on screens. The printed
> sales order now follows `status-pill.ts`, so it says *Proceed* where it said
> *In Production* before this change.

### A HOLD IS NOT A STATUS — it is a MARKER beside one (2026-08-22, migs 0324/0325)

**The owner, 2026-08-22:** 「我们的hold是给我们知道一个 order hold这的」 — the hold
exists so people KNOW an order is paused. And 「take off hold也要看」 — releasing
had to be looked at too.

**This is the one rule to take away from this section.** A hold answers a
different question from a status, so it lives in a different column:

| | says | written by | example |
|---|---|---|---|
| `status` | where the document has GOT TO | mostly the system, from facts | In Production, Partially Received, Dispatched |
| `on_hold` | that a PERSON stopped it | only a person | Hold |

Since mig 0324 every one of the five documents — Sales Order, Purchase Order,
GRN, Purchase Invoice, **Delivery Order** — carries four columns: `on_hold`
(boolean, default false), `hold_reason`, `held_at`, `held_by`. **`status` is
never written by a hold, in either direction.** Taking a hold off therefore
restores nothing, because nothing was lost.

**What it replaced, and why that was a defect rather than a preference.** The
hold used to be written INTO `status`. Holding an `IN_PRODUCTION` sales order
overwrote the progress, no `previous_status` column existed anywhere in `scm` to
recover it from, and `Take Off Hold` consequently sent EVERY released order to
`CONFIRMED` regardless of where it had been. Full trace:
`docs/bugs/0516-putting-an-order-on-hold-destroyed-its-progress-and-taking-i.md`.

**On screen: the status pill AND a Hold chip, never one instead of the other.**
`frontend/src/vendor/scm/components/HoldChip.tsx` is the one home for that chip.
A held delivery still says Loaded — the warehouse needs that — and carries Hold
beside it. The chip's tone is `pending`, not `danger`: a hold is reversible and
deliberate, and red is what this system uses for cancelled.

**The `on_hold` TAB reads the flag, and it OVERLAPS every other tab.** A held
document is counted under its real status too, so the pill counts deliberately do
not sum to All — the same overlap the Purchase Order list's `outstanding` pill
has carried since 2026-07-31. On the Sales Order list, `other = all − known` is
still computed from the status walk alone, so the sum-to-All invariant the owner
bought on 2026-07-24 is untouched.

**The Delivery Order got its first hold ever here**, and it needed no enum change
at all — `scm.do_status` is untouched. That is the plainest argument for the
marker: giving the other three a status-hold cost three irreversible
`ALTER TYPE ... ADD VALUE` statements.

#### `ON_HOLD` the LABEL is retired from writing and kept for ever in reading

Postgres has no `DROP VALUE`, so `ON_HOLD` stays a legal member of
`scm.po_status`, `scm.grn_status`, `scm.purchase_invoice_status` and
`scm.mfg_so_status` permanently. The rule is the same one `CLOSED` and `SHIPPED`
follow:

- **Nothing writes it.** `PATCH /mfg-sales-orders/:docNo/status` refuses it with
  `hold_is_not_a_status`; it is accepted as a `from` so a legacy row can leave.
- **Everything still renders it.** Every pill map keeps its `ON_HOLD` entry, and
  the status buckets keep `on_hold: ['ON_HOLD']` so such a row is still reachable
  from a tab — the 37-invisible-delivery-orders fault
  `statusBucketsEnumMembership.test.mjs` exists to prevent.
- **`isDocumentHeld` reads the flag OR the label**, backend and browser alike, so
  one such row behaves exactly as it did before.

Measured, not assumed: production carried **zero** rows on `ON_HOLD` across all
five tables when the flag shipped — read-only probe
`backend/scripts/check-hold-and-shipped-rows.mjs`, workflow run 32573160010,
2026-08-22. The legacy arm is dead code today and permanent anyway, because "no
row has it" is a fact about one moment and the enum label is not.

#### Where the hold's code lives

One row per file, because the reason this guide exists is that the same question
had answers in sixteen places. These are the homes; nothing else decides a hold.

| file | what it owns |
|---|---|
| `backend/src/db/migrations-pg/0324_scm_hold_is_a_marker_not_a_status.sql` | the four columns on all five tables, plus the partial indexes the On Hold tabs read |
| `backend/src/db/migrations-pg/0325_scm_so_payment_totals_view_carries_hold.sql` | the Sales Order list's view, taught the four columns — `CREATE OR REPLACE`, never DROP, so the GRANTs 0189 lost cannot be lost again |
| `backend/src/scm/lib/document-hold.ts` | `isDocumentHeld` (flag OR legacy label), `HOLD_COLUMNS`, `HELD_OR_TERM`, and the request/patch shapes. The one place that knows a hold writes four columns and never `status` |
| `backend/src/scm/lib/document-hold-route.ts` | the single `PATCH .../hold` handler behind all five documents |
| `backend/src/scm/routes/document-hold-routes.ts` | mounts it, and records what each document's hold means, side by side |
| `backend/src/scm/lib/source-document-gates.ts` | the four conversion gates that must read the marker: SO → DO, SO → PO, PO → GRN, GRN → PI. Moved here 2026-08-22 because all four had to change for the same reason at the same time |
| `frontend/src/vendor/scm/components/HoldChip.tsx` | the Hold chip, `rowIsHeld`, and `StatusWithHold` — the status pill and the chip as one element, so a screen cannot render the pill alone |
| `frontend/src/vendor/scm/lib/document-hold-queries.ts` | the one mutation. It never sends a status; that is the property to check if it is edited |
| `frontend/src/pages/scm-v2/use-hold-action.ts` | the confirm wording, so all five screens promise the same thing |
| `frontend/src/pages/scm-v2/row-menus.ts` | where Put On Hold / Take Off Hold is offered, on all five right-click menus |
| `frontend/src/pages/scm-v2/do-list-status.ts` | the Delivery Order list's `on_hold` tab — the one tab on that screen that is not a status |

#### Every place a hold DECIDES something

A guard that asks *"may somebody ACT on this document"* must read the flag. A
writer that *re-derives a status from a fact* must not — writing `status` can no
longer erase a hold, and freezing a held document's counts would be the same
lossiness the marker removes. The two sites in the second group are
`recomputePoReceived` (`backend/src/scm/routes/grns.ts`) and `DELIVERABLE_FROM`
(`backend/src/scm/lib/so-delivery-sync.ts`), and both say so in a comment.

**Two blocks that used to come FREE and now do not.** Migrations 0318 and 0319
each state in their own header that a held PO could not be received, and a held
GRN could not be billed, because the reads filter on an ALLOW-list. That was true
only while the hold overwrote the status. Both now check the marker explicitly:
`isReceivablePo` in `grns.ts`, and the `.eq('on_hold', false)` on the
billable-GRN read in `purchase-invoices.ts`. Missing either one writes stock IN,
or bills a supplier, against a document somebody deliberately stopped.

### `ON_HOLD` on the purchase side (2026-08-21, migs 0318/0319/0320)

> **SUPERSEDED for the mechanism, kept for the labels.** The three migrations
> below added `ON_HOLD` as a STATUS. Mig 0324 moved the hold to a flag (see the
> section above); the labels these three added stay in the enums and in the pill
> maps for ever, and nothing writes them any more.
>
> Worth knowing before adding a hold to a sixth document: **all three of these
> shipped with no way to reach them.** The word appeared on the tab, the pill and
> the detail blurb, and nothing in `frontend/src` ever sent that status — this
> router family exposes no generic status endpoint. Three screens rendered a
> state the product could not produce, for a day, and no check said so.

The Purchase Order, GRN and Purchase Invoice gained a REVERSIBLE stop — owner:
「PO 加 hold / GR / PI also hold」. All three read **On Hold** in `status-pill.ts`
and in their own detail maps.

**Adding a status means updating every map that can be handed it, and the detail
pages carry TWO each** — a label map and an `effectiveOf` chain. All three
`effectiveOf` chains end in a default arm, so before this change a held document
would have rendered as *cancelled*, *draft* and *partly paid* respectively. See
`docs/bugs/0512-a-held-purchase-document-read-as-cancelled-draft-or-partly-p.md`.

### Not renamed, and it would be wrong to

The Sales Invoice **Sent** tab and the Delivery Order **Open** tab are BUCKETS
holding several statuses — `sent` contains `DRAFT`, `SENT` and `OVERDUE`.
Calling a bucket "Confirmed" would state something false about the drafts inside
it. They are fixed by the separate tabs-equal-statuses change, not here.

---

## 1b. Only FOUR status moves are ever offered to a person

**The owner, 2026-08-22:** 「它不应该能转到 Mark in Production、Mark Shipped 和
Mark Invoiced ... 按理说不应该允许这样手动去转，否则我们的 transaction workflow
就全乱了」, and the reason: 「如果它已经有 processing date 了，我又把它换成别的状态
的话，那不是代表我的状态全部都 wrong 完了、是错完了吗？」

**The rule, and it decides membership rather than listing it:** a status a
MACHINE derives from a fact is never offered to a person. What is left is the
four that no machine can derive, because each is a DECISION:

| offered | why it cannot be derived |
|---|---|
| **Confirm** | a draft becomes real when a human says so |
| **Hold** | a person decided to pause this document |
| **Close remaining** | a person decided the rest is not coming |
| **Cancel** | a person decided this document should not happen |

**It was three until 2026-08-22 and the rule is what added the fourth**, not a
change of mind. The rule decides membership: a status a machine derives is never
offered, and **Close** cannot be derived by anything. Nothing in this system
knows that a customer took 7 of the 10 he ordered and does not want the last 3,
or that the supplier cannot supply them — only the person on the phone knows.
Asked whether that case happens here, the owner: 「有的」.

### What a machine actually derives on a Sales Order — CORRECTED 2026-08-22

> **This table replaces one that was wrong.** The version merged with #2655 named
> five machine-derived statuses. Re-checked against `origin/main` on 2026-08-22,
> two of the five have no writer at all and a third never had one. The old table
> described what the system was MEANT to do and stated it as fact — the same
> failure this repo keeps paying for, and the correction is the useful part, so
> it is recorded rather than quietly overwritten.

| status | what writes it today | derived? |
|---|---|---|
| `READY_TO_SHIP` | `lib/so-stock-allocation.ts` — advances a CONFIRMED / IN_PRODUCTION order when every main line is ship-ready, and regresses it when one is not | **yes** |
| `DELIVERED` | `lib/so-delivery-sync.ts` — advances when delivery orders fully cover the lines, releases back to READY_TO_SHIP when they stop covering. **Since 2026-09-04 the release needs POSITIVE evidence** (a cancelled DO, a reduced line, a return): a delivery order that counts as delivered yet holds no line rows is broken evidence, not an un-delivery, so the order is HELD at DELIVERED and a `RELEASE_REFUSED` audit row names the document (`emptyLiveDeliveries`; docs/bugs/0637, delivery-order.md "integrity lock") | **yes** |
| `IN_PRODUCTION` | nothing. A person sets it through `PATCH /:docNo/status` (`routes/mfg-sales-orders.ts`). `lib/so-processing-date.ts` names it only in comments, and the `autoProceed` / `proceeded_at` stamp was removed on 2026-08-18 | **no** |
| `SHIPPED` | nothing, anywhere. Every occurrence in `backend/src` is a read predicate, a bucket or a rank — `so-delivery-sync.ts` only READS it. Its tab folded into Delivered in #2655, so on a Sales Order it is a dead label | **no** |
| `INVOICED` | nothing. No path writes a Sales Order to this status | **no** |

**The rule is unaffected and the three buttons stay removed** — but the honest
reason is now two reasons rather than one:

- `READY_TO_SHIP` and `DELIVERED` are genuinely machine-written, so the original
  argument holds exactly: hand-setting one changes the LIST, not the fact, and
  the next sweep overwrites it. The only lasting effect is a window in which the
  screen lies.
- `IN_PRODUCTION`, `SHIPPED` and `INVOICED` are not written by anything, so the
  argument for THEM is different: offering a button for a status the system
  makes no use of would put a value on screen that nothing downstream reads.

**The Processing Date is the real gate, and it is independent of the status.**
This is the most useful thing the re-check turned up and it was written down
nowhere. In `routes/mfg-sales-orders.ts` a Processing Date is what RELEASES an
order to purchasing, and the 422 completeness gate beside it is what refuses.
`IN_PRODUCTION` as a STATUS currently decides nothing — the date does. That is
why wiring the date to the status would give the status a meaning it does not
have today, and it is why the owner wants it: 「应该是只要有processingdate 就会进
in production 不是吗」. **PLANNED, NOT BUILT** — he also said 「这个事之后才用的」,
so nothing here builds it.

This is the mainstream ERP shape, not a local preference: SAP derives an order's
overall status from item processing status and gives a person a block and a
rejection; NetSuite computes Partially Fulfilled / Pending Billing and gives a
person Close and Cancel. The human button list is short everywhere, for this
reason.

See `docs/bugs/0515-the-sales-order-right-click-let-a-person-hand-write-a-status.md`.

### EXCEPTION — the Delivery Order's three manual moves (2026-08-22, temporary)

`Mark Loaded`, `Mark In Transit` and `Mark Delivered` ARE offered on the
Delivery Order right-click menu (`frontend/src/pages/scm-v2/row-menus.ts`,
`deliveryOrderRowMenu`). This is a deliberate, dated exception, and it satisfies
the rule's own criterion rather than waiving it: **a status a machine derives is
never offered to a person, and today no machine writes any of these three.**

The owner asked for them as groundwork: 「保留全部状态 我可以convert，可是库存当我
开了DO 就是confirmed的时候就直接扣。然后我的shipped in transit delivered 我手动维
护，之后我才弄自动」, and confirmed that is what they are — 「是的 因为现在完全没有
这些功能 提前铺路而已」.

**They cannot move stock, which is what makes a right-click acceptable on the one
document where a status move normally could.** Since 2026-08-22 the inventory OUT
fires on the first entry into a shipped state, and that state is `LOADED`
(Confirmed). Every status these three entries can reach is already past Confirm,
so the deduction finds the delivery order's own OUT rows and returns without
writing. They are withheld from a `DRAFT` — where they WOULD be the deducting hop
— and from a `CANCELLED` delivery order, which the server refuses every
transition out of.

#### The end state each entry is temporary against

| status | what will write it, once built | what retires the manual entry |
|---|---|---|
| **Loaded** (`DISPATCHED`) | the storekeeper scanning the QR on the delivery order print — **BUILT 2026-08-26**, `DoLoadScan` now offers this rung | the storekeepers actually scanning. Existing is not in use, and only the owner can say which it is |
| **In transit** (`IN_TRANSIT`) | two writers: the driver trip flow, `frontend/src/mobile/MobileDeliveryPlanning.tsx`, and the driver's second scan on `DoLoadScan` (**BUILT 2026-08-26**) | the drivers actually scanning. The trip flow has never written a row |
| **Delivered** (`DELIVERED`) | the driver's Proof-of-Delivery signature, `frontend/src/mobile/MobilePOD.tsx` — the ONE writer that exists today | already has a machine. The manual entry is the stopgap for sites not using the driver app, and asked directly whether drivers use it the owner answered 「没有」 |
| **Invoiced** (`INVOICED`) | **PLANNED — NOT BUILT.** Reaching Delivered would raise the Sales Invoice automatically: 「然后delivered了之后Invoice 就可以自动开了 这个之后再弄」 | that automation existing |

**There is no `Mark Invoiced` entry and none is to be added.** The owner did not
ask for one, and `frontend/src/vendor/scm/lib/do-next-step.ts` already records
the measurement behind that: nothing in this codebase writes
`delivery_orders.status = 'INVOICED'`, so the label means "somebody clicked it",
not "this was billed".

### Close is not Cancel, and the menu must say so

They sit two entries apart in the same right-click menu and they do opposite
things to the money, so the words carry the whole load:

| | what happens to the document | what happens to what was delivered |
|---|---|---|
| **Close remaining** | it STAYS | it STANDS — really sold, really invoiced |
| **Cancel** | VOIDED, as if it never happened | unwound; any deposit becomes customer credit |

**The label is "Close remaining", never "Close".** On its own the word reads as
*finish*, and finishing is the opposite of what this does — a remainder is being
ABANDONED. Cancel is final and reaches AutoCount, which has no un-cancel; Close
is a decision to stop chasing an outstanding balance on an order that really
happened.

**No machine may ever write it.** There is no sweep to add later: nothing in the
system holds the fact that a remainder was given up on. It is manual-only on the
Sales Order, and a closed order cannot be walked back into an earlier live status
(`soStatusTransitionError`, 409) — un-deciding it is a new order, not a status
move. That refusal is load-bearing on its own and not merely the closing half of
the old ON_HOLD laundry: `CLOSED` is unranked, so without the arm `CLOSED →
DRAFT` falls through the rank block and is allowed outright. Cancel stays reachable from Closed, because an order that turns out to be
void entirely is the cancel guards' question, not the transition table's.

**A closed order still earns its commission**, deliberately —
`COMMISSION_EXCLUDED_STATUSES` in `backend/src/scm/shared/hr-commission.ts` does
not name it. The part that went out was really sold.

#### Close and the HOLD marker are ORTHOGONAL, and no gate was added either way

Checked deliberately when the two landed on the same day, and stated here
because "we looked and chose not to block it" is a different answer from "nobody
thought about it":

| asked | answer | why |
|---|---|---|
| may a HELD order be closed? | **yes** | `PATCH /:docNo/status` does not select `on_hold` and never calls `isDocumentHeld`; `soStatusTransitionError` only ever sees the status string. The right-click **Close remaining** is likewise gated on status alone |
| may a CLOSED order be put on hold? | **yes** | `document-hold-route.ts` states in its own header that it does not gate on status — *"A cancelled document can be marked, and that is intentional"* — and the menu offers the marker on every row |

That is the marker's whole point. A hold is information stuck beside the
progress, not a step in it, so blocking either direction would re-couple the two
things migration 0324 separated. A closed order carrying a Hold chip reads
exactly as it should: *the remainder is not coming, and somebody has flagged
this one for attention.*

**One thing did change in the transition table.** `CLOSED → ON_HOLD` is now
refused as `hold_is_not_a_status` (409) rather than by the close guard, because
`ON_HOLD` is refused as a TARGET for every source since mig 0324. `ON_HOLD →
CLOSED` is ALLOWED — a legacy row still sitting on the retired label must have a
way to be closed.

> **This is a RESTORATION, not a reversal.** `CLOSED` was removed from the app
> vocabulary on 2026-08-21 and that removal was CORRECT: what it removed was a
> vague lifecycle step sitting after Invoiced that nobody used, proven empty
> before it went. What came back on 2026-08-22 is a different decision wearing
> the same enum label. The evidence for the removal is kept in
> `backend/src/scm/lib/so-lifecycle-guards.ts` beside the new definition rather
> than deleted.

**The Purchase Order side is NOT built and is an open question for the owner.**
The supplier who cannot supply the rest is the mirror image of this case, and the
GRN already has a `CLOSED` of its own — but he was asked about the Sales Order,
so only the Sales Order was changed.

### `SHIPPED` folds into Delivered on the Sales Order

**The owner, same day:** 「Sales Order 的 Shipped 跟 Delivered 是合起来的」. On a
sales order both say "the goods went out"; the difference between LEFT and
ARRIVED is what the Delivery Order is for.

It **folds**, it is not deleted — `backend/src/scm/lib/so-tab-statuses.ts`.
Postgres cannot `DROP VALUE`, so `SHIPPED` stays a legal label for ever, and
`so-delivery-sync.ts` still writes it whenever a delivery order is raised.

**Why fold rather than leave it to the catch-all.** The Sales Order list is the
one list that HAS a catch-all — an **Other** tab that appears when
`other = allCount - known` is non-zero — so an unfolded `SHIPPED` order would
have been reachable. The reason is the reader: goods that went out belong under
**Delivered**, not under **Other**.

**The four purchase/delivery lists have no catch-all**, and there an unbucketed
status genuinely is reachable from no tab and subtracted from the count on
screen. That is the fault `status-counts.ts` exists to make loud — 37 delivery
orders invisible on 2026-08-17 while the numbers looked settled — and it is why
`*_STATUS_BUCKETS` maps must partition their enum exhaustively
(`backend/tests/statusBucketsEnumMembership.test.mjs`) while the Sales Order tab
map deliberately does not carry that name.

---

## 1a. One COLOUR rule for the Branding chip

**The owner, 2026-08-21:** 「比如 Mattress 和 Sofa 用不一样的颜色，要不然 Happy
Sleep Mattress 和 Accessories 那些颜色不一样，看起来不是很奇怪吗？」 — he was
looking at two mattresses in two different colours. Offered one colour for
everything or a colour per category, he chose **per category**.

### Why it looked random

Five lists each hand-wrote the same function, and every copy matched on the
LABEL TEXT rather than on what the line is:

```
if (s.includes("2990") || s.includes("SOFA")) return "success";
...
return "warning";                    // everything else
```

`2990S MATTRESS` matched the digits **"2990"** and came out green. `HAPPI.S
MATTRESS` matched nothing and fell through to amber. **The colour was decided by
whose brand name contained a number.**

The five copies had already split into three spellings — the Sales Invoice list
carried three tones where the others had four, the Delivery Order and Delivery
Return lists had lost the BEDFRAME arm, and the mobile pill mapped four tones
onto three CSS classes, so a bedframe chip turned mattress-amber on the phone
and accent on the desktop for the same order.

### The rule

**The colour says what the line IS; the label says whose brand it is.**
`frontend/src/lib/brandingTone.ts` is the one home, and its four groups are
exactly the buckets `brandingCategoryNoun` already resolves:

| group | tone |
|---|---|
| Sofa | success |
| Bedframe | accent |
| Mattress | warning |
| Accessory / Service / Dining / Bedlines / Diffuser / Carpet / Other | neutral |

### Two entry points, and the difference is not cosmetic

- **`brandingToneForCategory`** is the truth. The Sales Order list and the mobile
  Orders card carry the line's category, so colour and label share one bucket
  rule and cannot disagree.
- **`brandingToneForLabel`** is a **BRIDGE**. Sales Invoice, Delivery Order and
  Delivery Return carry only the stored `branding` text and no category at all,
  so it recovers the bucket from the nouns the label is built out of.
  Deterministic for every label this system produces, **not** for arbitrary text.

> **OPEN.** The proper fix is to put the first line's category on those three
> list payloads, the way the Sales Order list already does. Until then the
> bridge is the honest approximation, and it is named as one rather than left to
> look like the rule.

`ZANOTTI` names no furniture, so a Zanotti sofa would have read as OTHER and
turned grey beside a green 2990s sofa — the same product, two colours, one
tenant apart. Both house sofa brand names are read from the module that owns
them instead of being re-typed.

---

## 2. One name for the Delivery Date

**The owner, 2026-08-21:** *"为什么我外面的 listing 写着 customer
delivereydate，里面却是 delivery date？这种应该要统一的吧"*

One column, `scm.mfg_sales_orders.customer_delivery_date`, was shown under
**four different labels**: "Customer Delivery Date" (SO list, both Consignment
Note screens), "Delivery date" (SO detail, SI detail, DO list, mobile SO
detail), "Delivery Date" (SO form). It is **Delivery Date** on all of them now.

**It drifted because it was never REGISTERED.** Its partner, Processing Date,
is in `backend/scripts/lib/vocabulary.mjs` and held its name; this one was not,
so the pair was half-governed. It is registered now, which is the part that
stops it happening again — not the rename.

### The column that must NOT share the name

`line_delivery_date` is a **second, real column**: the per-line date that
cascades from the header value and can then be hand-overridden per line
(`MobileNewSO`'s `ddate`). Its label is **Line Delivery Date**.

Folding it into "Delivery Date" would put two live columns under one name —
exactly the fault the registry exists to prevent, committed in the act of
fixing it. `amended_delivery_date` is likewise its own column (the rescheduled
date the delivery board writes) and keeps its own label.

### The pair rule this name belongs to

An order carries **both** dates or **neither** — `soDatePairRefusal` in
`backend/src/scm/shared/so-processing-date.ts`, enforced on every path Houzs
authors and deliberately NOT on the 2990 SO mirror. See
`docs/modules/sales-order.md` for the gate and
`docs/bugs/` for the 28 imported orders that exemption cost.

---

## See also

- `backend/scripts/lib/vocabulary.mjs` — the registry. A concept with a name
  worth holding belongs in it; one that is not in it will drift, and both of
  the concepts above are the evidence.
- `docs/modules/document-conversion.md` §9.6 — the sibling ruling that gave the
  transfer buttons one generated label instead of twenty hand-written ones.
