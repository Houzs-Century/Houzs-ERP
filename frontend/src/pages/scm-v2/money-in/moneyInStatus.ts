// The words and tones Money in's lists put in their tags (the owner's Claude
// Design, batch 5). ONE home, so a status reads and looks the same on every
// Money-in page — CI's duplicated-decisions gate fires on a second copy. This
// holds Outstanding's and Not yet billed's today; the other Money-in pages
// bring theirs here as they are rebuilt.
//
// The four tones are the design's: late (red), warn (brass), info (petrol) and
// calm (grey). The WORD of a stored status always comes from status-pill's
// statusLabel, so the confirm rung reads "Submitted" here as everywhere else.

import { fmtDate } from '../../../vendor/shared/format';
import { statusLabel } from '../../../vendor/scm/lib/status-pill';
import type { OutstandingModule } from '../../../vendor/scm/lib/outstanding-queries';
import { dayDiff } from '../../../lib/dateRangePresets';

export type TagTone = 'late' | 'warn' | 'info' | 'calm';
export type Tag = { text: string; tone: TagTone };

/** An Outstanding row's status: the ERP's word, toned by what the document
 *  still waits on. Closed rows are calm and a cancelled or voided one late; an
 *  open one is brass while money or billing waits (an unpaid invoice, a GRN not
 *  billed, a delivery not invoiced, a return not refunded) and petrol while the
 *  work is under way (an order, a part-paid invoice). */
export function outstandingStatusTag(
  module: OutstandingModule,
  status: string | null | undefined,
  open: boolean,
  partlyPaid = false,
): Tag {
  const text = statusLabel(module, status);
  const s = String(status ?? '').toUpperCase();
  if (s === 'CANCELLED' || s === 'VOID') return { text, tone: 'late' };
  if (!open) return { text, tone: 'calm' };
  switch (module) {
    case 'si': return { text, tone: s === 'OVERDUE' ? 'late' : partlyPaid ? 'info' : 'warn' };
    case 'pi': return { text, tone: s === 'ON_HOLD' ? 'late' : 'warn' };
    case 'grn':
    case 'pr': return { text, tone: 'warn' };
    case 'so':
    case 'do': return { text, tone: s === 'DELIVERED' || s === 'SIGNED' || s === 'ON_HOLD' ? 'warn' : 'info' };
    case 'po': return { text, tone: s === 'ON_HOLD' ? 'warn' : 'info' };
  }
}

/** A due (or expected) date as a tag: `2026/10/01 · 28d late` in red once it
 *  has passed while the document is still open, else the date in grey. Null
 *  when there is no date. */
export function dueDateTag(date: string | null | undefined, open: boolean, today: string): Tag | null {
  const d = String(date ?? '').slice(0, 10);
  if (!d) return null;
  const late = open && d < today ? dayDiff(d, today) : 0;
  return late > 0 ? { text: `${fmtDate(d)} · ${late}d late`, tone: 'late' } : { text: fmtDate(d), tone: 'calm' };
}

/** Not yet billed's age tag: red from 91 days, brass from 31, grey before —
 *  the newest month is ordinary billing lag, not yet a finding. */
export function unbilledAgeTone(days: number): TagTone {
  return days >= 91 ? 'late' : days >= 31 ? 'warn' : 'calm';
}
