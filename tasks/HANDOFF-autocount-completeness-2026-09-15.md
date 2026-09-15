# Handoff: AutoCount sync completeness, 2026-09-15

The owner asked for four things to be fully in AutoCount, and for the fixes to
hold for future documents:

- documents shown as Not accepted and Cleared;
- payments;
- purchase orders and goods received.

His words: 「Not accepted 和 Clear 这一边也是要进完 ... Payment 跟 PO GR 那边一定要进完」 and
「autocount sync记得看之后也可以 同样的方式进去」. This file records the state at 07:21Z. It
follows `tasks/HANDOFF-autocount-option-b-2026-09-14.md`. Re-run the counts
before quoting them.

## Where it stands (07:21Z)

- **AutoCount Sync page**, computed the page's way (live shelf, re-queued marker,
  a refusal older than the newest arrival counts as history):

  | ALL | WAITING | NOT ACCEPTED | IN AUTOCOUNT | CLEARED |
  | ---: | ---: | ---: | ---: | ---: |
  | 906 | 0 | 0 | 905 | 0 |

  The one document not "in AutoCount" is HC-PO-2609-055: three old re-queued edit
  rows are filed under the row id rather than the number. The purchase order
  itself is in the book.
- **Goods received:** 69 of 69 ERP receipts since go-live (not carried over) are
  in the book.
- **Payments:** measured earlier on 09-15, 281 orders with a payment since
  go-live. 279 book balances equal the ERP, none differ, and 2 have no ERP total
  by design. The payment reference text is capped at the book's 50 characters
  (0921). HC-SO-2609-011 and SO-009093 were re-sent (run 34936267645) and read back
  in the book at 39 and 35 characters.
- **Cleared:** the last three (HC-SO-013361, -013393, -013394) were put back with
  `restore-arrived-ac-outbox-docs` `doc_nos` (run 34935666365, 32 rows).

## Merged today

| ledger | what | PR |
| --- | --- | --- |
| 0913, 0914, 0915 | a sofa piece of another model; invoice line key lanes; a receipt row over a split transfer | #3892 |
| 0917 | cleared documents that reached AutoCount go back on the list; archive guard | #3900 |
| 0918 | 120 carried-over deliveries AutoCount never invoiced can be invoiced | #3905 |
| 0919 | carried-over DO / PO line keys; a retired book line | #3909 |
| 0920 | a sofa's pieces are spelled in line order | #3914 |
| 0921 | payment text fits the 50-character field | #3918 |
| — | the restore takes named documents a person cleared | #3919 |
| 0923 | an ERP purchase order names itself on the sales lines (INERT until the host swap) | #3922 |
| 0924 | an edit refused for timing goes out by itself | #3926 (queued at writing) |

## Remark 2 ("READY" in AutoCount) is not ours

The owner corrected a wrong assumption of mine: 「autocount 的remark 2 是自动的 ... 你只要收了GR 就会自动变了」.
The book's `EventLog` proves it: 665 Remark 2 changes from 09-01 to 09-15, all
ADMIN on DESKTOP-TDH50IT, with no SQL trigger, procedure or UserScript behind them.

- **Runs.** Big runs on 09-07 12:37 local (83 changes) and 09-10 16:48–18:25
  (150). Nightly small runs around 00:13 local (4–17 changes).
- **Our receipts are recognised.** Bedframe or sofa groups received by ERP
  receipts on 09-10: 33 gained the group after the receipt, 4 never did. Staff
  receipts in the same window: 47 of 49.
- **Nothing received after 09-10 18:25 is reflected yet,** whoever made the
  receipt: ours 33 lines, staff 3. No big run has happened since. That run is on
  the AutoCount side.
- **Risk, UNKNOWN.** ERP purchase orders leave `SODTL.UDF_PONo` / `UDF_PODocKey` /
  `UDF_Creditor` blank: 97 orders, 163 lines at 06:55Z. The plug-in fills them on
  563 of 564 of its lines. Whether the Remark 2 program needs them is untested,
  because no ERP purchase order with a category had been received. #3922 fills
  them after the host swap.

## Waiting on a person

- **Office host swap** (AnyDesk; the owner will say when). It turns on:
  - #3865: conversion keys stored as they drain;
  - #3922: sales lines name their purchase order.

  After the swap:
  1. Re-send one ERP purchase order with `resend-ac-document-edits` and read
     `SODTL.UDF_PONo` on its sales lines. UNTESTED until then.
  2. Re-send the ERP purchase orders made before the swap, so their sales lines
     are filled.
- **A big Remark 2 run in AutoCount** for receipts after 09-10 18:25.
- **Purchase order document number.** Asked 09-15, not answered. Options: (A)
  AutoCount keeps its own running number; (B, recommended) keep the ERP number and
  put the SO number in Ref; (C) he meant another screen.
- **Carried-over receipts to purchase invoices** are refused wholesale. This
  needs an accounting decision (goods received not invoiced) and has not been
  raised yet.

## Open, not built or not investigated

These were measured earlier on 09-15; re-check before acting.

- **Keys arrive missing until the host swap.** Delivery orders, receipts and
  invoices made by conversion arrive without line keys, so run the export and
  stamp periodically. #3926 re-sends the refused edit once keys exist; keys
  stamped by the script still need `requeue-keyed-conversion-edits.mjs` for
  DO / GR.
- **HC-DO-010936:** the book's DocDate is still 2026-07-21 while the ERP's is
  09-12. The edit may not send DocDate; not investigated.
- **HC-DO-011518:** a DISPOSE line with quantity 0 is reported
  `source_not_in_book` although it is keyed. Noise in the stamp report.
- **Data items:**
  - PO-009790 has price 0 in the book;
  - PO-010098's receipt sits on the other line with the same item;
  - PO-009979 has a line with no item;
  - 24 receipt lines are RM1.00 placeholders in the ERP against 0.00 in the book;
  - HC-GRN-2609-012 and -057 look cross-assigned;
  - 73 carried-over receipts have no book receipt number and cannot be keyed;
  - 1 keyless SO.
- **Customer receipts (OR):** not built. Switch off, and the accountant picks the
  start date. It needs a host route, so the host swap first.
- **Photographs over 2 MiB:** four documents went without them, and reducing the
  images is not built.
