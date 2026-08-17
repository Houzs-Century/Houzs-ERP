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

export type StatementColumnMap = {
  date?: string;
  ref?: string;
  gross?: string;
  fee?: string;
  net?: string;
};

export type ParseConfig = {
  code: string;
  statement_format: string | null;
  fee_method: string | null;
  column_map: StatementColumnMap | null;
  /** Only for fee_method 'prorated-summary': the statement's total fee, keyed in
      by the operator from the summary block the file prints. */
  summaryFeeSen?: number | null;
};

export type ParsedRow = {
  lineNo: number;
  txnDate: string;   // YYYY-MM-DD
  ref: string | null;
  grossSen: number;  // negative = refund / chargeback line
  feeSen: number;    // always ≥ 0
  netSen: number;
};

export type ParseResult =
  | { ok: true; rows: ParsedRow[]; grossSen: number; feeSen: number; netSen: number; periodFrom: string; periodTo: string; skippedLines: number }
  | { ok: false; reason: string };

/* ── The small mechanical helpers ─────────────────────────────────────────── */

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
  let s = String(raw ?? '').trim();
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
  if (s.endsWith('-')) { negative = true; s = s.slice(0, -1); }
  s = s.replace(/^(RM|MYR)\s*/i, '').replace(/,/g, '').trim();
  if (s.startsWith('-')) { negative = !negative; s = s.slice(1); }
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  // Round rather than truncate: 0.1+0.2 style float error must not lose a sen.
  const sen = Math.round(Number(s) * 100);
  if (!Number.isFinite(sen)) return null;
  return negative ? -sen : sen;
}

/** Statement dates → YYYY-MM-DD. DD/MM/YYYY is the Malaysian acquirer default;
    an ISO date passes through. An ambiguous or impossible date is refused. */
