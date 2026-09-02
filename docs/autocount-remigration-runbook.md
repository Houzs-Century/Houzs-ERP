# AutoCount re-migration — what runs, in what order, and what a person must supply

**Written 2026-09-02.** Every claim below is labelled PROVEN / LIKELY / UNKNOWN
per CLAUDE.md. Nothing in this document was executed against production: no
import was run, no workflow was dispatched, no production row was touched. The
run ids quoted are runs that ALREADY happened and are read out of the ledger or
out of `gh run view`.

## 0. Read this before you read anything else

**There is already an executable procedure, and it is not this file.**
`docs/ac-resync-runbook.md` is the step-by-step dispatch order (Phase 0 to Phase
5), written 2026-08-31 as the distillation of the round recorded in
`docs/ac-reimport-2026-08-28-ledger.md`. **Follow that file when you actually
run the round.**

This file is the layer underneath it, and it exists because the runbook
deliberately does not carry it: for each importer, **what it reads, whether it
writes production, what its gate is, and what a SECOND run does.** An operator
needs the runbook. Somebody deciding whether a step is safe, or why a step is
where it is, needs this.

If the two ever disagree, `docs/ac-resync-runbook.md` is the procedure and this
file is wrong — say so in a PR rather than reconciling them in your head.

### 给老板的一句话

要把 AutoCount 最新的单据（销售单、采购单、收货、送货、发票、库存、货号、照片）
再抄一次进 ERP，**不需要你从 AutoCount 画面导出任何 Excel**。需要的只有三样：
① 账本安静下来（当下没人在改单）；② 一个能连上账本的密码档（你自己放，不经过
对话）；③ 云端图片仓库的一把钥匙（照片那一步才要）。其余全部是我们这边跑脚本。
**这一轮不删任何东西**——只补新的、刷被改过的，你 2026-08-29 定的规矩。

## 1. The import surface, enumerated

Six workflows carry the `import-ac-*` name. This is the complete set in the tree
at the head of this branch:

```enumeration
$ git ls-files '.github/workflows/import-ac-*.yml'
.github/workflows/import-ac-outstanding-po.yml
.github/workflows/import-ac-outstanding-so.yml
.github/workflows/import-ac-so-linked-pos.yml
.github/workflows/import-ac-sofa-stock.yml
.github/workflows/import-ac-stock-balance.yml
.github/workflows/import-ac-stock-layers.yml
```

Three further workflows are part of the same pipeline and only miss the `-ac-`
infix; they are listed here so nobody reads the six above as the whole import
surface:

```enumeration
$ git ls-files '.github/workflows/import-*.yml'
.github/workflows/import-ac-outstanding-po.yml
.github/workflows/import-ac-outstanding-so.yml
.github/workflows/import-ac-so-linked-pos.yml
.github/workflows/import-ac-sofa-stock.yml
.github/workflows/import-ac-stock-balance.yml
.github/workflows/import-ac-stock-layers.yml
.github/workflows/import-po-line-photos.yml
.github/workflows/import-po-so-links.yml
.github/workflows/import-so-line-photos.yml
```

### 1.1 The nine importers, one row each

Every one of them: `workflow_dispatch` only, never scheduled; two jobs
(`run-staging` / `run-prod`) selected by a `target` input; `DATABASE_URL` (prod)
or `STAGING_DATABASE_URL` (staging) is the only credential. PROVEN by reading
the nine workflow files.

