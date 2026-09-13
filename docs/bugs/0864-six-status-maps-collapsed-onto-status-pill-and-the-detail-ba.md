## Six status maps collapsed onto status-pill, and the detail badges a second family both guards were blind to [medium]

**Symptom.** Nothing new on screen — this entry is the ROOT FIX behind two
defects that already shipped and were patched on 2026-09-13: a Purchase Orders
filter tab reading SUBMITTED beside a pill reading Confirmed, and a Sales Invoice
reading "Sent" while its pill said "Submitted" (`0851`). Both came from the same
place: list and detail pages hand-writing their own copy of the status words
instead of reading `frontend/src/vendor/scm/lib/status-pill.ts`.
`docs/modules/document-status-vocabulary.md` §1 called that root fix OPEN.

**Root cause (traced).** Eighteen SCM pages each declared a `{ tone, label }` map.
A copy can only drift, and two of them had. `localStatusMapsAgree.test.ts` pinned
the disagreement but could not remove the copies.

**What was collapsed, and how the six were CHOSEN — by measurement, not reading.**
A scan evaluated `statusLabel(docType, KEY)` for every entry in every page's map
and compared it BYTE FOR BYTE against the word the page hand-wrote. Six pages came
back identical on every entry; those six were converted and nothing else was.

| page | docType | entries |
|---|---|---|
| `GoodsReceivedListV2.tsx` | grn | 5 |
| `GoodsReceivedDetailV2.tsx` | grn | 4 — the labels were DEAD, see below |
| `PurchaseReturnsListV2.tsx` | pr | 4 |
| `PurchaseReturnDetailV2.tsx` | pr | 4 |
| `StockTakesListV2.tsx` | stockTake | 3 |
| `StockTransfersListV2.tsx` | stockTransfer | 2 |

Each keeps what is genuinely its own — the tone (a four-name palette, not
status-pill's six), the filter bucket, the blurb — and takes only the LABEL from
`statusLabel`. An unlisted status still answers with its RAW value, as before.

Two details worth knowing before editing these:

- **`GoodsReceivedDetailV2`'s `label` was rendered NOWHERE.** All three readers of
  `EFFECTIVE_TONE` take `.tone` or `.blurb`. It was deleted, not repointed.
- **Purchase-return `DRAFT` is not in the canonical `pr` map**, so it resolves
  through statusLabel's humanise fallback, which answers "Draft" — the same word.
  It was NOT added to the canonical map: that map's tones are live elsewhere, and
  an entry invented to tidy a call site is the forged-evidence failure CLAUDE.md
  names.

**The twelve left alone, and why — every one would change a word on screen.**

| cause | pages |
|---|---|
| CASE only — the page lower-cases the second word | `PurchaseOrdersListV2` (Partially received), `PurchaseInvoicesListV2` (Partially paid), `DeliveryReturnsListV2` (Credit noted), `do-list-status` (In transit) |
| the map's KEY is not the stored status (`partial`, `cancel`, `issued`, `completed`, `open`, `shipped`), so a naive lookup answers "Partial" / "Cancel" | `PurchaseOrderDetailV2`, `PurchaseInvoiceDetailV2`, `SalesInvoicesListV2`, `SalesInvoiceDetailV2`, `SalesOrderDetailV2`, `DeliveryOrderDetailV2` |
| DELIBERATE, with its authority in the guard's own list | `so-list-status` IN_PRODUCTION (owner's to decide), `do-list-status` SIGNED (owner 2026-08-21), `DeliveryReturnDetailV2` (next-step vocabulary) |

**FOUND, NOT FIXED — the detail-page BADGE is a second family nobody watches.**
Traced in source on `origin/main` 678a8a8cd; NOT observed on a running screen.
Seven detail pages carry a separate document-status `STAGE_LABEL: Record<string,
string>` (Delivery Order, Delivery Return, GRN, Purchase Invoice, Purchase Order,
Purchase Return, Sales Invoice — `grep -rln "const STAGE_LABEL" frontend/src/pages/scm-v2`
also lists `FairReport.tsx`, whose `STAGE_LABELS` names report stages and is not a
status), and it is what renders inside the header `<Badge>{stageLabel}</Badge>`.
Four of the seven contradict the owner's 2026-09-12 ruling 「PI、SI、GR、PO、SO 都要改成 submitted」
or the canonical map:

| page | stored | badge says | canonical says |
|---|---|---|---|
| `GoodsReceivedDetailV2.tsx` | POSTED | **Posted** | Submitted |
| `PurchaseInvoiceDetailV2.tsx` | POSTED | **Posted** | Submitted |
| `SalesInvoiceDetailV2.tsx` | SENT | **Sent** | Submitted |
| `PurchaseReturnDetailV2.tsx` | POSTED | **Posted** | Confirmed |

Why BOTH guards missed it, which is the useful part: `confirmRungReadsSubmitted`'s
source scan fails only on a stored value beside a `"Confirmed"` label, and these say
"Posted" and "Sent"; `localStatusMapsAgree` parses only the `{ … label: "X" }`
object shape, and `STAGE_LABEL` is a flat `KEY: "X"` record. A guard that matches
one spelling of a copy is blind to the next spelling. Not fixed HERE because this
change was bounded to altering no word on screen; it is a separate, owner-visible
change and should carry its own entry.

**Fix, and how it is pinned.** `localStatusMapsAgree.test.ts`: the six are off
`PAGES` (so the list still says how much is left), and two assertions replace the
watch a page loses when it leaves that list — `COLLAPSED_WORDS` pins the exact word
each of the six showed before, against what `status-pill.ts` answers now, and a
relapse check fails if any of the six grows a hand-written label again. The 22
deleted `label:` lines were extracted from `git diff` and all 22 are in that table.
Both new assertions were proved RED — one by re-wording `grn` POSTED in the table,
one by re-adding a `label:` to `StockTransfersListV2` — then restored byte-identical.

**Ref.** chore/collapse-status-maps, 2026-09-13.
