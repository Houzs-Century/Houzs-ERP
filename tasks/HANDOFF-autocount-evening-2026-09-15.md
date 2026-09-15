# Handoff: AutoCount sync, evening of 2026-09-15

Follows `tasks/HANDOFF-autocount-completeness-2026-09-15.md` (state at 07:21Z).
This file records the state at about 12:50Z. Re-run the counts before quoting
them.

## Shipped since the morning

| ledger | what | PR | state |
| --- | --- | --- | --- |
| 0924 | an edit refused for timing goes out by itself | #3926 | merged |
| 0926 | Ref carries the customer reference; PO Doc No. is no longer overwritten | #3934 | merged, deployed, read back in the book |
| 0927 | fill PO Doc No. after create / convert / cancel; `repair-ac-po-doc-no` | #3943 | merged, deployed; repair running (below) |
| — | evening conversion-key snapshot | #3965 | merged; stamp applied (below) |
| 0934 | a carried-over order's payment text stays the office's (STOPGAP) | #3969 | merged 12:32Z, deploy `backend` job success 12:37Z |

## PO Doc No. repair (0927), in progress

The owner: 「PO document no 应该是根据我们的系统来填写的，而不是放 reference number」.

- The plan (run 34953750664, read-only) found 553 SOs and 110 POs where the ERP wrote these fields.
- **Batch 1:** run 34954947823 queued 20 SOs.
- **Batch 2:** run 34965425886 queued 200 SOs, each re-read on a fresh connection. At 12:45Z the drain had sent 158 of them.
- **Left for later runs:** 443 (333 SO, 110 PO).
- **How to run:** `repair-ac-po-doc-no.yml`, MODE=apply, CONFIRM `put our purchase order numbers back in AutoCount`.
  - Out of office hours only: the drain sends 20 rows per 5 minutes and shares the queue with live work.
  - After each batch, read the book back.
- SO edits carry `Header.UDF.ToPONo` only. PO edits carry `UDF.SONo` and `Ref`. Neither carries payment text.

## Evening key stamp

