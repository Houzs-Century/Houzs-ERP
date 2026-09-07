# Go-live runbook — 2026-09-07

One ordered list of what to dispatch tonight, and in what order, to satisfy the
owner's acceptance spec. Every number here was **measured**, not read off a
source file. The method and the raw evidence are in §6.

Companion docs, neither of which this one replaces:

- `docs/ac-resync-runbook.md` — the generic METHOD (phases 0-5) and its traps.
  This file is tonight's ordered INSTANCE of it, with the census attached.
- `docs/golive-readiness-2026-09-07.md` — what is currently WRONG (the parity
  gate's verdict). This file is what to RUN about it.

---

## 0. The finding, in one line

**The cutover jobs are not un-dispatched. They are dispatched in DRY-RUN and
never flipped to apply.**

The morning's reconciliation reported 32 Goods Received and 12 Delivery Orders
absent from the ERP, and concluded no importer was missing. Both halves are
right, and the conclusion drawn from them was wrong. `create-migrated-documents`
exists, and it ran **today at 08:25 UTC** — in `DRY-RUN`. Its own log says so.
So the documents really are absent, the tool really does exist, and the missing
step is the one nobody took.

Re-measured at 08:43 UTC today with a run dispatched for this report
(`34102058139`), against the snapshot re-cut this morning:

```
GR: book 212, in ERP 180, MISSING 32
DO: book  83, in ERP  71, MISSING 12
```

Exactly the morning's two numbers. They were never imported.

**This generalises.** Of the eight cutover lanes dispatched this morning, six
ran read-only and two wrote:

| dispatched today | mode | wrote anything? |
|---|---|---|
| `import-ac-outstanding-so` | `DRY-RUN` | no |
| `import-ac-outstanding-po` | `DRY-RUN` | no |
| `import-ac-so-linked-pos` | `DRY-RUN` | no |
| `stamp-ac-grn-refs` | `DRY-RUN` | no |
| `create-migrated-documents` | `DRY-RUN kind=both` | no |
| `repair-migrated-do-prices` | `mode=plan` | no |
| `sync-ac-delta` | `mode=plan lanes=desc,pay,links` | no |
| `recompute-so-allocation` | `DRY-RUN` + **refused** | no (see §5.1) |
| `import-so-line-photos` | **`mode=APPLY`** | yes |
| `import-po-line-photos` | **`mode=APPLY`** | yes |

PROVEN, from each run's own annotations. Photos are in. Nothing else is.

### The second-order trap: a stale check reports "all clear"

`check-cutover-completeness` ran at 03:20 UTC, **before** the snapshots were
re-cut at 06:35, and reported:

> SO: AutoCount outstanding 2750; in ERP 2750; **MISSING 0** · PO MISSING 1

The same check, re-dispatched at 08:43 against the fresh snapshot
(run `34102060759`), reports:

> SO: AutoCount outstanding 2777; in ERP 2679; **MISSING 98** · PO MISSING 75

Nothing changed in the ERP between those two runs. Only the input did. **A job
whose input is newer than its last run does not merely owe a run — its previous
verdict is actively misleading.** That is the rule the census below applies.

---

## 1. Headline census

Measured across every workflow the Actions API knows about, cross-referenced
against `git log -1 --format=%cI` on each file in `backend/scripts/data/`.

`origin/main` carries **446** workflow files; the API knows **447**. The extra
is `tmp-audit-all-so.yml` [gone] — deleted from the tree, still remembered
because it has run history. It is in none of the lists below.

| | count |
|---|---|
| workflow files on `origin/main` | 446 |
| **owe a run** (input snapshot newer than their most recent run of any kind) | **65** |
| ...of those, **never run at all** | **7** |
| workflows with zero runs in their entire history | 37 |
| snapshot entries under `backend/scripts/data/` | 82 |
| ...re-cut today by PR #3029 | 14 |

PROVEN. Full derivation in §6; the complete 65-row list is in §6.5.

### The 7 that owe a run and have NEVER been dispatched

```enumeration
align-rebind-unlinked          input autocount-sku-rebind-pairs.tsv @ 2026-08-07
bedframe-sofa-status-truth     input ac-bedframe-sofa-readiness.json.gz @ 2026-08-11
cancel-parity-check            input ac-cancel-parity.json.gz @ 2026-08-11
check-po-arm-own-text          input ac-outstanding-so.json.gz @ 2026-09-07
delivered-but-open             input ac-fidelity-so-lines.json.gz @ 2026-08-11
mrp-unreleased-demand          input ac-fidelity-so-lines.json.gz @ 2026-08-11
stamp-po-line-costs            input autocount-erp-mapping-1561.csv @ 2026-08-29
```

Only one of these is on tonight's critical path: **`check-po-arm-own-text`**,
whose input was re-cut this morning.

**It has now been run, for the first time in its life** (run `34102814435`,
read-only, dispatched for this report), and it found something:

```
distinct (DocNo|erp_code) keys in the PO export:  447
keys carrying more than one export row:            48
export rows whose parse the survivor overwrote:    15   <- the CEILING on PO-arm damage
  of those, the parse DIFFERS from the survivor:   12   <- the only keys that can have done damage
  of those, every row parses IDENTICALLY:          36   <- harmless
```

So the ceiling on PO-arm damage is **15 rows, of which 12 can actually have done
harm** (e.g. `PO-009776|8050-1S`). That is a small number and it is not zero —
and it sat unmeasured because nobody had ever pressed Run. **This is the whole
report in miniature:** a check that has never run is not evidence of health, it
is an absence of evidence, and the two look identical on a dashboard. The other six read snapshots that are
themselves weeks old (the `ac-fidelity-*` set has not moved since 2026-08-11),
so running them tonight would measure a stale world. They are listed for
completeness, not scheduled.

### The full never-run set (37, for the record)

These have zero runs in their entire history. Most are probes written and never
fired; none except `check-po-arm-own-text` and `resync-so-delivered-status` sit
on tonight's path.

```enumeration
align-rebind-unlinked            mrp-snapshot-check
backfill-zero-line-costs         mrp-unreleased-demand
bedframe-sofa-status-truth       park-2990-staff-showroom
branding-vocabulary-check        probe-amendment-price-discarded
cancel-parity-check              probe-effective-delivery-drift
check-po-arm-own-text            probe-mrp-roundtrip-cost
delivered-but-open               probe-po-so-link-provenance
driver-scope-link-check          probe-pos-flags-govern-erp
dump-compat-views                probe-remark-staleness
dump-views                       probe-so-delivered-not-advanced
duplicate-ic-check               probe-transfer-census
ios-release                      probe-venue-write-divergence
ledger-divergence-check          relabel-provenance-notes
migrate-2990-staff               resync-so-delivered-status
retire-non-fabric-rows           salesperson-picker-roster-check
sequence-drift-check             sequence-drift-repair
seed-fleet-data                  stamp-po-line-costs
truth-scope-check                variant-key-drift-check
which-so-is-so-to-po-retrying
```

---

## 2. The measured backlog to clear tonight

From run `34102058139` (read-only, dispatched 08:43 UTC today, fresh snapshot):

```
book graph: SO 2777 | PO 484 | DO 83 | GR 212 | PI 186 | SO->PO line edges 699
erp graph:  SO 2770 | PO 499 | DO 71 | GR 222 | PI  28 | SI 39

SO   book 2777, in ERP 2679, MISSING  98
PO   book  484, in ERP  409, MISSING  75
DO   book   83, in ERP   71, MISSING  12
GR   book  212, in ERP  180, MISSING  32
PI   book  186, in ERP   17, MISSING 169
SO->PO line edges  book 699, linked 542, LINE-MISSING 78, EDGE-MISSING 2
DO parent check: WRONG-PARENT 0
VERDICT: total backlog items 466
```

PROVEN. The **169 missing PIs** are the largest single item and the one with a
blocked tool — see §5.2.

---

## 3. The ordered runbook

**Step zero, before anything below: merge PR #3044** (the post-lock snapshot
re-cut) and, if the SI/PI lane matters tonight, land the invoice re-export from
§5.2 in the same window. Everything in Phase A reads those snapshots.

