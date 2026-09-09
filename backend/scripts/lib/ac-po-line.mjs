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

/* ── the SO -> PO dedication rule, stated ONCE ─────────────────────────────
   `purchase_order_items.so_item_id` is what makes a bedframe or sofa line
   READY: those lines are HARD-BOUND (`isHardBoundLine`,
   src/scm/lib/so-stock-allocation.ts) and light only through their OWN
   dedicated purchase order's received_qty, never through the pooled balance.
   So a dedication is not bookkeeping — it decides what the floor is told is
   ready to ship, and a wrong one lights the wrong bed.

   AutoCount's own evidence is the DtlKey pair: PODTL.FromSODtlKey names the
   SODTL row the buyer transferred from. That pair is sound — checked against
   the 2026-09-07T09:35Z truth snapshot, every PO line involved in the incident
   below resolves to an SO line with a BYTE-IDENTICAL item code.

   WHAT WAS MISSING was the assertion that OUR two rows agree. sync-ac-delta's
   lane `links` resolved both ends by `linked_ac_dtlkey` and wrote the
   dedication on the key pair alone. Run 34123720786 (2026-09-07 12:46Z,
   mode=apply) wrote 10; the sofa chain audit's SO->PO code mismatch went 0
   (11:54Z) -> 9 (14:02Z), and all nine bind a sales-order line to a
   purchase-order line for a different bed: REGAL (A)-(K) to a
   TRION (A) (HB STR)-(K), CODY-(Q) to a JAGER-(Q), JAGER-(Q) to a JAGER-(SS).
   The book and autocount-erp-mapping-1561.csv both agree with the PURCHASE
   ORDER, so the disagreement is between our own two rows.

   UNDER-REPAIR, NEVER WRONG-LINK — the same rule buildMigratedDoPlan states for
   the delivery matcher, for the same reason: a wrong link is worse than none,
   because it then reads as evidence. */

export const normItemCode = (s) => String(s ?? "").trim().toUpperCase().replace(/\s+/g, " ");

/**
 * Which SO->PO dedications may be written, and why each of the rest may not.
 *
 * `edges`      AutoCount PODTL rows (DocNo, DtlKey, FromDocNo, FromSODtlKey)
 * `soItemByDtl`/`poItemByDtl`  ERP lines keyed by `linked_ac_dtlkey` (string)
 * `alreadyClaimed`  SO line ids some PO line already dedicates (strings)
 *
 * Returns { plan, missing, mismatch } — `plan` is what to write, and the other
 * two are the reasons, kept apart because they need different answers: a
 * `missing` is an import that has not happened yet, a `mismatch` is a
 * disagreement inside the ERP that a person has to settle.
 */
export function planSoPoDedications({ edges, soItemByDtl, poItemByDtl, alreadyClaimed = new Set() }) {
  const claimed = new Set([...alreadyClaimed].map(String));
  const plan = [];
  const missing = [];
  const mismatch = [];
  for (const e of edges ?? []) {
    const key = acFromSoDtlKey(e);
    if (key == null) continue;
    const pi = poItemByDtl.get(String(e.DtlKey));
    const si = soItemByDtl.get(String(key));
    if (!pi) { missing.push({ po: e.DocNo, why: "the PO line is not in the ERP yet (import it first)" }); continue; }
    if (!si) { missing.push({ po: e.DocNo, why: `the SO line ${key} (${e.FromDocNo}) is not in the ERP` }); continue; }
    if (pi.so_item_id) continue;
    if (claimed.has(String(si.id))) { missing.push({ po: e.DocNo, why: `SO line ${key} is already dedicated to another PO line` }); continue; }
    if (normItemCode(si.item_code) !== normItemCode(pi.item_code)) {
      mismatch.push({
        po: e.DocNo, poNo: pi.po_number, soNo: e.FromDocNo, soDoc: si.doc_no,
        poItemId: String(pi.id), soItemId: String(si.id), soDtl: String(key), poDtl: String(e.DtlKey),
        soCode: si.item_code, poCode: pi.item_code,
      });
      continue;
    }
    claimed.add(String(si.id));
    plan.push({ poItemId: pi.id, soItemId: si.id, poNo: pi.po_number, soNo: e.FromDocNo });
  }
  return { plan, missing, mismatch };
}
