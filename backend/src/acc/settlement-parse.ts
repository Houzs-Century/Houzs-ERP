// ----------------------------------------------------------------------------
// acc/settlement-parse — reading an acquirer's settlement statement.
//
// Brief §3.5 layer 3, the two rules that govern this file:
//
//   "各家收单行的差异做成设定档，不要写死在代码里" — every difference between
//   acquirers (which column is the date, whether there is a unique reference,
//   how the fee is presented) lives in scm.acc_acquirer_config, never in an
//   `if (acquirer === 'GHL')` here. Teaching the system a sixth acquirer is a
//   config row, not a deploy.
//
//   "误传格式要报错，不准安静解析出 0 笔" (§2.14) — every refusal below returns
//   a reason a human can act on, naming the column or the line. A statement
//   that parses to zero rows is a FAILURE, not an empty day: the operator who
//   uploads the wrong file must be told so, not shown a clean screen.
//
// CSV only for now. XLSX/PDF statements are refused by name (with the format
// the config says the acquirer sends) rather than mis-parsed as text.
// ----------------------------------------------------------------------------

import { fmtSen } from '../scm/shared/format';

export type StatementColumnMap = {
  date?: string;
  ref?: string;
  gross?: string;
  fee?: string;
  net?: string;
  qr?: string;
  qr_values?: string;
};

export type ParseConfig = {
  code: string;
  statement_format: string | null;
  fee_method: string | null;
  column_map: StatementColumnMap | null;
  summaryFeeSen?: number | null;
  statementMonth?: string | null;
  total_net_label?: string | null;
  summary_totals?: { rowLabel: string; fee?: string; net?: string } | null;
};

export type ParsedRow = {
  lineNo: number;
  txnDate: string;
  ref: string | null;
  grossSen: number;
  feeSen: number;
  netSen: number;
  /** 'QR' for a customer's QR payment (owner 2026-11-09: 这个hlbb merchant 的
      0000PP 是qr direct 去bank 的，不算卡机的). Its money is in the bank by the
      sale itself, so it is matched to the sale, never to card money, and never
      joins what the acquirer owes through its clearing account. Absent = card. */
  channel?: 'QR';
  /** The card terminal the report names for this line (owner 2026-11-27: 往后上传后都要
      保存起来): its own column (PBB `TID`, Maybank `Terminal No.`, GHL `terminal_id`),
      else the `TERMINAL ID` line heading its block (Hong Leong, AEON). Absent: none named. */
  terminalId?: string;
};

export type ParseResult =
  | {
      ok: true; rows: ParsedRow[];
      grossSen: number; feeSen: number; netSen: number;
      periodFrom: string; periodTo: string; skippedLines: number;
      statedNetSen: number | null;
      adjustmentSen: number;
    }
  | { ok: false; reason: string };


/** RFC4180-ish splitter: quoted fields may contain commas and doubled quotes.
    Acquirer exports quote their merchant names, and a naive split() would shift
    every column after that field by one — silently reading the fee column as
    the net. */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i += 1; } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/**
 * Money → integer sen (§2.7: amounts are integers, always).
 *
 * Accepts what statements actually print: thousands separators, a currency
 * prefix, a trailing minus, and accountancy parentheses for negatives. Returns
 * null when it cannot be sure — and the caller turns that into a refusal that
 * names the line, never a zero.
 */
