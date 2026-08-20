## May a LOADED delivery order be invoiced? Two merged PRs disagreed — SETTLED [OWNER DECISION]

<!-- area: Delivery, DO, returns -->

> **ANSWERED 2026-08-20: yes, it may.** The owner ruled 不要拦 —— 人自己知道.
> The ruling, what changed and what deliberately did not are in entry **0480**.
> Everything below is the state of the question BEFORE he answered, kept
> because the evidence in it is what the ruling was made on.


**Not a defect report — an open question, recorded so it is not lost.** Nothing
here is broken today; two rulings simply point opposite ways and the system is
currently following both in different places.

- **#2485, owner, 2026-08-19.** *"A Sales Invoice can be raised from every
  CONFIRMED delivery order"* — anything past DRAFT that is not CANCELLED,
  `LOADED` included. The desktop still behaves this way:
  `do-next-step.ts:89` `SI_TRANSFERABLE_DO_STATUSES` opens with `'loaded'`, so a
  LOADED delivery shows an enabled **Transfer to Sales Invoice** button.
- **#2557, 2026-08-20.** A LOADED DO is still on the lorry and its inventory OUT
  has not fired, so *"billing it would be the bug"* — the words are
  `unbilled-deliveries.ts:39`. Its `DO_NOT_DELIVERED_IN_LIST` now filters the
  server's SI candidate picker, so a LOADED delivery's lines are not offered.

**What a user sees under each.** Under #2485, an operator can invoice goods that
are packed on the lorry but have not left, and stock still reads as on hand
because the OUT fires on dispatch. Under #2557, they must dispatch first, and the
button the desktop shows them produces an empty line picker.

**#2485 admitted LOADED DELIBERATELY — this is not a rule recorded more broadly
than it was meant.** Checked against the diff rather than the prose, because the
tempting reading is that "every confirmed DO" swept LOADED in by accident. It did
not. #2485 names LOADED four times:

```
-export const SI_TRANSFERABLE_DO_STATUSES = ['signed', 'delivered'] as const;
+export const SI_TRANSFERABLE_DO_STATUSES = ['loaded', 'dispatched', 'in_transit', 'signed', 'delivered'] as const;
-  if (s === 'loaded' || s === 'dispatched' || s === 'in_transit') {
-    return 'Mark this delivery order signed first — a Sales Invoice can only be raised once it is signed or delivered.';
```

plus the test updated to `toEqual(['loaded', …])` and a body sentence naming the
gate it reverses. LOADED was blocked, and #2485 unblocked it on purpose.

**What DOES weaken it, and belongs in the same breath.** #2485's stated
justification is *"stock was already deducted at dispatch"* — true of DISPATCHED
and IN_TRANSIT, false of LOADED, where the OUT has not fired. And its stated
consequence is *"a Sales Invoice can now be raised **before the customer
signs**"* — the signature step, not the dispatch step. So the reasoning it wrote
down covers four of the five states it admitted. That is an argument about
LOADED; it is not evidence that LOADED was included by accident.

**Where it stands (2026-08-20).** `main` is inconsistent with itself: the UI
offers the transfer and the server picker declines to supply it. The nesting is at
least the safe way round — the picker offers a strict SUBSET of what the create
gate accepts — so nothing is advertised that the create path then refuses, and no
money or stock is wrong either way. **PROVEN not to affect anything today:** the
production census (`check-do-integrity.mjs` R4, run 32368212535) found **0**
delivery orders in LOADED in either company, and 0 that the gate would refuse.
This is a rule being settled, not an incident being cleaned up.

The owner has been asked and his answer is not in yet. Two messages of his are on
the record and they are being read two ways, which is the whole difficulty:
*「等送完货了我们才自己convert to invoice啊」* and *「我们自己开啊 manually开的不是
吗」*. Whether that DESCRIBES what his staff do or MANDATES that the system refuse
is exactly the open question — and his documented standing philosophy for this
system (loosen restrictions as far as possible; a hard wall is the last resort)
points away from enforcement. **No rule has been changed here in either
direction, deliberately.** Neither list was edited, no pinning test was written,
and #2557's line is kept byte-for-byte, so whichever way he rules the change is
still a one-line change and not an unpicking.
