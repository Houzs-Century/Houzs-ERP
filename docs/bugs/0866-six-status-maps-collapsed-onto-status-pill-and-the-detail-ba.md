## Six status maps collapsed onto status-pill, and the detail badges a second family both guards were blind to [medium]
<!-- status: open -->
<!-- area: Frontend + mobile -->

`open` because of the BADGE finding below, which is unfixed. The collapse itself
changes nothing on screen and needs no production step.

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
`status-pill.ts`. An unlisted status still answers with its RAW value, as before.

**How the four LIST pages get it, and why it is not the obvious way.** They call
`withStatusLabels(docType, STATUS_OWN)` (new, in `status-pill.ts`) once at module
load, so their `statusFor` stays BYTE-IDENTICAL to what it was on `c6ce93745` —
checked by diffing each function against that commit. The obvious way, attaching
the label inside `statusFor`, was written first and the lint ratchet refused it:
+1 `no-unnecessary-condition` in all four files. Two attempts to keep it failed,
measured with `npm run lint` each time — a `| undefined` annotation (a `const`
narrows to its initialiser) and `?? null` (TypeScript types `T ?? null` as `T`
when `T` cannot be null). The rule exempts a nullish check made straight on an
index-signature access, which is the one shape the original line already had.
The two DETAIL pages read the word through a plain function call and were never
flagged.

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
| the map's KEY is not the stored status (`partial`, `cancel`, `issued`, `completed`, `open`, `shipped`), so a naive lookup answers "Partial" / "Cancel" | `PurchaseOrderDetailV2`, `PurchaseInvoiceDetailV2`, `SalesInvoicesListV2`, `SalesInvoiceDetailV2`, `SalesOrderDetailV2`, `so-list-status`, `DeliveryOrderDetailV2` |
| DELIBERATE, with its authority in the guard's own list | `do-list-status` SIGNED (owner 2026-08-21), `DeliveryReturnDetailV2` (next-step vocabulary) |

**Re-measured after merging `main`, not carried over.** While this change was in
progress `main` settled Sales Order `IN_PRODUCTION` as "In Production" in
`status-pill.ts` and removed it from the guard's DELIBERATE list (the sibling entry
`0864-the-sales-order-tab-said-in-production-and-the-pill-said-pro.md`, landed
concurrently). That was the one line of `status-pill.ts` it touched,
in the SO map, so no map these six read moved. The scan was re-run on the merged
tree regardless: the six pages' ORIGINAL 22 words against the merged canonical map
give 0 deltas, and `so-list-status` still differs — now only by its `cancel` key —
so it stays uncollapsed, under the key row above rather than DELIBERATE.

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
