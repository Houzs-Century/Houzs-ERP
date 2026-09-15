# Handoff: AutoCount sync, evening of 2026-09-15

Follows `tasks/HANDOFF-autocount-completeness-2026-09-15.md` (state at 07:21Z).
This file records the state at about 13:25Z. Every count carries the time it
was measured; re-run before quoting (R07).

Every production read below is read-only: the ERP inside `read only`, the
book with `WITH (NOLOCK)`. Local probe scripts live in this machine's session
scratchpad (not in git):
`C:\Users\User\AppData\Local\Temp\claude\C--Users-User-Desktop\78bf1114-6f66-4189-a16c-a28457aa1172\scratchpad\`.
Its `ro.mjs` runs a query module inside `read only`; run it from `backend/`, where
it finds `postgres`.

## Start here

1. **PO Doc No. repair.** Batch 3 is draining. Verify it once the queue is empty,
   then run the last 243 rows out of office hours (section below).
2. **Owner decisions.** Four are open (bottom of this file). Read the chat for
   answers before acting on any of them.
3. **Two builds were briefed and stopped before writing any code:** customer
   receipts, and the stale-key recompose. Restart them from their briefs below,
   or remove their worktrees; nothing would be lost.
4. **New defect.** ERP size changes on carried-over order lines did not reach the
   book: 6 lines on 4 orders. It is not raised with the owner and nothing is built.
5. **Only one document is refused now:** HC-GRN-2609-081. It waits on the Hookka
   decision.

## Shipped today, after the morning handoff

| ledger | what | PR | state |
| --- | --- | --- | --- |
| 0924 | an edit refused for timing goes out by itself | #3926 | merged |
| 0926 | Ref carries the customer reference; PO Doc No. is no longer overwritten | #3934 | merged, deployed, read back in the book |
| 0927 | fill PO Doc No. after create / convert / cancel; `repair-ac-po-doc-no` | #3943 | merged, deployed; repair in batches (below) |
| — | evening conversion-key snapshot | #3965 | merged; stamp applied |
| 0934 | a carried-over order's payment text stays the office's (STOPGAP) | #3969 | merged 12:32Z; Deploy `backend` job success 12:37:33Z; observed on production (below) |
| — | first version of this handoff | #3973 | merged 13:02Z |

## PO Doc No. repair (0927)

The owner said:
「PO document no 应该是根据我们的系统来填写的，而不是放 reference number」.

The plan (run 34953750664) found 553 SOs and 110 POs where the ERP had written
these fields.

| batch | run | queued | read back in the book |
| --- | --- | --- | --- |
| 1 | 34954947823 | 20 SO | 20 of 20 match, at 13:17Z (5 now name PO numbers, 15 cleared) |
| 2 | 34965425886 | 200 SO | 200 of 200 match, at 13:16Z (38 name PO numbers, 162 cleared) |
| 3 | 34971897037 | 200 SO; rows created 13:04:08–13:08:59Z | not yet: 140 still pending at 13:15:39Z (the drain sends 20 per 5 minutes) |

- **Left for later runs:** 243, of which 133 are SOs and 110 POs. The next `LIMIT 200` run takes SOs first.
- **Apply:** `repair-ac-po-doc-no.yml` with MODE=apply and CONFIRM `put our purchase order numbers back in AutoCount`.
  - Run it out of office hours only.
  - The previous agent was told to pause near 16:00Z (00:00 local). The book's nightly Remark 2 run is around 00:13 local (morning handoff).
- **Verify a batch:**
  1. Export its rows with `SINCE` and `UNTIL` set to the batch's row window: `node <scratchpad>/ro.mjs <scratchpad>/q-podocno-batch.mjs > bN-rows.txt`.
  2. Run `python <scratchpad>/ac-podocno-verify.py bN-rows.txt`, with env `AC_CRED_FILE` set to the credential file.
  3. It prints match, mismatch and "explained by a later edit" counts. Ref is compared by md5 only and never printed.
- **Payload:** SO edits carry `Header.UDF.ToPONo` and nothing else; PO edits carry `UDF.SONo` and `Ref`. Neither carries payment text. At 13:15Z, 0 of the 140 pending rows carried `PAYEMENT`.

## Payment text (0934): stopgap live, seen working once

- **What happened.** The book's `EventLog` has 76 MASTER changes from full SO edits that removed book text on 74 carried-over orders. On 69 of them a real reference was lost. A read-only comparison at 11:55Z found 415 more orders that would have lost text on their next edit.
- **The stopgap (#3969).** An order in the book under the book's own number now gets `BALANCE` and no `PAYEMENT`.
- **Observed on production (PROVEN, 13:15Z).**
  - After the deploy, 61 edits of book-numbered SOs were sent and none carried `PAYEMENT`.
  - One of them was a full edit: HC-SO-011654, composed 12:58:31Z and sent 13:00:19Z. It carried `BALANCE`.
  - For that save (21:00:19 local), the book's `EventLog` lists Description and Quantity changes only.
- **Not yet observed:** the payment-only edit, which fires when a payment is keyed on a carried-over order.
- **Waiting on the owner's option A:**
  - the root fix: keep the book's text in the ERP and append new ERP references;
  - the restore. The per-order plan is `<scratchpad>/payement-restore-plan.json`: 61 orders restore cleanly, 8 need a person, 5 already match again.

## Hookka POs sit on another company's account; receipts 079 / 081 (waiting on the owner)

Measured 12:30–12:55Z. Supplier names were compared by program and never printed.

**The receipts.**
- **HC-GRN-2609-079** is in the book (DocKey 931929, creditor 400-H004, MASTER) with **no lines**. Its outbox row reads `sent` with "AutoCount reported no lines". None of its 7 PO lines was received: TransferedQty is 0, and no GRDTL row draws on them.
- **HC-GRN-2609-081** failed after 6 attempts. AutoCount moved 3 lines, then refused "Either no item found or item already full transferred at DocNo HC-PO-2609-006". It is not in the book.
- **Why (PROVEN).** Each receipt draws on 5 carried-over POs under 400-O002 and 1–2 ERP POs under 400-H004, and a book GR holds one creditor.
  - The 12 other multi-PO receipts since go-live draw on one creditor each, and all converted.
  - Since 09-01, 079 is the only MASTER document with no lines, checked across SO, PO, DO, IV, GR and PI.

**The account (PROVEN).**
- The ERP supplier coded `400-H004` shares no name word with the book's 400-H004. That account was created 2025-10-03 by ADMIN and holds another company. The book creditor carrying this supplier's name is `400-H003`.
- How the office has booked this factory, counting non-cancelled documents per month:
  - 400-H003 through 2026-03 for POs, with GRs and PIs trailing to 06;
  - 400-O002 from 2026-04 onward for every PO (the account was created 2026-04-02);
  - 400-H004 for 5 staff POs, GRs and PIs each in 2026-08, then the ERP's 105 POs from 09-09 (7 cancelled) and the empty 079.
- The owner calls Ohana, Hookka and Hookka Manufacturing one factory (2026-09-12).
- No PI has been made under 400-H004 by the ERP yet. The first Hookka PI converted would post to the other company's creditor.
- **98 active ERP-made POs sit under 400-H004 in the book**, reconciled across all 704 ERP POs that have a book number:
  - 94 are the ERP's 400-H004 supplier;
  - 4 are POs whose ERP supplier is now 400-N002 (HC-PO-2609-027, -069, -072) or 400-D004 (HC-PO-2609-047). A PO edit never sends `CreditorCode`, so their book account never moved.

**Code facts (origin/main):**
- The write-back takes `CreditorCode` from `scm.suppliers.code`: `readConvertCreditor`, `readPoHeader`, and the `so_to_po` backfill in `autocount-outbox.ts`.
- `scm.suppliers` is unique on (company_id, code).
- The bridge's `/edit` header allow-list (`AcSyncService.cs`, `Edit`) has no `CreditorCode`.
- `POST /grns` accepts PO lines of any supplier. `/from-pos` refuses mixed suppliers, and `/from-po-items` makes one GRN per supplier (owner 2026-05-29).

**Exposure at 12:40Z:**
- still to receive: 56 POs / 115 lines under 400-O002, and 92 POs / 172 lines under 400-H004;
- receipts since go-live: 127 under 400-O002, and 2 under 400-H004 (079 and 081).

**Options asked about 12:50Z, no answer yet:**
- **A (recommended):** map the ERP supplier to 400-O002, as the office has done since April. Move the 94 POs in the book (and the 4 to their ERP supplier's account), void the empty book 079, then re-send 079 and 081.
- **B:** map it to 400-H003. Mixed receipts would still need splitting per account.
- **C:** keep 400-H004.

A and B both need two things:
- a write-back account override;
- a way to change an existing PO's creditor, either a bridge `/edit` change carried by the host swap or the office in AutoCount.

The owner was told the existing POs need one of those two.

## Found 13:00Z: an edit queued behind a rebuild is refused (fixed by hand, source not fixed)

**HC-SO-011654 (PROVEN from outbox rows, `scm.mfg_so_audit_log` and the book's `EventLog`):**
- **10:21:01Z.** A line was deleted in the ERP. The 10:21:02Z row was an edit with `Rebuild: true` and 7 keyed lines. It was sent at 10:25:17Z: the book deleted its 7 lines and added 6 with new DtlKeys 931973–931978, and the ERP stored those keys.
- **10:21:08–10:22:05Z.** Five ordinary edits (size and quantity changes) were composed before the rebuild drained, carrying the OLD keys 803471–803477. Each was refused 6 times ("line 803474 not found on SO-011654") and ended `failed`.
- **Cleared by hand.** `resend-ac-document-edits` plan run 34971913473, then apply run 34972024621, composed the order with the current keys. It was sent at 13:00:19Z, and the book's quantities matched the ERP afterwards.
- **Why it happens.** The drain replays a stored payload and never recomposes, and a Rebuild destroys the keys an earlier-composed edit names.

**Source fix: NOT built.** Design notes from the stopped brief:
- **Trigger:** an `edit` refused as line-not-found, where that key is no longer on any of the ERP's current lines for the document (the ERP re-keyed it).
- **Action:** stop retrying and compose the document as it is now through `enqueueEdit`, once.
- **If the ERP still carries the key,** the office changed the book: keep failing so a person sees it.
- **Alternative or addition:** when a `Rebuild: true` row is marked sent, recompose the same document's pending edits.
- **Model:** `backend/src/scm/lib/autocount-held-edit-resend.ts` (#3926). Put new code in a new file, because `autocount-outbox.ts` is near the 2,000-line cap.

## Found 13:20Z: ERP size changes on carried-over lines did not reach the book (not raised, not built)

**Evidence (PROVEN):**
- `scm.mfg_so_audit_log` `UPDATE_LINE` entries with a real `itemCode` change since go-live: 19 changes on 14 carried-over orders, and 20 on 11 ERP-made orders in the book.
- The current ERP line codes of those 25 orders were compared with the book line of the same DtlKey:

  | order kind | same code | naming only (supplier model alias) | different size | key missing |
  | --- | ---: | ---: | ---: | ---: |
  | ERP-made | 46 | 20 | 0 | 0 |
  | carried-over | 56 | 28 | 6 | 2 |

  "Naming only" covers pairs such as ERP `JAGER-(Q)` against book `HOK-1013 (Q)`. The 2 missing keys are on HC-SO-013319.

**The 6 lines. The book still holds the old size; each ERP change is recorded in the audit log.**

| order | book line now | ERP line now | ERP change recorded |
| --- | --- | --- | --- |
| HC-SO-001139 | AK-NOBILITY MATT (K) | AKEMI NOBILITY MATT (Q) | 09-10 08:28Z, (K) to (Q) |
| HC-SO-011532 | JM-CL JAC WP MP (S) | JM-CL JAC WP MP (SS) | 09-13 05:38Z, (S) to (SS) |
| HC-SO-011654 | AERO-MP (K) | AERO-MP (Q) | 09-15 10:21Z, (K) to (Q) |
| HC-SO-011654 | AK-ULTIMATE MATT (K) | AKEMI ULTIMATE MATT (Q) | 09-15 10:21Z, (K) to (Q) |
| HC-SO-011654 | AK-GUARDIAN MATT (SS) | AKEMI GUARDIAN MATT (Q) | 09-15 10:21Z, (SS) to (Q) |
| HC-SO-011840 | AERO-MP (Q) | AERO-MP (K) | 09-15 07:26Z, (Q) to (K) |

- **Book codes are original.**
  - The committed snapshot `ac-fidelity-so-lines.json.gz` (#1981, the book on 2026-08-11) holds SO-011654's codes: 803471 (K), 803472 (SS), 803474 AERO-MP (K), 803475 AERO-MP (Q).
  - The book's `EventLog` shows SO-011654 created 2026-05-04 by ADMIN and not saved again until today's rebuild.
- **HC-SO-009202** also differs (book `JM-CL JAC WP MP (SS)`, ERP `(S)`), but no ERP change is recorded for it. Where that came from is UNKNOWN.
- **What is known of the mechanism.** An ordinary edit carries no `ItemCode` per line: the rows of HC-SO-011654 carry only Desc2, Description, DtlKey, Location, Qty and UnitPrice. A `Rebuild` carries `ItemCode`, and today's rebuild sent the book's old codes.
- **Not traced:** which path, if any, is meant to carry a code change on a keyed line. Start from `so-edit-header.ts`, `composeEdit` and the route that sets `rebuild`.
- **Risk:** the book shows the old size to the office and to AutoCount's Remark 2. Purchasing follows the ERP.
- **Repair once fixed.** `resend-ac-document-edits` will not change a code while edits omit `ItemCode`. `rebuild-ac-document` re-keys lines and runs one order at a time, and a PO raised from the order blocks a rebuild (0609).

## Evening key stamp (12:05Z)

- **Stamped:** 46 line keys (DO 28, GR 18) by apply run 34966690584, on snapshot #3965 exported at 11:49:29Z.
- **Keyless after the stamp:** DO 0; GR 4 documents / 11 lines; IV 7 documents / 18 lines.
- **Refused as source-not-in-book,** the same as the morning: HC-GRN-2609-012 and -057, and HC-PO-2609-005 and -061.
- **HC-GRN-2609-026 (2 lines)** has no PO line to pair with.
- **The 7 carried-over invoices (`HC-I-…`)** stay keyless. The exporter's invoice lane reads only `HC-SI-`, so keying them needs a code change.
- **HC-GRN-2609-079** is keyless because it has no book lines (above).

## Builds briefed and stopped (no code written)

Both worktrees exist with dependencies installed and no commits. Their branches
were never pushed.

**Customer receipts (OR), switch OFF.**
- **Where:** worktree `houzs-work-worktrees/ac-official-receipts`, branch `feat/ac-official-receipts`. The only output is `<scratchpad>/or-ac-schema.py`.
- **Owner rules (09-14):**
  - build with the switch OFF;
  - the bank follows the accountant's practice: cash → CASH, HLB → HLBB, voucher → VOUCHER RECEIVED, everything else → MBB;
  - show sample ORs;
  - the accountant picks the start date, through the owner;
  - **never ask the owner accounting details.**
- **Research first, read-only.**
  - How the office records receipts in the book: `ARPayment`, its detail and knock-off tables, and `ARDeposit`; the payment method codes, the debtor, numbering, and where an SO number goes.
  - Whether the office already keys receipts for ERP payments made since 09-07. If it does, the start date is what prevents duplicates.
- **Never send** cutover payment rows (note "imported from AutoCount", method `imported`).
- **Build:**
  - the composer and enqueue, gated by the switch and the start date, with a dedupe key per payment id;
  - an outbox op;
  - a bridge route. Compile it with `backend/scripts/autocount-service/build-local.ps1` (R65); it deploys with the host swap.
  - tests and the module guide.
- **Stop at a green PR** for review.
- **Correction:** the brief said the C# only compiles on the office host. That was wrong; see R65.

**Stale-key recompose.** Worktree `houzs-work-worktrees/ac-stale-key-recompose`, branch `fix/ac-stale-key-recompose`. The design notes are in the rebuild section above.

## Waiting on a person

- **Hookka account mapping:** A / B / C above (asked about 12:50Z).
- **Payment text:** option A (root fix plus restore).
- **Balances.** 5 carried-over orders miss payments the office keyed in AutoCount: 6 payments on 4 orders, RM 9,047, PROVEN from `EventLog`. HC-SO-003945's RM 150 is LIKELY not a payment.
  - Options: A, staff key them in the ERP (recommended); B, a script; C, leave them.
  - Key them only after the payment-text fix, and key both HC-SO-012571 payments in one sitting.
- **A security item** was raised with the owner in chat on 2026-09-15. It is deliberately not detailed in this public repository.
- **Office host swap** (AnyDesk; the owner will say when). It turns on #3865 and #3922, and would carry a bridge `CreditorCode` edit and the receipts route.
- **A big Remark 2 run in AutoCount,** for receipts after 09-10 18:25 local (morning handoff).

## Housekeeping

- **Worktree `ac-so-po-doc-no-fill`** (branch `fix/ac-so-po-doc-no-fill`): its PR #3943 is merged and the remote branch is gone, so it is safe to remove.
- **Folder `houzs-work-worktrees/ac-po-doc-no`:** a leftover that git no longer tracks. It was locked when removal was tried.
- **`ac-official-receipts` and `ac-stale-key-recompose`:** remove them if the builds restart elsewhere.
