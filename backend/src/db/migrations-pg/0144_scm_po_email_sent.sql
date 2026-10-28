-- 0144_scm_po_email_sent.sql — the PO supplier-email SENT STAMP.
--
-- WHAT IT IS FOR. POST /mfg-purchase-orders/:id/send-to-supplier had no record
-- of having sent anything, so two clicks sent two POs to the supplier and
-- nothing anywhere answered "was this PO ever emailed, and to what address".
-- These two columns are the atomic claim that stops the double AND the answer to
-- the question.
--
-- WHY TWO COLUMNS. po_email_sent_at alone cannot detect the case that actually
-- costs money: the supplier's address was corrected AFTER the PO went out, so
-- the stamp says "emailed" while the address on the supplier record is not the
-- one that received it. po_email_sent_to records the address the mail actually
-- went to, which is a different fact from the address the supplier has today.
--
-- NOT A ONCE-ONLY LOCK. The route claims on "never sent OR last sent more than
-- PO_RESEND_WINDOW_MS ago" (scm/lib/po-email.ts), so a deliberate resend is a
-- normal action and only the accidental double is refused. HOOKKA shipped the
-- opposite — a one-shot customer notice — and had to retrofit a resend endpoint
-- when a customer lost the mail (its BUG-2026-06-24-003). The full history is in
-- scm.entity_audit_log, one append-only row per send attempt; this column is
-- only ever "last successful send".
--
-- TEXT, NOT timestamptz — the text-timestamp rule mig 0008 established for this
-- schema, and it is what the route writes (toISOString). The claim compares the
-- column against an ISO string with `<`; every value is written by the same
-- toISOString call, so all are same-length UTC 'Z' strings and lexical order is
-- chronological order.
--
-- Houzs SCM port conventions (mirrors 0122): scm.* lives in the separate `scm`
-- postgres schema, so this is schema-qualified. Plain ADD COLUMN IF NOT EXISTS,
-- NOT a DO block — the pg-migrate runner splits each file on ";\n", which would
-- fragment a dollar-quoted block. Idempotent, so the auto-apply on every deploy
-- is a no-op after the first. scm.purchase_orders exists on prod (core SCM
-- table), so this only ever adds two nullable columns.
--
-- NO BACKFILL. NULL means "not yet emailed", which is true of every existing row:
-- the purchase_order channel has been OFF since it was seeded (mig 0132), so no
-- PO has ever been emailed from this system.

SET search_path = public, scm;

ALTER TABLE scm.purchase_orders ADD COLUMN IF NOT EXISTS po_email_sent_at text;
ALTER TABLE scm.purchase_orders ADD COLUMN IF NOT EXISTS po_email_sent_to text;