export function toIsoDate(raw: string): string | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dmy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/.exec(s);
  if (dmy) {
    const d = Number(dmy[1]);
    const m = Number(dmy[2]);
    if (d < 1 || d > 31 || m < 1 || m > 12) return null;
    return `${dmy[3]}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  return null;
}

/** Header lookup is case- and space-insensitive: acquirers rename
    "Txn Date" to "TXN DATE" between statement versions and that is not a
    reason to refuse a file. */
function headerIndex(headers: string[], wanted: string): number {
  const norm = (s: string) => s.replace(/[\s_]+/g, '').toLowerCase();
  const target = norm(wanted);
  return headers.findIndex((h) => norm(h) === target);
}

/* ── The parse ────────────────────────────────────────────────────────────── */

export function parseStatement(cfg: ParseConfig, text: string): ParseResult {
  /* 决定4 not yet delivered for this acquirer: refuse by name. Guessing the
     columns is exactly how 系统3 ended up with two acquirers whose money never
     reconciled. */
  const format = (cfg.statement_format ?? '').toUpperCase();
  if (!format) {
    return { ok: false, reason: `${cfg.code} has no statement format configured yet — fill in its acquirer setup (决定4) before uploading.` };
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

  /* Excel writes a UTF-8 byte-order mark at the front of every CSV it saves,
     and an operator who opens the acquirer's file to look at it and presses
     save has just added one. Left in place it becomes part of the FIRST
     heading, so "Txn Date" stops matching "Txn Date" and a perfectly good
     statement is refused for a reason nobody can see. */
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = body.split(/\r\n|\n|\r/).filter((l) => l.trim() !== '');
  if (lines.length === 0) return { ok: false, reason: 'The file is empty.' };

  const headers = splitCsvLine(lines[0]);
  const idxDate = headerIndex(headers, map.date);
  const idxGross = headerIndex(headers, map.gross);
  const idxRef = map.ref ? headerIndex(headers, map.ref) : -1;
  const idxFee = map.fee ? headerIndex(headers, map.fee) : -1;
  const idxNet = map.net ? headerIndex(headers, map.net) : -1;

  const missing: string[] = [];
  if (idxDate < 0) missing.push(map.date);
  if (idxGross < 0) missing.push(map.gross);
  if (map.ref && idxRef < 0) missing.push(map.ref);
  if (feeMethod === 'stated' && idxFee < 0) missing.push(map.fee as string);
  if (feeMethod === 'gross-minus-net' && idxNet < 0) missing.push(map.net as string);
  if (missing.length) {
    /* Kept SHORT and free of the words a generic API-error humaniser strips as
       "database internals" (the frontend's shared humanApiError drops any
       message containing "column", which silently turned this sentence into
       "some details weren't accepted" — the exact opposite of §2.14). */
    const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
    return {
      ok: false,
      reason: `Not a ${cfg.code} statement — no ${clip(missing.join(', '), 50)} heading${missing.length > 1 ? 's' : ''}. The file has: ${clip(headers.join(', '), 90)}`,
    };
  }

  const rows: ParsedRow[] = [];
  let skipped = 0;
  for (let i = 1; i < lines.length; i += 1) {
    const cells = splitCsvLine(lines[i]);
    const rawDate = cells[idxDate] ?? '';
    const rawGross = cells[idxGross] ?? '';
    /* Statements end with a totals block — a row with no date and the whole
       statement's amount in the money column (a real MBB export ends
       `,,TOTAL,6077.00,91.16`). A DATELESS row cannot be a transaction under
       any reading, so it is skipped; a row that HAS a date it cannot read is a
       different thing and still raises below. The count is reported, because
       "skipped some rows" must never be something the operator has to guess. */
    if (!rawDate.trim()) { skipped += 1; continue; }

    const txnDate = toIsoDate(rawDate);
    if (!txnDate) return { ok: false, reason: `Line ${i + 1}: cannot read the date "${rawDate}".` };
    const grossSen = toSen(rawGross);
    if (grossSen == null) return { ok: false, reason: `Line ${i + 1}: cannot read the amount "${rawGross}".` };

    let feeSen = 0;
    let netSen = grossSen;
    if (feeMethod === 'stated') {
      const f = toSen(cells[idxFee] ?? '');
      if (f == null) return { ok: false, reason: `Line ${i + 1}: cannot read the fee "${cells[idxFee] ?? ''}".` };
      feeSen = Math.abs(f);
      netSen = grossSen - (grossSen < 0 ? -feeSen : feeSen);
    } else if (feeMethod === 'gross-minus-net') {
      const n = toSen(cells[idxNet] ?? '');
      if (n == null) return { ok: false, reason: `Line ${i + 1}: cannot read the net amount "${cells[idxNet] ?? ''}".` };
      netSen = n;
      feeSen = Math.abs(grossSen) - Math.abs(n);
      if (feeSen < 0) {
        return { ok: false, reason: `Line ${i + 1}: the net (${(n / 100).toFixed(2)}) is larger than the gross (${(grossSen / 100).toFixed(2)}) — that is not a fee, so the file is not being read the way ${cfg.code} wrote it.` };
      }
    }

    const ref = idxRef >= 0 ? (cells[idxRef] ?? '').trim() || null : null;
    rows.push({ lineNo: i + 1, txnDate, ref, grossSen, feeSen, netSen });
  }

  if (rows.length === 0) {
    return { ok: false, reason: `No transaction lines were found in this file. It has ${lines.length - 1} data line(s), none of them readable as a ${cfg.code} transaction — check that this is the right file.` };
  }

  /* prorated-summary: the acquirer prints one fee total for the whole
     statement. Spread it by gross value and give the rounding remainder to the
     largest line, so the fees SUM EXACTLY to the total the acquirer charged —
     an approximation here would leave a permanent unexplainable sen in 320-0000. */
  if (feeMethod === 'prorated-summary') {
    const total = cfg.summaryFeeSen ?? null;
    if (total == null) {
      return { ok: false, reason: `${cfg.code} prints its fee only as a statement total — enter that total when uploading so it can be spread across the lines.` };
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
  };
}