**Ordering rationale, which is the part that matters.** Each step's input is the
previous step's output:

1. Documents must EXIST before anything can reference them.
2. Line-level keys and links must exist before dedication/variant work can join on them.
3. A variant refresh parses a description, so the description must be current first.
4. Sofa compartment decomposition needs the lines to exist and their Desc2 to be current.
5. Stock movement is a consequence of documents, so stock imports come after documents.
6. MRP and COGS READ stock, so they come last.

**Two standing rules for every dispatch below:**

- **Always pass `-f target=prod`.** Most of these default to `staging`. On
  2026-08-30 a whole SO apply landed in staging because it was omitted. Verify
  by reading the run's first log line: `Complete job name: run-prod`.
- **Dispatch dry first, read the plan, then re-dispatch with apply.** Never
  chain them. The dry-run output is the evidence that the apply is safe.

### Phase A — documents (must be first)

| # | workflow | DRY RUN | APPLY | changes | proof it worked |
|---|---|---|---|---|---|
| A1 | `import-ac-outstanding-so` | `-f target=prod` | `-f target=prod -f apply=1` | inserts the 98 missing SOs | re-run A0 check: SO MISSING -> 0 |
| A2 | `import-ac-outstanding-so` (sofa pass) | `-f target=prod -f sofa=yes` | `-f target=prod -f sofa=yes -f apply=1` | the held sofa orders, per-compartment | sofa lines appear with compartments |
| A3 | `import-ac-outstanding-po` | `-f target=prod` | `-f target=prod -f apply=1` | inserts missing standalone POs | PO MISSING drops |
| A3b | `import-ac-outstanding-po` (sofa pass) | `-f target=prod -f sofa=yes` | `-f target=prod -f sofa=yes -f apply=1` | the held sofa POs, per-compartment | sofa PO lines appear |
| A4 | `import-ac-so-linked-pos` | `-f target=prod` | `-f target=prod -f apply=1` | POs raised against an in-book SO, line-bound | PO MISSING -> 0; LINE-MISSING drops |
| A5 | `topup-ac-po-lines` | `-f target=prod` | `-f target=prod -f apply=1 -f confirm="I HAVE REVIEWED THE DRY-RUN"` | adds PO lines missed by earlier rounds | LINE-MISSING 78 -> 0 |
| A6 | `stamp-ac-grn-refs` | `-f target=prod` | `-f target=prod -f apply=1` | stamps GR/PI refs onto imported POs | GR refs present on PO rows |
| A7 | `create-migrated-documents` | `-f target=prod -f kind=both` | `-f target=prod -f kind=both -f apply=1` | creates the 32 GR + 12 DO mirrors, **no stock movement** | GR MISSING 32->0, DO MISSING 12->0 |
| A8 | `repair-migrated-do-prices` | `-f mode=plan -f company=all` | `-f mode=apply -f company=all -f confirm="THE PRICE COMES FROM THE SALES ORDER"` | prices the zero-value migrated DO lines | see §3.1 |
| A9 | `create-migrated-invoices` | `-f target=prod -f mode=dry-run -f kind=both` | `-f target=prod -f mode=apply -f kind=both -f confirm="I HAVE REVIEWED THE DRY-RUN"` | the 169 missing PIs + SIs | **BLOCKED — see §5.2** |

Both importers carry a `sofa` input (`default: "no"`, choice `no|yes`), verified
against the YAML on `origin/main`. The sofa orders are **held out of the default
pass by design** — `import-ac-outstanding-so.mjs:6` skips any order with a sofa
line whole — so the sofa pass is a second dispatch, not an option on the first.
Run the plain pass to completion before the sofa pass on each side.

#### 3.1 What A8 will actually do

PROVEN, from run `34100490708`'s own plan output today:

```
zero-priced lines on migrated delivery orders : 320
  repairable from the sales order             :  65
  sales-order line is itself 0 - left alone   : 255
  no so_item_id - REPORTED, never guessed     :   0
documents affected                            :  56
```

So the population is **56 documents / 65 lines**, not the 71 quoted this
morning. The other 255 are legitimately zero because their sales-order line is
zero, and the tool leaves them alone by design.

### Phase B — line keys, links, dedication

