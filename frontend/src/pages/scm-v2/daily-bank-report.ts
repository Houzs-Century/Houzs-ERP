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

import { fmtDate, fmtSen, fmtSenPlain } from '../../../../shared/src/vendor/shared/format';
import type { DailyBankBoard } from './accounting-phase1-queries';

export type DailyBankRowKind =
  | 'bf' | 'receivedHead' | 'received' | 'paidHead' | 'paid' | 'pendingHead' | 'pending'
  | 'available' | 'transitHead' | 'transit' | 'withTransit';

export type DailyBankRow = {
  kind: DailyBankRowKind;
  who: string;
  doc: string;
  description: string;
  receivedSen: number | null;
  paymentSen: number | null;
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
  const day = Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB', { weekday: 'short' });
  return day ? `${day} · ${fmtDate(date)}` : fmtDate(date);
}

/** A money cell as the table prints it: plain figures, blank when there is none. */
export const cellMoney = (sen: number | null): string => (sen == null ? '' : fmtSenPlain(sen));

/** Where the figures come from, under the picture: the ledger on the original
    board; on the owner's cash book (2026-11-23), his starts, receipts and the
    approved vouchers. */
export const boardSourceLine = (board: DailyBankBoard): string => (board.book === 'cashbook'
  ? 'Cash book: each bank from its starting balance + receipts typed − approved vouchers. Pending = checked, awaiting approval; transit shown, never counted as movable.'
  : 'Live from the ledger — posted entries only. Pending = checked vouchers awaiting approval; transit money is shown, never counted as movable.');

/** The three totals above the table, in words — the image and the PDF print them too. */
export const boardTotalsLine = (board: DailyBankBoard): string =>
  `Can actually move ${fmtSen(board.availableSen)}   ·   In transit (swiped, not yet remitted) ${fmtSen(board.totalTransitSen)}   ·   Checked, awaiting approval ${fmtSen(board.pendingApprovalSen)}`;


/* On white, its greys neutral (owner 2026-11-25: 要白色 background，看起来还是米色): the warm
   greys of the bank rows, the lines and the dark bar read as beige. */
