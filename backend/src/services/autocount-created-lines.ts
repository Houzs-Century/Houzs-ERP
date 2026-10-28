// ----------------------------------------------------------------------------
// autocount-created-lines — the lines AcSyncService reports a document holds
// after a create, a conversion, or an edit that added a line.
//
// Moved out of autocount-writeback.ts unchanged apart from `FromDocDtlKey`:
// that file sits at the 2,000-line cap, and the field below is the whole reason
// this seam was touched (docs/bugs/0898).
// ----------------------------------------------------------------------------

/**
 * One line AutoCount created, as the create and convert routes now report them.
 * Ordered by DtlKey, which is creation order. ItemCode travels with the key so
 * the caller can ASSERT its index-zip before storing anything: a wrong DtlKey
 * silently edits a different line in a live book, which is strictly worse than
 * no DtlKey (no key is refused loudly by composeEdit).
 */
export interface AcCreatedLine {
  Seq: number;
  DtlKey: number;
  ItemCode: string;
  Desc2?: string | null;
  /**
   * The SOURCE line this line was transferred from, as AutoCount's own
   * `DocTransfer` table records it — present only when the host names exactly
   * one (AcSyncService.cs `CreatedLines`, built 2026-09-14 onward). Absent on a
   * create, on an added line, and from any host built before that; a caller
   * must treat absence as "not proved", never as "no source".
   */
  FromDocDtlKey?: number;
}

/**
 * Read the `lines` array off a service response, keeping only entries that are
 * completely usable. A half-parsed entry is dropped rather than coerced: a
 * DtlKey guessed from a malformed row would be stored as line identity and used
 * to edit a live document. The same rule applies to `FromDocDtlKey`: anything
 * but a positive integer is left off the line, so it reads as unproved.
 */
export function parseCreatedLines(raw: unknown): AcCreatedLine[] {
  if (!Array.isArray(raw)) return [];
  const out: AcCreatedLine[] = [];
  raw.forEach((entry, i) => {
    if (!entry || typeof entry !== 'object') return;
    const r = entry as Record<string, unknown>;
    const key = Number(r.DtlKey);
    if (!Number.isFinite(key) || key <= 0) return;
    const seq = Number(r.Seq);
    const from = r.FromDocDtlKey == null ? NaN : Number(r.FromDocDtlKey);
    out.push({
      Seq: Number.isFinite(seq) ? seq : i,
      DtlKey: key,
      ItemCode: typeof r.ItemCode === 'string' ? r.ItemCode : '',
      Desc2: typeof r.Desc2 === 'string' ? r.Desc2 : null,
      ...(Number.isInteger(from) && from > 0 ? { FromDocDtlKey: from } : {}),
    });
  });
  return out;
}
