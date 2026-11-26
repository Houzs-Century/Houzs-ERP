
import { documentEmailHtml } from '../../services/email';
import { fmtDate } from '../shared/format';
import { isValidEmailAddress, resolvePoRecipients } from '../shared/supplier-emails';

export const PO_ATTACHMENT_CAP_BYTES = 5 * 1024 * 1024;

export const PO_ATTACHMENT_MIN_BYTES = 1024;

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

export function isSendableEmail(addr: string | null | undefined): boolean {
  return isValidEmailAddress(addr);
}

export function poReplyTo(sender: { email?: string | null } | null | undefined): string | null {
  const addr = sender?.email?.trim() ?? '';
  return isSendableEmail(addr) ? addr : null;
}

export interface PoEmailRow {
  id: string;
  po_number: string | null;
  revision: number | string | null;
  status: string | null;
  total_sen: number | null;
  currency: string | null;
  po_date: string | null;
  supplier?: { name?: string | null; email?: string | null; email2?: string | null; email3?: string | null } | null;
}

export function poEmailDocNo(row: Pick<PoEmailRow, 'id' | 'po_number' | 'revision'>): string {
  const base = row.po_number ?? row.id;
  const rev = Number(row.revision ?? 1);
  return Number.isFinite(rev) && rev > 1 ? `${base}_R${rev - 1}` : base;
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
): { to: string; cc: string[]; subject: string; html: string } | null {
  /* To = Email, Cc = Email 2 / Email 3 (owner 2026-11-09) — the rule is
     shared/supplier-emails.ts, which the PO page's confirm also reads. */
  const recipients = resolvePoRecipients(row.supplier);
  if (!recipients.ok) return null;
  const { to, cc } = recipients;

  const docNo = poEmailDocNo(row);
  const total = (Number(row.total_sen ?? 0) / 100).toFixed(2);
  const currency = row.currency ?? 'MYR';

  return {
    to,
    cc,
    subject: `${companyName} — Purchase Order ${docNo}`,
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

export const PO_RESEND_WINDOW_MS = 60_000;
