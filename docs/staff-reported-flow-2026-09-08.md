# The three documents the shop floor reported — 2026-09-08 (Malaysia, UTC+8)

What the staff reported, what each one turned out to be, and how big its CLASS
is. Written so the next person repairs what is left rather than re-deriving it.

Measured, not recalled. Every number below names the run that produced it.

## 1. `SO-013475` — DONE, the customer is unblocked

> "So013475 item 2 matching incorrect. Autocount drawing is **1+1+1**. ERP
> **2+1**. please check & correct it, this urgent bill"

**The ERP was not wrong about the book's TEXT.** DtlKey `924983` reads
`3S(28")`, and `parse-sofa.mjs` turns a 3S at any seat depth other than 24" into
`2A(LHF)+1A(RHF)` by the owner's own standing rule. The **drawing** on the same
line shows three separate seats, and the owner ruled the drawing wins.

Corrected to `1A(LHF)+1NA+1A(RHF)` — apply run `34199823824`, verified on a
fresh connection. **The rule is unchanged**; this is one entry in the file that
exists for owner-approved per-document overrides
(`backend/scripts/data/sofa-compartment-corrections-2026-09.json`).

`docs/bugs/0705-a-3s-sofa-decodes-to-2-1-by-rule-and-the-book-s-drawing-said.md`.

## 2. `SO-009708` — the link EXISTS; something else on it does not agree

> "SO-009708 already have **PO-010149** dated 3/9/2026"

**The link is there and it is correct.** `HC-PO-010149` is in the ERP and both
its compartments are dedicated to `HC-SO-009708`'s matching compartments —
probe run `34199176419`, section B. Whether it was written before or after the
staff looked is not knowable from here; what IS knowable is that it is right
now.

**What is NOT right on that document, and nobody reported it:** its seat size.

```
SO-009708 DtlKey 660946 (ERP HC-SO-009708 9050-2A(LHF)): AutoCount "28"" vs ERP "30""
```

The purchase order already says 28". The sales order says 30". Under the
standing rule 「一律跟账本」 the book wins, so the sales order should read 28".
**Not written here** — seat size is part of the variant key stock allocation
buckets by, so changing it on a live order moves what that line can match. It is
listed below with its four siblings.

## 3. `SO-010035` — intact, and the numbering is one document under two spellings

> "SO-010035 PO009117 GRN5228 PI7824"

The whole chain is in the book and in the ERP:
`SO-010035` -> `PO-009117` -> `GR-005228` -> `PI-007824`, each child naming its
parent. `HC-PO-009117`'s two compartments are dedicated to the sales order and
both read `received 1` (probe run `34199176419`), and the order is
`READY_TO_SHIP`. No reconcile axis reports any of the four documents.

**`GRN5228` and `GR-005228` are the same document.** Searched across the whole
committed book cut: there is exactly one goods receipt numbered `GR-005228` and
none numbered `GRN5228` or `GR-5228`.

**Why you cannot find "GRN5228" in the ERP by that number, and it is not a bug.**
`scm.grns.linked_ac_docno` holds the receipt's **PURCHASE ORDER** number, not
the receipt's — the cutover convention, enforced by `grnLinkIsReallyAPo` in
`backend/src/scm/lib/autocount-outbox.ts`, which REFUSES to send that value
rather than name the wrong document in a live account book. The real receipt
numbers live in `scm.purchase_orders.linked_ac_grn_docnos`.

---

# The classes, sized

## Class A — a sofa's compartments disagree with the book

`check-sofa-bedframe-completeness.mjs` compares the compartment MULTISET against
what `parse-sofa.mjs` decodes from the book's own Desc2.

| population | run | sofa lines | disagree | of those, owner-ruled |
| --- | --- | --- | --- | --- |
| PROCEEDED only | `34199639532` | 413 | 11 on 4 documents | **4 of 4 documents** |
| every sales order | `34199783580` | 1,167 | 50 on 35 documents | 4 of 35 documents |

**On the live (proceeded) backlog the answer is ZERO.** Every flagged document
there is one the owner has already ruled on, so the ERP is MEANT to differ from
the text and the disagreement is the ruling working.

The other **31 documents** are all `CONFIRMED` and **not proceeded** (probe run
`34202130553`, section A) — old orders whose build the importer could not decode
and which fell back to a bare `-1S`. They are the owner's: the text cannot
answer them, so the drawing is the only source. A further **156 sofa lines** are
in the same position and are reported by that audit as *"build cannot be
re-derived from Desc2 (photo needed)"*.

**Do not re-decode a `3S` in bulk.** `SO-013475` was a per-document override,
not a rule change; a sweep would change hundreds of live builds on the strength
of one slip.

## Class B — a hard-bound sales line whose purchase order the book has

Probe run `34202130553` / re-measured `34204007759`:

