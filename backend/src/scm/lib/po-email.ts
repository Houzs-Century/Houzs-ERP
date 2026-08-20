// Purchase Order -> supplier email: the pure half.
//
// Split out of routes/mfg-purchase-orders.ts for the same reason do-email.ts is
// split out of the DO route — the message builder and the attachment check are
// pure functions of their inputs, so they can be tested without a PostgREST
// client. The claim/stamp/audit glue stays in the route, where the supabase
// client and the caller identity live.
//
// THIS CHANNEL SENDS TO AN EXTERNAL PARTY. Everything here is written on the
// assumption that a mistake reaches a real supplier's inbox and cannot be
// recalled, so each guard below states what it is protecting against.

import { documentEmailHtml } from '../../services/email';
import { fmtDate } from '../shared/format';

/* Attachment cap. Resend's own documented limit is 40 MB across the whole
   message, but the number that matters is smaller and comes from HOOKKA:
   BUG-2026-06-11-015 — its first real customer send claimed "please find
   attached" and arrived with nothing, because the oversize PDF was dropped at
   enqueue AFTER the body had already been rendered. HOOKKA settled on 5 MB
   (PDF_ATTACH_CAP_BYTES) and Houzs matches it deliberately: a PO PDF that
   exceeds 5 MB is a rendering fault, not a big order.

   Houzs's body never promises an attachment (documentEmailHtml inlines the
   summary), so an oversize PDF cannot produce HOOKKA's exact lie. It is still
   REJECTED rather than silently dropped: a supplier who receives a summary
   without the order document has to ask for it, and the operator who pressed
   Send would never learn that the PDF went missing. Loud beats quiet when the
   recipient is external. */
export const PO_ATTACHMENT_CAP_BYTES = 5 * 1024 * 1024;

/* A base64 payload below this is not a PDF — it is a truncated upload or an
   empty string that stringified. Rejecting it stops a 0-byte "PO.pdf" landing
   in a supplier's inbox looking like a corrupt order. The smallest structurally
   valid PDF is a few hundred bytes; 1 KB is comfortably under any real PO. */
export const PO_ATTACHMENT_MIN_BYTES = 1024;

/* Decoded size WITHOUT decoding — base64 is 4 characters per 3 bytes, minus the
   padding. Copied in intent from HOOKKA's base64DecodedBytes: allocating a
   multi-megabyte buffer just to measure it is how a size check becomes the
   memory problem it was added to prevent (HOOKKA's outbox batch pulled bodies
   plus base64 PDFs in one result set and blew up). */
export function base64DecodedBytes(b64: string): number {
  const clean = b64.replace(/\s/g, '');
  if (clean.length === 0) return 0;
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  return Math.floor((clean.length * 3) / 4) - padding;
}

export type PoAttachmentCheck =
  | { ok: true; attachment: { filename: string; content: string } | null }
  | { ok: false; message: string };

/**
 * Validate the frontend-rendered PDF before it becomes an outbound attachment.
 *
 * ABSENT is legal and returns `{ ok: true, attachment: null }` — a summary-only
 * PO email is a deliberate fallback (the PDF is rendered in the BROWSER because
 * the owner bars a backend PDF engine, so a render failure must not also block
 * the send). PRESENT BUT WRONG is rejected with a plain-language message: an
 * attachment the operator believes was sent is worse than one they were told
 * about.
 */
export function validatePoAttachment(pdfBase64: unknown, poNo: string): PoAttachmentCheck {
  if (pdfBase64 === undefined || pdfBase64 === null) return { ok: true, attachment: null };
  if (typeof pdfBase64 !== 'string') {
    return { ok: false, message: 'The attached PO document could not be read. Try Print PDF first, then send again.' };
  }
  const content = pdfBase64.trim();
  if (content.length === 0) return { ok: true, attachment: null };

  /* Character-set check before the size check: a non-base64 body (an error page,
     a data: URL the caller forgot to strip) would otherwise pass the byte maths
     and be handed to Resend, which rejects the whole message — turning a bad
     attachment into a failed send with a provider error nobody can read. */
  if (!/^[A-Za-z0-9+/=\s]+$/.test(content)) {
    return { ok: false, message: 'The attached PO document is not a valid PDF. Try Print PDF first, then send again.' };
  }

  const bytes = base64DecodedBytes(content);
  if (bytes < PO_ATTACHMENT_MIN_BYTES) {
    return { ok: false, message: 'The attached PO document is empty or incomplete. Try Print PDF first, then send again.' };
  }
  if (bytes > PO_ATTACHMENT_CAP_BYTES) {
    const mb = (bytes / (1024 * 1024)).toFixed(1);
    return {
      ok: false,
      message: `The PO document is too large to email (${mb} MB, limit 5 MB). Print it and send it to the supplier by hand.`,
    };
  }
  return { ok: true, attachment: { filename: `${poNo}.pdf`, content } };
}