| workflow | script | what it imports | input it reads | writes prod | gate | second run |
|---|---|---|---|---|---|---|
| `import-ac-outstanding-so.yml` | `backend/scripts/import-ac-outstanding-so.mjs` | Sales orders, whole documents, into `scm.mfg_sales_orders` / `_items` / `_payments`, company 1 | `data/ac-outstanding-so.json.gz`, `ac-so-remarks.json.gz`, `autocount-erp-mapping-1561.csv`, `agent-staff-binding.csv` | yes, on `apply=1` | `APPLY` defaults to dry-run; `limit=N` and `doc=<DocNo>` for a small verification pass; `sofa=yes` is a second pass | safe. Header is `INSERT ... ON CONFLICT (doc_no) DO NOTHING RETURNING`; items and payments are written only for a newly inserted header |
| `import-ac-outstanding-po.yml` | `backend/scripts/import-ac-outstanding-po.mjs` | Purchase orders with at least one line not fully received (lane 1) | `data/ac-outstanding-po.json.gz` + the mapping CSV, plus `ac-outstanding-so.json.gz` to resolve the SO line it is dedicated to | yes, on `apply=1` | `APPLY` defaults to dry-run; `sofa=yes` decomposes a sofa line per compartment | safe. Skips `po_number`s already present |
| `import-ac-so-linked-pos.yml` | `backend/scripts/import-ac-so-linked-pos.mjs` | Purchase orders raised FROM an imported sales order, INCLUDING fully received ones (lane 2). Paperwork plus `received_qty` plus the `so_item_id` dedication, and deliberately no stock movement | `data/ac-so-linked-pos.json.gz`, `ac-outstanding-so.json.gz`, mapping CSV | yes, on `apply=1` | `APPLY` defaults to dry-run | safe. Document-level idempotency guard skips a PO already present |
| `import-ac-stock-balance.yml` | `backend/scripts/import-ac-stock-balance.mjs` | Reconciling ADJUSTMENT movements so company-1 on-hand equals the book's `vItemBalQty` snapshot, non-sofa | `data/ac-stock-balance.json.gz`, `ac-utd-stock-cost.json.gz`, `ac-item-costs.json.gz`, mapping CSV | yes, on `apply=1` | `APPLY` defaults to dry-run; **`neg=1` is a second, separate opt-in** and is the only switch in the whole pipeline that REMOVES stock | inert by construction: it writes delta = book minus ERP, so once they agree the delta is zero. Its own header says so |
| `import-ac-stock-layers.yml` | `backend/scripts/import-ac-stock-layers.mjs` | Replaces flat zero-cost cutover lots with the real FIFO receipt layers (per-layer qty, cost, receipt date) | `data/ac-stock-layers.json.gz` + mapping CSV | yes, on `apply=1` | `APPLY` defaults to dry-run | inert. A cell is relayered only while its flat zero-cost lot is unconsumed |
| `import-ac-sofa-stock.yml` | `backend/scripts/import-ac-sofa-stock.mjs` | The sofa units the balance import skips: one received sofa PO line becomes one compartment lot, batched on that PO's number, capped by the book balance | `data/ac-stock-balance.json.gz`, `ac-stock-layers.json.gz`, `ac-sofa-gr-po.json.gz`, mapping CSV | yes, on `apply=1` | `APPLY` defaults to dry-run; `placeholder=1` (off by default) additionally opens stock for builds the sofa decoder could not read | tops up rather than doubles: a (product, warehouse, batch, variant) that already carries an `AC_CUTOVER` sofa lot is skipped |
| `import-po-so-links.yml` | `backend/scripts/import-po-so-links.mjs` | Rebuilds `purchase_order_items.so_item_id` from the book's own SO-to-PO conversion records | `data/ac-outstanding-po.json.gz` + `ac-outstanding-so.json.gz` | yes, on `apply=1` | `APPLY` defaults to dry-run | safe, and now normally a no-op: it fills NULLs only and never overwrites a link made in the ERP. Both PO importers carry the dedication at insert since 2026-08-28 |
| `import-so-line-photos.yml` | `backend/scripts/import-so-line-photos.mjs` | Appends R2 photo keys to sales-order line `photo_urls` | `data/ac-photo-manifest.json.gz` + mapping CSV | yes, on `apply=1` | default mode is RESOLVE, which prints the upload plan and writes nothing | idempotent: a key already in `photo_urls` is skipped |
| `import-po-line-photos.yml` | `backend/scripts/import-po-line-photos.mjs` | Same, for purchase-order lines. One sofa build's photo lands on every compartment line of that build | `data/ac-po-photo-manifest.json.gz` + mapping CSV | yes, on `apply=1` | default mode is RESOLVE | idempotent |

**Every input in that table is a COMMITTED SNAPSHOT FILE under
`backend/scripts/data/`, not a live read of AutoCount.** No importer opens the
account book. That is the single most important structural fact about this
pipeline and it is what section 3 is about.

