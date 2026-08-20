## BUG CLASS - party-code-unverified-identity: a valid code that names the wrong company [high]

<!-- area: AutoCount sync + write-back -->

**Symptom.** Owner, 2026-08-17. `HC-PO-2608-001`, `HC-GR-2608-001` and
`HC-PI-2608-001` are in the live book `AED_HOUZS` under creditor `400-H004`.
Measured on the host, that creditor is `HAO HUA FURNITURE`, of Jalan Bentara 1,
Skudai. The ERP purchase order behind those three documents names `HOOKKA
INDUSTRIES SDN. BHD.` Different company. Three real documents are booked against
the wrong party — an accounting error, not a technical one, which is why nothing
alerted.

**The shape** — an identifier that is a FOREIGN KEY into a system this one cannot
read. Every layer can check that the code is well-formed, present and accepted;
not one can check that it names the same company the ERP thinks it does. So the
only failure mode left is the silent one.

**Root cause, traced.** Three steps, none of which is wrong on its own:

1. `readPoHeader` (`backend/src/scm/lib/autocount-outbox.ts`) reads the supplier
   through `supplier_id` — `sb.from('suppliers').select('code, name')` — and
   returns `creditor_code: s?.code ?? null` beside `creditor_name: s?.name`.
2. `composeCreatePo` (`backend/src/services/autocount-writeback.ts`) refuses an
   EMPTY creditor code (`MissingCreditorError`) and sends anything else verbatim.
   Emptiness is the only property it tests.
3. The drain's `/ensure-masters` pre-flight is handed BOTH halves —
   `mastersOf` (`backend/src/scm/lib/autocount-masters.ts`) builds
   `Creditors: [{ AccNo, CompanyName }]` — and then throws the second half away.
   `AcSyncService.cs`: `if (CreditorExists(da, acc)) { existed.Add(...); continue; }`,
   where `CreditorExists` is `da.GetCreditor(acc) != null`. The entity is fetched,
   its `CompanyName` is right there, and it is never compared to the one the ERP
   sent. Only the CREATE arm ever touches `CompanyName`, and only for a code the
   book does not already hold.

`400-H004` is a perfectly valid creditor code. It exists, so step 3 short-circuits,
and steps 1 and 2 have nothing to object to. The document saves cleanly.

**Why it hides** — this class has no error state. The sibling class
`writeback-reads-the-empty-column` at least ends in a foreign-key throw, because
`""` is not a row in the master table. Here the code IS a row in the master table.
The write-back succeeds, `linked_ac_docno` is written back, the outbox row goes
`sent`, and the ERP and the account book agree about everything except who was
bought from. The only reader who can see it is a human holding both masters side
by side.

**What would have caught it, and where the check belongs.** Cheapest first:

- **Compare the name in `CreditorExists`, on the host** — the entity is already
  fetched. Return the found `CompanyName` instead of a bool and have
  `/ensure-masters` report `creditor:<acc> MISMATCH erp=<x> book=<y>` in the
  response it already returns. Cost: a few lines of C# and a service rebuild.
  This is the smallest change that closes the class, and it is the RIGHT layer —
  it is the only layer that holds both names at once. It should REPORT, not
  refuse: the ERP's name is often the shorter trading name and a hard refusal
  would wedge the queue on a cosmetic difference.
- **Refuse at bind time, not at send time.** The real defect is upstream of the
  sync: `scm.suppliers.code` is a free-text field with no validation, so the
  wrong value can be typed and then sits there being valid. A supplier-edit form
  that resolved the code against the book and showed the CompanyName it maps to
  would have made the error visible at the moment it was made, to the person who
  made it. That needs a read route AcSyncService does not have — its ten are
  `/health`, `/ensure-masters`, `/create-so`, `/create-po`, the four conversions,
  `/edit` and `/cancel`, and **not one of them hands the book's contents back**.
  `/ensure-masters` comes closest and still answers only created / existed /
  failed. So this option costs a new route plus a UI, not a comparison.
- **A periodic census, which is what this PR actually ships.** It cannot see the
  AutoCount side at all, so it is a diff aid rather than a check: it prints the
  ERP half in the book's own key order for a human to match against
  `SELECT AccNo, CompanyName FROM Creditor`. That is honest about what an
  ERP-side script can know, and it is worth having whatever else is built,
  because it also finds the codes that are missing and the ones used twice.

**What this PR does NOT do, deliberately.** It does not correct any mapping.
Which creditor code is right for HOOKKA INDUSTRIES is the owner's call against
the AutoCount masters, and a wrong "correction" moves three documents from one
wrong company to another.

**What the audit RULED OUT.** The customer side was suspected of carrying the
same defect through `debtor_code`, and it does not. `composeCreateSo` sends
`DebtorCode: AC_DEBTOR_CODE`, a CONSTANT (`autocount-writeback.ts`), and
overwrites `DebtorName` per customer; `mastersOf` deliberately emits no debtor at
all. So no per-customer code has ever been sent to the book and there is no
customer-side mapping to be wrong. `scm.customers` has no AutoCount column
either: its only code is `customer_code`, the `2990S-` value minted by
`upsert_customer_by_name_phone` (mig 0164). The sales side has a DIFFERENT open
question — every order lands on one AR account — and that is a decision, not a
bug. Also checked and absent: a `/doc-read` route on AcSyncService, which does
not exist in any form.

**Ref** — 2026-08-17, this PR. Census:
`backend/scripts/census-autocount-party-codes.mjs` +
`.github/workflows/census-autocount-party-codes.yml` (read-only,
`workflow_dispatch`, own concurrency group). Related:
**BUG CLASS - writeback-reads-the-empty-column** below — same subsystem, opposite
symptom: that one fails loudly on a foreign key, this one cannot fail at all.
