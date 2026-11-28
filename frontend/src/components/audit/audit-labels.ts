
export type AuditFieldChange = {
  field: string;
  from?: unknown;
  to?: unknown;
  from_label?: string;
  to_label?: string;
};

export type AuditLogEntry = {
  id: string | number;
  action: string;
  actor_name_snapshot: string | null;
  field_changes: AuditFieldChange[];
  source: string | null;
  note: string | null;
  created_at: string;
};

export type AuditLabelDictionary = {
  actions: Record<string, string>;
  fields: Record<string, string>;
  moneyFields?: ReadonlySet<string>;
  fallbackFieldLabel?: (field: string) => string | undefined;
};

const ACRONYMS = new Set(['ID', 'SO', 'PO', 'DO', 'GRN', 'SI', 'UOM', 'PWP', 'TBC']);

export const humaniseKey = (key: string): string => {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .filter((w, i, all) => !(i === all.length - 1 && all.length > 1 && w.toLowerCase() === 'centi'));
  if (words.length === 0) return key;
  return words
    .map((w, i) => {
      const upper = w.toUpperCase();
      if (ACRONYMS.has(upper)) return upper;
      const lower = w.toLowerCase();
      return i === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
    })
    .join(' ');
};

export const auditActionLabel = (
  action: string,
  dict: AuditLabelDictionary,
): string => dict.actions[action] ?? action.replace(/_/g, ' ').toLowerCase();

export const auditFieldLabel = (
  field: string,
  dict: AuditLabelDictionary,
): string =>
  dict.fields[field] ??
  dict.fallbackFieldLabel?.(field) ??
  humaniseKey(field).replace(/ Ids?$/i, '');
