/* Shared audit-trail vocabulary.
   Stage 1 of the system-wide audit trail: the Sales Order History drawer was
   the only complete "who / when / what changed" viewer in the system, and its
   ACTION_LABEL / FIELD_LABEL dictionaries were hardcoded to SO wording. Each
   entity now supplies its own dictionary of this shape, so the drawer itself
   carries no module vocabulary. */

export type AuditFieldChange = {
  field: string;
  from?: unknown;
  to?: unknown;
};

/* Structural shape of one append-only audit row. Matches mfg_so_audit_log's
   column names so an entity's existing query type satisfies it without a
   mapping layer; any future audit table should keep these names. */
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
  /* Raw action key (CREATE, UPDATE_LINE, …) to display text. */
  actions: Record<string, string>;
  /* Raw field key as written by the backend differ, to display text. */
  fields: Record<string, string>;
  /* Fields whose numeric value is stored in cents and must render as money. */
  moneyFields?: ReadonlySet<string>;
  /* Escape hatch for logs whose field keys are DATA rather than a fixed
     vocabulary. Stock take writes one change per counted SKU keyed by the
     product code itself, and humaniseKey would lower-case a real code
     ("AB-12X" -> "Ab 12x"). Return undefined to fall through to humaniseKey. */
  fallbackFieldLabel?: (field: string) => string | undefined;
};

const ACRONYMS = new Set(['ID', 'SO', 'PO', 'DO', 'GRN', 'SI', 'UOM', 'PWP', 'TBC']);

/* A key with no dictionary entry must still read as English, never as a raw
   database column. Splits camelCase and snake_case, drops the `centi` storage
   suffix, and keeps known acronyms upper-case. */
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
): string => dict.fields[field] ?? dict.fallbackFieldLabel?.(field) ?? humaniseKey(field);
