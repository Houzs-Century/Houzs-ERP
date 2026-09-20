# Assessment — can "Add Line Item" be unified across the system?

Owner asked (2026-09-18): 「add item 的全套系统能不能统一…在一个地方操作」 — can the
add-line experience be ONE consistent way to operate everywhere? This is an
**assessment only**. Nothing here is built. The owner decides the scope.

Business summary (白话文): 现在全系统有大约 30 个单据都有「加一行 / Add Line
Item」的功能，但它们不是同一套做出来的 —— 有三种不同的写法，按钮名字也有四种
（"Add Line Item"、"Add item"、"Add line"、"Add another line"）。要「统一」有大有小
三个做法，见下方「三个选项」。**动到会写库存/写钱的单据风险最高**，要一个一个来，
不能一次全改。

---

## 1. Every form with a line-item editor (enumeration)

Paths are under `frontend/src/`. "Editor" = where a person actually adds/edits
lines (some read-only pages just link into their editor — marked *handoff*).

| Document | File | Layout | Shared editor? | Add-line label |
|---|---|---|---|---|
| Sales Order — new | `pages/scm-v2/SalesOrderNew.tsx` | cards | **shared** `SoLineCard` | Add Line Item |
| Sales Order — detail (edit) | `pages/scm-v2/SalesOrderDetail.tsx` | cards | **shared** `SoLineCard` + `so-add-lines.ts` | Add Line Item |
| Sales Order — detail V2 | `pages/scm-v2/SalesOrderDetailV2.tsx` | *handoff* | `add-line-handoff` | Add line |
| Sales Order — mobile | `mobile/MobileNewSO.tsx` | cards | hand-rolled (mirrors `SoLineCard`) | Add line |
| Purchase Order — new | `pages/scm-v2/PurchaseOrderNew.tsx` | cards | hand-rolled (reuses only `missingRequiredVariants`) | Add Line Item |
| Purchase Order — detail | `pages/scm-v2/PurchaseOrderDetail.tsx` | cards | **shared** `PoLineCard` | Add item |
| Purchase Order — detail V2 | `pages/scm-v2/PurchaseOrderDetailV2.tsx` | *handoff* | `add-line-handoff` | Add line |
| Stock Transfer — new | `pages/scm-v2/StockTransferNew.tsx` | **table** | hand-rolled (shared `styles.table`) | Add Line Item |
| Stock Adjustment — new | `pages/scm-v2/StockAdjustmentNew.tsx` | **table** | hand-rolled (shared `styles.table`) | Add Line Item |
| Stock Transfer — mobile | `mobile/MobileStockTransferNew.tsx` | rows (div) | hand-rolled | + Add item |
| Delivery Order — new | `pages/scm-v2/DeliveryOrderNewV2.tsx` | cards | **shared** `SoLineCard` | Add line |
| Delivery Return — new | `pages/scm-v2/DeliveryReturnNew.tsx` | cards | **shared** `SoLineCard` (lines seeded from DO; no free add) | — |
| GRN — new / from PO | `pages/scm-v2/GrnNew.tsx`, `GrnFromPo.tsx` | cards | hand-rolled | + Add another item |
| GRN — detail (edit) | `pages/scm-v2/GoodsReceivedDetail.tsx` | table + rows | hand-rolled + `useAddLineHandoff` | Add item |
| Sales Invoice — new | `pages/scm-v2/SalesInvoiceNew.tsx` | cards | **shared** `SoLineCard` | Add Line Item |
| Sales Invoice — detail V2 | `pages/scm-v2/SalesInvoiceDetailV2.tsx` | in-page panel | **shared hook** `useSalesInvoiceAddLine` | Add line |
| Purchase Invoice — new | `pages/scm-v2/PurchaseInvoiceNew.tsx` | cards | hand-rolled | + Add another item |
| Purchase Invoice — detail | `pages/scm-v2/PurchaseInvoiceDetail.tsx` | cards | **shared** `PoLineCard` | Add item |
| AP Invoice | `pages/scm-v2/ApInvoiceForm.tsx` | **table** | hand-rolled (Insert-key add) | Line |
| Consignment Note / Order / Return — new | `pages/scm-v2/Consignment{Note,Order,Return}New.tsx` | cards | **shared** `SoLineCard` | Add Line Item |
| Purchase-Consignment Order/Receive/Return, Purchase Return — new | `pages/scm-v2/PurchaseConsignment*New.tsx`, `PurchaseReturnNew.tsx` | cards | hand-rolled | Add item / Add line |
| Purchase-Consignment Order — detail | `pages/scm-v2/PurchaseConsignmentOrderDetail.tsx` | cards | **shared** `PcLineCard` | Add item |
| Payment Voucher — new / detail | `pages/scm-v2/PaymentVoucher{New,Detail}.tsx` | **table** | hand-rolled (Insert-key add) | + Add another line |
| Credit Notes | `pages/scm-v2/CreditNotes.tsx` | **table** | hand-rolled | Add line |
| Journal Entry | `pages/scm-v2/JournalEntryCards.tsx` | line blocks + read table | hand-rolled (index-keyed) | Add line |
| Debtor Bill | `pages/scm-v2/DebtorBillForm.tsx` | **table** | hand-rolled (twin of `ApInvoiceForm`) | Line |

Shared building blocks that already exist (there is **no** single generic
line-items editor):
- **Per-line CARD components:** `vendor/scm/components/SoLineCard.tsx`,
  `PoLineCard.tsx`, `PcLineCard.tsx` (+ their `empty*Line`/`*LineDraft`).
- **Shared table CSS:** `pages/scm-v2/SalesOrderDetail.module.css`
  (`.table`, `.tableRight`, `.addLineRow`, `.actionsCell`, `.emptyRow`).