export const DB_COLORS = {
  ink: '#202124', soft: '#5F6368', green: '#2F5D4F', red: '#B8331F', orange: '#B76B00', grey: '#80868B',
  band: '#E4F0E9', sectionBg: '#F1F3F4', bar: '#202124', barText: '#FFFFFF', rule: '#E0E3E7',
  /* The cash book's picture draws its lines to be seen (owner 2026-11-23: 线条). */
  line: '#BDC1C6',
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


const isQuietSection = (sec: DailyBankSection): boolean =>
  sec.code !== null && sec.rows.every((r) => r.kind === 'bf' || r.kind === 'available');

/** What a quiet bank's one line says between its name and its balance. */
export const QUIET_BANK_NOTE = 'No movement today · nothing pending';

/** The board drawn onto a canvas as the table: the totals, the dark bar, a section per bank.
    Owner 2026-11-25 (这个0 不要有dash，然后可以优化一下): every word and figure in the page's
    sans, whose 0 has no stroke through it; a party or description too long for its column
    wraps onto a second line; a quiet bank is one line. */
export function drawDailyBankCanvas(board: DailyBankBoard): HTMLCanvasElement {
  const sections = dailyBankSections(board);
  const W = 980;
  const P = 24;
  const rowH = 24;
  const lineH = 14;
  const X = { who: P + 8, doc: P + 236, desc: P + 360, rec: W - P - 250, pay: W - P - 130, bal: W - P - 8 };
  const whoW = X.doc - X.who - 24;
  const descW = X.rec - X.desc - 100;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  const font = (size: number, bold = false) => `${bold ? '700' : '400'} ${size}px 'IBM Plex Sans', system-ui, sans-serif`;
  const fit = (s: string, maxW: number): string => {
    if (ctx.measureText(s).width <= maxW) return s;
    let cut = s;
    while (cut.length > 1 && ctx.measureText(`${cut}…`).width > maxW) cut = cut.slice(0, -1);
    return `${cut}…`;
  };
  const wrap = (t: string, maxW: number, size: number): string[] => {
    ctx.font = font(size);
    if (ctx.measureText(t).width <= maxW) return [t];
    const words = t.split(' ');
    let first = '';
    let n = 0;
    for (const w of words) {
      const next = first ? `${first} ${w}` : w;
      if (ctx.measureText(next).width > maxW) break;
      first = next;
      n += 1;
    }
    const rest = words.slice(n).join(' ');
    if (n === 0) return [fit(t, maxW)];
    return rest ? [first, fit(rest, maxW)] : [first];
  };
  const text = (t: string, x: number, y: number, o: { size?: number; bold?: boolean; color?: string; right?: boolean; maxW?: number } = {}) => {
    ctx.font = font(o.size ?? 12.5, o.bold);
    ctx.fillStyle = o.color ?? DB_COLORS.ink;
    ctx.textAlign = o.right ? 'right' : 'left';
    ctx.fillText(o.maxW ? fit(t, o.maxW) : t, x, y);
  };

  const laid = sections.map((sec) => ({
    sec,
    quiet: isQuietSection(sec),
    rows: sec.rows.map((r) => {
      const detail = isDetailRow(r.kind);
      const who = detail && r.who ? wrap(r.who, whoW, 12) : [r.who];
      const desc = detail && r.description ? wrap(r.description, descW, 11.5) : [r.description];
      return { r, who, desc, h: rowH + (Math.max(who.length, desc.length) - 1) * lineH };
    }),
  }));
  const body = laid.reduce((s, l) => s + (l.quiet ? rowH : 2 * rowH + l.rows.reduce((t, x) => t + x.h, 0)) + 6, 0);
  const H = P + 70 + body + 24 + P;
  const scale = 2;
  canvas.width = W * scale;
  canvas.height = H * scale;
  ctx.scale(scale, scale);
  ctx.fillStyle = '#FFFFFF'; // owner 2026-11-25: background 颜色可以换成白色
  ctx.fillRect(0, 0, W, H);

  let y = P + 14;
  text(boardTotalsLine(board), P, y, { size: 13, bold: true, color: DB_COLORS.green });
  y += 22;
  ctx.fillStyle = DB_COLORS.bar;
  ctx.fillRect(P, y, W - 2 * P, 34);
  text(board.book === 'cashbook' ? 'BANK BALANCE AVAILABLE · CASH BOOK' : 'BANK BALANCE AVAILABLE', P + 14, y + 22, { size: 14, bold: true, color: DB_COLORS.barText });
  text(boardDayLabel(board.date), W - P - 14, y + 22, { size: 12.5, bold: true, color: DB_COLORS.barText, right: true });
  y += 34;

  /* The cash book's picture is ruled: a line under the headings and under every
     row, and a frame round each bank (owner 2026-11-23: 线条). The original keeps
     its faint rules. */
  const ruled = board.book === 'cashbook';
  const lineUnder = (at: number, h: number) => {
    ctx.fillStyle = ruled ? DB_COLORS.line : DB_COLORS.rule;
    ctx.fillRect(P, at + h - 1, W - 2 * P, 1);
  };
  for (const { sec, quiet, rows } of laid) {
    const top = y;
    ctx.fillStyle = DB_COLORS.sectionBg;
    ctx.fillRect(P, y, W - 2 * P, rowH);
    text(sec.code ? `${sec.title}  ·  ${sec.code}` : sec.title, X.who, y + 16, { size: 13, bold: true });
    if (sec.bankBalanceSen != null) {
      const balance = `Bank Balance  ${fmtSenPlain(sec.bankBalanceSen)}`;
      text(balance, X.bal, y + 16, { size: 13, bold: true, right: true, color: sec.bankBalanceSen < 0 ? DB_COLORS.red : DB_COLORS.ink });
      if (quiet) text(QUIET_BANK_NOTE, X.bal - ctx.measureText(balance).width - 24, y + 16, { size: 11.5, color: DB_COLORS.soft, right: true });
    }
    y += rowH;
    if (!quiet) {
      const heads = DAILY_BANK_HEAD;
      text(heads[0], X.who, y + 16, { size: 10, bold: true, color: DB_COLORS.soft });
      text(heads[1], X.doc, y + 16, { size: 10, bold: true, color: DB_COLORS.soft });
      text(heads[2], X.desc, y + 16, { size: 10, bold: true, color: DB_COLORS.soft });
      text(heads[3], X.rec, y + 16, { size: 10, bold: true, color: DB_COLORS.soft, right: true });
      text(heads[4], X.pay, y + 16, { size: 10, bold: true, color: DB_COLORS.soft, right: true });
      text(heads[5], X.bal, y + 16, { size: 10, bold: true, color: DB_COLORS.soft, right: true });
      if (ruled) lineUnder(y, rowH);
      y += rowH;
    }
    for (const { r, who, desc, h } of quiet ? [] : rows) {
      if (r.kind === 'available') { ctx.fillStyle = DB_COLORS.band; ctx.fillRect(P, y, W - 2 * P, h); }
      const color = rowColor(r.kind);
      const detail = isDetailRow(r.kind);
      const strong = r.kind === 'available' || r.kind === 'withTransit';
      if (detail) who.forEach((line, i) => { if (line) text(i === 0 ? `· ${line}` : line, X.who + (i === 0 ? 8 : 17), y + 16 + i * lineH, { size: 12, color }); });
      else text(r.who, X.who, y + 16, { size: 12, bold: strong, color, maxW: X.rec - X.who - 110 });
      if (r.doc) text(r.doc, X.doc, y + 16, { size: 10.5, color: DB_COLORS.soft, maxW: X.desc - X.doc - 8 });
      if (r.description) desc.forEach((line, i) => { text(line, X.desc, y + 16 + i * lineH, { size: 11.5, color: detail ? DB_COLORS.soft : color, maxW: descW }); });
      if (r.receivedSen != null) text(cellMoney(r.receivedSen), X.rec, y + 16, { size: 12, color: DB_COLORS.green, bold: r.kind === 'receivedHead', right: true });
      if (r.paymentSen != null) text(cellMoney(r.paymentSen), X.pay, y + 16, { size: 12, color, bold: r.kind === 'paidHead' || r.kind === 'pendingHead', right: true });
      if (r.balanceSen != null) text(cellMoney(r.balanceSen), X.bal, y + 16, { size: 12, color: balanceColor(r), bold: strong || r.kind === 'bf' || r.kind === 'transitHead', right: true });
      lineUnder(y, h);
      y += h;
    }
    if (ruled) {
      ctx.strokeStyle = DB_COLORS.line;
      ctx.lineWidth = 1;
      ctx.strokeRect(P + 0.5, top + 0.5, W - 2 * P - 1, y - top - 1);
    }
    y += 6;
  }
  text(boardSourceLine(board), P, y + 18, { size: 10.5, color: DB_COLORS.soft });
  return canvas;
}
