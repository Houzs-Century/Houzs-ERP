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
| Payment Voucher | `POSTED` | Confirmed |
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
| DO `DISPATCHED` | **Shipped** | the stock has left the building — the first entry into it writes the inventory OUT. `LOADED` is the DO's confirm step: document real, nothing moved yet |
| SI / PI `PARTIALLY_PAID`, `PAID` | Partially Paid, Paid | money, not commitment |
| PO `PARTIALLY_RECEIVED`, `RECEIVED` | Partially Received, Received | progress, not commitment |
| GRN `CLOSED` | Closed | finished, not committed |

### Where the rule is enforced, and where it ISN'T

`frontend/src/vendor/scm/lib/status-pill.ts` carries the canonical map and the
rule in its header. **It is not the only copy, and pretending otherwise is how
this drifted.** Sixteen list and detail pages declare their own
`{ tone, label, bucket }` map, because they need the bucket and the blurb that
`status-pill` does not carry. Those copies were aligned by hand on 2026-08-21.

> **OPEN — the root fix is not done.** Those sixteen pages should read their
> LABEL from `status-pill` and keep only their own bucket/blurb. Until they do,
> a seventeenth page can invent a sixth word and nothing will say so. Adding a
> document type today? Its confirm step reads **Confirmed**, in `status-pill.ts`
> AND in that page's own map.

### `ON_HOLD` on the purchase side (2026-08-21, migs 0318/0319/0320)

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
three that no machine can derive, because each is a DECISION:

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

Everything else is written from a fact and would be overwritten by the next
sweep — `IN_PRODUCTION` from a processing date, `SHIPPED` from a delivery order,
`READY_TO_SHIP` from stock allocation, `DELIVERED` from delivery coverage,
`INVOICED` from invoice coverage. Hand-setting one changes the LIST, not the
fact, so the only lasting effect is a window in which the screen lies.

This is the mainstream ERP shape, not a local preference: SAP derives an order's
overall status from item processing status and gives a person a block and a
rejection; NetSuite computes Partially Fulfilled / Pending Billing and gives a
person Close and Cancel. The human button list is short everywhere, for this
reason.

See `docs/bugs/0515-the-sales-order-right-click-let-a-person-hand-write-a-status.md`.

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
move. Cancel stays reachable from Closed, because an order that turns out to be
void entirely is the cancel guards' question, not the transition table's.

**A closed order still earns its commission**, deliberately —
`COMMISSION_EXCLUDED_STATUSES` in `backend/src/scm/shared/hr-commission.ts` does
not name it. The part that went out was really sold.

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
