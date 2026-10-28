// ----------------------------------------------------------------------------
// daily-bank-report — the Daily Bank board as ONE table model, read by the
// page, the image and the PDF alike, so the three can never disagree (owner
// 2026-09-29, his "BANK BALANCE AVAILABLE" sample: 1 By bank · 2 pending =
// checked, not yet approved · 3 show what was paid · 4 keep the totals; then
// settlement in transit 放在相对应的银行 and the line with it added).
//
// One section per money account, the Bank Balance in its header:
//   Balance B/F
//   Received today        (green)  — one line each: who, document, note
//   Paid today            (red)    — one line each: who, document, note
//   Pending payment       (orange) — the checked vouchers that pay from it
//   Available (after pending)      (green band)
//   In transit                     (grey)  — per acquirer that pays into it
//   Available + in transit
// and, when something names no bank on the board, a last section for it.
// Columns, one kind of figure each (owner 2026-09-29, 你看 paid amount 不在同一个
// column → 做): PAY TO / FROM · DOC NO. · DESCRIPTION · RECEIVED · PAYMENT (what
// was paid today AND what is pending, told apart by colour) · BALANCE (B/F,
// Available, the transit figures, Available + in transit).
// ----------------------------------------------------------------------------

import { fmtDate, fmtSen, fmtSenPlain } from '../../vendor/shared/format';
import type { DailyBankBoard } from './accounting-phase1-queries';

export type DailyBankRowKind =
  | 'bf' | 'receivedHead' | 'received' | 'paidHead' | 'paid' | 'pendingHead' | 'pending'
  | 'available' | 'transitHead' | 'transit' | 'withTransit';

export type DailyBankRow = {
  kind: DailyBankRowKind;
  /** PAY TO / FROM — a group's own words, or the party of a line. */
  who: string;
  doc: string;
  description: string;
  receivedSen: number | null;
  /** PAYMENT — a payment made today or one pending approval; the row's kind tells which. */
  paymentSen: number | null;
  /** BALANCE — Balance B/F, Available, a transit figure, Available + in transit. */
  balanceSen: number | null;
};

export type DailyBankSection = { key: string; title: string; code: string | null; bankBalanceSen: number | null; rows: DailyBankRow[] };

export const DAILY_BANK_HEAD = ['PAY TO / FROM', 'DOC NO.', 'DESCRIPTION', 'RECEIVED (RM)', 'PAYMENT (RM)', 'BALANCE (RM)'] as const;

/** A line of a group is a detail; the rest are the section's own figures. */
export const isDetailRow = (k: DailyBankRowKind): boolean => k === 'received' || k === 'paid' || k === 'pending' || k === 'transit';

const row = (kind: DailyBankRowKind, who: string, over: Partial<DailyBankRow> = {}): DailyBankRow =>
  ({ kind, who, doc: '', description: '', receivedSen: null, paymentSen: null, balanceSen: null, ...over });

export function dailyBankSections(board: DailyBankBoard): DailyBankSection[] {
  const sections: DailyBankSection[] = board.blocks.map((b) => {
    const rows: DailyBankRow[] = [row('bf', 'Balance B/F', { balanceSen: b.openingSen })];
    if (b.receipts.length > 0) {
      rows.push(row('receivedHead', 'Received today', { receivedSen: b.inSen }));
      for (const m of b.receipts) rows.push(row('received', m.party ?? '', { doc: m.docNo, description: m.note, receivedSen: m.amountSen }));
    }
    if (b.payouts.length > 0) {
      rows.push(row('paidHead', 'Paid today', { paymentSen: b.outSen }));
      for (const m of b.payouts) rows.push(row('paid', m.party ?? '', { doc: m.docNo, description: m.note, paymentSen: m.amountSen }));
    }
    if (b.pending.length > 0) {
      rows.push(row('pendingHead', 'Pending payment (checked, awaiting approval)', { paymentSen: b.pendingSen }));
      for (const p of b.pending) rows.push(row('pending', p.payee ?? '', { doc: p.pvNumber ?? '', description: p.description, paymentSen: p.amountSen }));
    }
    rows.push(row('available', 'Available (after pending)', { balanceSen: b.availableSen }));
    if (b.transit.length > 0) {
      rows.push(row('transitHead', 'In transit (swiped, not yet in this bank)', { balanceSen: b.transitSen }));
      for (const t of b.transit) rows.push(row('transit', t.acquirerCode, { doc: t.accountCode, description: t.accountName, balanceSen: t.balanceSen }));
      rows.push(row('withTransit', 'Available + in transit', { balanceSen: b.availableWithTransitSen }));
    }
    return { key: b.accountCode, title: b.accountName, code: b.accountCode, bankBalanceSen: b.closingSen, rows };
  });
  if (board.unassignedPending.length > 0 || board.unassignedTransit.length > 0) {
    const rows: DailyBankRow[] = [];
    if (board.unassignedPending.length > 0) {
      rows.push(row('pendingHead', 'Pending payment (checked, awaiting approval)', { paymentSen: board.unassignedPending.reduce((s, p) => s + p.amountSen, 0) }));
      for (const p of board.unassignedPending) rows.push(row('pending', p.payee ?? '', { doc: p.pvNumber ?? '', description: [p.accountCode, p.description].filter(Boolean).join(' · '), paymentSen: p.amountSen }));
    }
    if (board.unassignedTransit.length > 0) {
      rows.push(row('transitHead', 'In transit (no bank named for it)', { balanceSen: board.unassignedTransit.reduce((s, t) => s + t.balanceSen, 0) }));
      for (const t of board.unassignedTransit) rows.push(row('transit', t.acquirerCode, { doc: t.accountCode, description: t.accountName, balanceSen: t.balanceSen }));
    }
    sections.push({ key: 'unassigned', title: 'Not tied to a bank', code: null, bankBalanceSen: null, rows });
  }
  return sections;
}

