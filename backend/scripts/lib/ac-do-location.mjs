/* THE ONE RULE that answers "which branch shipped this AutoCount delivery note",
   shared by the two places that need it — create-migrated-documents.mjs, which
   stamps it on a document as it is written, and
   backfill-migrated-do-warehouse.mjs, which stamps it on the ones already
   written. A second copy of a location map (or of the rule that reads one) is
   how stock silently moves between branches in one script and not the other;
   lib/ac-stock-compare.mjs says so about SALESLOC itself, and this file exists
   so the same thing does not happen one layer up.

   OWNER RULING 2026-09-07, "记在单头就好" — the delivery location lives on the DO
   HEADER, never on a per-line column. Measured on data/ac-fidelity-do-*.json.gz
   BEFORE asking, which is why the question was worth asking: a line's Location
   equals its header's SalesLocation on 46,182 of 46,194 non-blank book lines,
   and only 2 of 11,134 documents span two locations (DO-000140 PG+HQ,
   DO-000153 KL+SUNWAY). A per-line column would carry 46,194 values to express
   11,134 facts.

   THE ORDER, and it never guesses:
     1. the book's own DO header field (SalesLocation).
     2. the document's own line Locations, and ONLY when they are unanimous.
        The header snapshot runs ~307 documents behind the book, so 19 of the
        cutover cut's 84 have no header row; all 19 are unanimous, and where
        BOTH sources exist they agree on 65 of 65.
     3. nothing. `id` comes back null with a `why` the caller must PRINT. An
        unresolved location stays visibly absent — never a company-blind
        default, because a wrong warehouse reads as another branch's stock.

   The map is the SHARED SALESLOC (AutoCount location -> ERP warehouse CODE),
   the same one the PO importer's whId() uses. The resolution onto a warehouse
   row is resolve-warehouse-location.mjs — the tested spec of migration 0309's
   backfill: CODE first, then NAME, company-scoped, unambiguous only.

   NO SHEBANG — imported by backend/tests/acDoLocation.test.mjs. */
import { SALESLOC } from './ac-stock-compare.mjs';
import { resolveWarehouseLocation } from './resolve-warehouse-location.mjs';

const norm = (s) => (s || '').trim().toUpperCase().replace(/\s+/g, ' ');

/**
 * @param {string} acDoNo            the AutoCount delivery note number
 * @param {Map<string,string>} hdrLoc   DocNo -> the book header's SalesLocation
 * @param {Map<string,Set<string>>} lineLocs DocNo -> the distinct line Locations
 * @param {Array<{id:string, code?:string|null, name?:string|null}>} warehouses
 *        candidates ALREADY scoped to the delivery's company
 * @returns {{ warehouseId: string|null, salesLocation: string|null,
 *             bookLocation: string|null, source: 'header'|'lines'|null,
 *             why: string|null }}
 *   `salesLocation` is the ERP warehouse code the location mapped to, and is
 *   written BESIDE `warehouseId` from this same answer so the stored text and
 *   the stored id can never tell a reader different things.
 */
export function resolveAcDeliveryLocation(acDoNo, hdrLoc, lineLocs, warehouses) {
  const miss = (why) => ({ warehouseId: null, salesLocation: null, bookLocation: null, source: null, why });

  let bookLocation = (hdrLoc.get(acDoNo) ?? '').trim() || null;
  let source = bookLocation ? 'header' : null;
  if (!bookLocation) {
    const seen = lineLocs.get(acDoNo);
    if (seen && seen.size === 1) { bookLocation = [...seen][0]; source = 'lines'; }
    else if (seen && seen.size > 1) {
      return miss(`the book gives no header location and this document's lines disagree (${[...seen].join(' + ')})`);
    }
  }
  if (!bookLocation) return miss('the book snapshots carry no location for this document');

  const erpCode = SALESLOC[norm(bookLocation)] ?? bookLocation.trim();
  const hit = resolveWarehouseLocation(erpCode, warehouses);
  if (!hit.id) {
    return { ...miss(`location "${bookLocation}" maps to "${erpCode}", which resolves to no single warehouse in this company (${hit.reason})`), bookLocation, source };
  }
  return { warehouseId: hit.id, salesLocation: erpCode, bookLocation, source, why: null };
}

/** The documents the book itself cannot answer with ONE location. Named in
    every run rather than quietly flattened onto their header value — the ruling
    asked for them to stay visible. */
export function mixedLocationDocs(lineLocs) {
  return [...lineLocs].filter(([, s]) => s.size > 1).map(([doc, s]) => ({ doc, locations: [...s] }));
}
