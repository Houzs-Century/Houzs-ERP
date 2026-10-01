// ----------------------------------------------------------------------------
// official-doc.ts — a payment made on a proforma or a quotation owes its
// official invoice (owner 2026-10-01, payment-request item 3 → 做: 他们有时是给
// proforma invoice, 这样我要 follow up 回 original 单, 所以我有一个 list 看到这些要
// follow up 的, 然后谁 submit 的也会看到自己还没给正式单的).
//
// FINANCE marks it — never the requester (我不需要申请人选太多): a tick on the
// voucher or AP invoice, pre-ticked when the bill reader read PROFORMA or
// QUOTATION. The state lives on the paying document itself, so a voucher Finance
// made without any request owes the same way:
//   OWED      marked — the official invoice is still to come
//   RECEIVED  it came (the requester's upload, copied here) — Finance checks it
//   CHECKED   Finance checked it; it leaves the list
// The ledger is never touched: the money was paid; a different amount on the
// official invoice is Finance's own next move (pay the rest, or get it back).
// ----------------------------------------------------------------------------

type Row = Record<string, any>;

export type OfficialState = 'OWED' | 'RECEIVED' | 'CHECKED';
export const OFFICIAL_STATES: readonly OfficialState[] = ['OWED', 'RECEIVED', 'CHECKED'];
export const isOfficialState = (v: unknown): v is OfficialState => typeof v === 'string' && (OFFICIAL_STATES as readonly string[]).includes(v);

/** The paying documents that can owe one, by the kind the routes name. */
export const OFFICIAL_DOC_TABLES = {
  PV: { table: 'payment_vouchers', number: 'pv_number', entityType: 'PAYMENT_VOUCHER' },
  /* AP invoices keep no entity trail (their module never had one); the row's
     official_doc_at / official_doc_by say who changed it last. */
  API: { table: 'ap_invoices', number: 'invoice_number', entityType: null },
} as const;
export type OfficialDocKind = keyof typeof OFFICIAL_DOC_TABLES;
export const isOfficialDocKind = (v: unknown): v is OfficialDocKind => v === 'PV' || v === 'API';

/** Who made the change, as the audit names people. */
export const officialActor = (c: any): string | null => {
  const u = c.get('houzsUser') as { name?: string | null; email?: string | null } | undefined;
  return u?.name ?? u?.email ?? null;
};

/** What a create door stamps when Finance ticks 欠正式单. */
export function officialOwedFields(body: Row, who: string | null): Row {
  if (body.officialDocOwed !== true) return {};
  return { official_doc: 'OWED', official_doc_at: new Date().toISOString(), official_doc_by: who };
}

/** A draft's edit: the tick put on, or taken off while nothing has come yet. */
export function officialOwedUpdates(body: Row, who: string | null, before: Row): Row {
  if (body.officialDocOwed === true && !before.official_doc) {
    return { official_doc: 'OWED', official_doc_at: new Date().toISOString(), official_doc_by: who };
  }
  if (body.officialDocOwed === false && before.official_doc === 'OWED') {
    return { official_doc: null, official_doc_note: null, official_doc_at: new Date().toISOString(), official_doc_by: who };
  }
  return {};
}

/** Does the reader's document kind say the bill is not yet the real one? */
export const isProvisionalKind = (kind: unknown): boolean => kind === 'proforma' || kind === 'quotation';

/* Letters and digits, upper case — "INV-0012" and "inv 0012" are one number. */
const fold = (s: unknown): string => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, '');

const rm = (sen: number): string => `RM ${(sen / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** What the reader read off the official invoice against the proforma it
    follows — said, for Finance to check; null when nothing stands out. */
export function compareOfficial(
  official: { invoiceNumber: string | null; totalSen: number | null } | null,
  proforma: { billNo: string | null; totalSen: number | null },
): string | null {
  if (!official) return null;
  const notes: string[] = [];
  if (official.totalSen != null && proforma.totalSen != null && official.totalSen !== proforma.totalSen) {
    const diff = official.totalSen - proforma.totalSen;
    notes.push(`The official invoice reads ${rm(official.totalSen)}; the proforma read ${rm(proforma.totalSen)} (${diff > 0 ? 'more' : 'less'} by ${rm(Math.abs(diff))}).`);
  }
  if (official.invoiceNumber && proforma.billNo && fold(official.invoiceNumber) === fold(proforma.billNo)) {
    notes.push(`It carries the proforma's own number (${official.invoiceNumber}) — check it is the official invoice.`);
  }
  return notes.length > 0 ? notes.join(' ') : null;
}