/* Recipient shape check. sendEmail only tests for an "@", which passes strings
   no mail server will accept ("@", "a@b", "name <a@b.com>"). This is the last
   point before an external send, so the address is checked properly here: a
   malformed supplier address costs a provider error and an operator who thinks
   the PO went out. Deliberately permissive on the domain (no TLD allowlist) —
   this rejects nonsense, it does not adjudicate real domains. */
const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

export function isSendableEmail(addr: string | null | undefined): boolean {
  return EMAIL_RE.test((addr ?? '').trim());
}

export interface PoEmailRow {
  id: string;
  po_number: string | null;
  status: string | null;
  total_sen: number | null;
  currency: string | null;
  po_date: string | null;
  supplier?: { name?: string | null; email?: string | null } | null;
}

/**
 * Build the supplier-facing PO email. Returns null when there is no usable
 * recipient — the caller turns that into a refusal, NOT a silent skip: unlike a
 * customer with no email on file (an ordinary state; the goods still ship), a
 * supplier who is never told about a PO simply never delivers it.
 */
export function buildPurchaseOrderEmail(
  row: PoEmailRow,
  companyName: string,
  note?: string | null,
): { to: string; subject: string; html: string } | null {
  const to = (row.supplier?.email ?? '').trim();
  if (!isSendableEmail(to)) return null;

  const docNo = row.po_number ?? row.id;
  const total = (Number(row.total_sen ?? 0) / 100).toFixed(2);
  const currency = row.currency ?? 'MYR';

  return {
    to,
    subject: `${companyName} — Purchase Order ${docNo}`,
    /* documentEmailHtml escapes every interpolated value (supplier names carry
       apostrophes, ampersands and Chinese characters) and inlines the summary,
       so the email is readable even when the PDF is missing or the supplier's
       client blocks attachments. */
    html: documentEmailHtml({
      docTypeLabel: 'Purchase Order',
      docNo,
      recipientName: row.supplier?.name ?? 'Supplier',
      rows: [
        { label: 'PO No.', value: docNo },
        { label: 'Date', value: fmtDate(row.po_date) },
        { label: 'Total', value: `${currency} ${total}` },
      ],
      companyName,
      note: note && note.trim() ? note.trim() : null,
    }),
  };
}

/* Statuses a PO may be emailed in.

   DRAFT is barred because the order is not committed — the Procurement agent
   raises DRAFTs, and sending one would put an unapproved order in front of a
   supplier who may act on it.

   CANCELLED is barred for the sharper reason: emailing a cancelled PO tells a
   supplier to ship goods the company has already decided not to buy. The
   frontend hides the button in both states, but the button is not the gate —
   the API is reachable directly and the reopen/cancel flow can change the
   status between the page load and the click. */
const SENDABLE_PO_STATUSES: ReadonlySet<string> = new Set([
  'SUBMITTED',
  'PARTIALLY_RECEIVED',
  'RECEIVED',
]);

export function poSendRefusalForStatus(status: string | null | undefined): string | null {
  const s = String(status ?? '').toUpperCase();
  if (s === 'DRAFT') return 'Confirm the PO before sending it to the supplier.';
  if (s === 'CANCELLED') return 'This PO is cancelled. Reopen it before sending it to the supplier.';
  if (!SENDABLE_PO_STATUSES.has(s)) return `A PO in ${s || 'this'} status cannot be emailed to a supplier.`;
  return null;
}

/* The accidental-double-click window.

   The send is deliberately NOT once-only. HOOKKA learned the opposite lesson
   the hard way (BUG-2026-06-24-003): its DO notice was one-shot by design, and
   when a customer lost the mail there was no way to re-send it — a resend
   endpoint had to be retrofitted. A supplier legitimately needs a second copy
   (mail lost, wrong contact, PO amended), so re-sending stays a normal action.

   What is guarded is the accident: two clicks, or a click plus a retry, landing
   within a minute. After the window a resend just works, and every send appends
   its own audit row, so the stamp is "last sent" and entity_audit_log is the
   full history. */
export const PO_RESEND_WINDOW_MS = 60_000;
