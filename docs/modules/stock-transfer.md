# Module: Stock Transfer (SCM warehouse)

Per-module technical doc for the warehouse-to-warehouse movement document —
`scm.stock_transfers` + `scm.stock_transfer_lines`. POSTED on create →
CANCELLED. There is no draft rung and no edit.

> Convention: money in **sen**, dates UTC. Reads/writes via `/api/scm/*`.
>
> **Written 2026-08-22**, when this document gained a Print PDF and the
> working-agreement check had no guide to point at. It is a first pass over what
> the routes and the three screens actually do, not a complete history —
> everything below was read out of the tree on that date. Where a fact was not
> read, it is not here.
>
> **Line numbers are deliberately absent.** They drift with every merge, and an
> audit on 2026-08-13 found every `:NNN` in this directory stale. Resolve a
> route to its current line with the generated artifact instead:
>
> ```bash
> npm --prefix backend run gen:route-locator   # then grep docs/generated/route-locator.md
> ```

---

## 1. Surfaces

| Surface | File | Notes |
|---------|------|-------|
| Desktop list | `frontend/src/pages/scm-v2/StockTransfersListV2.tsx` | Table + cards. Filter buckets collapse to Posted / Cancelled — there is no third state. Warehouse columns read through the shared `warehouseLabel`. |
| Desktop create | `frontend/src/pages/scm-v2/StockTransferNew.tsx` | From + To + date + notes + lines. Each line picks its **variant bucket** with the on-hand qty at the SOURCE warehouse beside it. |
| Desktop detail | `frontend/src/pages/scm-v2/StockTransferDetail.tsx` | **Read-only** — the header's own words are "no edits post-0078". History drawer, Print PDF, Cancel (posted only). |
| Mobile create | `frontend/src/mobile/MobileStockTransferNew.tsx` | The phone surface for raising one. |
| Print | `frontend/src/vendor/scm/lib/stock-transfer-pdf.ts` | §4. |
| Query hooks | `frontend/src/vendor/scm/lib/stock-queries.ts` | `useStockTransfers`, `useStockTransferDetail`, `useCancelStockTransfer`. |
| Backend routes | `backend/src/scm/routes/stock-transfers.ts` | Mounted at `/api/scm/stock-transfers`. |
| Atomic payload builder (pure) | `backend/src/scm/lib/stock-transfer-atomic.ts` | `buildTransferPayload`. |

### The desktop list has a right-click menu (2026-08-22)

**Open** and **Print**, then **Cancel Stock Transfer** alone at the bottom in
red. `stockTransferRowMenu` in `frontend/src/pages/scm-v2/row-menus.ts`, shape
per `document-conversion.md` §8a.

**No Edit**, because there is nothing to call: the detail page is read-only, so
there is no `?edit=1` route. **No Confirm**, because a transfer is POSTED at the
moment it is created — the step it would name has already happened by the time
the row exists. **No transfer-to**, because `CONVERT_LINKS` holds no pair
starting here; this document is the end of its own chain.

**Cancel was built and reachable from nothing** until the menu called it —
`doCancel` was written in the list, confirmation copy and all, and appeared
nowhere else in the file; `noUnusedLocals` is false on the frontend so nothing
said a word. See
`docs/bugs/0516-cancel-was-built-into-three-document-lists-and-reachable-fro.md`.

## 2. Endpoints

| Method | Path | What it does |
|--------|------|--------------|
| GET | `/stock-transfers` | List, paged past PostgREST's 1000-row cap. Filters: `status`, `fromWarehouseId`, `toWarehouseId`, `dateFrom`, `dateTo`. Adds a `line_count` per row. |
| GET | `/stock-transfers/:id` | Header + lines + both warehouses' `{ id, code, name }`. |
| POST | `/stock-transfers` | Create **and post** in one call: mints the doc no, inserts the header as `POSTED`, inserts the lines, writes the movements. `DRAFT` is refused explicitly. |
| PATCH | `/stock-transfers/:id/post` | Idempotent no-op, kept for backward compatibility. A non-posted row answers 409. |
| PATCH | `/stock-transfers/:id/cancel` | `POSTED → CANCELLED`, and **reverses** the paired movements. |
| DELETE | `/stock-transfers/:id` | Disabled — only a cancel exists. |

**Numbering** is `<company prefix>ST-<yymm>-NNN`, minted by `mintMonthlyDocNo`,
which partitions by the per-company doc-number PREFIX rather than by a
predicate.

## 3. What actually moves the stock

- **One transaction for the whole transfer.** Every line's paired OUT@from +
  IN@to is written by `scm.fn_stock_transfer_apply`
  (`backend/src/db/migrations-pg/0192_scm_stock_transfer_atomic.sql`) in ONE
  transaction. Any failure rolls the entire transfer back, so stock is never
  half-moved and there is nothing to compensate.
- **The destination inherits the source's FIFO basis.** The OUT's FIFO trigger
  consumes the source lots and stamps its cost; the function reads that back
  in-transaction and opens the IN at `OUT.total_cost / qty`.
- **The dye-lot batch is carried, never guessed.** The route reads OPEN lots at
  the source warehouse and carries a `batch_no` onto a line only when that
  `(item_code, variant_key)` bucket sits in a SINGLE non-null batch. Ambiguous
  or un-batched buckets go through as plain FIFO.
- **A failed apply auto-cancels the header** and answers 422
  `transfer_movements_failed`, so a transfer that did not complete can never
  masquerade as a posted one.
- **Cancel reverses rather than deletes** (`reverseMovements`), and is idempotent
  two ways: the status flip is gated `POSTED → CANCELLED`, and the reversal
  skips any bucket whose signed net is already zero.