### 1.2 Where the `RE-RUN:` line is, and where it is missing

`npm --prefix backend run audit:release-discipline` requires four things of a
`backend/scripts` script that opens a database and writes: a plan-by-default
`MODE`/`APPLY` gate, a `CONFIRM` phrase on the apply path, a verification that
re-reads on a fresh connection and asserts the SHAPE, and a `RE-RUN:` header
line. The importers do NOT all carry all four — they are grandfathered, rule by
rule, in `backend/scripts/release-discipline-grandfathered.json`.

PROVEN by reading that file: every one of the nine importers above is waived
`confirm-phrase` and `fresh-verify`; six of them are additionally waived
`rerun-note` (`import-ac-outstanding-po`, `import-ac-so-linked-pos`,
`import-ac-sofa-stock`, `import-po-so-links`, `import-so-line-photos`,
`import-po-line-photos`), and those six state their re-run behaviour as an
`Idempotent:` sentence in the header instead. `import-ac-stock-balance.mjs` and
`import-ac-stock-layers.mjs` do carry a real `RE-RUN:` line;
`import-ac-outstanding-so.mjs` carries the `Idempotent:` sentence.

**What that costs you, plainly: nothing stands between a mis-typed `apply=1` and
a production write except the operator reading the dry run.** There is no confirm
phrase to fumble and no built-in independent re-read. The round's discipline —
dry, read the notices, apply, then re-read with a SEPARATE read-only check — is
not a nicety here, it is the missing gate. The grandfathered list may only
shrink, so fixing any of these is welcome; it is out of scope for this document.

## 2. The correct order, and why

### 2.1 The dependency chain in one paragraph

Item codes must exist before a document can reference them; documents must exist
before a link between documents can be written; stock must be counted before it
can be dedicated to a line; and allocation, which decides whether a line shows
READY, must run last because it reads all of the above. Photos hang off line
identity (`linked_ac_dtlkey`), so they can only be attached after the lines
exist. Verification is last of all and is worthless before the recompute has
been consumed by the Worker.

### 2.2 The order as the runbook has it

The authoritative list is `docs/ac-resync-runbook.md`. Reproduced here as a
dependency argument, not as a substitute for it:

| phase | step | why it must be here |
|---|---|---|
| 0 | Fresh export on the machine with the ZeroTier link; regenerate `gen:ac-sofa-corpus` and `gen:ac-item-map`; `test:light`; land it all in one PR | every later step reads these files. A snapshot that is not on `main` cannot be read by a workflow |
| 0b | Mapping CSV rows and an `ac-newskus-<date>.json` seed for genuinely new book codes, then `align-seed-skus.yml`, then `mirror-hookka-bindings.yml` | an unmapped code makes the PO importers `exit 2` and write NOTHING (2026-08-31, `docs/bugs/0577-a-purchase-order-carried-an-internal-sofa-code-no-product-ro.md`) |
| 1.1 | `import-ac-outstanding-so.yml`, twice: default (non-sofa) then `sofa=yes` | every PO lane, every mirror and every link resolves an SO line. Nothing can precede it |
| 1.2 | `import-ac-outstanding-po.yml` (lane 1) | lane 1 is "not fully received"; lane 2 overlaps it and skips what exists |
| 1.3 | `import-ac-so-linked-pos.yml` (lane 2) | bound-mode readiness reads the line's OWN purchase order; without the already-received POs every processed line stays PENDING |
| 1.4 | `topup-ac-po-lines.yml` | fills received quantities the two lanes could not resolve. Needs both lanes present |
| 1.5 | `stamp-ac-grn-refs.yml` | stamps the book's GRN and PI document numbers onto the POs. Reference numbers only — no receipt, no stock |
| 1.6 | `create-migrated-documents.yml` (`kind=both`) | GRN and DO mirrors. Must follow the POs and SOs they hang off, and writes NO movements: the balance snapshot already counts every past receipt and delivery |
| 1.7 | `create-migrated-invoices.yml` | invoices mirror GRNs and DOs, so they follow 1.6. Opens one only where the amount matches the book to the cent |
| 2.1 | `import-ac-stock-balance.yml` with `neg=1` | on-hand is reconciled against the book AFTER the paperwork, so the mirrors have something to hang on and the delta is computed once |
| 2.2 | `import-ac-sofa-stock.yml` | sofa lots are driven off the already-imported SO-linked POs |
| 2.3 | `stamp-real-po-costs.yml`, if the price list is over two days old | costing follows quantity |
| 3.1 | `refresh-so-tail-from-book.yml` | rewrites values staff changed in the book during the window. Must follow the import that created the rows |
| 3.2 | `backfill-ac-line-keys.yml` + `backfill-ac-sofa-line-keys.yml` | should now report `to-set` near zero: the SO importer stamps line keys at insert since 2026-08-28. Anything above zero is the exception list |
| 3b | Photos: export, RESOLVE, upload to R2, `apply=1`, verify | needs the lines to exist (3.2) and the R2 objects to exist before attach |
| 4.1 | `enqueue-so-allocation-recompute.yml`, then wait for the Worker | allocation reads documents plus stock plus dedication. It is last by definition |
| 4.2 | `import-ac-stock-balance.yml` dry with `neg=1` — the zero proof | positive 0 and negative 0 is the only statement that the two systems agree |
| 4.3 | `check-so-dates-truth.yml` | eight fields, value by value, against the round's own snapshot. All DIFFER must be 0 |
| 4.4 | `check-ac-vs-erp-reconcile.yml` | "fully received must be lit" equals 0 |
| 4.5 | `check-remark2-vs-status.yml` | ALGO-SUSPECT must be 0; the other buckets are explained differences |
| 4.6 | `check-ac-erp-doc-links.yml` | the two document-relationship graphs, both directions. `backlog = 0` |
| 5 | Go-live seal: lock the book, re-run 0 to 4, turn on write-back, smoke-test | only after 4 is green |

