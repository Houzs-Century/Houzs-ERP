## The Delivery Orders page failed to load — the on-hold count asked do_status for a label it never had [high]

**Symptom.** `/scm/delivery-orders` rendered its chrome and then nothing: four
KPI cards stuck on "Loading…", every filter pill reading `· 0`, and the grid
showing **"Failed to load — on_hold count failed: unknown error"**. Both
companies, every account, no row reachable. Reported by the owner 2026-08-24;
the page had been dead since #2661 deployed on 2026-08-22.

**Root cause (traced).** #2661 made Hold a MARKER rather than a status
(mig 0324) and gave the five holdable documents one shared predicate,
`document-hold.ts`'s

```
HELD_OR_TERM = 'on_hold.is.true,status.eq.ON_HOLD'
```

The second arm is the legacy reader, and on four of the five documents it is
correct: `scm.mfg_so_status`, `scm.po_status`, `scm.grn_status` and
`scm.purchase_invoice_status` all carry `ON_HOLD` permanently, because Postgres
has no `DROP VALUE`, so a mirrored or pre-0324 row can still arrive holding it.

`scm.do_status` is the one that never had the label. Its members are
`DRAFT, LOADED, DISPATCHED, IN_TRANSIT, SIGNED, DELIVERED, INVOICED, CANCELLED`
— Hold was never a step in a delivery order's life. Comparing an enum against a
label it does not define is not an empty match: it is `22P02 invalid input value
for enum do_status: "ON_HOLD"`, which PostgREST returns as **400**.

That 400 landed on the status-count read, which is the one read the list route
refuses to paper over — `readStatusCounts` reports an unreadable count rather
than serving it as `0`, and the route turns that into `500 status_counts_failed`
for the WHOLE response. So a broken count for one tab took down the entire page,
including the 39 delivery orders that have nothing to do with holds.

Production access log, every DO-list open in the window:

```
GET /rest/v1/delivery_orders?select=*&company_id=eq.2
    &or=(on_hold.is.true,status.eq.ON_HOLD)          → 400
```

The route's own comment two lines above the defect already stated the rule —
*"on this document the only thing it can read, since scm.do_status has no
ON_HOLD label"* — while the code beside it passed the shared term anyway. The
comment was right and was not reread when the term was introduced.

**Fix.** The delivery-order route filters holds by the MARKER alone,
`.eq('on_hold', true)`, in both places that ask the question: the `on_hold` tab
filter and the overlay count. The other four documents keep `HELD_OR_TERM` —
the rule genuinely differs per document, and this is the one where the legacy
arm is not merely dead but poisonous.

**Not fixed by adding ON_HOLD to `do_status`.** That was the tempting
one-word change and it is the wrong direction three times over: enum labels are
permanent, so it could never be undone; the DO vocabulary deliberately excludes
Hold, which is the whole point of #2661's marker; and `DO_STATUS_BUCKETS` is
asserted against the enum's membership by
`backend/tests/statusBucketsEnumMembership.test.mjs`, so a new label with no
bucket would fail that test — correctly.

**This is the second time this exact shape has taken the page down.** On
2026-08-17 the `delivered` bucket carried `COMPLETED`, which is also not a
`do_status` member, and the list answered `500 invalid input value for enum
do_status: "COMPLETED"`. Same enum, same class of defect, seven days apart: a
status-shaped string reaching `do_status` from code that was never checked
against the enum's actual membership. The guide's bucket section carries both
notes now.

Pinned by `backend/tests/doListOnHoldEnumSafe.test.ts` (3) — a source scan, not
a unit test, because the compiler cannot help here: `HELD_OR_TERM` is a plain
string and every one of the five tables really does have an `on_hold` column, so
nothing in the type system knows which enum lacks the label. The scan strips
comments before matching, so the rule can still be explained in prose beside the
code it governs. Proved RED by restoring `.or(HELD_OR_TERM)` — 2 of 3 fail.

**Ref.** `fix/do-list-on-hold-enum`, 2026-08-24. Follows #2661.
