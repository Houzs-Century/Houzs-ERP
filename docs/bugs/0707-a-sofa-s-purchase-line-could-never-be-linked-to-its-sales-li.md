## A sofa's purchase line could never be linked to its sales line, so seven pieces stay PENDING [high]

<!-- area: Sofa, fabric, variants -->

**白话.** 一张沙发单，工厂那边的采购单其实已经开好了，账本上也写清楚这张采购单是从
哪一张销售单来的。可是我们系统里两边**接不上**：账本一行沙发，到了我们这里会拆成好
几件（1A、1NA、CNR…），旧的对接工具一看「一个号码对到好几行」，就宁可不做也不乱猜
——这是对的。结果是这些沙发件永远不会亮「货齐」，采购看了还会以为没下单，**再下一次
单**。全公司实际卡住的是 **7 件、4 张单**，全部 PENDING。

**Symptom.** The shop floor reported one of these on 2026-09-08: *"SO-009708
already have PO-010149 dated 3/9/2026"*. That one turned out to be linked
already (probe run `34199176419` — `HC-PO-010149 -> HC-SO-009708` on both
compartments). Sweeping the class found the ones nobody had reported.

Measured on production, probe run `34202130553`
(`probe-staff-reported-flow.mjs`, read-only):

```
company-1 sales lines, not cancelled                          15062
of them HARD-BOUND (bedframe / sofa / (SP) mattress)           3741
of those, on an order that is NOT terminal                     3618
of those, carrying NO dedicated purchase-order line            2842  <- cannot reach READY

WHAT THE BOOK SAYS ABOUT EACH OF THOSE:
  the ERP row carries no AutoCount line key - unanswerable       118
  the book has NO purchase order for this line either           2717  the absence is CORRECT
  the book HAS one and we do not hold the link                     7  <- THE FINDING
of the 7 the book names, 7 are not READY today
```

The 2,842 is not the backlog and reporting it as one would be alarming and
wrong: for 2,717 of them the shop simply has not raised a purchase order yet,
and the ERP agreeing with the book is the system working. **Seven** lines, on
four sales orders, are the ones where the book raised a purchase order and the
ERP does not know:

| sales order | pieces | the purchase order the book raised |
|---|---|---|
| `HC-SO-013232` | `8030-1A(LHF)`, `8030-1A(RHF)` | `PO-010078` |
| `HC-SO-012277` | `8051-1NA`, `8051-1A(RHF)` | `PO-010040` |
| `HC-SO-010287` | `9058-2A(LHF)`, `9058-1A(RHF)` | `PO-010085` |
| `HC-SO-008166` | `9058-1NA` | `PO-009974` |

**Root cause (traced).** `isHardBoundLine`
(`backend/src/scm/lib/so-stock-allocation.ts:78`): a company-1 bedframe / sofa /
`(SP)` mattress line reads READY **only** through its own dedicated
purchase-order line. So the link is not paperwork — without it the line cannot
light up whatever arrives, and MRP will ask purchasing to raise a SECOND
purchase order for goods already on the way.

The book records that edge, and only that edge, at LINE grain:
`PODTL.FromSODtlKey`. `repair-po-so-link-from-book.mjs` copies it — and its gate
2 refuses whenever either key resolves to more than one ERP row, because a Map
keyed by DtlKey would keep one of them and the pairing would be a coin flip.
**Every sofa is in that bucket by construction**: one book line becomes one ERP
row per compartment. The whole sofa population was therefore unrepairable by
that tool, correctly, at the grain it works at. Nothing was wrong with it; what
was missing was a tool at the other grain.

**Fix.** `backend/scripts/repair-po-so-link-sofa-compartments.mjs` +
`.github/workflows/repair-po-so-link-sofa-compartments.yml`. It asks the
narrower question: inside ONE pair of book lines, does every item code appear
exactly once on each side? Where it does, each purchase compartment has exactly
one sales compartment of the same product to be — the book's own edge plus an
exact identity match, not a choice. Five gates, each a refusal rather than a
fallback, and the buckets are asserted to total the whole population so no row
falls through unreported. Plan by default; apply needs
`CONFIRM="I HAVE REVIEWED THE DRY-RUN"` and the workflow passes it.

**Only ONE of the four is provable, and the other three are findings of their
own.** The classification below is the read-only probe's own section C (run
`34202130553`), which computes the identical pairing this repair plans; the
repair's plan and apply runs are recorded at the bottom.

- `HC-PO-010078 <- SO-013232`, 2 rows: every code unique on both sides.
  This is the one the repair writes.
- `HC-PO-010040 <- SO-012277`: 2 purchase rows against 3 sales rows. The
  purchase order is short a compartment; that is a build question.
- `HC-PO-010085 <- SO-010287`: the purchase side carries
  `9058-1A(LHF)+9058-2A(RHF)` and the sales side carries
  `9058-2A(LHF)+9058-1A(RHF)` — **the same sofa MIRRORED**. Which side is right
  is the drawing, and it is the owner's.
- `HC-SO-008166`'s `9058-1NA` does not reach this tool at all: no live purchase
  line of `PO-009974` is unlinked, so the sales compartment it is owed is not
  in the population. A separate look.

**A LINK MOVES READINESS AND THIS DOES NOT RECOMPUTE IT** —
`docs/bugs/0675-*`: a direct SQL write does not trigger the allocation
recompute. The script prints READY / PENDING / PARTIAL either side of its own
write so the delta is on the record, and says to dispatch **Recompute SO stock
allocation** next. Doing it inside the repair would fold a separate, serialised,
owner-visible operation into a data fix.

**It enqueues nothing.** No outbox row, no AutoCount call. Owner 2026-09-08:
「写回autocount的你不需要理了」.

**Ref.** `fix/staff-reported-flow`, 2026-09-08. Probe run `34202130553`. The
repair's own plan and apply runs are recorded in the PR that ships it — a
`workflow_dispatch` file is not dispatchable until it is on the default branch,
so the first run of this workflow necessarily follows the merge (CLAUDE.md:
"a workflow_dispatch workflow is not shipped until it has been dispatched once
and reported success").