| # | workflow | DRY RUN | APPLY | changes |
|---|---|---|---|---|
| B1 | `backfill-ac-line-keys` | `-f target=prod` | `-f target=prod -f apply=1` | stamps `linked_ac_dtlkey` on SO lines |
| B2 | `backfill-ac-sofa-line-keys` | `-f target=prod` | `-f target=prod -f apply=1` | same, sofa lines |
| B3 | `backfill-po-ac-dtlkey` | `-f target=prod` | `-f target=prod -f apply=1` | PO line -> SO line key |
| B4 | `repair-dedication-from-autocount` | `-f target=prod` | `-f target=prod -f apply=1` | which PO line serves which SO line |
| B5 | `repair-migrated-po-lines` | `-f target=prod` | `-f target=prod -f apply=1 -f confirm="I HAVE REVIEWED THE DRY-RUN"` | repairs PO lines against the book |
| B6 | `repair-so-delivered-from-imported-dos` | `-f company=1` | `-f company=1 -f apply=1 -f confirm_company=1` | advances SO delivered state from the DOs A7 created |

**B6 must come after A7.** It reads the delivery orders A7 creates; run before,
it sees nothing and reports a clean no-op — the exact false negative that
started this report. Its confirm value is the company id repeated, not a phrase.

Proof for Phase B: re-run `check-ac-erp-doc-links` — `LINE-MISSING` and
`EDGE-MISSING` should both reach 0.

### Phase C — the "latest data" refresh (remark 2, dates, payments)

The owner's spec: *remark 2、照片、variant 等等也是根据最新的数据 update 进来*.

| # | workflow | DRY RUN | APPLY | changes |
|---|---|---|---|---|
| C1 | `refresh-so-tail-from-book` | (no inputs) | `-f apply=1 -f confirm="REFRESH SO TAIL"` | header fields + line delivery dates, from the book |
| C2 | `backfill-so-remarks` | (no inputs) | `-f apply=1 -f confirm="BACKFILL SO REMARKS"` | Remark2-4 |
| C3 | `backfill-so-dates` | `-f target=prod` | `-f target=prod -f apply=1` | SO dates |
| C4 | `unify-processing-date` | `-f target=prod -f mode=dry-run -f company=1` | `-f target=prod -f mode=apply -f company=1 -f confirm="I HAVE REVIEWED THE DRY-RUN"` | the **62 missing Processing Dates** |
| C5 | `sync-ac-delta` | `-f target=prod -f apply=no` | `-f target=prod -f apply=yes -f confirm="SYNC AC DELTA" -f lanes=desc,pay,links` | desc2 + the **47 payment differences (RM 155,521)** + links |

C1/C2 take **no `target` input** — they are prod by design. A 422 means drop
the parameter.

C4 and C5 together close items 2 and 3 of the readiness doc's three blockers.

Photos are already applied (`import-so-line-photos` / `import-po-line-photos`,
`mode=APPLY`, 08:21 UTC today) — **do not re-run them** unless
`probe-line-photo-coverage` shows a gap.

### Phase D — variants, sofa compartments, bedframe

**Must come after Phase C**: these parse the description, so the description has
to be current first. This is the ordering the owner's spec implies and the one
most likely to be got wrong.

