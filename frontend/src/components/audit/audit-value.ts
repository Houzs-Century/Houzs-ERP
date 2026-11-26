import { fmtSen } from '@2990s/shared';
import type { AuditLabelDictionary } from './audit-labels';

export const AUDIT_VALUE_MAX = 300;

const isInlineImage = (s: string): boolean => /^data:image\//i.test(s.trim());

/** A stored photo's object key ("so-items/HC-SO-013319/<uuid>/<uuid>.jpg"): the
 *  History drawer read it out in full, which staff took for garbled text. */
export const isStoredPhotoKey = (s: string): boolean =>
  /^[a-z0-9_-]+(\/[^/\s]+)+\.(jpe?g|png|webp|gif|heic|heif)$/i.test(s.trim());

/** The full text of a value (pictures masked), before any cut. */
export function auditValueText(field: string, val: unknown, dict: AuditLabelDictionary): string {
  if (val === null || val === undefined || val === '') return '—';
  if (dict.moneyFields?.has(field) && typeof val === 'number') return fmtSen(val);
  if (typeof val === 'string' && isInlineImage(val)) return '[image]';
  if (typeof val === 'string' && isStoredPhotoKey(val)) return '1 photo';
  if (typeof val === 'object') {
    return JSON.stringify(val, (_k, v: unknown) => (typeof v === 'string' && isInlineImage(v) ? '[image]' : v));
  }
  return String(val).replace(/_/g, ' ');
}

/** What the drawer shows: the text, cut at AUDIT_VALUE_MAX characters. */
export function auditValueShown(full: string): string {
  return full.length > AUDIT_VALUE_MAX ? `${full.slice(0, AUDIT_VALUE_MAX)}…` : full;
}
