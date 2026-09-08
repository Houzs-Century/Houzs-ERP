# The go-live reconcile's remaining differences — every one classified

**Company 1 (Houzs Century). Written 2026-09-08 (Malaysia, UTC+8) against
reconcile run `34188640304`, which reported 41.**

The owner, 2026-09-08: *你是不是要仔细审查？然后看回去之前怎么样处理的？查清楚了
一次性处理呢？要不然那么久了*

He is right, and this file exists because of it. The count had been worked one
symptom at a time — measure, find one cause, fix a slice, re-measure. This is
the whole remainder classified in one pass, so that a repair can carry a
population instead of a document.

## How the count moved today

| run | local time | count | what closed it |
| --- | --- | --- | --- |
| `34187501117` | 12:35 | 127 | the starting point |
| `34187887821` | 12:41 | 70 | #3185/#3186/#3187 — the GR item column, the IV/PI line-shape columns, the PO discount |
| `34188640304` | 12:54 | 41 | #3190 (the three sofas re-applied) and #3192 (AutoCount's own empty rows) |
| — | 12:56 | **40** | `HC-SO-000021` repaired, run `34188782181` |

## The four classes

Every one of the 41 falls into exactly one. **X = the checker counting its own
guess. Y = the book's own gap or a shape the ERP cannot hold. Z = a real defect.
W = the owner's call.**

| type | count | X checker | Y book/design | Z real defect | W owner's call |
| --- | ---: | ---: | ---: | ---: | ---: |
| SO | 19 | 2 | 0 | 15 | 2 |
| PO | 0 | 0 | 0 | 0 | 0 |
| GR | 11 | 2 | 0 | 0 | 9 |
| DO | 4 | 1 | 1 | 2 | 0 |
| IV | 6 | 0 | 0 | 4 | 2 |
| PI | 1 | 1 | 0 | 0 | 0 |
| **total** | **41** | **6** | **1** | **21** | **13** |

---

## SO — 19

### line count 11, and 4 of the 6 money — ONE population, not fifteen accidents

`docs/bugs/0697`. Across all 2,882 paired sales orders there are exactly 24
unclaimed book lines, and AutoCount's own line key splits them without overlap:
every EMPTY BOOK ROW between keys 31219 and 152540, every CODED LINE between
915889 and 926603. A key in the 9xx,xxx band on an order dated 2024-12-14 is a
line **added to that order after our import ran**, and nothing re-reads an
existing document.

Whole-book measurement: **16 documents, 22 late lines, RM 750.00** — and PO and
DO have none at all. The reconcile reports 9 of those documents (11 lines) and
**every ringgit of the money**.

| document | the line the book added later | money |
| --- | --- | ---: |
| `SO-003945` | key 915889 `STORAGE` | RM 150.00 |
| `SO-010789` | key 924468 `TRANSPORTATION CHARGES` | RM 150.00 |
| `SO-012842` | key 925208 `Miscellaneous` | RM 300.00 |
| `SO-008319` | key 926603 `STORAGE` | RM 150.00 |
| `SO-007144` | key 925867 `AK-HAPPY SLEEP EASY` | — |
| `SO-011752` | keys 917574, 917575 `HOK-1013 (Q)` | — |
| `SO-010602` | keys 919061, 919062 divan / bedframe | — |
| `SO-007362` | key 918904 `HOK-2006(A) (K)` | — |
| `SO-013181` | key 924663 `DISPOSE` | — |

`SO-012842` also holds an ERP-internal inconsistency: its header reads
RM 4,888.00 — the book's figure — while its own lines sum to RM 4,588.00.

**Seven more documents carry a late line the reconcile cannot see.**
`SO-012128` is PROVEN missing its four compensation pillows (key 924549) and is
invisible only because its sofa decomposed into two rows, so the line-count
column reads 2 = 2. `SO-004188`, `SO-007298`, `SO-011160`, `SO-012416`,
`SO-012705`, `SO-012717` were checked on probe run `34188565498`: the ERP does
hold their late lines, so they are clean. They are listed so nobody
rediscovers them.

### line count — the two that are not that class

- `SO-011384` key 783795: no item code, **quantity 4**, RM 0.00. #3192
  deliberately kept it out of the blank-row class. What the four units are is
  UNKNOWN. **W — owner's call.**
- `SO-013160`: the only order where the ERP holds MORE than the book.
  `docs/bugs/0699`. **W — owner's call.**

### item code 1 and quantity 1 — both `SO-012128`, both the checker

The ERP rows on `HC-SO-012128` carry no AutoCount line key, so the checker
paired by position and set the book's `HOK-SQUARE PILLOW` (qty 4) against our
sofa piece `9028-1A(RHF)` (qty 1). Our sofa is **right**: the book's
`HOK-5530 SOFA` aliases to 9028 and its build `(1EL+1ER)` is exactly
`1A(LHF)+1A(RHF)`. One artefact, counted twice. **X.**

### money 6 — five causes, and one is already repaired

