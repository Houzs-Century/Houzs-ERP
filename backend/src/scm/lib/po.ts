// PO helpers — pure functions for shape validation + print template rendering.
// Database-touching validation (lane state, !po_issued) lives in the route handler
// since it requires Supabase client. This file is for pure logic + tests.

import { fmtDate } from '../shared/format';

export interface PoLineItem {
  order_id: string;
  sku: string;
  name: string;
  size: string | null;
  colour: string | null;
  qty: number;
}

export type ValidationResult = { ok: true } | { ok: false; error: string };

export function validatePoLineItemsShape(items: unknown): ValidationResult {
  if (!Array.isArray(items)) return { ok: false, error: 'not_an_array' };
  if (items.length === 0) return { ok: false, error: 'empty_line_items' };

  for (const it of items) {
    if (!it || typeof it !== 'object') return { ok: false, error: 'invalid_item' };
    const item = it as Record<string, unknown>;
    if (typeof item.order_id !== 'string' || item.order_id.length === 0) {
      return { ok: false, error: 'missing_order_id' };
    }
    if (typeof item.sku !== 'string' || item.sku.length === 0) {
      return { ok: false, error: 'missing_sku' };
    }
    if (typeof item.name !== 'string' || item.name.length === 0) {
      return { ok: false, error: 'missing_name' };
    }
    if (typeof item.qty !== 'number' || item.qty <= 0 || !Number.isInteger(item.qty)) {
      return { ok: false, error: 'invalid_qty' };
    }
  }
  return { ok: true };
}

// HTML escape for the print template
function esc(s: string | null | undefined): string {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface PoPrintInput {
  po: { id: string; po_number: string; created_at: string };
  supplier: { code: string; name: string; whatsapp_number: string | null; email: string | null };
  lines: { sku: string; name: string; size: string | null; colour: string | null; qty: number }[];
  coordinator: { name: string };
  sourceOrderIds: string[];
  showroom: { name: string; address: string };
}

export function renderPoPrintHtml(input: PoPrintInput): string {
  const { po, supplier, lines, coordinator, sourceOrderIds, showroom } = input;
  const issuedDate = fmtDate(po.created_at);

  const linesHtml = lines.map((l) => `
    <tr>
      <td><code>${esc(l.sku)}</code></td>
      <td>${esc(l.name)}</td>
      <td>${esc(l.size) || '—'}</td>
      <td>${esc(l.colour) || '—'}</td>
      <td class="r">×${l.qty}</td>
    </tr>
  `).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(po.po_number)} — ${esc(supplier.name)}</title>
<style>
  :root { --c-ink: #221F20; --c-line: #DCD3C4; --c-cream: #FAF6EE; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font: 14px/1.55 'Crimson Text', 'Georgia', serif;
    color: var(--c-ink);
    background: white;
    padding: 40px 48px;
    max-width: 720px;
    margin: 0 auto;
  }
  h1 { font-size: 22px; font-weight: 600; }
  h2 { font-size: 13px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; color: #6B6157; margin-bottom: 6px; }
  .head { display: flex; justify-content: space-between; align-items: baseline; padding-bottom: 18px; border-bottom: 1px solid var(--c-line); margin-bottom: 24px; }
  .meta { text-align: right; font-size: 13px; color: #6B6157; }
  .meta strong { display: block; font-size: 16px; color: var(--c-ink); }
  .parties { display: grid; grid-template-columns: 1fr 1fr; gap: 32px; margin-bottom: 24px; }
  .party p { margin: 2px 0; }
  table { width: 100%; border-collapse: collapse; margin: 24px 0; font-size: 13px; }
  th, td { padding: 8px 6px; text-align: left; border-bottom: 1px solid var(--c-line); }
  th { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #6B6157; font-weight: 600; }
  .r { text-align: right; }
  code { font: 12px/1 ui-monospace, monospace; background: var(--c-cream); padding: 2px 6px; border-radius: 3px; }
  .sources { font-size: 13px; color: #6B6157; margin: 16px 0; }
  .sig { display: flex; justify-content: space-between; align-items: baseline; margin-top: 32px; padding-top: 16px; border-top: 1px solid var(--c-line); font-size: 13px; }
  .footer { margin-top: 48px; text-align: center; font-size: 12px; color: #6B6157; font-style: italic; }
  @media print {
    body { padding: 24px; max-width: none; }
    @page { size: A4; margin: 18mm; }
  }
</style>
</head>
<body>
  <div class="head">
    <h1>2990&apos;s</h1>
    <div class="meta">
      <strong>${esc(po.po_number)}</strong>
      ${esc(issuedDate)}
    </div>
  </div>

  <div class="parties">
    <div class="party">
      <h2>To</h2>
      <p><strong>${esc(supplier.name)}</strong></p>
      <p>Code: ${esc(supplier.code)}</p>
      ${supplier.whatsapp_number ? `<p>WhatsApp: ${esc(supplier.whatsapp_number)}</p>` : ''}
      ${supplier.email ? `<p>Email: ${esc(supplier.email)}</p>` : ''}
    </div>
    <div class="party">
      <h2>From</h2>
      <p><strong>HOUZS Venture Sdn Bhd</strong></p>
      <p>${esc(showroom.name)}</p>
      <p>${esc(showroom.address)}</p>
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th>SKU</th>
        <th>Item</th>
        <th>Size</th>
        <th>Colour</th>
        <th class="r">Qty</th>
      </tr>
    </thead>
    <tbody>${linesHtml}</tbody>
  </table>

  <div class="sources">Source orders: ${sourceOrderIds.map(esc).join(', ')}</div>

  <div class="sig">
    <span>Coordinator: <strong>${esc(coordinator.name)}</strong></span>
    <span>Issued: ${esc(issuedDate)}</span>
  </div>

  <div class="footer">2990&apos;s — Same price. Every piece. Always.</div>
</body>
</html>`;
}