- **Runs:** snapshot exported 11:49:29Z (#3965); plan run 34966534789; apply run 34966690584. 46 line keys were stamped and verified on a fresh connection: DO 28, GR 18.
- **Keyless after the stamp (read-only count, 12:05Z):** DO 0, GR 4 documents / 11 lines, IV 7 / 18.
- **Refused as source-not-in-book, same as the morning apply:**
  - HC-GRN-2609-012 and -057 (1 line each);
  - HC-PO-2609-005 (3 lines) and -061 (1 line).
- **HC-GRN-2609-026 (2 lines):** these lines have no PO line, so there is nothing to pair.
- **7 carried-over invoices (HC-I-…):** keyless because the exporter's invoice lane reads only `HC-SI-` numbers, and the carried-over list takes only DO and PO. Keying them needs a code change; nothing is built.
- **HC-GRN-2609-079 (7 lines):** see the next section.

## NEW: Hookka receipts cannot convert, and Hookka POs sit on another company's account

Found 12:30–12:55Z. Everything read-only: book with NOLOCK, production ERP inside
`read only`. Supplier names were compared by program, never printed.

**HC-GRN-2609-079.**
- In the book (DocKey 931929, creditor 400-H004, MASTER 17:00:18 local) with **no lines**.
- The outbox row reads `sent`, with "AutoCount reported no lines".
- None of its 7 PO lines was received in the book: TransferedQty 0, and no GRDTL row draws on them.

**HC-GRN-2609-081.** `po_to_gr` failed after 6 attempts. AutoCount moved 3 lines, then refused "Either no item found or item already full transferred at DocNo HC-PO-2609-006". It is not in the book.

**Why (PROVEN):**
- Each receipt draws on 5 carried-over POs under 400-O002 and on 1–2 ERP POs under 400-H004. A book GR holds one creditor.
- The 12 other multi-PO receipts since go-live draw on one creditor each, and all converted.
- Since 09-01, 079 is the only MASTER-created document with no lines, checked across SO, PO, DO, IV, GR and PI.

**The deeper cause (PROVEN):**
- The ERP supplier coded `400-H004` shares no name word with the book's creditor 400-H004. That account was created 2025-10-03 by ADMIN and holds another company. The book creditor carrying this supplier's name is `400-H003`.
- **How the office books this factory** (non-cancelled documents per month):
  - 400-H003 was used through 2026-03 (POs), with GRs and PIs trailing to 06.
  - 400-O002 was created 2026-04-02, and every PO for this factory since April is under it.
  - 400-H004 holds 5 staff POs, GRs and PIs each in 2026-08, then the ERP's 105 POs from 09-09 (7 cancelled) and the empty GR 079.
- The owner calls Ohana, Hookka and Hookka Manufacturing one factory (2026-09-12).
- No PI under 400-H004 has been made by the ERP yet. The first Hookka PI converted would post to the other company's creditor.
- **The book's active ERP-made POs under 400-H004 number 98** (read-only reconciliation across all 704 ERP POs that have a book number):
  - 94 are the ERP's 400-H004 supplier (91 submitted, 1 partly received, 2 received).
  - 4 are POs whose ERP supplier is now 400-N002 (HC-PO-2609-027, -069, -072) or 400-D004 (HC-PO-2609-047). A PO edit never sends `CreditorCode`, so the book still holds 400-H004.
  - Outside these, one old staff PO (PO-006690, received) differs, book 400-H003 against ERP 400-N002; no other linked PO differs.

**Code facts (origin/main):**
- The write-back takes `CreditorCode` from `scm.suppliers.code`: `readConvertCreditor`, `readPoHeader`, and the `so_to_po` backfill in `autocount-outbox.ts`.
- `scm.suppliers` is unique on (company_id, code).
- The bridge's `/edit` header allow-list (`AcSyncService.cs`, `Edit`) has no `CreditorCode`, so today nothing can move a book PO to another account.
- `POST /grns` (New GRN form) accepts PO lines of any supplier. `/from-pos` refuses mixed suppliers, and `/from-po-items` makes one GRN per supplier (owner 2026-05-29, 「不同 supplier 不能 under 同一张 GRN」).

**Exposure.**
- Still to receive: 56 POs / 115 lines under 400-O002 (all book-numbered), and 92 POs / 172 lines under 400-H004.
- Receipts since go-live: 127 under 400-O002; 2 under 400-H004, which are 079 and 081.

**Options put to the owner, not answered:**
- **A (recommended):** map the ERP supplier to 400-O002, as the office has done since April. Move the 94 Hookka POs in the book to 400-O002 (and the 4 above to their ERP supplier's account), then re-send 079 and 081 (the empty book 079 has to be voided first). Mixed receipts then convert as they are.
- **B:** map it to 400-H003. Mixed receipts still need splitting per account.
- **C:** keep 400-H004.

Either A or B needs two things:
- an AutoCount account override for the write-back, because the code is unique and 400-O002 already belongs to another ERP supplier row;
- a way to change the existing POs' creditor: a bridge `/edit` change that waits for the host swap, or the office in AutoCount.

## Payment text (0934)

- **What happened.** The book's `EventLog` shows 76 MASTER changes, from full SO edits, that removed book text on 74 carried-over orders. A real reference was lost on 69.
- **What the stopgap does** (#3969). An order in the book under the book's own number now gets `BALANCE` and no `PAYEMENT`. Before the fix, 415 orders would have lost text on their next edit.
- **Production read-back: UNTESTED.** No SO edit had been queued since the deploy, at 12:38Z. On the next MASTER "Edit Sales Order: SO-0…", `EventLog` should show a BALANCE change and no "UDF PAYEMENT" change.
- **Waiting on the owner's option A:**
  - the root fix: keep the book's text in the ERP and append new ERP references;
  - the restore. A per-order plan exists (local, read-only): 61 orders restore cleanly, 8 need a person, 5 already match again.

## Waiting on a person

- **Hookka account mapping:** A / B / C above.
- **Payment text:** option A (root fix plus restore).
- **Balances.** 5 carried-over orders miss payments the office keyed in AutoCount: 6 payments on 4 orders, RM 9,047 PROVEN from `EventLog`. HC-SO-003945's RM 150 is LIKELY not a payment. Options: A, staff key them in the ERP (recommended); B, a script; C, leave them. Key them only after the payment text fix, and both HC-SO-012571 payments in one sitting.
- **A security item** was raised with the owner in chat on 2026-09-15. It is deliberately not detailed in this public repository.
- **Office host swap** (AnyDesk, the owner will say when). It turns on #3865 and #3922; see the morning handoff. It is also where a bridge `/edit` CreditorCode change would ride.
- **A big Remark 2 run in AutoCount,** for receipts after 09-10 18:25 (morning handoff).
- **The purchase order document number question is ANSWERED.** "PO Doc No." is `SO.UDF_ToPONo`, which lists the POs raised from the order; 0926 and 0927 handle it.
