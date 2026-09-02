## Every printed document title-cased the raw stored status instead of the word the screen shows [medium]

<!-- area: Delivery, DO, returns -->

**Symptom.** In business terms: the paper and the screen called the same
delivery order two different things, and after the 2026-08-26 relabel they
swapped words in a way that could send a storekeeper to the wrong row.

The owner was looking at a real printed delivery order. The sheet said
**LOADED**. Every screen calls that state **Confirmed**. And the state the
screens now call **Loaded** — stored `DISPATCHED`, the pallet on the lorry —
printed as **DISPATCHED**. So the word *Loaded* named one rung on paper and a
different rung on the list, on the same document, at the same time.

It was not only the delivery order. Measured across all nine printed documents
that state a status, nine of the 66 status values in the vocabulary printed a
different word from the one their own screen shows:

| document | stored | printed on paper | shown on screen |
| --- | --- | --- | --- |
| Delivery Order | `LOADED` | LOADED | **Confirmed** |
| Delivery Order | `DISPATCHED` | DISPATCHED | **Loaded** |
| Goods Received Note | `POSTED` | Posted | **Confirmed** |
| Purchase Invoice | `POSTED` | Posted | **Confirmed** |
| Purchase Return | `POSTED` | Posted | **Confirmed** |
| Sales Invoice | `SENT` | Sent | **Confirmed** |
| Sales Order | `IN_PRODUCTION` | In Production | **Proceed** |
| Sales Order | `READY_TO_SHIP` | Ready To Ship | **Ready to Ship** |
| Stock Take | `POSTED` | Posted | **Confirmed** |
| Stock Transfer | `POSTED` | Posted | **Confirmed** |

The Delivery Return was the only one of the nine that happened to agree
throughout — its labels are all identical to their title-cased keys, which is
luck, not a design.

A tenth printed document, the SO / PO **amendment**, got it wrong a different
way: a REJECTED amendment printed **Requested**, the one word that says nobody
has decided yet, on the sheet filed as the decision record.

**Root cause (traced).** Every generator carried its own copy of the same
hand-rolled title-caser and ran it over the RAW STORED VALUE:

```
header.status.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())
```

Nine copies, one per file, in `frontend/src/vendor/scm/lib/`:
`delivery-order-pdf.ts`, `delivery-return-pdf.ts`, `grn-pdf.ts`,
`purchase-invoice-pdf.ts`, `purchase-return-pdf.ts`, `sales-invoice-pdf.ts`,
`sales-order-pdf.ts`, plus a file-local `titleCase()` in `stock-take-pdf.ts` and
`stock-transfer-pdf.ts`.

A caser is not a translator. It can turn `READY_TO_SHIP` into words, and it
cannot know that `LOADED` reads Confirmed, because that is a decision, not a
transformation. The owner MADE that decision on 2026-08-21 (「那就 A」 — change
the word, never the stored value) and it was applied to the screens;
`status-pill.ts` has held the answer ever since. Nothing on the printed side
ever read it. The 2026-08-26 `DISPATCHED` → "Loaded" relabel then reused a word
the paper was already using for a different rung, which is what turned a
cosmetic mismatch into a wrong-row hazard.

The amendment PDF failed through the neighbouring mechanism: `AmendmentPdfInput`
took an OPTIONAL `statusLabel?: string`, and all four callers (SO + PO amendment
detail, desktop + mobile) hand-wrote the same `applied ? "Approved" :
"Requested"` — a two-way collapse of a six-value vocabulary, with no arm for
REJECTED. That is CLAUDE.md's **optional-param-noop** shape
(`docs/bugs/0098-bug-class-optional-param-noop-an-optional-argument-that-deci.md`)
carrying a decision.

This is the same root as
`docs/bugs/0519-the-sales-order-list-printed-a-raw-enum-key-where-a-status-l.md`,
whose own entry names the durable fix — *"the durable fix is those pages reading
their LABEL from `status-pill.ts`"*. 0519 did the Sales Order LIST. This is the
PRINTED half, and it is why §1's OPEN note in
`docs/modules/document-status-vocabulary.md` said a seventeenth surface could
invent a sixth word and nothing would say so.

