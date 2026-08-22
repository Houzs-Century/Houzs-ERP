# 0518 — The AP control check could not see the failure it existed to find

- **Area:** Accounting, GL, journals
- **Found:** 2026-08-22, on production (Houzs Century), walking the real screens
- **Status:** Fixed

## What was wrong

`GET /control-check` compares each control account against the documents that
are supposed to explain it. The **AR** arm reports a confirmed sales invoice
with no active journal. The **AP** arm skipped that case outright:

```ts
/* PI posts on demand — a confirmed PI with no journal is NORMAL here,
   not drift (the AP aging is the place that surfaces unposted PIs). */
if (!je) continue;
```

Both halves of that justification are false.

**"PI posts on demand."** `postPurchaseInvoiceHandler` calls `postPiAccounting`
on *both* of its arms — the `DRAFT → POSTED` transition and the already-posted
ensure branch. A confirmed PI that has no journal is therefore not a PI waiting
to be posted; it is a PI whose post **failed**.

**"The AP aging is the place that surfaces unposted PIs."** `scm.v_ap_aging`
selects from `purchase_invoices` alone and never joins `journal_entries`. It
buckets unpaid invoices by due date. It has no notion of posted, so it cannot
surface an unposted anything.

## How it showed up

Houzs Century on 2026-08-22:

- `HC-PI-2608-002` and `HC-PI-2608-003` — both **CONFIRMED**, both with **no
  journal entry**. AP control check: **CLEAN**.
- `HC-SI-2608-002` — same shape on the sales side. AR control check:
  **"document has no active journal"**, correctly reported.

The company had **zero** journal entries. The check built to catch exactly that
reported the payables side clean.

## The fix

The AP arm now mirrors the AR arm, keeping the MYR conversion the PI side needs
(`toMyrSen`, because `total_sen` is in the invoice's own currency and the
journal is in ringgit).

Three neighbours stay skipped, and the test pins each one:

| Case | Why no journal is correct |
|---|---|
| `DRAFT` | has committed nothing |
| `CANCELLED` | its journal was reversed at cancel |
| `migrated_no_stock` | AutoCount already booked the payable (mig 0280) |
| **zero total** | `postPiAccounting` refuses one (`zero_total`) |

## What this does NOT fix

**Why the post failed is still unknown.** This entry is about the check being
blind, not about the underlying failure. What is established: the confirm
returns HTTP 500 with no structured body — an *uncaught* throw, not one of the
handler's own `c.json({error, reason}, 500)` paths — while the invoice is left
CONFIRMED, so the operator is told "Purchase invoice not posted" about an
invoice that posted. Ruled out by reading: `resolveRoles` (handles its error and
falls back), `piLines` (pure), `nextJeNo` / `padMmDd` (an invalid date yields a
malformed number, not a throw), and every structured-return path in
`postJournal` and `postPiAccounting`. The chart of accounts is not the cause —
all ten role accounts exist on company 1, postable and active. Not reproduced
again because Houzs Century has no unbilled goods-received lines left to bill.

## Related

- `docs/bugs/0233` — company 2's ledger lines booked to codes its chart did not
  have. Same family: the GL's account codes and the check over them drifting
  apart from what the books actually hold.
