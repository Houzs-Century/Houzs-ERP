## A LOADED delivery order may be invoiced — the owner ruled, and the rule now has one home [high]

<!-- area: Delivery, DO, returns -->

**Symptom.** The desktop offered "Transfer to Sales Invoice" on a delivery order
still marked LOADED, and the server's picker returned nothing for it. One rule,
two homes, disagreeing — with no error anywhere.

**The ruling (owner, 2026-08-20).** Asked directly whether the system should
REFUSE to invoice a LOADED delivery, he chose **不要拦 —— 人自己知道** ("don't
block it — the person knows"), on the grounds he gave himself:

> 「发票是invoice？等送完货了我们才自己convert to invoice啊」
> 「我们自己开啊 manually开的不是吗」

The invoice is raised BY HAND, by someone who knows whether the goods arrived, so
the system does not second-guess them. Consistent with his standing posture for
this system — loosen as far as possible, a hard wall is the last resort. Note
that those two sentences DESCRIBE the practice; read as a request to enforce it
they say the opposite of what he decided, which is why the ruling is quoted here
rather than summarised.

**Root cause (traced).** Two merged PRs answered the same question differently.

- **#2485 (owner, 2026-08-19)** opened the invoice to LOADED *deliberately* —
  verified against the diff, not the prose, because the tempting reading is that
  "every confirmed DO" swept it in by accident. It names LOADED four times: it
  replaced `['signed','delivered']` with `['loaded','dispatched','in_transit',
  'signed','delivered']`, DELETED a guard reading `s === 'loaded'` whose message
  was *"Mark this delivery order signed first"*, updated the test to
  `toEqual(['loaded', …])`, and said in its body which gate it was reversing.
- **#2557 (2026-08-20)** closed it again, and NOT on purpose. Its real subject
  was a genuine defect — a LOADED DO counted as DELIVERED, so a full delivery was
  refused its own dispatch for over-delivering against itself. Consolidating that
  onto `doCountsAsDelivered` swept the Sales-Invoice picker along with it,
  because the picker read the same list.

**Said plainly, because a future reader will re-derive it otherwise:** #2485's
stated justification does NOT reach LOADED. It argued *"stock was already
deducted at dispatch"*, true of DISPATCHED and IN_TRANSIT and false of LOADED,
where the inventory OUT has not fired. **The rule holds because the owner chose
it, not because that argument covered it.**

**Fix.** One home per question, and the two questions kept apart.
`do-shipped-states.ts` now declares both:

```
DO_NOT_DELIVERED_STATES   = DRAFT, LOADED, CANCELLED   "have the goods left?"
DO_NOT_INVOICEABLE_STATES = DRAFT,         CANCELLED   "may this be billed?"
```

They agree on six of the eight statuses and differ on exactly LOADED, which makes
them look like one rule written twice — the shape `check-duplicated-decisions`
hunts. Both the declaration and the test say why merging them re-breaks one of
the two rulings. `do-line-remaining.ts`, the Pending engine both pickers read,
takes a REQUIRED `DoPendingBasis` of `'invoiceable' | 'delivered'` rather than
defaulting, for the same reason its `companyId` argument is required: a basis a
caller can omit is whichever answer the last editor preferred, and this rule has
now flipped twice.

Only the invoice sites of #2557's nine moved — `resolveCandidateDoIds` and
`doLineRemaining` from sales-invoices, and the `doRemainingByItemId` /
`checkSiOverRemaining` write cap, which has to measure the pool the gate offers
or an invoice passes `siTransferRefusal` and then dies on `over_remaining`.
Delivery-returns, unbilled-deliveries and the unlinked-line shadow guard keep
`'delivered'` and say so at the call site; `so-delivery-sync`,
`so-stock-allocation`, `do-unlinked-coverage`, `routes/inventory`,
`routes/delivery-orders-mfg` and `check-do-integrity.mjs` are untouched, because
that is #2557's real fix and it stays.

**Nothing in production changed.** `check-do-integrity.mjs` R4 (run 32368212535)
found ZERO delivery orders in LOADED in either company, and zero the gate would
have refused. A rule settled, not an incident cleaned up.

**Pinned, because this is the second reversal.**
`backend/tests/loadedStaysInvoiceable.test.ts` fails BY NAME if LOADED is folded
back into the invoice path, and asserts in the same file that #2557's DELIVERED
exclusion is still intact — so whoever next tries to "unify" the two sets is told
which ruling they are undoing. Proved RED on the unfixed tree: re-adding LOADED
to `DO_NOT_INVOICEABLE_STATES` fails 4 of its 8 assertions; restoring it passes
8/8.

**Ref.** `fix/loaded-stays-invoiceable`, 2026-08-20. Supersedes entry 0475, which
recorded the same question while it was still open.