/** The board's day as the dark bar prints it: "Tue · 2026/09/29". */
export function boardDayLabel(date: string): string {
  const d = new Date(`${date}T12:00:00`);
  /* The weekday from the platform, not a hand-typed list (one of those already lives in three calendars). */
  const day = Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB', { weekday: 'short' });
  return day ? `${day} · ${fmtDate(date)}` : fmtDate(date);
}

/** A money cell as the table prints it: plain figures, blank when there is none. */
export const cellMoney = (sen: number | null): string => (sen == null ? '' : fmtSenPlain(sen));

/** The three totals above the table, in words — the image and the PDF print them too. */
export const boardTotalsLine = (board: DailyBankBoard): string =>
  `Can actually move ${fmtSen(board.availableSen)}   ·   In transit (swiped, not yet remitted) ${fmtSen(board.totalTransitSen)}   ·   Checked, awaiting approval ${fmtSen(board.pendingApprovalSen)}`;

/* ── The colours a row wears — the sample's: received green, pending orange ── */

export const DB_COLORS = {
  ink: '#221F20', soft: '#6F6A63', green: '#2F5D4F', red: '#B8331F', orange: '#B76B00', grey: '#8A857E',
  band: '#E4F0E9', sectionBg: '#EDE8E2', bar: '#2B2320', barText: '#F6F1EA', rule: '#DDD7CF',
} as const;

export const rowColor = (k: DailyBankRowKind): string => {
  switch (k) {
    case 'receivedHead': case 'received': case 'available': return DB_COLORS.green;
    case 'paidHead': case 'paid': return DB_COLORS.red;
    case 'pendingHead': case 'pending': return DB_COLORS.orange;
    case 'transitHead': case 'transit': return DB_COLORS.grey;
    default: return DB_COLORS.ink;
  }
};

/** The BALANCE figure's colour: a negative balance reads red; a transit figure grey; the rest ink, the available green. */
export const balanceColor = (r: DailyBankRow): string => {
  if ((r.kind === 'bf' || r.kind === 'available' || r.kind === 'withTransit') && (r.balanceSen ?? 0) < 0) return DB_COLORS.red;
  return rowColor(r.kind);
};

/* ── The PNG the owner sends to WhatsApp — drawn, not captured ─────────────── */

