## Settlement matching could not see migrated payments, and a half-failed upload held its file hostage [high]

<!-- area: Accounting + GL -->

**Symptom.** The owner, 2026-09-04: 「我发现我 upload 了好像对不上，你可以帮我
确定现在他会链接 sales order 那边输入的资料吗？」. His first four real MBB
statements (batches 1–4, uploaded 2026-08-27) sat entirely UNMATCHED — "No
payment recorded near … for this amount" — while three of the four sales were
plainly in the ERP. And his PBB statement of 2026-08-01 looked uploaded
(a batch in the list) but opened onto nothing, and re-uploading the same file
answered "This exact file has already been uploaded."

**Root cause (traced), two of them.**

1. *The candidate loader filtered on a tag the migrated payments do not have.*
   `loadPaymentCandidates` (backend/src/acc/settlement.ts) queried
   `.eq('merchant_provider', acquirer.display_name)` and then kept only
   `method === 'merchant' || method === 'installment'`. Every migration-era
   payment carries `method = 'imported'` and `merchant_provider = NULL`, so it
   failed BOTH filters. Measured on production 2026-09-04: statement line
   RM 2,588.00 @ 2026-08-15 ref 969745 has counterpart HC-SO-013278
   (RM 2,588.00, paid 2026-08-17, provider NULL, method imported) inside the
   3-day window; the RM 1,000 line ↔ HC-SO-013218; the RM 2,300 line has two
   candidates (HC-SO-013177 / 013229). The RM 3,899 line genuinely has no
   payment in range — that one is a true UNMATCHED. The parser was NOT at
   fault: the owner's real PBB CSV runs 4/4 lines through the shipped
   `settlement-parse.ts` (RM 11,910.00 gross / RM 95.56 fee), and his IBG
   payment advice reads whole through `readPbbAdvice` with a net that ties the
   CSV to the sen.

2. *The upload wrote its batch head first and could not clean up after itself.*
   `settlementUpload` inserts `acc_settlement_batches`, then loads candidates
   and inserts `acc_settlement_rows`; every failure in between returned 500
   and LEFT THE HEAD. Production batch #5 (PBB, file 2990HOMESB_CSV_20260801)
   is exactly this wreck: head says `row_count = 1`, the rows table has
   nothing for it. The head still owns the `UNIQUE (company_id, file_hash)`,
   so retrying the same file hit the duplicate refusal — "already uploaded",
   about an upload that never finished.

**Fix.** PR #2965, branch fix/settlement-recon-gaps.

- `couldBeAcquirers` (new, pure): a candidate is a card payment tagged with
  THIS acquirer, a card payment tagged with nothing, or an `imported` payment
  tagged with nothing; a different acquirer's tag and cash/transfer never.
  The loader reads the window whole and filters here. Untagged candidates
  carry `merchantProvider: null` and render as 未标 merchant; the matcher
  still auto-takes only on a unique reference, and `confirmSettlementRow`
  stamps the tag onto the payment (`.is('merchant_provider', null)` — never
  over a tag chosen at the till) before anything posts. The phase-2A posting
  rule is untouched: `imported` rows still never book.
- `settlementUpload` deletes its batch head on any failure after writing it,
  and `clearOrphanBatch` (new) clears a line-less wreck at the next upload of
  its file; a batch WITH lines keeps the 409.

Pinned by `settlement.test.ts` (loader offers untagged + imported and refuses
another acquirer's stream; confirm stamps NULL-only; clearOrphanBatch
clear / cleared_orphan / duplicate), `settlementRoutes.test.ts` (the retry
after a simulated half-failure replaces the wreck; a real duplicate still
409s), and `MerchantRecon.test.tsx` (the marker renders for null, not for a
tagged or field-less candidate). The loader and orphan cases were written
against the unfixed behaviour these symptoms ARE — batch detail recomputes
candidates on read, so the four MBB batches gain their candidates on deploy
with no re-upload; the PBB orphan clears itself when the owner re-uploads
that file.

**Ref.** fix/settlement-recon-gaps, 2026-09-04.