**Two workflows sit in the 2026-08-28 order but NOT in the resync order, and
that is worth a decision rather than a habit.** `import-ac-stock-layers.yml` and
`import-po-so-links.yml` are both absent from `docs/ac-resync-runbook.md`.
LIKELY correct in both cases — the layers pass only touches an unconsumed flat
zero-cost lot, and the PO-to-SO links are now written at insert (the round's own
convergence proof was a dry run with 0 rows to write, run 33189216543). But an
incremental round can create NEW zero-cost cells: the 2026-08-29 pass added 21
cells. **UNKNOWN whether any of them needed a layer.** The check costs nothing
and writes nothing: dispatch `import-ac-stock-layers.yml` with no `apply` and
read the count. Do that once per round.

### 2.3 What the previous round actually landed

Source: `docs/ac-reimport-2026-08-28-ledger.md` sections 1 to 4o, plus the bug
ledger. Summarised, not re-derived.

- **Wipe (2026-08-28).** `golive-wipe-hc.yml`, plan run 33143344805, apply run
  33143464728. 93 rows over 68 tables, document counters KEPT.
- **Codes.** Book item master 1,589; all 1,561 mapping rows still present; 16
  genuinely new codes opened, plus the Hookka binding mirror.
- **Sales orders.** 2,756 documents / 13,858 lines imported whole-document
  (non-sofa run 33154299948, then the sofa pass).
- **Dates.** 551 headers plus 2,528 line delivery dates (run 33170449326), after
  `docs/bugs/0556-imported-processing-dates-landed-in-the-retired-column-so-th.md`
  moved the write off the retired column.
- **Purchase orders.** Lane 1 187 documents / 559 lines (run 33157041761); lane
  2 293 new documents / 511 lines, after
  `docs/bugs/0557-the-so-linked-po-import-crashed-whole-on-one-missing-supplie.md`
  stopped a missing supplier killing the whole run.
- **Stock.** Balance 981 cells / +9,699 units (run 33173101230), independent
  re-read 0 cells / +0 units (run 33174030232); sofa 116 lots (run 33173822826);
  layers 674 cells rebuilt into 1,107 real cost layers (run 33176943948).
- **Keys and links.** Sofa line keys 782/782 (run 33175468166); ordinary line
  keys about 13,400 rows, finished at run 33181625007 with an independent plan
  re-read of 0 remaining (run 33182609755).