/** The board drawn onto a canvas as the table: the totals, the dark bar, a section per bank. */
export function drawDailyBankCanvas(board: DailyBankBoard): HTMLCanvasElement {
  const sections = dailyBankSections(board);
  const W = 980;
  const P = 24;
  const rowH = 24;
  /* Column right edges / left edges, the table's six. */
  const X = { who: P + 8, doc: P + 210, desc: P + 360, rec: W - P - 250, pay: W - P - 130, bal: W - P - 8 };
  const rowsCount = sections.reduce((s, sec) => s + sec.rows.length + 2, 0);
  const H = P * 2 + 60 + 40 + rowsCount * rowH + 40;
  const canvas = document.createElement('canvas');
  const scale = 2; // crisp on phone screens
  canvas.width = W * scale;
  canvas.height = H * scale;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  ctx.scale(scale, scale);
  ctx.fillStyle = '#FBF8F3';
  ctx.fillRect(0, 0, W, H);

  const font = (size: number, bold = false, mono = false) => `${bold ? '700' : '400'} ${size}px ${mono ? 'ui-monospace, Menlo, monospace' : 'system-ui, sans-serif'}`;
  const text = (t: string, x: number, y: number, o: { size?: number; bold?: boolean; color?: string; right?: boolean; mono?: boolean; maxW?: number } = {}) => {
    ctx.font = font(o.size ?? 12.5, o.bold, o.mono);
    ctx.fillStyle = o.color ?? DB_COLORS.ink;
    ctx.textAlign = o.right ? 'right' : 'left';
    let s = t;
    if (o.maxW && ctx.measureText(s).width > o.maxW) {
      while (s.length > 1 && ctx.measureText(`${s}…`).width > o.maxW) s = s.slice(0, -1);
      s = `${s}…`;
    }
    ctx.fillText(s, x, y);
  };

  let y = P + 14;
  text(boardTotalsLine(board), P, y, { size: 13, bold: true, color: DB_COLORS.green });
  y += 22;
  ctx.fillStyle = DB_COLORS.bar;
  ctx.fillRect(P, y, W - 2 * P, 34);
  text('BANK BALANCE AVAILABLE', P + 14, y + 22, { size: 14, bold: true, color: DB_COLORS.barText });
  text(boardDayLabel(board.date), W - P - 14, y + 22, { size: 12.5, bold: true, color: DB_COLORS.barText, right: true });
  y += 34;

  for (const sec of sections) {
    ctx.fillStyle = DB_COLORS.sectionBg;
    ctx.fillRect(P, y, W - 2 * P, rowH);
    text(sec.code ? `${sec.title}  ·  ${sec.code}` : sec.title, X.who, y + 16, { size: 13, bold: true });
    if (sec.bankBalanceSen != null) {
      text(`Bank Balance  ${fmtSenPlain(sec.bankBalanceSen)}`, X.bal, y + 16, { size: 13, bold: true, mono: true, right: true, color: sec.bankBalanceSen < 0 ? DB_COLORS.red : DB_COLORS.ink });
    }
    y += rowH;
    const heads = DAILY_BANK_HEAD;
    text(heads[0], X.who, y + 16, { size: 10, bold: true, color: DB_COLORS.soft });
    text(heads[1], X.doc, y + 16, { size: 10, bold: true, color: DB_COLORS.soft });
    text(heads[2], X.desc, y + 16, { size: 10, bold: true, color: DB_COLORS.soft });
    text(heads[3], X.rec, y + 16, { size: 10, bold: true, color: DB_COLORS.soft, right: true });
    text(heads[4], X.pay, y + 16, { size: 10, bold: true, color: DB_COLORS.soft, right: true });
    text(heads[5], X.bal, y + 16, { size: 10, bold: true, color: DB_COLORS.soft, right: true });
    y += rowH;
    for (const r of sec.rows) {
      if (r.kind === 'available') { ctx.fillStyle = DB_COLORS.band; ctx.fillRect(P, y, W - 2 * P, rowH); }
      const color = rowColor(r.kind);
      const detail = isDetailRow(r.kind);
      const strong = r.kind === 'available' || r.kind === 'withTransit';
      /* A group's own words run across the empty number and description columns; a line's party keeps to its column. */
      text(detail ? `· ${r.who}` : r.who, detail ? X.who + 8 : X.who, y + 16, { size: 12, bold: strong, color, maxW: detail ? X.doc - X.who - 12 : X.rec - X.who - 110 });
      if (r.doc) text(r.doc, X.doc, y + 16, { size: 10.5, color: DB_COLORS.soft, mono: true, maxW: X.desc - X.doc - 8 });
      if (r.description) text(r.description, X.desc, y + 16, { size: 11.5, color: detail ? DB_COLORS.soft : color, maxW: X.rec - X.desc - 110 });
      if (r.receivedSen != null) text(cellMoney(r.receivedSen), X.rec, y + 16, { size: 12, mono: true, color: DB_COLORS.green, bold: r.kind === 'receivedHead', right: true });
      if (r.paymentSen != null) text(cellMoney(r.paymentSen), X.pay, y + 16, { size: 12, mono: true, color, bold: r.kind === 'paidHead' || r.kind === 'pendingHead', right: true });
      if (r.balanceSen != null) text(cellMoney(r.balanceSen), X.bal, y + 16, { size: 12, mono: true, color: balanceColor(r), bold: strong || r.kind === 'bf' || r.kind === 'transitHead', right: true });
      ctx.fillStyle = DB_COLORS.rule;
      ctx.fillRect(P, y + rowH - 1, W - 2 * P, 1);
      y += rowH;
    }
    y += 6;
  }
  text('Live from the ledger — posted entries only. Pending = checked vouchers awaiting approval; transit money is shown, never counted as movable.', P, y + 18, { size: 10.5, color: DB_COLORS.soft });
  return canvas;
}
