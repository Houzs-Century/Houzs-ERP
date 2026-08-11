# The AutoCount → ERP migration: what was done, how it was proved, what is left

**Status as of 2026-08-11: PAUSED. Staff continue on AutoCount. Work resumes Friday.**

Owner's call, 2026-08-11: *"让他们继续用 autocount 先，我们星期五再继续做."* The ERP is not
ready to be the system of record, so nobody is moved onto it yet.

This is the record a stranger needs to pick the migration up. It says what was migrated, which
AutoCount column each field came from, what was verified and with what numbers, what was written
to production and when, and what is still open. Where a number is quoted it came from a run whose
workflow is named — re-run it rather than trusting this file.

Companion documents: [`autocount-cutover-ledger.md`](./autocount-cutover-ledger.md) is the
chronological run log; [`cutover-tally-method.md`](./cutover-tally-method.md) defines how documents
are counted; [`modules/autocount-writeback.md`](./modules/autocount-writeback.md) covers the return
direction (ERP → AutoCount).

---

## 0. The rules this migration runs under

These came from the owner and are not negotiable. Every one of them was written after something
went wrong, so none is theoretical.

### 0.1 A migration COPIES. It never computes.

> 跟着 autocount 的 document 就对了，我们 migrate data 不可以更改数据啊，更改的话数据就不一样了啊
> — owner, 2026-08-11

For every field, name the AutoCount column that is its source and read **that**, per line. Where
AutoCount is blank, the ERP is blank. Where AutoCount is ambiguous, the row is **skipped and
reported**, never guessed. "The data is different" is the failure, even when the invented value
looks more useful than a gap.

Three separate repair lanes independently drifted into inference and each produced a wrong row that
no test caught:

| what was about to be written | why it was wrong |
| --- | --- |
| `HOK-DIVAN ONLY (K)` RM470 stamped onto a `(Q)` line, 3 units | the key was `(document, Desc2)` and **Desc2 does not carry size — size lives in the item code**. `(Q)`'s own median is RM325, so this was +44.6% |
| `HOK-2041 (A) (SS)` RM641.50 onto a `(Q)` line | same defect, +9.7% |
| `HC-PO-009633` two lines written as "ordered 1, received 2" | read from an export column aggregated on `(DocNo + ItemCode)` |
| a mattress PO line about to be dedicated to a pillow SO line | two AutoCount lines looked identical on every field the ERP stores, but differed on `FromSODtlKey`, and those two keys pointed at **different products on the same order** |

Inference also defeats the guards: once a wrong price is stamped, the line reads as "priced", so
the zero-cost receipt gate never fires on it again.

### 0.2 不可以删，只可以 cancel