```
company-1 sales lines, not cancelled                          15062
of them HARD-BOUND (bedframe / sofa / (SP) mattress)           3741
of those, on an order that is NOT terminal                     3618
of those, carrying NO dedicated purchase-order line            2842
  the ERP row carries no AutoCount line key - unanswerable      116
  the book has NO purchase order for this line either          2718   the absence is CORRECT
  the book HAS one and we do not hold the link                    8   <- THE FINDING
```

**The 2,842 is not a backlog and must not be quoted as one** — for 2,718 of them
the shop has simply not raised a purchase order, and the ERP agreeing with the
book is the system working. The number with a customer behind it is **8 pieces
on 5 sales orders, all PENDING**.

| sales order | pieces | book's purchase order | verdict |
| --- | --- | --- | --- |
| `HC-SO-013232` | `8030-1A(LHF)`, `8030-1A(RHF)` | `PO-010078` | **provable** at compartment grain |
| `HC-SO-012277` | `8051-1NA`, `8051-1A(RHF)` | `PO-010040` | **provable** once the whole pair is tallied |
| `HC-SO-010287` | `9058-2A(LHF)`, `9058-1A(RHF)` | `PO-010085` | the purchase side is the same sofa **MIRRORED** — the owner's, from the drawing |
| `HC-SO-008166` | `9058-1NA` | `PO-009974` | that purchase line is not unlinked, so the tool never sees it — a separate look |
| `HC-SO-013389` | `8030-1A(RHF)` | `PO-010087` | appeared on the re-measure; not yet classified |

Tool: `backend/scripts/repair-po-so-link-sofa-compartments.mjs`, and
`docs/bugs/0707-a-sofa-s-purchase-line-could-never-be-linked-to-its-sales-li.md`
for why the existing `repair-po-so-link-from-book.mjs` cannot do it.

## Class C — a broken or mis-numbered link on SO -> PO -> GR -> PI

`check-ac-convert-symmetry.mjs`, run `34199094790`, re-measured AFTER the
14:22 line-key stamping rather than inherited from an earlier verdict.

| edge | book -> ERP | ERP -> book | wrong item | finding |
| --- | --- | --- | --- | --- |
| PO <- SO | 512 / 522 | 512 / 512 | 0 | **10 book edges we do not hold**, 12 lines unresolvable at key grain |
| DO <- SO | 171 / 173 | 171 / 171 | 0 | 2, both already ruled the book's own gap |
| IV <- DO | 46 / 46 | 46 / 46 | 0 | — |
| IV <- SO | 0 / 0 | 0 / 0 | 0 | — |
| GR <- PO | 521 / 521 | 521 / 521 | 0 | — |
| PI <- GR | 448 / 448 | 448 / 448 | 0 | — |

**Nothing points the wrong way.** `0 ERP edges the book does not record`, and
`0 GRNs whose header and lines name different purchase orders`. Three orphan
child lines in all (PO <- SO 2, IV <- DO 1).

The 10 book edges we do not hold, by name:

```
PO-009122 <- SO-012173   PO-009262 <- SO-010956   PO-009467 <- SO-012128
PO-009554 <- SO-012729   PO-009587 <- SO-010209   PO-009679 <- SO-010955
PO-009710 <- SO-012986   PO-009829 <- SO-010128   PO-009830 <- SO-011207
PO-010137 <- SO-007362
```

# What is left, and who owns it

| # | item | owner |
| --- | --- | --- |
| 1 | the 31 not-proceeded sales orders whose sofa build the text cannot decode — the drawing is the only source | **the owner** |
| 2 | `HC-SO-010287` vs `PO-010085`: the same sofa mirrored. Which end carries the arm is a drawing question | **the owner** |
| 3 | five sales-order seat sizes that disagree with the book: `SO-009708` 28 vs 30, `SO-013310` 30 vs 28, `SO-001526` 28 vs 35, `SO-013227` 28 vs 35, `SO-011756` 40 vs 30. The book wins by standing rule, but seat size is part of the stock-allocation bucket key, so it moves what a line can match | needs a tool + a measured before/after |
| 4 | `HC-SO-008166` / `PO-009974`: the book names the edge and no unlinked purchase line answers it | a separate look |
| 5 | the 10 PO <- SO document edges above | unclaimed |

# What was NOT touched, deliberately

- **The ERP -> AutoCount write-back.** Owner, 2026-09-08:
  「写回autocount的你不需要理了」. No outbox row was written and no AutoCount call
  was made by anything in this lane.
- **Payment columns.** Out of scope.
- **Other lanes' documents.** `docs/cutover-so-do-remainder-2026-09-08.md`
  sections A/B/G and the GR / SI / PI remainder belong to
  `fix/book-line-remainder` and `fix/gr-iv-pi-remainder`. None of the three
  reported documents is in either scope.
