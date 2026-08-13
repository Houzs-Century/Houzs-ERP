// ONE place that reads an AutoCount PODTL row out of the cutover snapshots.
//
// Why a file and not three inline field reads: the export was re-cut in
// a5f51653 (PR #1779) and the delivery-date column came back named
// `DeliveryDate` where the first cut had called it `DelivDate`.
// `import-ac-outstanding-po.mjs` still read `l.DelivDate`, which is not an
// error in JavaScript — it is `undefined`, so 338 of 338 lines imported with a
// blank delivery date and nothing anywhere said so. Reading a renamed key
// through a named accessor makes the rename a TEST failure instead of a silent
// column of NULLs (tests/acPoLineRepair.node.mjs asserts the accessor still
// resolves on every row of the committed snapshots).
//
// Both spellings are accepted on purpose: the older export is still committed
// in other data files, and a reader that only knows the new name would rot the
// same way in the other direction.

/** Every key an export has ever used for PODTL.DeliveryDate, newest first. */
export const AC_PO_DELIVERY_DATE_KEYS = ["DeliveryDate", "DelivDate"];

/* `YYYY-MM-DD` from either shape a date reaches us in: the export's
   "2026-08-15 00:00:00" text, or the JS Date the postgres driver returns for a
   `date` column. The Date case is not hypothetical — `String(date).slice(0,10)`
   yields "Tue Mar 25", which sorts wrong and is not a value any date column
   accepts. Anything else is null, never a guess. */
export function isoDate(v) {
  if (v === null || v === undefined || v === "") return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  const s = String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

/** `YYYY-MM-DD`, or null when the line genuinely carries no delivery date. */
export function acDeliveryDate(line) {
  for (const k of AC_PO_DELIVERY_DATE_KEYS) {
    const d = isoDate(line?.[k]);
    if (d) return d;
  }
  return null;
}

/** PODTL.DtlKey as a number — the bigint PRIMARY KEY of the AutoCount line. */
export function acDtlKey(line) {
  const n = Number(line?.DtlKey);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** PODTL.FromSODtlKey as a string, or null. 0 means "not raised from an SO". */
export function acFromSoDtlKey(line) {
  const v = line?.FromSODtlKey;
  if (v === null || v === undefined || v === "") return null;
  const s = String(v).trim();
  return s && s !== "0" ? s : null;
}

/* The two PO exports overlap: ac-so-linked-pos.json.gz and
   ac-outstanding-po.json.gz name 121 of the same documents and 179 of the same
   DETAIL rows. DtlKey is the primary key of PODTL, so it is the identity that
   de-duplicates them; earlier arguments win, so the caller decides which export
   is authoritative by argument order. */
export function mergeAcPoLines(...rowSets) {
  const byKey = new Map();
  for (const rows of rowSets) {
    for (const r of rows ?? []) {
      const k = acDtlKey(r);
      if (k === null) continue;
      if (!byKey.has(k)) byKey.set(k, r);
    }
  }
  return byKey;
}
