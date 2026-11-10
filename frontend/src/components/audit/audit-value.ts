/* How one audit "from" / "to" value reads in the History drawer.

   Gap review P18: a field holding an inline picture (a data: URL) or a long text
   used to print in full, so one change could fill the drawer with base64. A
   picture now reads "[image]" (also inside an object value), and text past
   AUDIT_VALUE_MAX characters is cut with "…"; the drawer keeps the full text in
   the tooltip. */
import { fmtSen } from '@2990s/shared';
import type { AuditLabelDictionary } from './audit-labels';

export const AUDIT_VALUE_MAX = 300;

const isInlineImage = (s: string): boolean => /^data:image\//i.test(s.trim());

/** The full text of a value (pictures masked), before any cut. */
export function auditValueText(field: string, val: unknown, dict: AuditLabelDictionary): string {
  if (val === null || val === undefined || val === '') return '—';
  if (dict.moneyFields?.has(field) && typeof val === 'number') return fmtSen(val);
  if (typeof val === 'string' && isInlineImage(val)) return '[image]';
  if (typeof val === 'object') {
    return JSON.stringify(val, (_k, v: unknown) => (typeof v === 'string' && isInlineImage(v) ? '[image]' : v));
  }
  return String(val).replace(/_/g, ' ');
}

/** What the drawer shows: the text, cut at AUDIT_VALUE_MAX characters. */
export function auditValueShown(full: string): string {
  return full.length > AUDIT_VALUE_MAX ? `${full.slice(0, AUDIT_VALUE_MAX)}…` : full;
}