export function toSen(raw: string): number | null {
  let s = String(raw ?? '').trim().replace(/^'/, '').replace(/^\+/, '');
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
  if (s.endsWith('-')) { negative = true; s = s.slice(0, -1); }
  s = s.replace(/^(RM|MYR)\s*/i, '').replace(/,/g, '').trim();
  if (s.startsWith('-')) { negative = !negative; s = s.slice(1); }
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const sen = Math.round(Number(s) * 100);
  if (!Number.isFinite(sen)) return null;
  return negative ? -sen : sen;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** A date shape that carries a day and a month but NO year (`05-Jun`) — the
    Maybank terminal statement prints exactly this. It cannot be dated without
    being told which month the statement covers. */
export const dateNeedsYear = (raw: string): boolean =>
  /^\d{1,2}[-/\s]([A-Za-z]{3,})$/.test(String(raw ?? '').trim());

/**
 * Statement dates → YYYY-MM-DD.
 *
 * Handles what the real files print: ISO (with or without a time), DD/MM/YYYY,
 * DD-MMM-YYYY, two-digit years, and — the Maybank case — DD-MMM with no year
 * at all, which is why `hint` exists. An ambiguous or impossible date is
 * refused rather than guessed; money is not dated by assumption (§2.5).
 */
export function toIsoDate(raw: string, hint?: { year: number; month: number } | null): string | null {
  const s = String(raw ?? '').trim().replace(/^'/, '');
  if (!s) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const pad = (n: number) => String(n).padStart(2, '0');
  const fullYear = (y: number) => (y < 100 ? 2000 + y : y);
  const yearFor = (month: number): number | null => {
    if (!hint) return null;
    if (month > hint.month + 6) return hint.year - 1;
    if (month < hint.month - 6) return hint.year + 1;
    return hint.year;
  };

  const packed = /^(\d{8})$/.exec(s);
  if (packed) {
    const v = packed[1];
    const asYmd = { y: Number(v.slice(0, 4)), m: Number(v.slice(4, 6)), d: Number(v.slice(6, 8)) };
    if (asYmd.y >= 1990 && asYmd.y <= 2100 && asYmd.m >= 1 && asYmd.m <= 12 && asYmd.d >= 1 && asYmd.d <= 31) {
      return `${asYmd.y}-${pad(asYmd.m)}-${pad(asYmd.d)}`;
    }
    const asDmy = { d: Number(v.slice(0, 2)), m: Number(v.slice(2, 4)), y: Number(v.slice(4, 8)) };
    if (asDmy.y >= 1990 && asDmy.y <= 2100 && asDmy.m >= 1 && asDmy.m <= 12 && asDmy.d >= 1 && asDmy.d <= 31) {
      return `${asDmy.y}-${pad(asDmy.m)}-${pad(asDmy.d)}`;
    }
    return null;
  }

  const dmy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/.exec(s);
  if (dmy) {
    const d = Number(dmy[1]);
    const m = Number(dmy[2]);
    if (d < 1 || d > 31 || m < 1 || m > 12) return null;
    return `${fullYear(Number(dmy[3]))}-${pad(m)}-${pad(d)}`;
  }

  const named = /^(\d{1,2})[-/\s]([A-Za-z]{3,})(?:[-/\s](\d{2,4}))?$/.exec(s);
  if (named) {
    const d = Number(named[1]);
    const m = MONTHS[named[2].slice(0, 3).toLowerCase()];
    if (!m || d < 1 || d > 31) return null;
    const y = named[3] ? fullYear(Number(named[3])) : yearFor(m);
    if (y == null) return null;
    return `${y}-${pad(m)}-${pad(d)}`;
  }
  return null;
}

function headerIndex(headers: string[], wanted: string): number {
  const norm = (s: string) => s.replace(/[\s_]+/g, '').toLowerCase();
  const target = norm(wanted);
  return headers.findIndex((h) => norm(h) === target);
}

/* Read by name, not from the acquirer setup: every bank names its terminal one of
   these ways, in a column or on a TERMINAL ID line holding only that label and its
   value above the lines it swiped (53 uploaded files checked, owner 2026-11-27). */
const TERMINAL_NAMES: ReadonlySet<string> = new Set(['tid', 'terminalid', 'terminalno', 'terminalnumber']);
const isTerminalName = (s: string): boolean => TERMINAL_NAMES.has(s.replace(/[\s_.:#]+/g, '').toLowerCase());
const terminalValue = (raw: string | undefined): string | null => String(raw ?? '').trim().replace(/^'/, '').trim() || null;

function blockTerminals(lines: readonly string[]): Array<string | null> {
  let current: string | null = null;
  return lines.map((line) => {
    const filled = splitCsvLine(line).filter((c) => c !== '');
    if (filled.length === 2 && isTerminalName(filled[0])) current = terminalValue(filled[1]) ?? current;
    return current;
  });
}


export function parseStatement(cfg: ParseConfig, text: string): ParseResult {
  /* 决定4 not yet delivered for this acquirer: refuse by name. Guessing the
     columns is exactly how 系统3 ended up with two acquirers whose money never
     reconciled. */
  const format = (cfg.statement_format ?? '').toUpperCase();
  if (!format) {
    return { ok: false, reason: `${cfg.code} has no statement format configured yet — fill in its acquirer setup before uploading.` };
  }
  if (format !== 'CSV') {
    return { ok: false, reason: `${cfg.code} is configured to send ${format} statements, which this screen cannot read yet. Export the statement as CSV, or change the acquirer's configured format.` };
  }
  const map = cfg.column_map ?? null;
  if (!map || !map.date || !map.gross) {
    return { ok: false, reason: `${cfg.code} has no file layout set up yet (at least the date and amount headings) — fill in its acquirer setup first.` };
  }
  const feeMethod = cfg.fee_method ?? null;
  if (!feeMethod) {
    return { ok: false, reason: `${cfg.code} has no fee method configured (stated / gross-minus-net / prorated-summary) — fill in its acquirer setup before uploading.` };
  }
  if (feeMethod === 'stated' && !map.fee) {
    return { ok: false, reason: `${cfg.code} states its fee on each line, but its fee heading has not been set up.` };
  }
  if (feeMethod === 'gross-minus-net' && !map.net) {
    return { ok: false, reason: `${cfg.code} works its fee out as gross minus net, but its net heading has not been set up.` };
  }

  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = body.split(/\r\n|\n|\r/).filter((l) => l.trim() !== '');
  if (lines.length === 0) return { ok: false, reason: 'The file is empty.' };

  const required = [
    map.date, map.gross,
    ...(map.ref ? [map.ref] : []),
    ...(feeMethod === 'stated' ? [map.fee as string] : []),
    ...(feeMethod === 'gross-minus-net' ? [map.net as string] : []),
  ];
  let headerLine = -1;
  let headers: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const cells = splitCsvLine(lines[i]);
    if (required.every((h) => headerIndex(cells, h) >= 0)) { headerLine = i; headers = cells; break; }
  }
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  if (headerLine < 0) {
    return {
      ok: false,
      reason: `Not a ${cfg.code} statement — no row has the ${clip(required.join(', '), 60)} heading${required.length > 1 ? 's' : ''}. The file starts: ${clip(splitCsvLine(lines[0]).join(', '), 70)}`,
    };
  }
  const headerSignature = headers.join('');

  const idxDate = headerIndex(headers, map.date);
  const idxGross = headerIndex(headers, map.gross);
  const idxRef = map.ref ? headerIndex(headers, map.ref) : -1;
  const idxFee = map.fee ? headerIndex(headers, map.fee) : -1;
  const idxNet = map.net ? headerIndex(headers, map.net) : -1;
  const idxQr = map.qr ? headerIndex(headers, map.qr) : -1;
  const qrValues = new Set(String(map.qr_values ?? '').split(',').map((v) => v.trim().toUpperCase()).filter(Boolean));
  const idxTerminal = headers.findIndex(isTerminalName);
  const blockTerminal = blockTerminals(lines);

  const hint = /^\d{4}-\d{2}$/.test(cfg.statementMonth ?? '')
    ? { year: Number((cfg.statementMonth as string).slice(0, 4)), month: Number((cfg.statementMonth as string).slice(5, 7)) }
    : null;

  const rows: ParsedRow[] = [];
  let skipped = headerLine;
  for (let i = headerLine + 1; i < lines.length; i += 1) {
    const cells = splitCsvLine(lines[i]);
    if (cells.join('') === headerSignature) { skipped += 1; continue; }
    const rawDate = cells[idxDate] ?? '';
    const rawGross = cells[idxGross] ?? '';
    if (!rawDate.trim()) { skipped += 1; continue; }

    if (dateNeedsYear(rawDate) && !hint) {
      return {
        ok: false,
        reason: `This ${cfg.code} statement writes its dates without a year (line ${i + 1} says "${rawDate}") — choose the month it covers and upload it again.`,
      };
    }

    const txnDate = toIsoDate(rawDate, hint);
    if (!txnDate) { skipped += 1; continue; }

    if (!rawGross.trim()) { skipped += 1; continue; }
    const grossSen = toSen(rawGross);
    if (grossSen == null) return { ok: false, reason: `Line ${i + 1}: cannot read the amount "${rawGross}".` };

    let feeSen = 0;
    let netSen = grossSen;
    if (feeMethod === 'stated') {
      const f = toSen(cells[idxFee] ?? '');
      if (f == null) return { ok: false, reason: `Line ${i + 1}: cannot read the fee "${cells[idxFee] ?? ''}".` };
      feeSen = Math.abs(f);
      netSen = grossSen - (grossSen < 0 ? -feeSen : feeSen);
      if (idxNet >= 0) {
        const statedNet = toSen(cells[idxNet] ?? '');
        if (statedNet != null && statedNet !== netSen) {
          return {
            ok: false,
            reason: `Line ${i + 1}: ${fmtSen(grossSen)} less the fee ${fmtSen(feeSen)} is ${fmtSen(netSen)}, but the file says ${fmtSen(statedNet)}. That fee heading is probably a rate, not an amount — set ${cfg.code} to "gross minus net".`,
          };
        }
      }
    } else if (feeMethod === 'gross-minus-net') {
      const n = toSen(cells[idxNet] ?? '');
      if (n == null) return { ok: false, reason: `Line ${i + 1}: cannot read the net amount "${cells[idxNet] ?? ''}".` };
      netSen = n;
      feeSen = Math.abs(grossSen) - Math.abs(n);
      if (feeSen < 0) {
        return { ok: false, reason: `Line ${i + 1}: the net (${fmtSen(n)}) is larger than the gross (${fmtSen(grossSen)}) — that is not a fee, so the file is not being read the way ${cfg.code} wrote it.` };
      }
    }

    const terminalId = (idxTerminal >= 0 ? terminalValue(cells[idxTerminal]) : null) ?? blockTerminal[i];
    const terminal = terminalId ? { terminalId } : {};
    if (idxQr >= 0 && qrValues.has(String(cells[idxQr] ?? '').trim().toUpperCase())) {
      rows.push({ lineNo: i + 1, txnDate, ref: null, grossSen, feeSen, netSen, channel: 'QR', ...terminal });
      continue;
    }
    const ref = idxRef >= 0 ? (cells[idxRef] ?? '').trim().replace(/^'/, '') || null : null;
    rows.push({ lineNo: i + 1, txnDate, ref, grossSen, feeSen, netSen, ...terminal });
  }

  if (rows.length === 0) {
    return { ok: false, reason: `No transaction lines were found in this file. It has ${lines.length - 1} data line(s), none of them readable as a ${cfg.code} transaction — check that this is the right file.` };
  }

  let summaryFeeSen: number | null = cfg.summaryFeeSen ?? null;
  let summaryNetSen: number | null = null;
  if (cfg.summary_totals) {
    const { rowLabel, fee, net } = cfg.summary_totals;
    const norm = (v: string) => v.replace(/[\s:]+/g, '').toLowerCase();
    let idxFee = -1;
    let idxNet = -1;
    let summaryHeader = -1;
    for (let i = headerLine + 1; i < lines.length; i += 1) {
      const cells = splitCsvLine(lines[i]);
      const f = fee ? headerIndex(cells, fee) : -1;
      const n = net ? headerIndex(cells, net) : -1;
      if ((fee && f >= 0) || (net && n >= 0)) { summaryHeader = i; idxFee = f; idxNet = n; break; }
    }
    if (summaryHeader >= 0) {
      for (let i = summaryHeader + 1; i < lines.length; i += 1) {
        const cells = splitCsvLine(lines[i]);
        if (norm(cells[0] ?? '') !== norm(rowLabel)) continue;
        if (idxFee >= 0) summaryFeeSen = toSen(cells[idxFee] ?? '') ?? summaryFeeSen;
        if (idxNet >= 0) summaryNetSen = toSen(cells[idxNet] ?? '');
        break;
      }
    }
  }

  if (feeMethod === 'prorated-summary') {
    const total = summaryFeeSen;
    if (total == null) {
      return { ok: false, reason: `${cfg.code} prints its fee only as a statement total, and this file does not show one — enter it when uploading, or check the acquirer's summary-row setup.` };
    }
    if (!Number.isInteger(total) || total < 0) {
      return { ok: false, reason: 'The statement fee total must be a non-negative amount.' };
    }
    const grossAbsTotal = rows.reduce((s, r) => s + Math.abs(r.grossSen), 0);
    if (grossAbsTotal === 0) return { ok: false, reason: 'Every line on this statement is zero — nothing to spread a fee across.' };
    let allocated = 0;
    let biggest = 0;
    rows.forEach((r, i) => {
      const share = Math.floor((total * Math.abs(r.grossSen)) / grossAbsTotal);
      r.feeSen = share;
      allocated += share;
      if (Math.abs(r.grossSen) > Math.abs(rows[biggest].grossSen)) biggest = i;
    });
    rows[biggest].feeSen += total - allocated;
    for (const r of rows) r.netSen = r.grossSen - (r.grossSen < 0 ? -r.feeSen : r.feeSen);
  }

  let statedNetSen: number | null = summaryNetSen;
  if (cfg.total_net_label) {
    const wanted = cfg.total_net_label.replace(/[\s:]+/g, '').toLowerCase();
    for (const line of lines) {
      const cells = splitCsvLine(line);
      if (cells[0].replace(/[\s:]+/g, '').toLowerCase() !== wanted) continue;
      for (let k = cells.length - 1; k >= 1; k -= 1) {
        const v = toSen(cells[k]);
        if (v != null) { statedNetSen = v; break; }
      }
      break;
    }
  }
  const lineNetSen = rows.reduce((s, r) => s + r.netSen, 0);
  const adjustmentSen = statedNetSen == null ? 0 : lineNetSen - statedNetSen;

  const dates = rows.map((r) => r.txnDate).sort();
  return {
    ok: true,
    rows,
    grossSen: rows.reduce((s, r) => s + r.grossSen, 0),
    feeSen: rows.reduce((s, r) => s + r.feeSen, 0),
    netSen: rows.reduce((s, r) => s + r.netSen, 0),
    periodFrom: dates[0],
    periodTo: dates[dates.length - 1],
    skippedLines: skipped,
    statedNetSen,
    adjustmentSen,
  };
}

/**
 * What a report owes THROUGH THE ACQUIRER'S CLEARING ACCOUNT — its card lines.
 *
 * A QR line's money reached the bank by the sale itself (keyed Online, booked
 * straight to the bank), so it is no part of what the acquirer pays out of the
 * clearing account: counting it there would leave the report "owed" money that
 * never passes through it, and invite the bank's QR credit to be booked as a
 * card payout — the money into the bank a second time. Its net comes off the
 * net the file states too, so the statement's own adjustment is unchanged.
 */
export function cardTotalsOf(p: Extract<ParseResult, { ok: true }>): {
  grossSen: number; feeSen: number; netSen: number; statedNetSen: number | null;
} {
  const qr = p.rows.filter((r) => r.channel === 'QR');
  const sum = (pick: (r: ParsedRow) => number) => qr.reduce((s, r) => s + pick(r), 0);
  const qrNet = sum((r) => r.netSen);
  return {
    grossSen: p.grossSen - sum((r) => r.grossSen),
    feeSen: p.feeSen - sum((r) => r.feeSen),
    netSen: p.netSen - qrNet,
    statedNetSen: p.statedNetSen == null ? null : p.statedNetSen - qrNet,
  };
}