- **Header text.** The five columns the first export never pulled — Remark2 to
  Remark4, the note, and the header delivery-date field — were added and
  backfilled 937/937 (run 33178979475),
  `docs/bugs/0559-re-import-dropped-the-so-header-stock-status-and-notes-field.md`.
- **Mirrors.** GRN 316 documents (run 33178796412); DO 70 documents / 314 lines
  / 453 units (run 33180660876), with the stock-unchanged proof run immediately
  afterwards (run 33181084910): 0 cells and +0 units of difference.
- **Invoices.** 66 opened across three passes (runs 33182730435, 33190902211,
  33191440271) under the exact-amount rule.
- **Allocation.** Enqueued at run 33183013211 and consumed by the Worker; READY
  went 915 to 1,514.
- **The 2026-08-29 quiet-book resync**, run update-style with nothing deleted,
  then the 2026-08-30 cross-verify round, which ended with eight-field DIFFER 0,
  bound-must-light 0, ALGO-SUSPECT 0, and the stock zero proof at positive 0 and
  negative 0 (run 33256248116).

## 3. What a person must supply

This is the whole of the human input. Everything else is a workflow dispatch.

### 3.1 The account book must be quiet

The owner declares it. The 2026-08-28 round measured the cost of not waiting:
between a 12:16 snapshot and a 21:40 re-measure, **40 sales orders had their
delivery date changed by staff on the same day**. A snapshot taken over a busy
book is not wrong, it is stale on arrival, and every verification in phase 4
compares the ERP against that snapshot.

### 3.2 There is no Excel to export, and no AutoCount screen to use

**PROVEN by reading `backend/scripts/export-ac-reimport.py`.** The export is a
read-only ODBC connection straight into the live SQL Server that holds the
account book, and it reads these objects: `SO` + `SODTL`, `IVDTL`, `PO` +
`PODTL`, `Creditor`, `DO` + `DODTL`, `vItemBalQty`, `UTDStockCost`, `ItemUOM` +
`Item`, `GR` + `GRDTL`, `PI` + `PIDTL`, and `sys.columns` (to discover the
DO-to-SO line column rather than assume it — that assumption is
`docs/bugs/0553-the-po-refetch-reference-sql-named-a-column-the-book-does-no.md`).

So the operator does not open AutoCount at all. What the operator supplies is:

1. **The ZeroTier link, up.** Host `10.147.17.100,55500`, database `AED_HOUZS`,
   user `sa2` — these are the exporter's defaults, overridable with `AC_HOST`,
   `AC_DB`, `AC_USER`.
2. **A password file.** `AC_CRED_FILE` must point at a file whose entire content
   is the database password. The owner or the operator creates that file
   directly; per CLAUDE.md it never passes through chat and is never echoed.
3. **A machine that can reach the book.** In practice that is this desktop; the
   exporters cannot run in GitHub Actions, because the book is not reachable
   from there.

### 3.3 The commands, and the files each one replaces

Run from the repository root. Each rewrites its snapshot files WHOLE — the
snapshot rule is never to edit a snapshot, only to swap it and record the swap.

```bash
AC_CRED_FILE=<path to the password file> python backend/scripts/export-ac-reimport.py
AC_CRED_FILE=<path to the password file> python backend/scripts/export-ac-invoice-refs.py
AC_CRED_FILE=<path to the password file> python backend/scripts/export-ac-invoice-prices.py
```

`export-ac-reimport.py` runs twelve sections in this order — `so`, `iv`,
`dates`, `po1`, `po2`, `dos`, `bal`, `costs`, `grrefs`, `links`, `ruler`,
`remarks` — and writes:

| file under `backend/scripts/data/` | what it holds |
|---|---|
| `ac-outstanding-so.json.gz` | every sales order with at least one line not fully delivered, ALL of its lines |
| `ac-so-iv-excluded.json.gz` | the orders excluded because they were invoiced without a delivery order |
| `ac-so-dates.json.gz` | the processing date and the line delivery date, per line |
| `ac-outstanding-po.json.gz` | lane 1 purchase orders, whole documents |
| `ac-so-linked-pos.json.gz` | lane 2 purchase orders, whole documents, including fully received |
| `ac-partial-dos.json.gz` | ALL delivery orders of the imported sales orders |
| `ac-stock-balance.json.gz` | the `vItemBalQty` cell balances |
| `ac-utd-stock-cost.json.gz`, `ac-item-costs.json.gz` | the two opening-cost sources, in waterfall order |
| `ac-gr-refs.json.gz` | goods-receipt and purchase-invoice reference index, scoped to this round's POs |
| `ac-po-fromsodtlkey.json.gz` | the PO line to SO line link |
| `ac-outstanding-now.json.gz` | the ruler: which documents are outstanding right now, numbers only |
| `ac-so-remarks.json.gz` | Remark2, Remark3, Remark4, the note, and the header delivery-date field |
| `ac-reimport-manifest.json` | row counts plus `exported_at`, which is the ONLY freshness authority |

If the link drops mid-run, `START_AT=<section>` resumes from that section
onwards and keeps what is already written. To re-pull exactly one section and
touch nothing else, use `ONLY=<section>` — `START_AT` re-runs the whole tail and
has already clobbered two mid-round snapshots once.

### 3.4 New item codes

If the book has grown codes that `backend/scripts/data/autocount-erp-mapping-1561.csv`
does not know, the operator adds a mapping row per code, plus an
`ac-newskus-<date>.json` seed file in the same directory for codes that need an
ERP product opened (`ac-newskus-2026-08-28.json` and `ac-newskus-2026-08-30.json`
are the worked examples). Two traps, both paid for:

- A book item code is capped at 30 characters and some real codes sit exactly on
  that cap with an unclosed bracket. Copy the code as the book has it; do not
  "repair" the bracket
  (`docs/bugs/0567-seventeen-mapping-rows-carried-30-char-truncated-codes-four.md`).
- A mapping row that points at an ERP code with no product row now makes both PO
  importers `exit 2` and write nothing at all. That is the guard working. Fix the
  mapping or open the product, then re-run
  (`docs/bugs/0577-a-purchase-order-carried-an-internal-sofa-code-no-product-ro.md`).

### 3.5 Photographs, which need one more thing from the owner

`backend/scripts/export-ac-line-photos.py` pulls the embedded pictures out of the
book, and `backend/scripts/upload-line-photos-r2.mjs` puts them in R2. The upload
needs an R2 API token with Object Read and Write on the bucket, saved to a file
the script reads and never prints. **The owner creates that token in the
Cloudflare dashboard**; the exact path and account are in
`docs/ac-resync-runbook.md` Phase 3b, step 2.

### 3.6 Landing the snapshot

The snapshots reach the workflows only by being on `main`. One PR carrying:
the replaced `backend/scripts/data/*.gz`, `ac-reimport-manifest.json`, the two
regenerated artifacts (`npm --prefix backend run gen:ac-sofa-corpus` and
`npm --prefix backend run gen:ac-item-map`), and any data-pinned test re-pinned
per its own contract. `npm --prefix backend run test:light` locally first: the
first PR of the last round burned three CI round trips on exactly this.

## 4. What is actually outstanding

The list this task was given — "GRN/DO and invoice mirrors, photos, allocation,
and a verification pass against a fresh export" — **is stale, and the tree
contradicts four of its five items.** Reporting the contradiction rather than
bridging it, per CLAUDE.md.

| item as given | what the tree says | label |
|---|---|---|
| GRN / DO mirrors outstanding | LANDED 2026-08-28 to 08-30. GRN 316 then 319/319; DO 70 documents / 314 lines, later 71 of 73 with 2 refused on purpose by the duplicate guard | PROVEN from the ledger |
| Invoice mirrors outstanding | PARTLY LANDED. 66 invoices opened under the exact-amount rule. The residue (about 319 refused as of 2026-08-30) is an OWNER DECISION, not an unrun step: one book invoice covering several receipts, receipts whose PO is out of scope, two amount mismatches, six non-unique matches | PROVEN that they ran; the residue is an open owner choice |
| Allocation outstanding | LANDED. Enqueued and consumed; READY 915 to 1,514, later settling at 1,463 then 1,461 after the bound-mode fix | PROVEN from the ledger |
| Verification against a fresh export outstanding | RAN, and was green on 2026-08-29 and again 2026-08-30. It has since gone STALE — see below | PROVEN |
| Photos outstanding | **Correct, and it is the one genuinely unrun item** | PROVEN |