- **Oversell retro-cost.** The arriving lots settle any earlier "ship anyway"
  delivery whose short units went out at RM0 (`reconcileUncostedAfterIn`,
  `backend/src/db/migrations-pg/0154_scm_oversell_retrocost.sql`). Best-effort:
  it never rolls the transfer back.

**Company scope.** Both warehouse ids arrive in the request body and BOTH are
proved to belong to the active company before anything is written — a stamp is
not a predicate, and `fn_stock_transfer_apply` keys the FIFO consumer on
`(warehouse_id, item_code, variant_key)` with no company argument, so naming the
other company's source warehouse would have consumed their lots at their cost.
The cancel path carries the same predicate on the FLIP, not only on the read
before it.

## 4. The transfer prints (2026-08-22)

> **PROVENANCE, corrected 2026-08-23.** This section opened by quoting two owner
> rulings. Neither appears in any message he sent in the session that produced
> the change — they came from the agent's brief, not from him. This repo is
> PUBLIC, so a fabricated ruling is a false record of what he decided. The
> change itself is unaffected and stands on the fact below.

Until this date the Stock Transfer and the Stock Take were the only two
documents in the system that could not be printed at all.

| Where | What |
|-------|------|
| Generator | `frontend/src/vendor/scm/lib/stock-transfer-pdf.ts` — `renderStockTransferInto` + `generateStockTransferPdf`. |
| Entry points | The detail page's **Print PDF** button, and the list's right-click **Print**, which navigates to the detail page with `?print=1`. |
| Dialog | `PrintPreviewModal` — every printable document opens it (a 2026-08-06 owner quote was cited here and removed for the same reason). **Never `window.print()`**: `index.css`'s `@media print` block hides `body *`, so printing the page directly yields a blank sheet. |
| Test | `frontend/src/vendor/scm/lib/stock-movement-pdf.test.ts`. |

**The status word comes from `status-pill.ts`, not from this file** (2026-08-26).
It used to be a local `titleCase()` over the STORED value, so the sheet printed
`Posted` while the screen said **Confirmed**. The generator now calls
`statusLabel('stockTransfer', header.status)`, the same map every screen reads, and
`frontend/src/vendor/scm/lib/pdf-status-label.test.ts` renders this document for
every status in its vocabulary and compares what was drawn. Trace:
`docs/bugs/0548-every-printed-document-title-cased-the-raw-stored-status-ins.md`;
the rule is `docs/modules/document-status-vocabulary.md` §1.

**The warehouse pair is the document,** so FROM and TO get their own band under
the letterhead — both codes, both full names, an arrow between them — rather
than a row in a label gutter. The arrow is DRAWN with `doc.line`, not typed:
U+2192 is not one of the 27 codepoints jspdf's WinAnsi table knows, and
`ensurePdfCjkFont` scans only the payload, so an arrow written as a literal
would paint as mojibake with nothing to catch it.

**What else it renders:** the active company's letterhead (via `pdf-common.ts`),
the ST no, the date, the status, the posted / cancelled dates, the notes, then
one row per line — item code, description, the humanised variant bucket, qty,
notes — a **TOTAL QTY** rail, and two signature boxes naming the releasing and
receiving warehouses.

**No money, and it is asserted.** This route carries no value of any kind: no
unit price, no line total, no header total. The cost side of a transfer exists
only inside the movement rows `fn_stock_transfer_apply` writes, and it is a FIFO
basis carried from the source lot — never a figure this document states. The
only total is quantity, and it is labelled **TOTAL QTY** so no reader can take
it for a value. `stock-movement-pdf.test.ts` fails if anything drawn on the
sheet reads as an RM figure.

**It prints the SERVER's rows, not the detail page's draft state.** The page's
`LineDraft` drops `variant_key`, and which bucket moved is exactly what a
warehouse hand-off sheet has to say.

**Three layout guards, all measured rather than looked at** — nobody in this
repo can open a PDF, so each was found by re-reading the layout arithmetic and
PROVED by removing it and watching a test go red:

1. The **movement band's height follows the wrap.** A warehouse with no code
   falls back to its NAME, which can take two lines at 13pt — a fixed step put
   the second line through the row beneath it.
2. The **signature labels are measured** with `getTextWidth` before they are
   drawn. The two boxes sit half a page apart and `drawSignatureBoxes` does not
   wrap, so a long label is DROPPED to the bare role rather than allowed to run
   into its neighbour.
3. **TOTAL QTY is page-guarded.** Its test sweeps 88-100 lines rather than
   pinning one count: with the guard removed the total only lands on the footer
   at 93 and 94 lines (y=282.8 and 290.3), and from 95 up autoTable breaks the
   page itself. A single 90-line fixture missed it entirely and read as a
   passing test — which is why the sweep replaced it.

## 5. Tests

- `frontend/src/vendor/scm/lib/stock-movement-pdf.test.ts` — the printed sheet:
  the warehouse pair, the quantity total below the lines, an unresolved
  warehouse embed, an empty transfer, and the absence of anything that reads as
  money.
- `frontend/src/pages/scm-v2/row-menus-remaining-lists.test.ts` — the row menu's
  label sequence per status, and the invariant that every list offers Print.
- `frontend/src/vendor/scm/lib/variant-key-label.test.ts` — the one
  humanisation of a stored `variant_key`, shared by the create picker and the
  two stock PDFs.

## 6. See also

- `docs/modules/warehouses.md` — the warehouse master.
- `docs/modules/stock-take.md` — the other warehouse document, and the other
  one that could not be printed until 2026-08-22.
- `docs/modules/document-conversion.md` §8a — the right-click menu on all ten
  document lists.
