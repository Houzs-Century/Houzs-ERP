// ----------------------------------------------------------------------------
// acc/self-check — Books › Self-check summed up (the owner's Claude Design,
// batch 6 c3): how many of its eight checks name something to look at, and
// the one-line items To do lists for them. Pure: the reads are made by the
// caller (scm/routes/accounting-self-check.ts — Run again and the nightly
// run), the same reads the page shows.
//
//   a control account   "<doc> journal RM x short|over" per document whose
//                        journal disagrees; "N lines from other sources on
//                        <code>"; "<name> not checked" when it could not run
//   payments            "N payments not in the books"; "N payments no longer
//                        agree with their entry"
//   money not done with "N cancelled orders holding money"; "N payments
//                        without an official receipt"
//
// A read that failed counts as one to look at — never as clean.
// ----------------------------------------------------------------------------

import type { ControlCheckResult } from './control-check';

export type SelfCheckSummary = { checks: number; findings: number; items: string[] };

export type SelfCheckFacts = {
  control: { ok: true; value: ControlCheckResult } | { ok: false; reason: string };
  /** Cancelled orders still holding money. */
  cancelled: { ok: true; count: number } | { ok: false; reason: string };
  /** Payments without an official receipt. */
  receipts: { ok: true; count: number } | { ok: false; reason: string };
};

/** The page's four control rows, the two payment rows and the two money rows. */
export const SELF_CHECK_COUNT = 8;

/** A control role by the name Finance uses for it. */
const controlName = (role: string): string => {
  switch (role) {
    case 'AR': return 'Trade debtors';
    case 'AR_OTHER': return 'Other debtors';
    case 'AP_OTHER': return 'Other creditors';
    default: return 'Trade creditors';
  }
};
const rm = (sen: number): string => `RM ${(Math.abs(sen) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const count = (n: number, one: string, many: string): string => `${n.toLocaleString('en-MY')} ${n === 1 ? one : many}`;

export function selfCheckSummary(f: SelfCheckFacts): SelfCheckSummary {
  const items: string[] = [];
  let findings = 0;
  if (!f.control.ok) {
    /* The control check read every row below it: all six are unknown. */
    findings += 6;
    items.push(`Control check not run (${f.control.reason})`);
  } else {
    for (const c of f.control.value.checks) {
      const name = controlName(c.role);
      if ('error' in c) { findings += 1; items.push(`${name} not checked`); continue; }
      if (c.driftDocs.length === 0 && c.foreignLines.length === 0) continue;
      findings += 1;
      for (const d of c.driftDocs) items.push(`${d.docNo} journal ${rm(d.diffSen)} ${d.jeTotalSen < d.docTotalSen ? 'short' : 'over'}`);
      if (c.foreignLines.length > 0) items.push(`${count(c.foreignLines.length, 'line', 'lines')} from other sources on ${c.accountCode}`);
    }
    const p = f.control.value.payments;
    if (p.error) { findings += 1; items.push('Payments not checked'); } else {
      const never = p.since == null ? p.neverBooked?.count ?? 0 : 0;
      const n = never > 0 ? never : p.rows.length;
      if (n > 0) { findings += 1; items.push(`${count(n, 'payment', 'payments')} not in the books`); }
    }
    const d = f.control.value.paymentDrift;
    if (d.error) { findings += 1; items.push('Payment entries not checked'); } else if (d.rows.length > 0) {
      findings += 1;
      const n = d.rows.length;
      items.push(n === 1 ? '1 payment no longer agrees with its entry' : `${n.toLocaleString('en-MY')} payments no longer agree with their entries`);
    }
  }
  if (!f.cancelled.ok) { findings += 1; items.push('Cancelled orders not checked'); } else if (f.cancelled.count > 0) {
    findings += 1;
    items.push(`${count(f.cancelled.count, 'cancelled order', 'cancelled orders')} holding money`);
  }
  if (!f.receipts.ok) { findings += 1; items.push('Official receipts not checked'); } else if (f.receipts.count > 0) {
    findings += 1;
    items.push(`${count(f.receipts.count, 'payment', 'payments')} without an official receipt`);
  }
  return { checks: SELF_CHECK_COUNT, findings: Math.min(findings, SELF_CHECK_COUNT), items };
}