Nothing is ever DELETED — not a document, not a line, not a stock movement. Corrections are
compensating writes. This forbids implementing an edit as delete-and-recreate (which would also
destroy AutoCount's own document links and audit trail), and forbids fixing a duplicated stock
movement by removing the duplicate.

### 0.3 The ERP is the only editing surface (once live)

Sync is one-way, ERP as master. But staff will edit in AutoCount out of habit, so **drift detection
is required regardless**.

### 0.4 A lost sync must be impossible to miss

ZeroTier (`10.147.17.100,55500`) is the transport and keeping the link up is the only mitigation.
A save that succeeds in the ERP while its sync is silently lost must be impossible — durable queue
plus a loud alarm. The justification is making failure **visible**, not distrusting the link.

### 0.5 Outstanding, defined by the owner

An SO is outstanding only if it is **not converted to a DO and not invoiced**, and not cancelled.
Converting to a PO does **not** make it non-outstanding. Same shape for a PO: outstanding until
received.

---

## 1. What was migrated

Company scope is `company_id = 1` (Houzs Century). 2990 is untouched.

| | count | source |
| --- | --- | --- |
| Sales orders (outstanding) | **2,710** documents / 13,588 lines | `SO` / `SODTL` |
| Purchase orders | **407** (including 250 already received) | `PO` / `PODTL` |
| Goods receipts | **291** migrated GRNs | `GR` / `GRDTL` |
| Delivery orders | **25** migrated partial DOs | `DO` / `DODTL` |
| Stock balance | 1,020 cells / +9,679 units, later relayered into real FIFO layers | view `vItemBalQty` |
| Line photos | 983 SO + 242 PO keys in R2 | RTF `\pict` blobs carved out of the AutoCount description |

**Deliberately NOT migrated**, each a decision rather than a gap:

- **Historical IV / DO / PI documents** (9,783 / 11,134 / 5,120). Owner: *"这个不要"*.
- **Whole-sofa stock balances.** Owner: *"沙发库存不准的，因为我们接下来跑 compartment 了 …
  pillow 就 ok"*. AutoCount counts one whole sofa; the ERP counts its compartments, so a balance row
  cannot be decomposed without inventing which build it is. Sofa **pillows** are ordinary
  accessories and DID come in.

### 1.1 Numbering

Every migrated document carries AutoCount's own number, prefixed `HC-`. A GRN whose AutoCount
receipt spans several POs also carries the PO (`HC-GR-000201-PO-000596`). This is checked by
`check-migrated-numbering` and currently passes.

### 1.2 Migrated documents post no stock

`scm.grns` and `scm.delivery_orders` carry `migrated_no_stock boolean` (migration `0276`). Those
documents hold quantities and links but create **no inventory movement**, because the AutoCount
balance snapshot already counted the goods. Double-counting them is the failure mode this flag
exists to prevent.

The corollary bit people in practice: **a migrated GRN creates no FIFO layer**, so writing a cost
onto a migrated PO or GRN line is *inert* — see §4.

---

## 2. The field map — which AutoCount column each value comes from

Anything not on this list was not migrated. If a field matters and is missing here, that is a gap,
not an omission from the document.

| ERP field | AutoCount source | note |
| --- | --- | --- |
| document number | `DocNo` | prefixed `HC-` |
| customer / supplier | `DebtorCode` / `CreditorCode` + name | |
| document date | `DocDate` | |
| line item code | `ItemCode` → ERP `material_code` | via the mapping CSV; **not invertible for sofa** (§5.2) |
| line description | `Description` / `Desc2` | `Desc2` carries the build: fabric, size, legs, gap |
| quantity | `Qty` | |
| unit price (SO) | `UnitPrice` | |
| unit price (PO) | `UnitPrice` — **null on 565 of 579 imported lines, and on 126 of 126 sofa lines** | faithful: AutoCount prices sofas on the purchase invoice, not the PO |
| **received quantity** | **`PODTL.TransferedQty`** | NEVER the export's `GrQty` — see §5.1 |
| PO ← SO dedication | `PODTL.FromSODtlKey` | never a zip or a sibling match |
| line identity | `DtlKey` → `linked_ac_dtlkey` | a WRONG key is worse than NULL: NULL means "create", a wrong one makes AcSyncService **append a duplicate line** instead of editing the operator's line |
| stock status | `SO.Remark2` | free text a human types; `ACC` = accessories ready, `Mattress` = mattress ready |
| the PO raised for an order | `SO.UDF_ToPONo` | **comma-joined** when one SO became several POs — compare as a SET |
| outstanding balance | `SO.UDF_BALANCE` | |
| delivery date | `DeliveryDate` | **not** `DelivDate` — an earlier export key rename silently lost 76 line dates |
| **unit cost** | **`PIDTL.UnitPrice`**, reached PO → GR → PI | §4 |
| stock on hand | `vItemBalQty` | per item × location |

### 2.1 AutoCount has no line-to-line keys

This is the single most important structural fact about the whole migration.

```
PIDTL.FromDocDtlKey populated:  0 of 20,777
GRDTL.FromDocDtlKey populated:  0 of 21,000
```

AutoCount records only the **document** a line came from, never the line. Every line-to-line link in
the ERP is therefore a **reconstruction**, joined on `(document number, ItemCode, Desc2)`. That
reconstruction is where every wrong-value incident in §0.1 came from — and the reason a key that
omits the item code will pull a different bed size's price.

`linked_ac_dtlkey` is the first time those links are pinned down. Coverage today:

```
SO lines: 12,910 of 13,907 set;  972 no AutoCount match;  25 skipped as ambiguous
PO lines:    275 of    864 set;  589 no AutoCount match
```

The 589 are the sofa problem in disguise: the backfill matches on `(DocNo, ERP code)` and a
decomposed sofa line stores a **compartment** sku (`DSL-8030-1A(LHF)`) that no AutoCount ItemCode
maps to.

---

## 3. What was verified, and with what numbers

Every one of these is a **standing check on `main`** with a `workflow_dispatch` workflow. Re-run
them; do not trust the numbers below to still be current.

| check | what it answers | result at 2026-08-11 |
| --- | --- | --- |
| `check-migrated-numbering` | does every migrated document carry AutoCount's number | **PASS** |
| `check-autocount-parity` | PO number / stock status / balance / document flow | see below |
| `check-status-disagreement-why` | why each stock-status disagreement exists | 104 of 104 explained |
| `stock-truth-check` | balance vs AutoCount, FIFO integrity, delivered COGS | see below |
| `over-receipt-check` | is an over-receipt paper-only or did stock move | |
| `check-line-supply-trace` | which PO a not-ready line waits on, and when | |
| `truth-scope-check` | how large the GRN→PI / DO→IV conversion is | |
| `bedframe-sofa-status-truth` | why bedframe/sofa readiness diverges | |

**Document parity** — `check-autocount-parity`:

```
PO document number : 262 exact / 0 different / 1 missing (SO-012267 lacks PO-009216) / 0 supersets
balance            : 2,708 compared, 2,696 agree, 12 differ
document flow      : 427 chains agree / 0 disagree / 10 AutoCount receipts the ERP has no GRN for
                     (+12 the ERP has and AutoCount's export does not — all 12 confirmed
                      TRANSFERRED in AutoCount's own TransferedQty, so the ERP is right)
stock status       : AutoCount states one on only 404 of 2,710 orders;
                     284 agree, 104 disagree, 16 "READY (PARTIAL)" not falsifiable per category
```

**The 104 status disagreements, every one with a cause** —
`check-status-disagreement-why`:

| n | cause |
| ---: | --- |
| 52 | sofa has no stock in the ERP at all — the compartment round has not been run |
| 28 | an earlier order already claimed the stock — a genuine shortage, nothing broken |
| 13 | the order has no Processing Date, and the allocator gates those to PENDING regardless of stock |
| 7 | `MISC` — a charge posted as a goods line, so it can never read READY |
| 2 | the line is already fully delivered; the allocator skips it and the flag is frozen |
| 1 | stock exists but in a different warehouse |
| 1 | no stock anywhere for that product |

52 of these disappear with the sofa round. The `so_item_id` backfill removes **none** of them — that
gap is real but is not what is blocking these orders.

**Stock** — `stock-truth-check`, after the zero-cost backfill:

```
BALANCE : 2,268 cells compared (1,315 both zero); 2,232 agree
          ERP higher 35 cells / +104 units; ERP LOWER 1 cell / -1 unit
          items not mapped 0; locations not mapped 0; ERP-only 0
FIFO    : SOUND — 3,386 layers, arithmetic broken on 0; no negative or over-remaining layer;
          no shipment drew from a zero-cost layer; layers reconcile to movements
          layer value RM 2,228,410.31 vs the Inventory screen's RM 2,227,767.31 (differs by RM 643 —
          stock on an inactive warehouse or a non-active product, real but not displayed)
COGS    : 42 delivered units carry zero cost, on 28 lines — ALL of them MIGRATED lines.
          Company 1 has shipped no normal delivery order yet, so this ratio is 100% by
          construction, not a costing collapse.
```

Sofa is excluded from the balance comparison **symmetrically** — both AutoCount's 31 sofa codes and
the ERP's 77 compartment cells are held out. Excluding only AutoCount's side would make every ERP
compartment cell report as "ERP-only", a gap invented by the filter rather than found by it. The
exclusion is printed on the report, not applied silently.

### 3.1 What was checked and found NOT to be a bug

- **MYR 0.00 on migrated POs** is faithful — 565 of 579 lines are unpriced in AutoCount, sofa 126 of
  126, and every null-price line carries `SubTotal` 0 too.
- **Sofa decomposition does not break item lookup** — 184 of 184 ItemCodes match, 0 decode failures.
  (An earlier theory blamed decomposition for the binding failures; it was wrong.)
- **Repeat conversion is deliberate.** The business ships and invoices in batches, so an SO that
  already has a DO can legitimately get another. The real guard is the **quantity ceiling**, never
  an "already converted" flag.

---

## 4. Costing — how it actually works, and why the obvious fix was wrong

**The cost pipeline is:** document price → FX + freight → `inventory_movements.unit_cost_sen` →
`inventory_lots` → `inventory_lot_consumptions` → DO line → SI line. There is no COGS general-ledger
account.

The mechanism is one AFTER INSERT trigger on `inventory_movements`:

- **IN** opens one lot at `COALESCE(unit_cost_sen, 0)` — floored at zero, no average fallback.
- **OUT** consumes lots in `received_at ASC, id ASC` order, exact dye lot first
  (`fn_consume_fifo_batch`) then plain product+variant (`fn_consume_fifo`), writing the consumption
  rows that ARE the COGS.
- **positive ADJUSTMENT** opens a lot at `COALESCE(NULLIF(cost,0), average_of_open_lots, 0)` — the
  average fallback exists only on this branch.

### 4.1 The trap: writing a cost onto a migrated PO or GRN line is INERT

`inventory_lots.unit_cost_sen` — the valuation column — has **exactly one writer in the entire
backend**:

```
$ grep -rn "from('inventory_lots')" --include=*.ts backend/src | grep -i update
backend/src/scm/lib/recost.ts:417:  await sb.from('inventory_lots').update({ unit_cost_sen: newCost })
```

A migrated GRN posts no movement, so it opens no lot. The migrated stock lives in lots minted by
the **balance snapshot as positive ADJUSTMENT movements** (`source_doc_type = 'AC_CUTOVER'`), not by
receipts. So the plan "read the invoice price and stamp it on the PO line" would have written a
number nothing downstream reads. The cost has to go on the **lot**.

### 4.2 The invoice is where the price is

AutoCount prices these purchases on the **purchase invoice**, not the PO, and the cutover never read
it. Measured live, read-only:

```
PI lines: 21,927 total, 19,918 priced (90.9%)
PO lines with NO price: 10,371 -> the PI down the chain carries a price for 9,863 (95.1%)
the chain is PO -> GR -> PI:  PIDTL.FromDocType = 'GR' on 20,777 of 21,927 lines
```

Validated against a known-good subset — PO lines that already had a price:

```
5,665 such lines have a PI price; the PI AGREES with the PO on 5,603 (98.9%), differs on 61 (1.1%)
```

The 1.1% that differ are price changes between order and invoice; **for costing the invoice is the
truth, because it is what was actually paid.**

For contrast, the inference approaches that were backtested over 11,239 priced purchase lines and
**rejected**:

| method | exact | MAPE | overstates |
| --- | ---: | ---: | ---: |
| `MAX(UnitPrice)` by item code | 2.1% | 112.5% | 97.6% |
| LAST purchase cost by item code | 9.7% | 32.2% | 57.2% |
| item + `Desc2` signature | 97.3% | 0.4% | 1.5% |
| supplier + item + `Desc2` | 98.0% | 0.4% | — |

### 4.3 Applied to production 2026-08-11 — the zero-cost lot backfill

`backfill-zero-cost-lots` (`APPLY`, run 31458214535). It only touches lots that are from this
cutover, **still fully unconsumed** (so no settled COGS is rewritten), and currently zero-cost; the
originating movement is updated in the same transaction so the lot and the ledger never disagree.

```
to cost                          : 103 lots /  396 units,  +RM 69,812.18 of inventory value
left at zero on purpose          : 127 lots /  216 units  (GWP / demo / display — zero IS their cost)
skipped because already shipped  :   0
```

Independently re-measured afterwards by `stock-truth-check`, not by the script's own log:

```
zero-cost open layers : 230 layers / 612 units   ->   127 layers / 216 units
inventory value       : RM 2,158,598             ->   RM 2,228,410
```

The 127 that remain are 89 sofa layers (waiting on the compartment round) and 38 genuinely free
items.

**Caveat, stated plainly:** this backfill priced from *the item's most recent priced purchase*,
which is an inference (9.7% exact in the table above), not a copy. It was applied on the owner's
explicit instruction after that was pointed out. Snapshot lots have no invoice of their own to copy
— but where a relayered lot does trace to a real receipt, upgrading it to that receipt's actual
invoice price is strictly better and is still open (§5.3).

---

## 5. Open problems

### 5.0 The answer to "is our migrated data identical to AutoCount?"

**No.** The owner asked it directly on being shown the over-receipt —
*"我们的数据居然是 migrate 的，那就应该全部一模一样 migrate"* — and he was right to.
`check-migration-fidelity` (PR #1981) now answers it on demand, per line, per field:

```
migrated lines compared field by field against the live AED_HOUZS book : 15,295
field values that DIFFER                                               :  2,397
of those, with no already-decided reason                               :  1,765
ERP lines that could not be paired at all (each one listed)            :     33 of 15,328
```

It prints a **72-field map** (42 COMPARED / 6 DERIVED / 21 DECLARED / 3 NOT-CHECKED) so a field the
check does not cover is visible rather than silently absent, and it groups findings **by field**, so
one importer bug wrong on many rows reads as one finding instead of scattered noise.

Everything in §5.1–§5.4 was found by it. Nothing in this list was visible to any aggregate check:
document counts, numbering, balances, the SO→PO→GR chain and stock status were all passing while
every one of these was true.

**Why nothing caught them sooner:** each aggregate agrees while a per-line field is wrong. The
header totals of the 39 SO and 7 PO documents flagged as "amount differs" turn out to agree with
their own lines to the cent — the money is not wrong, **lines are missing** (§5.4).

**Discipline note worth keeping.** The first run of this check found only 51 over-received lines,
not 65. Rather than explaining the gap away, the agent went after its own check and found the fault:
matching a sofa build by exact item code claimed one compartment and orphaned its siblings, hiding
14 lines. Fixed to claim a build as a group, re-run, and it reproduced 65 exactly.

### 5.1 130 lines carry a received quantity AutoCount never recorded

**AutoCount does not permit an over-receipt. We manufactured this during migration.**

`export-received-pos-live.py` computes `GrQty` as `SUM(GRDTL.Qty)` over `(DocNo, ItemCode)` — a
document-level aggregate. On a document holding two lines of the same item code (routine for sofa
compartments) every line therefore got the document's total, and
`import-ac-so-linked-pos.mjs:167` wrote that into `received_qty`.

```
export received qty DISAGREES with PODTL.TransferedQty : 60 of 738 lines — always inflated
export lines where recv > qty (impossible for one line):      59
e.g. HC-PO-009633 : ERP says both lines received 2
                    AutoCount GR-005152 holds two GR lines of qty 1 — each received 1
system-wide: 65 PO lines / 73 excess units / 29 POs
        PLUS 65 migrated GRN lines that INHERIT the same number  ->  130 lines in total
```

The GRN half was missed on the first pass: the migrated GRN copies the PO line's `received_qty`, so
one wrong source produced two wrong rows. **Repairing the PO line alone would leave the GRN wrong.**

**The fix is to copy, not to decide:** read `PODTL.TransferedQty` per line and overwrite both.
It touches no inventory movement, because migrated GRNs never posted one.
**Not applied — awaiting the owner.**

### 5.1b A misspelled export key ate 101 delivery dates

`import-ac-outstanding-po.mjs` reads `l.DelivDate` in three places. The export column is named
**`DeliveryDate`**. The read silently yields `undefined`, so the date was never written.

```
PO lines ERP-null against a real AutoCount date : 101
POs showing no expected delivery at all         :  46
```

This is the root cause of the owner's own screenshot question — *"delivery date 全部没带来？"* — and
it is the second time this exact key rename has cost data (an earlier one lost 76 line dates, §2).
Pure loss, no wrong value: copying the correct column fills them.

### 5.1c AutoCount quantity 0 becomes 1

`Math.round(num(l.Qty)) || 1`. Zero is falsy in JavaScript, so a legitimate zero-quantity line is
written as one. **5 lines**, plus 2 PO line totals AutoCount records as 0.

Small, but it is the same class as the rest: the importer decided a value instead of copying one.

### 5.2 D9 / D10 — sofa cannot round-trip to AutoCount

- **D10 — ItemCode is not invertible.** The ERP stores a compartment sku; AutoCount holds one line
  per sofa. 589 of 864 PO lines cannot be matched back for this reason.
- **D9 — a sofa does not collapse back to one AutoCount line.** Until it does, **any document
  carrying a sofa cannot be written back**, which blocks the owner's go-live criterion 1 for those
  documents.

### 5.4 321 AutoCount lines are on a document we hold, but the line never arrived

The document came in; the line did not. This is the one that explains the "header amount differs"
findings — each of those headers agrees with its own lines exactly, so nothing is mispriced; there
is simply less of the order in the ERP than in AutoCount.

```
AutoCount lines on an ERP-held document with NO matching ERP line : 321
  already transferred (delivered/invoiced in AutoCount)           : 245
  zero quantity                                                   :  23
  STILL OUTSTANDING — the ones that matter                        :  42
        of which purchase-order lines                             :  26
        of which sofa builds on recent POs                        :  24
```

The 42 outstanding ones are a real gap in what staff can see and act on. The 245 transferred ones
are consistent with the deliberate decision not to migrate history (§1), but they were never
enumerated before, so they had never been separated from the real gap.

### 5.5 1,004 venue values the check cannot evidence

The venue on those lines does not match AutoCount's raw value, and the check could not prove it is
the post-import canonicalisation (it *could* prove that for 593 others). Either the canonicalisation
is under-recorded or some venues were rewritten by something else. Unresolved — it needs the
canonicalisation rule stated somewhere the check can read.

### 5.6 Still open, smaller

| | |
| --- | --- |
| 382 PO lines have no `so_item_id` | bound allocation cannot settle, and the over-ship / over-receive ceilings are **keyed on the link**, so they are blind to unlinked lines — this is why `DO-2607-005` on `SO-2606-019` double-shipped |
| 46 migrated DO lines carry no price **or** cost | converting them to sales invoices as-is produces zero-value invoices |
| 2,768 bedframe/sofa lines never ordered from a supplier on either system | a real buyer's backlog, not a defect |
| 10 AutoCount receipts landed after the migrated documents were created | drift — and it grows every day the two systems both run |
| `RM 643` of stock is invisible on the Inventory screen | held on an inactive warehouse or non-active product |
| a genuine FIFO short is silently discarded | `v_short` is computed and never persisted |
| SO photo routes apply no company scoping | the PO and consignment routes do; the SO pair is the odd one out, and the client is service-role so the predicate IS the isolation boundary. Owner: *"要隔离啊"* |
| upgrade §4.3's pricing to the actual invoice | where a relayered lot traces to a real receipt |

---

## 6. Resuming on Friday — do these in order

1. **Re-sync the drift first.** Both systems have been running, so the snapshot is stale by however
   many documents AutoCount has moved since. Re-export and top up **before** touching anything else,
   or you will be repairing new problems with old data. The 10 known receipts are the floor, not
   the number.
2. **Run `check-migration-fidelity` and treat its output as the work list.** It is the only check
   that reads per line and per field; every defect in §5.1–§5.5 came from it and none of them was
   visible to the aggregate checks. Diff its numbers against §5.0 — anything new is either step 1's
   drift or a regression, and you need to know which before you repair anything.
3. **Re-run the other eight standing checks** and diff against §3.
4. **Repair the pure LOSSES first — they are copies, not decisions, and carry the least risk.**
   In this order, because each is a straight read of a column we already have:
   - the 101 missing delivery dates (§5.1b) — one misspelled key, nothing to judge;
   - the 130 over-received lines (§5.1) — copy `PODTL.TransferedQty` to the PO line **and** its
     migrated GRN line;
   - the 5 zero-quantity lines turned into 1 (§5.1c);
   - the 42 still-outstanding missing lines (§5.4) — import what never arrived.
   All four are "read AutoCount's own value and write it". None needs a rule.
5. **Then close D9 and D10** (§5.2) — nothing sofa-shaped can be written back until they are done,
   and 24 of the 42 missing lines in §5.4 are sofa builds, so the two are related.
6. **Then** the remaining items in §5.6 and the unresolved §5.5.

Step 4 before step 5 is deliberate: a loss is cheap and safe to repair, a reconstruction is not.
Fixing what we simply failed to copy costs nothing in judgement and shrinks the surface of
everything after it.

### 6.1 Do not repeat these

- **Never branch from local `main`** in this repo — it runs hundreds of commits behind
  `origin/main`. An audit branched from it and "proved" that a column added months ago does not
  exist, and every conclusion it drew had to be thrown away. Make any agent print
  `git rev-list --count $(git merge-base origin/main HEAD)..origin/main` before you read its findings.
- **A dry-run must print exactly what apply will write.** One repair's log said "LEFT AT ZERO" for
  two lines that apply would have priced at RM2,051.50. Build the plan once and let both the log and
  the writer consume that same list.
- **CI green is not correctness.** Every wrong-value defect above passed CI. They were caught by
  adversarial review — an agent whose task was to refute the work, reading the diff rather than the
  report, and re-running the tests with the fix reverted to prove they actually fail without it.
- **Read the failing response before writing down a cause.** Line photos were recorded as "files
  never uploaded" and then as "bucket name not configured". Both were wrong. The actual response was
  `500 signing_failed: R2_ACCESS_KEY_ID not configured`, while the same object served fine through
  the proxy route — the objects were never missing.

---

## 7. The safety state while this is paused

Verified live on 2026-08-11 by `check-write-freeze` (run 31458625039), not from memory:

```
scm.write_freeze = "1"   (set 2026-08-10T07:53:24Z)
MEANS: FROZEN for company 1 only (others trade normally), every area
areas still PAUSED (24): sales orders / delivery / invoices / returns · procurement / GRN / PI /
                         MRP / PO / PR / products / suppliers · warehouse inventory / adjustments /
                         stock take / transfers · the whole consignment set · finance
areas REOPENED (0): none
staff message: "Editing is paused while the AutoCount data migration is completed. Please do not
                create or change orders — ask IT when you need something updated."
```

**Nobody can create or change a document in the Houzs ERP, so nothing can write into AutoCount.**
That is the intended state while staff stay on AutoCount. 2990 (company 2) is unaffected and trades
normally — it is not part of this migration.

Two things to know before anyone touches this:

- A per-module staged lift now EXISTS (`set-write-freeze`, PR #1967) but **zero areas have been
  lifted**. The capability is not the same as the act.
- **Enforcement trails the database row by up to 30 seconds** (middleware cache TTL). Do not judge
  the effect of a freeze change in the second after making it.
- Routers with no area key (hr, staff, localities, currencies, categories,
  state-warehouse-mappings, pos-cart, personal-quick-picks, sales-analysis) cannot be lifted
  individually and stay paused until the whole company is unfrozen.

Unfreezing is the owner's call alone. His standing instruction: *"解冻我跟你说你才做."*