### 4.1 The one that is genuinely unrun: photographs

- The round-1 photo key set is fully attached. The resolve pass reports 602 of
  602 on the sales side and 238 of 238 on the purchase side
  (`tasks/HANDOFF-2026-09-01.md`). Nothing attachable is unattached.
- The FULL book extraction has never been run. Measured on the live book
  2026-08-31: **2,723 sales-order lines and 2,392 purchase-order lines carry a
  picture**, all of them `wmetafile8`. Only a 20-line sample has ever been
  extracted; the purchase side has never been run at all; **nothing has ever been
  uploaded to R2** — the token file does not exist yet.
- The photo manifest currently in the tree is the 2026-08-10 content, so pictures
  added to the book since then are not in it.

### 4.2 The new outstanding item the list did not have

**The committed snapshot is already too old for the final check to run.**
PROVEN, 2026-09-01: `check-ac-erp-doc-links.yml` run 33517630321 printed

    snapshots exported_at=2026-08-30 02:32:01.297447 (2.5 days old)
    REFUSED: snapshots are 2.5 days old (>2).

and exited 2. The manifest in the tree still reads `2026-08-30 02:32:01.297447`.
So the document-relationship verification — the owner's own "do not just look at
one sales order" check — cannot answer at all until Phase 0 is re-run. That is
the strongest single argument for doing this round now.

Read that run beside the one two minutes before it: run 33517461629 concluded
**success** on the same workflow, and its step was
`node scripts/diag-mrp-false-shortage.mjs`. That is
`docs/bugs/0597-a-workflow-named-for-the-document-link-check-was-running-an.md`
— a workflow left pointing at a borrowed script, reporting green for a check
that never ran. The wiring is fixed on `main` now (both steps read
`scripts/check-ac-erp-doc-links.mjs`), but the lesson is operational: **read the
step name in the run log, not the badge.**

### 4.3 Owner decisions carried forward, none of them blocking

None of these stops the round; each will be re-reported by the round's own
checks if left alone.

1. The invoice residue above.
2. About 95 sofa lines whose Desc2 never said the seat composition — a person
   must read the drawing. The parser recovered what it mechanically could.
3. `PO-009979`, one book line with no item code, currently dropped whole.
4. `BASTION (SS)`: the ERP holds 2 units in a location the book has no row for.
5. Five new sofa component codes still need mapping rows.

## 5. Risks, plainly

### 5.1 Destructive, and NOT part of this round

**`golive-wipe-hc.yml` deletes Houzs Century's transactions and stock.** It is
not a step in a re-migration. The owner's standing instruction from 2026-08-29 is
update-style throughout and delete nothing. Running it today would remove roughly
2,750 imported sales orders and every mirror built on them. Its plan mode is
read-only and its apply mode demands an exact confirm phrase, so it cannot happen
by accident — but it can happen by copying the 2026-08-28 order without reading
why the wipe was in it.

Its `doc_counters=reset` option is separately dangerous: the account book
permanently holds every number the ERP has ever pushed to it, so restarting at
001 re-issues numbers AutoCount already has and the book refuses them with a
primary-key error. `docs/doc-number-reissue-coe.md` is that incident.

### 5.2 Irreversible

- **Stock movements.** Every quantity written by the balance and sofa importers
  is a movement row, and movements are corrected by writing an offsetting
  movement, never by deletion. Getting the sign wrong is a real repair job.
- **Money.** An invoice, once opened, is a posted document.
- **Anything already in the account book.** Write-back is a separate switch and
  is off (`scm.autocount_writeback`), but the moment it is on, an ERP edit
  reaches the live book.

### 5.3 The one switch that must never be run casually twice

