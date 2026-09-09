## Five sofa purchase orders were left mislabelled because the repair refuses a build that already shipped [medium]

**Symptom.** Five purchase orders differ from the account book on the `transfer
from` axis, run after run, and no sofa tool touches them:

```
HC-PO-009467 · HC-PO-009554 · HC-PO-009587 · HC-PO-009679 · HC-PO-009830
```

**Root cause (traced, not guessed).** Measured with a probe written for it,
`probe-po-sofa-line-keys.mjs`, run 34321091880:

```
HC-PO-009467   9028-1S   group=others   key=861768
HC-PO-009554   9058-1S   group=others   key=868667
HC-PO-009587   9058-1S   group=others   key=872577
HC-PO-009679   9058-1S   group=others   key=880127
HC-PO-009830   9028-1S   group=others   key=892708
```

The AutoCount line key is present and correct on every one, and the model is
already folded to ours. **The single wrong value is `item_group = 'others'`.**
That is `docs/bugs/0577` / `0686`: the SO-linked purchase importer asked the
catalogue about the MAPPED code (`5530-1S`) before folding it through
`SOFA_MODEL_ALIAS`, the catalogue has never carried a 5530 code, and the
`?? "others"` underneath filed the line as `others`.

**Why four separate tools all answered "nothing to do", which is the part worth
keeping.** Every sofa tool selects `item_group = 'sofa'` FIRST, so to all of them
these rows do not exist:

| tool | its answer |
|---|---|
| `probe-sofa-collapsed-1s-cause` | class N on the PO side is **0** |
| `backfill-ac-sofa-line-keys` | sales orders only, by design |
| `repair-sofa-added-compartment-line-key` | **0** rows to stamp |
| `probe-book-line-gaps` | printed nothing for all five |

Four negatives were read as four answers. They were **one blind spot reported
four times**, and two wrong causes were told to the owner before a probe was
written that prints the rows instead of filtering them.

**What actually blocked the existing repair.**
`repair-mislabelled-sofa-po-lines.mjs` finds all five (`bare -1S purchase lines
not filed as sofa: 5; of those on a SOFA-category AutoCount item: 5`) and refuses
all five, correctly:

```
HC-PO-009467 ... — 2 delivery-order line(s) already state this build on HC-SO-012128
```

The goods have shipped. Re-describing a build a delivery note already states is a
change to HISTORY, and `planMislabelledBuild` may not decide that alone.

**Fix.** `allowDelivered` — a REQUIRED parameter on `planMislabelledBuild`, and
`ALLOW_DELIVERED=1` on the runner. Unset, every delivered build is refused
exactly as before. It opens that one gate and no other, pinned by two tests: a
cancelled sales order and an unminted piece SKU still refuse with
`allowDelivered: true`.

It is required rather than optional on purpose (CLAUDE.md, **BUG CLASS
optional-param-noop**): as `?:` every caller that says nothing keeps the old
behaviour with no signal, so the switch would apply only where somebody
remembered it. **Said plainly: this is `.mjs`, so nothing COMPILES the
requirement.** The single caller passes it explicitly and the JSDoc says it is
required; a new caller that forgets it gets the safe answer, not a crash.

**The owner's decision, 2026-09-09.** Told exactly what correcting these five
does and does not touch — no money, no stock, no delivery line moves; the
purchase row stops saying "one single seater" and says the four pieces the sales
order already says — he answered 「那就修」. His standing rule is why:
「已经出货了的单金额不用追，可是还是要确保 transaction flow 的数据是一样的」.

## The switch was HALF applied, and the transaction caught it

*Added the same day, after the apply.* `ALLOW_DELIVERED` opened the gate in
`planMislabelledBuild` and **not** the identical re-check inside the write
transaction. All five planned cleanly, entered the transaction, and were rolled
back one at a time:

```
=== APPLYING 1 BUILD(S) ===
ROLLED BACK HC-PO-009467 (PO-009467) 9028-1S <- HOK-5530 SOFA
            — HC-SO-012128 now carries 2 delivery-order line(s)
=== VERIFIED ON A FRESH CONNECTION ===
  builds applied 0 of 1; shapes verified 0
```

**Nothing was written**, on any of the five (runs 34327433537, 34327518796,
34327602216, 34327685367, 34327763573). That is the transaction working, and it
is the reason a half-applied switch cost a re-run rather than a repair.

**The second check is not redundant and is not weakened.** The plan reads a
snapshot; this one re-reads inside the transaction, so it still catches a
delivery raised between the two. What it must not do is enforce a rule the
operator has already been asked about and answered — so it now reads the SAME
switch, and prints `proceeding on <doc> despite N delivery-order line(s)` when it
does.

**The lesson, and it is not "grep harder".** The counter line said
`purchase lines re-coded 1 · inserted 1` — the PLAN's numbers — three lines above
`builds applied 0 of 1`. Read to the verdict, not to the number that looks like
one: this script prints what it INTENDED before it prints what it DID, and only
the second is evidence.

**Ref.** PRs for `fix/mislabelled-sofa-po-allow-delivered` and
`...-allow-delivered-2`, 2026-09-09.

