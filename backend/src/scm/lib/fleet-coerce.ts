/* Request-body coercion for the fleet maintenance routes.
 *
 * WHY THESE ARE ONE MODULE, AND WHY THEY ARE TESTED. Each returns a
 * discriminated `{ ok: true, value } | { ok: false }`, and the whole point of
 * that shape is the distinction between the two ways a field can be "empty":
 *
 *   { ok: true, value: null }   the caller legitimately sent nothing — write NULL
 *   { ok: false }               the caller sent something INVALID — refuse, 400
 *
 * Collapse those two and a typo'd mileage silently becomes NULL on a
 * compliance row instead of a refusal the operator can see. They lived as
 * private functions inside a 2,100-line router with no test of any kind, which
 * is the combination the coverage ratchet calls out: a file that decides what
 * reaches the database, and nothing pinning it.
 *
 * The blank-is-null-not-invalid rule is deliberate and shared by all of them:
 * `null`, `undefined` and `""` all mean "not supplied". An HTML form posts `""`
 * for an untouched field, so treating `""` as invalid would refuse every save
 * that left an optional box alone.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** `{ ok: true, value: null }` for every shape that means "not supplied". */
const blank = (v: unknown): boolean => v === null || v === undefined || v === '';

/** A YYYY-MM-DD prefix, or null when the value is absent or unparseable.
 *  Unlike `dateOrNull` this NEVER refuses — it is for READ paths shaping a row
 *  that is already in the database, where a bad stored value must not throw. */
export function iso(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).slice(0, 10);
  return ISO_DATE.test(s) ? s : null;
}

/** Plate numbers compare without whitespace and in upper case: `w a 1234 b`
 *  and `WA1234B` are the same lorry to a human, so they must be to us. */
export function normPlate(p: string | null | undefined): string {
  return (p ?? '').replace(/\s+/g, '').toUpperCase();
}

export function dateOrNull(v: unknown): { ok: true; value: string | null } | { ok: false } {
  if (blank(v)) return { ok: true, value: null };
  const s = String(v).slice(0, 10);
  return ISO_DATE.test(s) ? { ok: true, value: s } : { ok: false };
}

/** A non-negative INTEGER (mileage, counts) or null. Rejects fractions —
 *  a mileage of 12.5 km is a typo, not a reading. */
export function intOrNull(v: unknown): { ok: true; value: number | null } | { ok: false } {
  if (blank(v)) return { ok: true, value: null };
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return { ok: false };
  return { ok: true, value: n };
}

/** A non-negative money (cents) or number, allowing null/blank. */
export function numOrNull(v: unknown): { ok: true; value: number | null } | { ok: false } {
  if (blank(v)) return { ok: true, value: null };
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return { ok: false };
  return { ok: true, value: n };
}

/** A finite float (e.g. GPS lat/lng) or null; no sign/range constraint. */
export function floatOrNull(v: unknown): { ok: true; value: number | null } | { ok: false } {
  if (blank(v)) return { ok: true, value: null };
  const n = Number(v);
  if (!Number.isFinite(n)) return { ok: false };
  return { ok: true, value: n };
}

/** An ISO timestamp string or null/blank. Stored as-is (Postgres parses it). */
export function tsOrNull(v: unknown): { ok: true; value: string | null } | { ok: false } {
  if (blank(v)) return { ok: true, value: null };
  const s = String(v);
  const t = Date.parse(s);
  if (Number.isNaN(t)) return { ok: false };
  return { ok: true, value: s };
}

/** A JSON array of R2 keys (strings) or null. Rejects non-arrays.
 *  An array that is empty after trimming stores as NULL rather than `[]`:
 *  "no attachments" has one representation in this schema, not two. */
export function refsOrNull(v: unknown): { ok: true; value: string[] | null } | { ok: false } {
  if (blank(v)) return { ok: true, value: null };
  if (!Array.isArray(v)) return { ok: false };
  const out = v.map((x) => String(x).trim()).filter(Boolean);
  return { ok: true, value: out.length ? out : null };
}

/* -- Work-order files (HC-0031) ---------------------------------------------
   lorry_work_orders has carried invoice_refs / quote_refs / photo_refs (R2 keys,
   mig 0204) since it was built, but nothing ever uploaded a file into them. The
   key is SERVER-MINTED under the work order's own prefix, and the file name
   rides inside it so the screen can show it without another column. */
export const WORK_ORDER_FILE_KINDS = { invoice: 'invoice_refs', quote: 'quote_refs', photo: 'photo_refs' } as const;
export type WorkOrderFileKind = keyof typeof WORK_ORDER_FILE_KINDS;

export function isWorkOrderFileKind(v: unknown): v is WorkOrderFileKind {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(WORK_ORDER_FILE_KINDS, v);
}

/** fleet/work-orders/<woId>/<kind>/<ms>-<safe name>.<ext> */
export function workOrderFileKey(woId: string, kind: WorkOrderFileKind, ext: string, name: string | null, nowMs: number): string {
  return `fleet/work-orders/${woId}/${kind}/${fileTail(ext, name, nowMs)}`;
}

/** <ms>-<safe name>.<ext> - the file name rides inside the key. */
function fileTail(ext: string, name: string | null, nowMs: number): string {
  const stem = (name ?? '').replace(/\.[^.]*$/, '').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
  return `${nowMs}${stem ? `-${stem}` : ''}.${ext}`;
}

/** True only for a key minted for THIS work order - the delete route refuses
 *  anything else, so a crafted key cannot remove another object. */
export function isWorkOrderFileKeyOf(key: string, woId: string): boolean {
  return key.startsWith(`fleet/work-orders/${woId}/`) && !key.includes('..');
}

/* -- Breakdown media -----------------------------------------------------------
   lorry_breakdown_cases.media_refs (mig 0204) holds the scene photos/videos.
   New files get a server-minted key under the case; older mobile reports put a
   SLIPS-bucket key (slips/...) there, which the read route still serves. */

/** fleet/breakdowns/<caseId>/<ms>-<safe name>.<ext> */
export function breakdownFileKey(caseId: string, ext: string, name: string | null, nowMs: number): string {
  return `fleet/breakdowns/${caseId}/${fileTail(ext, name, nowMs)}`;
}

export function isBreakdownFileKeyOf(key: string, caseId: string): boolean {
  return key.startsWith(`fleet/breakdowns/${caseId}/`) && !key.includes('..');
}