`import-ac-stock-balance.yml` with **`neg=1`**. Positive-only reconciliation has
been safe for months; the first use of `neg=1`, on 2026-08-29, immediately found
a real defect — the importer computed one delta per BOOK row, while 35 ERP cells
are fed by several book codes, so the second row deducted the cell again and
`SQUARE PILLOW` at Balakong went to minus 161
(`docs/bugs/0566-balance-importer-computed-one-delta-per-autocount-row-two-co.md`).
It is fixed and it aggregates per ERP cell now. The rule that came out of it:
**a `neg=1` apply is always followed immediately by the zero proof**, and a zero
proof that does not read positive 0 / negative 0 stops the round.

### 5.4 Traps that make a wrong run look right

- **The default target is staging.** Several of these workflows default to
  `staging`, and one whole sales-order apply landed there on 2026-08-30 before
  anyone noticed. Always pass `-f target=prod`, and confirm
  `Complete job name: run-prod` in the log.
- **A file's modification time is not its content date.** Three stale-snapshot
  bugs landed in one evening
  (`docs/bugs/0560-pure-losses-repair-trusted-a-17-day-old-snapshot-and-propose.md`,
  `docs/bugs/0561-migrated-invoice-planner-ran-on-a-17-day-old-invoice-map-tha.md`,
  `docs/bugs/0563-third-stale-snapshot-in-one-evening-the-pi-price-stamp-read.md`).
  Only the `exported_at` inside the manifest counts.
- **A green badge can belong to a different script.** Section 4.2.
- **`exit 2` with `REFUSED ... not in the catalog` is the guard working**, not a
  flake. Do not retry it; fix the mapping.
- **A diagnostic can be right and premature.** Between the PO import and the GRN
  mirror, the receipt-drift diagnostic necessarily reports red and suggests
  replaying an old recompute. Running that suggestion zeroes the received
  quantities copied from the book. It goes green on its own once the mirrors
  exist.
- **Photo write-back overwrites the whole field.** A book line can carry more
  than one picture (measured: up to 2 on the sales side, 5 on the purchase side).
  The write-back path rewrites `FurtherDescription` whole, so it must read the
  current value first or it erases the second picture.
  `docs/autocount-further-description-photos.md` section 7 has it.

### 5.5 Go / no-go checkpoints

| gate | pass condition | if it fails |
|---|---|---|
| G0, before exporting | the owner has declared the book quiet | wait. A snapshot over a live book is stale on arrival |
| G1, after exporting | exporter exits 0; the manifest's counts match the live census; `exported_at` is today | re-run the failing section with `ONLY=<section>` |
| G2, before any apply | the snapshot PR is merged to `main`, both generated artifacts regenerated, `test:light` green | the workflows read `main`; an unmerged snapshot is invisible to them |
| G3, per import step | the dry run was read and its exception list is understood | never apply a step whose dry run you did not read |
| G4, after stock | zero proof reads positive 0 and negative 0 | stop. Do not proceed to allocation over a disagreeing ledger |
| G5, final | eight-field DIFFER 0; reconcile 0; ALGO-SUSPECT 0; doc-links backlog 0 | each non-zero item is the next round's list, named row by row, not summarised |
| G6, go-live only | the write-back smoke matrix passes on a real document | do not turn AutoCount read-only until it does |

## 6. What this document does not answer

- **UNKNOWN: how much the book has moved since 2026-08-30 02:32.** Nobody has
  measured it, and the only way to measure it is Phase 0.
- **UNKNOWN: whether the incremental stock cells added since need a layers pass.**
  Section 2.2 says how to find out for free.
- **UNKNOWN: how long the full photograph extraction takes.** Only 20 lines have
  ever been run, against 5,115 lines that carry a picture, and downloading is the
  slow half.
- **UNTESTED, and deliberately so: every operational claim in this file about
  what a run WILL do.** No import, no dispatch, no production write was performed
  in producing it. Where a number is quoted it belongs to a run that already
  happened and the run id is beside it.

## See also

- `docs/ac-resync-runbook.md` — the procedure. Start there to run a round.
- `docs/ac-reimport-2026-08-28-ledger.md` — the full trace of the last round.
- `docs/autocount-cutover-ledger.md` — the first round, 2026-08.
- `docs/autocount-migration-record.md` — the field-level migration record.
- `docs/autocount-further-description-photos.md` — the photo format and the
  write-back hazard.
- `docs/modules/autocount-writeback.md` — the outbound direction, which this
  document does not cover.
