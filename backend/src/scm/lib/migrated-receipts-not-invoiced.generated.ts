// The goods receipts (GRNs) carried over from AutoCount that AutoCount never
// invoiced, so the ERP may bill them into a purchase invoice like any other GRN
// (docs/bugs/0918, purchase-side mirror). A GRN on this list is UNLOCKED for a
// hand-built purchase invoice; every other migrated GRN is still refused by the
// invoice paths (routes/purchase-invoices.ts, lib/migrated-chain.ts), because
// AutoCount already billed it and re-billing here double-books the payable.
//
// HOW THIS LIST WAS COMPUTED (2026-09-21, interim activation — owner asked for
// migrated GRs to be operable):
//   Not the live-book python (export-migrated-receipts-not-invoiced.py has never
//   run at the office). Instead computed from the COMMITTED, CI-validated
//   reconcile snapshot data/ac-reconcile-truth.json.gz (exported 2026-09-09),
//   using the SAME decode + PI->GR transfer read the reconcile checker uses:
//   of the 214 migrated AutoCount GRs the ERP holds, 189 had a non-cancelled
//   AutoCount purchase invoice raised from them (kept LOCKED, do not double-bill)
//   and 25 had none (listed here, by their ERP grn_number, both halves of a
//   multi-PO receipt). All 25 are late-Aug/Sept post-go-live receipts the owner
//   bills in the ERP, so AutoCount invoicing them is not expected.
//
// RESIDUAL RISK: the snapshot is 2026-09-09. If AutoCount raised a purchase
// invoice for one of these 25 AFTER that date, hand-billing it here would
// double-book. Low (billing moved to the ERP at go-live), but re-run
// export-migrated-receipts-not-invoiced.py against the LIVE book when the office
// can, and reconcile this list against it.

export const MIGRATED_RECEIPTS_NOT_INVOICED_AS_OF = '2026-09-09-cut (interim, computed from committed reconcile-truth)';

export const MIGRATED_RECEIPTS_NOT_INVOICED_IN_AUTOCOUNT: ReadonlySet<string> = new Set([
  'HC-GR-005239-PO-009787',
  'HC-GR-005239-PO-009811',
  'HC-GR-005239-PO-009818',
  'HC-GR-005239-PO-009819',
  'HC-GR-005245',
  'HC-GR-005325',
  'HC-GR-005335',
  'HC-GR-005349',
  'HC-GR-005350-PO-009780',
  'HC-GR-005350-PO-009922',
  'HC-GR-005350-PO-009966',
  'HC-GR-005350-PO-009972',
  'HC-GR-005350-PO-009988',
  'HC-GR-005350-PO-010009',
  'HC-GR-005350-PO-010013',
  'HC-GR-005350-PO-010032',
  'HC-GR-005352',
  'HC-GR-005352-PO-009893',
  'HC-GR-005353',
  'HC-GR-005353-PO-009894',
  'HC-GR-005356',
  'HC-GR-005358',
  'HC-GR-005358-PO-009711',
  'HC-GR-005358-PO-010058',
  'HC-GR-005359',
  'HC-GR-005360-PO-009832',
  'HC-GR-005360-PO-009901',
  'HC-GR-005360-PO-009908',
  'HC-GR-005360-PO-009909',
  'HC-GR-005360-PO-009911',
  'HC-GR-005360-PO-009912',
  'HC-GR-005360-PO-009914',
  'HC-GR-005360-PO-009965',
  'HC-GR-005360-PO-009990',
  'HC-GR-005360-PO-009999',
  'HC-GR-005360-PO-010010',
  'HC-GR-005360-PO-010012',
  'HC-GR-005360-PO-010015',
  'HC-GR-005360-PO-010024',
  'HC-GR-005360-PO-010027',
  'HC-GR-005360-PO-010030',
  'HC-GR-005360-PO-010051',
  'HC-GR-005360-PO-010057',
  'HC-GR-005361-PO-009985',
  'HC-GR-005361-PO-010043',
  'HC-GR-005363',
  'HC-GR-005364',
  'HC-GR-005365',
  'HC-GR-005367',
  'HC-GR-005368',
  'HC-GR-005373',
  'HC-GR-005375',
  'HC-GR-005376',
  'HC-GR-005377',
  'HC-GR-005378',
  'HC-GR-005381',
  'HC-GR-005382-PO-009780',
  'HC-GR-005382-PO-009933',
  'HC-GR-005382-PO-009966',
  'HC-GR-005382-PO-009991',
  'HC-GR-005382-PO-010052',
  'HC-GR-005382-PO-010054',
  'HC-GR-005382-PO-010056',
  'HC-GR-005382-PO-010061',
  'HC-GR-005382-PO-010066',
  // Added 2026-09-21: migrated GRs whose ERP row never got its AutoCount GR
  // number stamped (linked_ac_gr_docno NULL), so the first pass missed them.
  // Derived the AutoCount GR from the grn_number (HC-GR-<n>) and confirmed
  // NEVER invoiced against the same 2026-09-09 book cut. GR-005305 is the
  // DORSETTLOFT receipt the owner was stuck on (ticket 36).
  'HC-GR-005239-PO-009587',
  'HC-GR-005239-PO-009815',
  'HC-GR-005239-PO-009822',
  'HC-GR-005239-PO-009824',
  'HC-GR-005264',
  'HC-GR-005305',
]);