- **Add-line handoff contract:** `vendor/scm/lib/add-line-handoff.ts`
  (`ADD_LINE_LABEL = 'Add line'`) + `useAddLineHandoff.ts`.
- **Sales-invoice add-line hook:** `pages/scm-v2/SalesInvoiceAddLine.tsx`.
- **SO staged-add settler:** `pages/scm-v2/so-add-lines.ts` (`runSoLineWrites`).
- **Field widgets:** `DateField`, `SpecialOrders`, `SearchCombo`/`SearchableSelect`,
  mobile `MobileSkuPicker`, `MobileAddLine`.

## 2. How consistent is it today?

Partly. There are **three de-facto patterns**, not one:

1. **Card editors on a shared card** — SO new/detail, DO, Sales Invoice new,
   PO/PI/PC *detail*, all three sell-side Consignment new forms. This is the
   most consolidated group (`SoLineCard`/`PoLineCard`/`PcLineCard`).
2. **Card editors that copy the card shape but do NOT import the card** — the
   biggest duplication: `PurchaseOrderNew`, `GrnNew`, `PurchaseInvoiceNew`, the
   four `PurchaseConsignment*New`, `PurchaseReturnNew`, `MobileNewSO`. They all
   repeat the identical `DraftLine[]` + per-row `rid` + `newLine`/`addLine`/
   `dropLine`/`setLine` shape by hand.
3. **`<table>` editors** — `StockTransferNew` + `StockAdjustmentNew` share the
   `styles.table`/`.addLineRow` look; the finance forms (`PaymentVoucherNew`,
   `CreditNotes`, `ApInvoiceForm`, `DebtorBillForm`, `JournalEntryCards`) each
   roll their own `<table>` with slightly different keyboard behaviour
   (Insert-key add on some, not others).

The button label is drifting: `ADD_LINE_LABEL = 'Add line'` exists and the V2
handoff pages use it, but legacy forms still say "Add Line Item", "Add item",
"Add another line", "Line". State shape is *almost* uniform (`_key`/`rid` per
row, `add`/`remove`/`set`) but `JournalEntryCards` is index-keyed and the tables
manage columns ad hoc.

So: values and per-doc logic are correct everywhere, but the row scaffolding,
keyboard behaviour and labels are re-implemented per form.

## 3. Three options to unify

### Option A — Standardize the shell only (low cost, low risk) — RECOMMENDED first step
Don't build a mega-component. Instead make every form agree on the *frame*:
one add-line label (`ADD_LINE_LABEL`), one delete-row control, one keyboard
rule (Insert = add line, Enter = next field), and one shared `<LineTableShell>`
/ `<LineCardsShell>` that owns only the add/remove/`_key` plumbing and the
table/card chrome — each form keeps its own columns and its own save logic.
- **Cost:** ~1 small shared helper + a per-form adoption PR (mechanical).
- **Blast radius:** chrome + labels only; no change to what is saved.
- **What breaks:** tests that assert an old label string; a few snapshot/DOM
  queries. No write-path change.
- **Recommendation:** do this. It delivers the owner's "one consistent way to
  operate" (same buttons, same keys, same feel) without touching money/stock
  write code. Roll out one form per PR, read-only/non-critical forms first.

### Option B — One shared `LineItemsEditor` component the forms adopt incrementally (medium cost, medium risk)
Build a generic `<LineItemsEditor rows columns onAdd onRemove renderRow>` (table
mode + card mode) and migrate forms onto it family by family, starting with the
already-consolidated card group (they share `SoLineCard` today). Each form still
supplies its columns and its save mapping.
- **Cost:** design + build the component, then a migration PR per family
  (SO/DO/SI, PO/PI/PC, stock tables, finance tables) — several weeks spread out.
- **Blast radius:** every adopted form re-renders through new code; column and
  validation wiring is re-plumbed.
- **What breaks:** highest chance of subtle regressions in per-line validation
  (variant gates, bucket picks, over-qty caps, discount/price math) precisely on
  the money/stock forms. Needs the full test suite per family + browser checks.
- **Recommendation:** worth it only after Option A proves the shared shell, and
  only for the card-editor family first (lowest risk, most duplication removed).
  Defer the finance/stock tables.

### Option C — Leave editors doc-specific, standardize behaviour by lint/convention (lowest cost, no runtime risk)
Keep each form's editor, but write down the conventions (label, keyboard, state
shape, delete control) and add a light check (like the existing `warehouse-label`
corpus test) that fails a PR introducing a new divergent pattern. No existing
form is rewritten.
- **Cost:** a short convention doc + one guard test.
- **Blast radius:** none at runtime.
- **What breaks:** nothing; only new code is constrained.
- **Recommendation:** a good *complement* to A (stops future drift), but on its
  own it does not make today's forms feel the same, which is what the owner
  asked for.

## Money / stock-critical forms (touch these last, one at a time, with tests + browser)

- **Write stock:** Stock Adjustment, Stock Transfer (+ mobile), GRN (new/from-PO/
  detail), Delivery Order, Delivery Return, and the whole Consignment family.
- **Write money:** Sales Invoice, Purchase Invoice, AP Invoice, Payment Voucher,
  Credit Notes, Journal Entry, Debtor Bill.
- **Both (qty + price):** Sales Order, Purchase Order, Consignment orders/notes.

R37 applies to every one of these: a shared-editor migration must preserve each
form's write contract exactly, so they are the last to move and never in bulk.

## Suggested path
1. Adopt Option A (shared shell + one label + one keyboard rule), read-only and
   non-critical forms first. 2. Add Option C's guard test to lock it. 3. Only
   then consider Option B for the card-editor family. Owner picks the appetite.