**Fix.** All nine generators now call `statusLabel(docType, header.status)` with
their own document type. The two file-local `titleCase()` helpers are deleted
outright — the status was their only caller. The amendment mapper computes the
word itself from `simplifiedAmendmentPill`, the canonical implementation of the
Requested / Approved / Rejected collapse the owner chose for the amendment lists
on 2026-07-24, and `statusLabel?:` is GONE from both input shapes so no caller
can hand a document its own word again; the compiler enumerated the four call
sites.

**Nothing about the layout moved** (owner: 「不可以动我的排版，只是把 QR Code 加进
来呀」). The only thing that changed is which string is computed. Measured with
jsPDF's own `getTextWidth` at the size and font each document draws it: the
widest status now printed anywhere is `Ready to Ship` at **20.4mm** in a
right-hand rail **56mm** wide, and on 6 of the 9 documents the widest value got
*narrower*. The delivery order's status chip is sized to its text and its right
edge lands at **162.7mm** against a content edge of 196mm — 33mm of clearance,
and 0.6mm narrower than before, because `CONFIRMED` is shorter than
`DISPATCHED`.

**An unknown status still prints, and prints readably.** `statusLabel` falls
through to `humaniseStatusKey`, so a value with no row in the map prints as
`Awaiting Pick`, not as a blank, a dash or a refusal. That is the deliberate
choice for PAPER: a printed document leaves the building, and a dash reads as
"this document has no status", which is a lie, while a refusal to print blocks
a delivery. A humanised slug is honest — it cannot be mistaken for one of the
real words. In practice these columns are Postgres enums, so an unmapped value
can only arrive from a legacy or mirrored row
(`docs/bugs/0530-the-delivery-orders-page-failed-to-load-the-on-hold-count-as.md`:
comparing an enum to a label it does not define is a `22P02`, not an empty
match).

**Pinned by `frontend/src/vendor/scm/lib/pdf-status-label.test.ts`**, which
renders each of the nine documents for **every** member of its vocabulary —
enumerated from `statusVocabulary(docType)`, never typed out — and asserts on
what `doc.text` actually PAINTED, not on which helper was imported. A generator
that hand-rolls a caser again fails it even if it never touches `status-pill`. A
source scan over `*-pdf.ts` covers the tenth generator nobody has written yet,
and its matcher self-tests against the exact lines this change removed.

**Proved RED on the unfixed tree: 13 of 60 failed**, naming each of the ten
mismatched values above. Every guard was then proved by deleting it and
re-running:

| guard deleted | what went red |
| --- | --- |
| one generator (GRN) back to the caser | 3 failed — the POSTED case, the confirm-step sweep, the source scan |
| the delivery order back to the caser | 5 failed, including the named LOADED / DISPATCHED trap |
| the amendment status back to `applied ? … : …` | 2 failed — REJECTED printed Requested again |
| the `['Status', …]` row removed from a document | `printedStatus` THREW "saw 0" rather than passing on an empty read |
| the source-scan regexes made unmatchable | the matcher self-test failed — it refuses rather than reporting a clean run |
| `statusVocabulary` returning `[]` | the harness test failed — a loop over nothing must not read as a pass |

**Not fixed here, and it is the owner's call, not a defect:** `status-pill.ts`
says `IN_PRODUCTION` reads **Proceed** while `so-list-status.ts` says
**In Production** — and that file's own comment claims "the LABELS match
status-pill.ts exactly". They do not, and have not since the June vendoring.
Routing the Sales Order sheet through the one home therefore changes that one
printed word from *In Production* to *Proceed*. One word, one status, one
document; both spellings are live on screens today. It is written up in the PR
for the owner to settle, because picking the word is the decision he already
reserved to himself on 2026-08-21.

**Ref.** fix/the-printed-document-says-what-the-screen-says, 2026-08-26.