| document | book | ERP | cause |
| --- | ---: | ---: | --- |
| `SO-010789` | 7,650.00 | 7,500.00 | the late `TRANSPORTATION` line — `0697` |
| `SO-003945` | 3,350.00 | 3,200.00 | the late `STORAGE` line — `0697` |
| `SO-008319` | 6,250.00 | 6,100.00 | the late `STORAGE` line — `0697` |
| `SO-012842` | 4,888.00 | 4,588.00 | the late `Miscellaneous` line — `0697` |
| `SO-000021` | 9,876.00 | 10,852.00 | **REPAIRED**, run `34188782181` |
| `SO-012571` | 3,450.00 | 3,538.00 | sofa decomposition — see below |

`SO-012571`: the book prices `DSL-8050 SOFA` at RM 3,300.00 and our two
decomposed pieces carry RM 3,388.00 on the lead piece. The ERP is RM 88.00 over
on a sofa the book states one price for. **Z**, not yet repaired.

**`SO-000021` — what the owner now owes a decision on.** The repair wrote the
book's RM 9,876.00 and, by design, did not touch what the customer paid:

```
HC-SO-000021  total RM 9876.00   paid RM 10852.00 + balance RM 0.00 = RM 10852.00
              <-- does not equal the total; the owner's call
```

The customer is **RM 976.00 in credit**. That fact existed before the repair;
the repair only made the ERP say so.

---

## PO — 0

Cleared today. The nine were the three sofas' purchase orders, and #3190 put the
book's own model back on them.

---

## GR — 11

### item code 2 — the checker, and provably so

`docs/bugs/0698`. `GR-005304|PO-009714` holds a transposed
`LONG PILLOW` / `SQUARE PILLOW` pair whose item-code multisets **are** equal.
The classifier never looks: `check-ac-erp-reconcile.mjs:1108` sets a
**per-document** `sofa` flag from `acLines.some(isSofaCode)`, `:1128` only fills
`bags` when `!sofa`, and a `HOK-5536 SOFA` sits on the same receipt. **X.**

### money 9 — NOT the accepted 100, and the source's own explanation is false

The comment at `probe-gr-pi-iv-residue.mjs:34-40` says a receipt "totals only the
lines whose order happened to carry money". That predicts these nine would be
RM 0.00. Measured: **not one purchase-order line on them is priced**, so the
prediction fails.

What they actually are: on a receipt that mixes a **sofa** with accessories, the
sofa's money is dropped — its compartment purchase-order line carries the book's
unpriced PODTL UnitPrice of 0 — while the accessory beside it keeps its own
receipt-line money. `GR-004909|PO-009017` is RM 3,080.00 of sofa plus RM 120.00
of pillow, and we kept the pillow.

**「GR 0 没关系」 does not cover this.** The ruling says a migrated receipt may
carry no money. A receipt carrying RM 120.00 where the book says RM 3,200.00 is
not "no money" — it looks priced and is 96% wrong. 19 of the 400 pairs are mixed
and carry book money; these 9 are a subset. **W — the remedy is his call,
because writing the book's total onto 9 receipts while 100 stay at RM 0.00 is a
different rule from the one he gave.**

---

## DO — 4

| finding | class |
| --- | --- |
| `DO-001953` — the ERP lacks `HB109M-CC` x4 and `HB109NL` x4, real goods | **Z** |
| `DO-004903` — the ERP lacks `HB109NL` and `HB109M-CC`, real goods | **Z** |
| `DO-002544` — the ERP lacks `* PENDING 2PCS LATEX PILLOW WITH CS COVER`, an annotation with no goods and no money | **Y** |
| `DO-011465` qty — the checker paired the book's pillow (qty 4) against our sofa piece (qty 1), the same artefact as `SO-012128` | **X** |
| `DO-001604` money RM 150.00 — the ERP dropped `* DISPOSE 3S L SHAPE SOFA + CONSOLE TABLE`, a codeless line **carrying money** | **Z** |

`DO-001604` is the one to look at twice: a line with no item code was dropped,
and it was not empty — it was RM 150.00.

---

## IV — 6. They are not their own problem; they are downstream of DO

The report's field-by-field section still says *"no population by the owner's
decision (「这个不要」, the historical invoice import)"*. **That sentence quotes a
ruling the owner overturned.** On 2026-09-07 he said 没有的 SO DO 何来发票？
有的 SO DO 自然要发票 (`docs/bugs/0662`). Section 1 guards itself against exactly
this drift (`check-ac-erp-reconcile.mjs:942-963`); section 5's string is
unconditional and was missed. The six are real gaps by his own words.

And four of them are **caused by the delivery-order defects listed above**:

| invoice | blocked by | already diagnosed |
| --- | --- | --- |
| `I-2411-0323` | `DO-001953` came in 2 lines short — its only lines carrying quantity | `docs/bugs/0674`, `0669` |
| `I-000213` | `DO-000097` is RM 50.00 short | `docs/bugs/0669` |
| `I-2410-0192` | `DO-001604` is RM 150.00 short, the codeless DISPOSE line | `docs/bugs/0669` |
| `I-2411-0275` | RM 6,800.00 across three DOs; an options paper exists and **Recommendation A was never executed** | `docs/migrated-invoices-2026-09-07.md` §5 |

`create-migrated-invoices` refuses an invoice whose total cannot equal
AutoCount's (`migrated-chain.ts` rule 4), so a short delivery order silently
becomes a missing invoice. **Repair the DO lines and these resolve themselves.**

`I-2410-0016` and `I-2507-0234` appear nowhere in the tree or its history.
**UNKNOWN.**

---

## PI — 1

`PI-007875`. The totals agree to the sen; the ERP carries one extra row,
`CELENE 2.0 (A)(F)-(Q)`, at RM 0.00 that AutoCount did not bill. The declared
class exists — *"AutoCount bills a FREE gift as its own RM 0.00 line"* — but its
executable form is one-directional: `check-ac-erp-reconcile.mjs:1173` requires
`s.erpQty === 0`, so it forgives a zero-money line **the book has and we do
not**, and has no clause for the mirror. A migrated purchase invoice draws its
rows from **our** goods receipt, so an unbilled RM 0.00 row riding along is
precisely the shape the migration produces. **X.**

---

## The one shape under four of these findings

A **per-document sofa flag** applied to the ordinary lines standing beside the
sofa. `docs/bugs/0691` named it for line counts. It also explains:

- the GR item-code multiset never being measured (`GR-005304|PO-009714`),
- the GR money on every mixed receipt (`0698`),
- `SO-012128`'s and `DO-011465`'s missing pillow line being invisible because
  the sofa decomposed into two rows and made the counts match,
- `SO-012571`'s RM 88.00.

It is one flag, and it is wrong for every non-sofa line on a mixed document.

---

## Which of these a salesperson could TOUCH once PO / DO / SO open

*Added 2026-09-08, `fix/sync-human-edit-guard`. The owner asked for PO, DO,
新 SO and edit SO. Every one of the 40 differences above sits on a MIGRATED
document, so this is the list of which ones stop being read-only.*

The two switches do different things, and the answer splits on the AREA the
document lives in, not on the class it was given above:

| type | count | area the document lives in | after step 1 (freeze lift) | after step 2 (`scm.migrated_so_lock = 'off'`) |
| --- | ---: | --- | --- | --- |
| SO | 19 | `scm.sales.orders` | still read-only — the migrated lock holds | **editable** |
| DO | 4 | `scm.sales.delivery` | **editable immediately** | unchanged — this lock is SO-only |
| GR | 11 | `scm.procurement.grn` | shut | shut |
| IV | 6 | `scm.sales.invoices` | shut | shut |
| PI | 1 | `scm.procurement.pi` | shut | shut |
| PO | 0 | `scm.procurement.po` | — | — |

**23 of the 40 become touchable; 18 stay shut.** (19 SO + 4 DO = 23; 11 GR +
6 IV + 1 PI = 18.)

### The four DO ones are the ones to look at, because step 1 alone opens them

`migratedSoReadonly()` guards sales orders. **Nothing equivalent guards delivery
orders** — `/delivery-orders-mfg/*` carries the area guard and no document-level
lock — so lifting `scm.sales.delivery` makes `DO-001953`, `DO-004903`,
`DO-002544`, `DO-011465` and `DO-001604` editable in the same minute, migrated
lock or not.

**Does that matter? For three of them, yes, and in a specific way:**
`DO-001953`, `DO-004903` and `DO-001604` are the **Z** rows — the ERP is
genuinely missing goods or money the book has, and four of the six IV gaps are
downstream of exactly these. If a person "tidies" one of them by hand before the
line repair runs, the repair's own preconditions stop holding and the invoice
chain has to be re-diagnosed from a document nobody has a before-picture of.

`DO-002544` (**Y**, an annotation with no goods) and `DO-011465` (**X**, the
checker's own sofa artefact) are harmless to touch.

### The nineteen SO ones, after step 2

They are editable, and the sync will no longer overwrite an edit made to them —
`docs/migrated-so-lock.md` §2a. Two consequences worth stating plainly:

1. **An edit is not a repair.** A salesperson correcting `SO-010789` by hand
   makes the reconcile agree and leaves `docs/bugs/0697`'s population of 16
   documents / 22 late lines / RM 750.00 unfixed everywhere else. Worse, the
   repair that carries the population can no longer be run over that document
   without a person's edit standing in its way — which is precisely the refusal
   this PR added, working as intended, at the cost of a manual reconciliation.
2. **`SO-000021` and `SO-013160` are already the owner's call** (W). An edit by
   anyone else settles a question that was put to him.

**Recommendation: land the population repairs BEFORE step 2, not after.** The
sync guard makes a person's edit safe from the machine; it does not make it safe
from being the wrong repair.