| # | workflow | DRY RUN | APPLY | changes |
|---|---|---|---|---|
| D1 | `refresh-so-variants` | `-f target=prod` | `-f target=prod -f apply=1` | re-parses SO line variants |
| D2 | `refresh-po-variants` | `-f target=prod` | `-f target=prod -f apply=1` | same, PO side |
| D3 | `redecode-collapsed-sofa-lines` | `-f target=prod -f mode=plan -f company=1` | `-f target=prod -f mode=apply -f company=1 -f confirm="I HAVE REVIEWED THE DRY-RUN"` | **sofa -> compartments** (the owner's item 1) |
| D4 | `refresh-sofa-colours` | `-f target=prod -f company=1` | `-f target=prod -f company=1 -f apply=1` | fabric colour per compartment |
| D5 | `apply-sofa-compartment-corrections` | `-f target=prod -f company=1` | `-f target=prod -f company=1 -f apply=1` | the owner's hand corrections |

**Bedframe (the owner's item 2) has no dedicated apply workflow.** See §5.3.

Proof for Phase D: `check-sofa-bedframe-completeness -f target=prod -f
company=1` — the PROCEEDED backlog (colour 47 / seat size 21 / compartments 0)
should shrink. Per the owner's 2026-09-04 rule, only the **proceeded**
population counts; the all-orders figure is context and must not be quoted as
the work.

### Phase E — stock

**After documents, because documents move stock.**

| # | workflow | DRY RUN | APPLY | changes |
|---|---|---|---|---|
| E1 | `import-ac-stock-balance` | `-f target=prod -f neg=1` | `-f target=prod -f neg=1 -f apply=1` | balances both directions |
| E2 | `import-ac-sofa-stock` | `-f target=prod` | `-f target=prod -f apply=1` | sofa batches |
| E3 | `import-ac-stock-layers` | `-f target=prod` | `-f target=prod -f apply=1` | FIFO cost layers |

`neg=1` on E1 is deliberate: negatives are period issues, deducted by FIFO.
Read both columns in the dry-run.

Proof: `check-stock-vs-autocount` and `stock-truth-check`. The 1A figure to beat
is **798 of 936 cells agreeing (85.3%)**.

### Phase F — allocation, MRP, COGS (last, because they read stock)

| # | workflow | notes |
|---|---|---|
| F1 | `recompute-so-allocation` | **BROKEN — see §5.1.** Use `enqueue-so-allocation-recompute` instead. |
| F2 | `enqueue-so-allocation-recompute` | queues the in-app allocator, which is not affected by the §5.1 defect |
| F3 | `mrp-pairing-audit` | read-only |
| F4 | `uncosted-cogs-check` | read-only; last succeeded 2026-08-05, owes a run |
| F5 | `costless-stock-check` | read-only; last succeeded 2026-08-11, owes a run |

F2 is what clears the **43 CONTESTED orders** the parity gate flagged — the ones
where our own stored status is stale and AutoCount may be right.

### Phase G — final verification (all read-only, dispatch freely)

Run these in order and read every one:

```
check-cutover-completeness   -f target=prod
check-ac-erp-doc-links       -f target=prod
golive-parity-check          -f target=prod -f company=1
check-sofa-bedframe-completeness -f target=prod -f company=1
check-stock-vs-autocount     -f target=prod
stock-truth-check
ac-erp-reconcile
```

The gate is `golive-parity-check`. Its verdict block is the acceptance
criterion; the readiness doc explains how to read each section.

---

## 4. Mapping the owner's spec to the steps

| the owner asked for | steps | tool exists? |
|---|---|---|
| SO DO PO GR 全部搬进来 | A1-A7 | yes |
| SI PI 搬进来 | A9 | **blocked, §5.2** |
| remark 2 update | C2, C5 | yes |
| 照片 import | already applied today | yes, done |
| variant update | D1, D2 | yes |
| 哪些 SO 转成 DO / PO 转成 GR / SO 转成 PO | B4, B6 + `check-ac-erp-doc-links` | yes |
| 对标 transaction workflow, 确认哪些 valid | Phase G | yes |
| 沙发 -> compartment | D3, D4, D5 | yes |
| Bed frame -> variants | D1 partly | **no dedicated tool, §5.3** |
| 核对哪些数据没有 / 是否本来就该没有 | Phase G + readiness doc | yes |
| tally stock balance + amount | E1-E3, then G | yes |
| MRP / COGS 自动跟着 tally | F2-F5 | partly, §5.1 |
| sales agent 跟着我们的逻辑 | `sync-ac-delta` LANES=hdr / hdrstaff | yes, §5.4 |
| SKU 跟着我们的逻辑 | `align-open-skus`, `align-seed-skus`, `reconcile-sku` | yes, but all stale |

---

## 5. Gaps — things the spec needs that have no working tool

### 5.1 `recompute-so-allocation` cannot run the canonical allocator (PROVEN)

Run `34099835565` today reported job status **success** while the operation
**refused**:

```
[so-allocation] recompute failed: Error: allocation DO-line load failed:
  pgrest-shim: unsafe identifier "so.status"
canonical result: ok=false linesFlipped=0 ordersAdvanced=0 ordersRegressed=0
```

Root cause, traced: `backend/src/scm/lib/so-stock-allocation.ts:447` uses an
embedded PostgREST select with a dotted filter —

```js
.select('id, so:mfg_sales_orders!inner(status), do_items:delivery_order_items!inner(...)')
.not('so.status', 'in', SO_TERMINAL_STATES_PGREST)
```

Real PostgREST supports that. The **script wrapper does not**:
`backend/scripts/lib/pgrest-shim.mjs:53` guards identifiers with
`/^[a-z_][a-z0-9_]*$/`, which rejects the dot. The shim's own header says it is
"NOT a general client. No embedded selects". So the workflow is structurally
incapable of running the current allocator.

**Impact is limited**: the in-app allocator (every GRN/DO/return trigger) uses
real PostgREST and is unaffected. Use `enqueue-so-allocation-recompute` (F2)
tonight. The shim fix is a follow-up, not a tonight job.

**Note the reporting hazard**: the job exits 0 by the repo's own read-only
convention, so this refusal is invisible unless you read the log. Anyone
scanning for red runs would have called this green.

### 5.2 The SI/PI lane is blocked on a stale snapshot (PROVEN)

`create-migrated-invoices` last ran 2026-09-05 and **failed**:

```
REFUSED: ac-invoice-refs.json.gz was exported 2026-08-30T02:38:32 (6.1 days ago).
Invoices raised since are invisible to it and its totals are superseded.
Re-export the map first (export-ac-reimport.py ONLY=ivrefs).
```

The guard is `ageDays <= 2` (`create-migrated-invoices.mjs:88`). Today it would
be **8.9 days** and refuse again.

**Why**: PR #3029 re-cut 14 snapshots this morning but **not** the invoice pair.
`ac-invoice-refs.json.gz` and `ac-invoice-prices.json.gz` are still at
2026-08-29T19:01:04Z. This is what leaves **169 PIs** missing.

**Confirmed twice.** PR #3044 — *"the FINAL AutoCount cut, taken one minute after
the book was locked"*, open and queued as this was written — re-cuts 15 snapshot
files and **also skips the invoice pair**. So two consecutive re-cuts, including
the one explicitly framed as final, have left the invoice map untouched. This is
not an oversight to hope somebody notices tonight: **the exporters below are a
separate pair of scripts and somebody has to run them.**

**The fix, and it must happen on this machine before A9 can run:**

```bash
AC_CRED_FILE=<scratchpad>/.ac-cred python backend/scripts/export-ac-invoice-refs.py
AC_CRED_FILE=<scratchpad>/.ac-cred python backend/scripts/export-ac-invoice-prices.py
```

then commit both `.gz` files in a PR and merge before dispatching A9. The export
is read-only, so the AutoCount view-only lock does not block it — but it does
need the ZeroTier link to `DESKTOP-TDH50IT\A2006`.

**UNTESTED** — I did not run either exporter; they need the credential file and
the ZeroTier link, neither of which is available from this session.

### 5.3 Bedframe decomposition has no apply workflow (LIKELY)

The owner asked for bedframe descriptions to be parsed into variants, the same
way sofas become compartments. The parser exists
(`backend/scripts/lib/parse-bedframe.mjs`, used by `check-golive-parity` and
others), and `refresh-so-variants` (D1) will apply whatever that parser yields.
But there is **no bedframe equivalent of `redecode-collapsed-sofa-lines`** — no
dedicated decomposition-and-apply lane.

`bedframe-sofa-status-truth` exists and would measure this, but it has **never
been run** and its snapshot (`ac-bedframe-sofa-readiness.json.gz`) is from
2026-08-11, so it would measure a stale world.

Labelled LIKELY, not PROVEN: D1 may already cover the requirement via the shared
parser. **Confirm with the owner what bedframe decomposition should produce
beyond what D1 does** before treating this as a gap to build.

### 5.4 Sales agent has no cutover tool — CLOSED 2026-09-07 (header master lane)

The owner's last line asks whether incoming orders can follow our own logic for
sales agents and SKUs. For SKU there are tools (`align-open-skus`,
`align-seed-skus`, `reconcile-sku`) — all stale, all in the 65.

For sales agent there was only `salesperson-picker-roster-check`, which has
**never been run** (0 runs, entire history). There was no backfill or alignment
workflow that assigns sales agents on imported orders.

**What closed it.** `sync-ac-delta.mjs` gained a HEADER MASTER lane, and the gap
turned out to be wider than the agent: the importer maps AutoCount's whole
header at INSERT and nothing had looked at it since, so the customer name, the
invoice address, the phone, Ref, venue, branding, the processing date and the
remarks were all frozen on the day each document was copied. The lane reports,
per FIELD, how many migrated documents AGREE with AutoCount, how many DIFFER,
and how many the ERP holds blank while AutoCount has a value — and it does the
same for purchase-order headers.

- **Plan is the default and writes nothing.** Actions -> *Sync AutoCount delta
  (go-live)* -> target `prod`, apply `no`.
- **The field map is shared with the importer**
  (`backend/scripts/lib/ac-header-fields.mjs`), so the insert and the update
  cannot drift. `SALESLOC` was moved there out of
  `import-ac-outstanding-so.mjs`, and a test fails if a local copy comes back.
- **`LANES=hdr`** writes the straight copies only. A field the importer DERIVED
  (postcode, city, state, emergency phone, the header delivery date) is counted
  and never written — re-deriving it is the inference
  `migration-copy-never-compute` forbids. A field AutoCount left blank stays
  blank.
- **`LANES=hdrstaff`** creates the missing inactive salesperson rows. That is a
  WRITE TO MASTER DATA, so it is off unless named, every row carries an
  `ACIMP-` staff code (the reversal is one `DELETE ... WHERE staff_code LIKE
  'ACIMP-%'`), and it can never activate a person who was deactivated on
  purpose.
- **Refusals are per (document, FIELD)** and keyed on
  `mfg_so_audit_log.actor_id` being a real person, not on `version > 1` — PR
  #3042 measured 80 of 81 of those "conflicts" as the automated stock-allocation
  sweep. The plan prints what a version test WOULD have refused, so the
  difference is a number rather than an argument.
- **Fields AutoCount carries that the ERP has nowhere to put** — `Attention`,
  the four delivery-address lines, `DeliverContact`, `DisplayTerm` (the credit
  term) and `UDF_ToPONo` — are counted and labelled `NO COL`, not silently
  dropped. Giving any of them a home is an owner decision, not a sync.

The header snapshot is `backend/scripts/data/ac-doc-headers.json.gz`, cut by the
one exporter with `ONLY=hdr AC_CRED_FILE=<path> python
backend/scripts/export-ac-reimport.py`. Unlike the outstanding cut it is NOT
filtered to the outstanding population: a document that has since been fully
delivered still needs its header kept current.

### 5.5 The snapshots were cut before the lock — BEING FIXED

AutoCount went view-only at 16:20 local. The snapshot set this report measured
against is 06:35 UTC (14:35 local) with its book export stamped 13:03 local, so
there is a **1-3 hour window before the lock** whose edits it cannot contain.

**PR #3044 closes this** — it is the post-lock re-cut, and it was queued while
this was written. **Merge #3044 before running any of Phase A**, and re-run the
Phase G checks afterwards: every count in §2 was measured against the PRE-lock
snapshot and will move. The backlog shape will not change much, but the exact
numbers will, and the runbook's proof steps compare against them.

---

## 6. Method, and how to reproduce it

### 6.1 The run census

```bash
gh api 'repos/Houzs-Century/Houzs-ERP/actions/workflows' --paginate \
  -q '.workflows[] | [(.id|tostring), .state, .path, .name] | @tsv'
# then per workflow:
gh api "repos/.../actions/workflows/$id/runs?per_page=1" \
  -q '.workflow_runs[0] | [(.id|tostring), .status, .conclusion, .created_at, .event, .head_branch] | @tsv'
gh api "repos/.../actions/workflows/$id/runs?per_page=1" -q '.total_count'
```

**Trap, recorded so nobody repeats it:** the `?status=success` filter is
unreliable — it returned zero rows for `mrp-pairing-audit`, which has six
successful runs. Never-run claims in this document rest on `total_count == 0`,
which is sound; recency claims use the **unfiltered** latest run.

### 6.2 The input-freshness test

```bash
for f in backend/scripts/data/*; do git log -1 --format=%cI -- "$f"; done
```

Then map workflow -> script (`grep` the YAML) -> snapshot (`grep` the script for
the basename), and flag any workflow whose most recent run predates the snapshot
it reads. Reverse-mapping (snapshot -> readers) catches the scripts that build
their paths dynamically; the forward map alone found only 39 of them.

### 6.3 The plan-vs-apply test

The cheap way — no log download:

```bash
jid=$(gh api "repos/.../actions/runs/$RUN/jobs" -q '.jobs[0].id')
gh api "repos/.../check-runs/$jid/annotations" -q '.[].message'
```

`##[notice]` lines surface as annotations, and every one of these scripts prints
its mode there (`mode=DRY-RUN`, `mode=plan`, `mode=APPLY`, `PLAN ONLY. Nothing
was written.`).

### 6.4 Evidence dispatched for this report

Both read-only, both `success`:

| run | workflow | why |
|---|---|---|
| `34102058139` | `check-ac-erp-doc-links` | was failing on a stale snapshot since 2026-09-01; the re-cut unblocked it, PROVEN by this run |
| `34102060759` | `check-cutover-completeness` | re-measured against the fresh snapshot; MISSING 0 -> 98 |

No workflow was dispatched with `apply=1` in the course of writing this
document.

### 6.5 The 65 that owe a run

Never-run (7) are listed in §1. The remaining 58, oldest run first:

```enumeration
align-open-skus                  2026-08-05    repair-pure-losses               2026-08-28
align-link-models                2026-08-05    backfill-so-remarks              2026-08-28
align-safe-cleanup               2026-08-06    repair-migrated-po-lines         2026-08-28
load-supplier-price-list         2026-08-09    topup-ac-po-lines                2026-08-29
check-cutover-metrics            2026-08-09    import-ac-stock-balance          2026-08-29
repair-leaked-sofa-lines         2026-08-10    import-ac-sofa-stock             2026-08-29
remove-delivered-imported-so     2026-08-10    refresh-so-tail-from-book        2026-08-29
probe-sofa-import-duplicates     2026-08-10    backfill-ac-sofa-line-keys       2026-08-29
rollback-so-linked-po-import     2026-08-10    repair-dedication-from-autocount 2026-08-30
import-po-so-links               2026-08-10    backfill-photo-urls-from-keys    2026-08-31
open-5526-model                  2026-08-10    refresh-po-variants              2026-08-31
refresh-so-variants              2026-08-10    probe-sofa-colour-misses         2026-09-01
probe-write-persistence          2026-08-10    check-stock-vs-autocount         2026-09-02
backfill-so-line-warehouse       2026-08-10    check-autocount-parity           2026-09-02
check-stock-criterion            2026-08-10    check-migration-fidelity         2026-09-02
check-sofa-chain-alignment       2026-08-10    backfill-ac-line-keys            2026-09-02
diag-sofa-cutover-residue        2026-08-10    seed-chart-of-accounts           2026-09-03
repair-collided-so-variants      2026-08-10    redecode-collapsed-sofa-lines    2026-09-04
repair-grn-variant-snapshot      2026-08-11    probe-sofa-placeholder-desc2     2026-09-04
seed-hydraulic-special-addon     2026-08-11    stock-truth-check                2026-09-04
diag-so-po-variant-divergence    2026-08-11    refresh-sofa-colours             2026-09-04
backfill-po-ac-dtlkey            2026-08-11    check-so-dates-truth             2026-09-04
repair-desc2-from-own-line       2026-08-11    check-ac-vs-erp-reconcile        2026-09-05
check-status-disagreement-why    2026-08-11    check-remark2-vs-status          2026-09-05
unify-processing-date            2026-08-13    check-sofa-bedframe-completeness 2026-09-05
autocount-field-alignment        2026-08-14    check-ac-erp-doc-links           2026-09-05
census-autocount-party-codes     2026-08-18    check-cutover-completeness       2026-09-07
probe-undated-demand             2026-08-18    import-ac-stock-layers           2026-08-28
delete-ac-iv-orders              2026-08-28    backfill-so-dates                2026-08-28
```

Not all 65 should be run. `rollback-so-linked-po-import` is a rollback tool.
The `align-*` and `open-5526-model` group are one-shot August alignments whose
input files have not changed since. The ones on tonight's path are the ones
named in §3.

---

## 7. What is NOT proven here

- ~~**That the applies will succeed.**~~ CLOSED 2026-09-07 — §8 is the applied log. Originally: every apply in §3 was UNTESTED by this
  report — the brief forbade `apply=1`, correctly. The dry-runs are the
  evidence that the plans are sane; they are not evidence that the writes land.
- **That §3's order is complete.** It is derived from `docs/ac-resync-runbook.md`
  plus the dependency reasoning in §3, and cross-checked against what ran today.
  A step nobody has needed yet would not appear.
- **Whether the pre-lock window (§5.5) contains edits.** UNKNOWN.
- **Whether bedframe needs more than D1** (§5.3). LIKELY a gap; ask the owner.

---

## 8. APPLIED — 2026-09-07, the go-live run

§7 opened by saying every apply above was UNTESTED. This section closes that:
the runs below were **dispatched against prod** and their output pasted. Every
row names the run id, so nothing here has to be taken on trust.

### 8.1 What was applied, in dependency order

| # | job | plan (re-measured on the day) | what it wrote | run |
|---|---|---|---|---|
| 1 | `import-ac-outstanding-so` `sofa=yes` | 2,789 source orders / 14,041 lines; 112 absent | **112 orders, 558 items, 108 payments**; 2,677 skipped-existing; 108 exceptions | 34112020535 |
| 2 | `import-ac-outstanding-po` `sofa=no` | 159 POs / 429 lines / RM 582,827.90 | **70 POs, 156 items**; 89 skipped-existing; 1 exception | 34112625997 |
| 2b | `import-ac-outstanding-po` `sofa=yes` | 190 POs — **all 190 already in the ERP** | nothing to do; the sofa POs came in through steps 2 and 3 | 34119669091 |
| 3 | `import-ac-so-linked-pos` | 6 POs / 15 lines, 0 unresolved | **6 POs, 15 lines, 15 dedications** | 34112984269 |
| 4 | `stamp-ac-grn-refs` | 60 to stamp, 0 unimported | **60 POs stamped**; no GRN, no stock | 34113197377 |
| 5 | `create-migrated-documents kind=both` | GRN 1, DO 11 | **1 GRN + 11 DOs**, no inventory movement | 34113377388 |
| 6 | `create-migrated-invoices` | PI 4, SI 1 | **5 invoices**, VERIFY OK | 34113583399 |
| 7 | `sync-ac-delta lanes=recv,do,dedi do_scope=since` | recv 241 / do 89 / dedi 0 | **241 received_qty, 89 delivery documents, 0 inventory movements** | 34113822612 |
| 8 | `repair-migrated-do-prices mode=apply` | 65 lines / 56 documents | **65 lines, 56 documents** (63 real, 2 zero-qty — see 0665) | 34116824015 |
| 9 | `create-migrated-invoices` (again, after the 89 new DOs) | SI 2 | **2 invoices**, VERIFY OK | 34118636973 |
| 10 | `sync-ac-delta lanes=hdr` | 14,916 field values / 3,456 documents | see 8.4 | 34114714868 |

The invoice job was run TWICE on purpose. Step 7 created 89 delivery orders, and
a delivery order is an invoice SOURCE — `doToIv` could not see them on the first
pass. Its source count went 82 -> 171 and two more invoices AutoCount had
actually raised became writable.

### 8.2 The read-back, not the write count

A row count answers "did a row change". These are re-measurements:

| | before | after | run |
|---|---|---|---|
| `recv` lines still to raise | 241 on 111 POs | **0 on 0 POs** | 34114554129 |
| `received_qty` AGREES with AutoCount `TransferedQty` | 869 | **1,281** | ” |
| ERP received LESS than the book says | 241 lines | **0 lines** | ” |
| `do` documents still to create | 89 | **0** | ” |
| ERP mirrors delivery orders | 71 | **171** | ” |
| ERP mirrors GRNs | 319 | **320** | ” |
| zero-priced migrated DO lines that are REPAIRABLE | 65 | **0** | 34119785887 |

### 8.3 Two defects the applies exposed, both fixed the same day

- **#3068** — `sync-ac-delta` verified lanes it did not run, so `LANES=recv,do,dedi`
  exited 1 after writing 241/241 and 89/89 correctly. A red apply against
  production reads as "back it out", and backing that one out would have
  discarded correct data. `docs/bugs/0665-sync-ac-delta-verified-lanes-it-did-not-run-so-a-lanes-subse.md`.
- **#3069** — `repair-migrated-do-prices` selected work on the SALES ORDER's unit
  price but verified on the DELIVERY line total, so two `qty = 0` lines were
  written correctly as 0, failed the shape check, and were re-proposed for ever.
  `docs/bugs/0665-the-do-price-repair-re-proposed-two-zero-quantity-lines-for.md`.

### 8.4 Why the header plan is 14,916 and not 786

The header lane was planned at **786 field values across 382 documents** at
10:25. Re-planned at 11:00 it read **14,916 across 3,456**. The whole difference
is #3064, which merged in between and gave seven AutoCount header fields an ERP
column for the first time — `attention`, `delivery_address1..4`, `display_term`,
`ac_to_po_no`. Those columns are 100% blank in the ERP by construction, so the
lane now plans to FILL them:

```
display_term 3456 + delivery_address1 2878 + delivery_address3 2738
+ delivery_address4 2517 + delivery_address2 1802 + ac_to_po_no 495
+ attention 244                                        = 14,130
14,130 + the original 786                              = 14,916
```

Nothing is overwritten: `human` reads 0 on every field, and the new columns had
no value to lose. The 786 that were always in the plan are unchanged.

**It is slow.** 14,916 guarded single-row UPDATEs over Hyperdrive from a runner
ran for well over an hour. Measured mid-flight against the reconcile, the SO
"ERP blank where the book states a value" count fell 3,025 -> 2,554 in 22
minutes. The lane is convergent and every UPDATE is guarded on the value it
read, so an interrupted run is finished by re-running it — but a future change
here should batch the writes rather than issue one statement per value.

### 8.5 Still open after this run

- **270 purchase invoices refused** as `total_disagrees_with_autocount`. 95 are
  ours at RM 0.00 — a price the cutover dropped, writable once the AutoCount
  invoice price is stamped on the source lines. **175 have both sides priced and
  genuinely differ: those need a human.**
- **648 zero-priced migrated DO lines** whose SALES ORDER line is itself zero.
  COPY-NEVER-COMPUTE says leave them; they are the same dropped-price family.
- **PO unit price: 241 lines differ** in the reconcile, unchanged by this run.
- `HC-PO-009944` — **do not delete**; a dump-then-delete workflow is being written.
- `PO-009979` — one code-less line held back; it needs an accessory product first
  (`item_code` is NOT NULL). Owner 2026-09-02: 「要进 accessories」.
- 5 delivery documents REFUSED by lane `do`'s over-delivery guard, e.g.
  `HC-SO-011850` would deliver 26 units on top of 0 against 25 ordered.
- 121 delivery orders AutoCount never invoiced. Correctly given no invoice —
  owner: 「发票确定也是 autocount 开了我们才开」.

### 8.6 The verdict — `ac-erp-reconcile`, before and after

Baseline run `34111686290` (current `main`, before any apply). Final run
`34124410806` (after all ten). Both read-only, both against prod, company 1.

| type | scope | ERP before | ERP after | absent before | **absent after** | price before | price after | money before | money after |
|---|---|---|---|---|---|---|---|---|---|
| SO | 2,789 | 2,770 | 2,882 | 112 | **0** | 13 | 13 | 24 | 24 |
| PO | 484 | 499 | 575 | 77 | **1** | 241 | 241 | 9 | **2** |
| GR | 214 | 222 | 256 | 34 | **0** | – | – | – | – |
| DO | 84 | 71 | 171 | 13 | **2** | 52 | **0** | 55 | **2** |
| IV | 47 | 39 | 42 | 8 | **7** | 0 | 0 | 0 | 0 |
| PI | 192 | 180 | 202 | 40 | **21** | 0 | 0 | 0 | 0 |

**Disagreements not covered by a declared design difference: 797 -> 470.**

#### FIELD IDENTITY, on the copied fields of PROCEEDED documents

| | before | after | |
|---|---|---|---|
| **fields that DIFFER** | **1,262** | **673** | SO 993 -> 652, PO 269 -> 21, DO 0 -> 0 |
| **blank in the ERP where the book states a value** | **731** | **441** | SO 731 -> 441, PO 0 -> 0, DO 0 -> 0 |
| values in fields no importer carries at all (SO) | 2,240 | **1** | #3064 gave them columns; the header lane filled them |

The `blank in the ERP` figure is not a straight line between those two readings.
#3064 landed mid-run and reclassified ~14,130 values from *"no column exists"* to
*"the column exists and is blank"*, so the intermediate reading (run
`34120935099`) shows it at **3,025** — higher than the 731 it started at. The
header lane then took it to 441. Same for SO's "no importer carries it": 2,240
values had nowhere to go this morning; one does now.

#### The header lane was cancelled mid-write and finished by a re-run

Run `34114714868` wrote for 1h39m and was cancelled at 12:43:51 when a second
session's `sync-ac-delta` dispatch entered the same concurrency group. Because
every UPDATE is guarded on the value the plan read, the partial state is not a
problem: a re-plan measured **1,316 of the 14,916 left**, and run `34123578643`
wrote `1316 of 1316 intended; 0 skipped`, VERIFY clean.

**Two sessions were dispatching `sync-ac-delta` against prod at the same time.**
Nothing was corrupted — the lane's design is exactly what absorbed it — but an
hour and a half of writing was thrown away and had to be re-measured. Serialise
the go-live dispatches on one operator.

---

## 9. APPLIED — the second half, 12:44 to 13:30

§8 ends with the header lane finished. This section is everything after it, run
by a second session. Same rule: every row names its run.

### 9.0 A correction to §8's account of the cancel

§8 says run `34114714868` "was cancelled at 12:43:51 when a second session's
`sync-ac-delta` dispatch entered the same concurrency group". That is not what
happened, and the difference matters because the lesson is a different one.

It was cancelled by an explicit `gh run cancel` from that second session, which
had **read the wrong evidence**. A normal `sync-ac-delta` run finishes in 35-40
seconds; this one had been running 96 minutes; GitHub serves no log for an
in-progress job, so there was nothing to read; and the session's own arithmetic
— 786 writes at the ~0.4s round trip it had measured off a verify sample — said
six minutes, not ninety-six. So it called the run hung and cleared it to unblock
the concurrency group.

Every input to that conclusion was true. The conclusion was false, because the
run's `LANES` were not 786 writes but **14,916**, and 14,916 x 0.4s is 99
minutes. The one fact that settles it — what the run was actually dispatched
with — is not on the run object the API returns, but the identical 14,916 plan
had been printed by a sibling run an hour earlier and was one `gh run view` away.

**The rule this buys: before cancelling a long-running job, find out what it was
asked to do.** A duration is only anomalous relative to a workload.

Nothing was lost but time: every UPDATE is guarded on the value the plan read,
so the re-plan simply measured the 1,316 that remained.

### 9.1 What was applied

| # | job | plan | what it wrote | run |
|---|---|---|---|---|
| 11 | `sync-ac-delta lanes=desc,pay,links,recv,do,dedi,hdr` | desc 75 / pay 40 / links 10 / hdr 0 | **75 description2 lines, 40 payment rows, 10 dedications**; VERIFY 5/5/5 | 34123720786 |
| 12 | `backfill-sofa-variants`, `fuzzy` OFF | 16 to fill, 58 held on a fuzzy colour | **16 lines merged**, 0 skipped | 34124801377 |
| 13 | `dump-and-delete-po HC-PO-009944` | dump first, delete second | **dump 16,491 bytes, re-read OK; 3 lines + 1 header deleted**; VERIFY 0 remaining | 34124910249 / 34125030805 |
| 14 | `backfill-specials-into-variants skip_priced=1` | SO 89 / PO 38 | **127 lines**; read-back 127 carry every code, 0 do not; 358 held as priced | 34125641978 |
| 15 | `backfill-so-dates` | 62 headers | **62 headers + 306 item lines**; 2 headers and 17 lines REFUSED on the audit trail | 34125933888 |
| 16 | `refresh-so-variants` | 2,565 lines, erases 10 | see 9.3 | 34126455704 |

### 9.2 The invoices did not become writable, and not for the reason assumed

The go-live brief said the 7 sales and 21 purchase invoices were absent only
because their source DOs and GRs had not been imported, and would now be
creatable. They are not. Dry-run `34124085262`, after every import:

```
PURCHASE INVOICES   source documents: 320   WOULD CREATE: 0   refused: 320
   total_disagrees_with_autocount 270 | nothing_to_invoice 34
   no_autocount_invoice 10 | ambiguous_autocount_invoices 6
SALES INVOICES      source documents: 171   WOULD CREATE: 0
   already mirrored 42 | refused 126 (no_autocount_invoice 121,
   total_disagrees 4, nothing_to_invoice 1)
```

The sources ARE all there now — 320 and 171, against 82 this morning, so the
import half of the theory was right. The gate that refuses them is
`acValueSen === valueSen` in `src/scm/lib/migrated-chain.ts`, and of the 270,
**175 have both sides priced and genuinely differ**. Those need a human, not a
re-run. `allowTotalMismatch` exists in that module and is deliberately not
exposed on the workflow; forcing it would write invoices whose money is not the
book's money.

### 9.3 The bedframe sweep was measured before it was run

`refresh-so-variants.mjs` re-derives the owned variant axes from AutoCount's
Desc2 and writes `null` for every axis the parse does not yield;
`variants || patch` stores those nulls, so a value the ERP holds and the book
does not state is DELETED. Its last apply was 2026-08-10 — four weeks of staff
edits stood behind it — and its dry-run reported only what it would ADD.

PR #3074 made it report what it would take away. Measured against production
(run `34126290530`) before any write:

```
WOULD ERASE: 10 value(s) the ERP holds and the AutoCount Desc2 does not state
   fabricId 2 | colourId 2 | fabricCode 2 | colourLabel 2 | fabricLabel 2
      SO-007693 VALKYRIE (A)-(Q)   colourId "SF-AT 04"
      SO-008447 FENRIR-(Q)         colourId "KS-08"
```

Ten values on two lines, both of them the colour block — not the 1,171 TBC/KIV
lines that were feared. Against a gain of 51 colours newly resolved and ~31
blank axes filled on proceeded orders, the sweep was run, and the two losses
were written to
`Desktop/Houzs-Project/ac-golive-dumps/refresh-so-variants-2026-09-07-erased.json`
first so they can be put back by hand. `SO-007693`'s label reads
`04 [MERGED into SF-AT-04 on 2026-08-13 - superseded, not deleted]` — a pointer
at a library row that no longer exists.

`refresh-po-variants.mjs` imports the same `buildBedframeVariantPatch` and has
the same behaviour. It was NOT instrumented and NOT run.

### 9.4 Still open

- **175 purchase invoices** where our total and AutoCount's are both priced and
  differ. A human decision, per document.
- **PO unit price: 241 lines** — **53% of the whole remaining 456** — and it is
  AutoCount holding **RM 0.00** where the ERP holds the real price. Copying the
  book here would zero 241 real prices. This is the mirror of COPY-NEVER-COMPUTE
  and it must not be "closed".
- **`HC-SO-010886`** — AutoCount qty 5 against ERP qty 2, RM 4,250.00 against
  RM 3,800.00: a LINE QUANTITY change made after the copy. No lane writes qty;
  it is one of 22 such lines.
- **58 sofa colours** that resolve only through the fuzzy matcher, and **2 codes
  absent from the fabric library** (`nicca - 02 Oat glow`, `CHINO-01`). Owner
  decision, by the tool's own rule that a match is not a copy.
- **358 lines** the specials backfill held back because they would gain a PRICED
  add-on. Owner decision — stamping one reprices a historical document.
- **`PO-009979`**, and the 2 owner-declined delivery orders: unchanged from §8.5.

### 9.5 `backfill-so-dates` reports its header plan and hides its line plan

The dry-run prints `headers to update: 62` and stops. The per-line section that
went on to write **306** `line_delivery_date` values sits inside the `if (APPLY)`
block, so no dry-run can show it. The write itself is safe — `IS NULL` is
repeated inside the SQL and a human-touched document is refused — but "the
dry-run prints EXACTLY the list apply consumes" is the standard
`backfill-sofa-variants-from-desc2.mjs` sets in its own header, and this script
does not meet it. Not fixed tonight.
