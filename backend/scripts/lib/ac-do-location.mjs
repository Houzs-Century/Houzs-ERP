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

/* ── WHERE THE TWO MAPS COME FROM ────────────────────────────────────────────
   The rule above takes `hdrLoc` and `lineLocs` as arguments and does not care
   which files they were read from. Both callers built them by hand, from the
   same two snapshots, in two places — the second copy the header of this file
   warns about, one layer down. It cost the exact thing it predicted: on
   2026-09-08, 89 of 173 migrated delivery orders had no ship-from branch, and
   the reason was not the rule but the SOURCES. `ac-fidelity-do-headers.json.gz`
   holds 11,134 documents and none of the 89; `ac-partial-dos.json.gz` is a
   369-line projection of the imported orders' deliveries and holds none of them
   either. The book has known all along.

   So the loader lives here, with the rule, and it reads THREE sources:

     1. ac-fidelity-do-headers.json.gz   the book's own DO header field.
     2. ac-partial-dos.json.gz           line Locations of the imported orders'
                                         deliveries.
     3. ac-reconcile-truth.json.gz       line Locations of EVERY delivery note in
                                         the book. `location` is the fourteenth
                                         line field, appended 2026-09-07 and
                                         first actually cut 2026-09-08; a cut
                                         older than that has 13 fields and this
                                         source contributes nothing rather than
                                         reading some other column by position.

   Sources 2 and 3 are UNIONED into the same per-document set, deliberately.
   They are two views of one fact, so agreement is invisible and disagreement
   turns the document mixed — which the rule then refuses instead of picking a
   side. Flattening it would be the guess this whole module exists to avoid. */
export function loadDoLocationSources(dataDir, { readFileSync, gunzipSync, existsSync, join }) {
  const gz = (f) => JSON.parse(gunzipSync(readFileSync(join(dataDir, f))).toString('utf8').replace(/^\uFEFF/, ''));
  const sources = [];

  const hdrLoc = new Map();
  if (existsSync(join(dataDir, 'ac-fidelity-do-headers.json.gz'))) {
    for (const h of gz('ac-fidelity-do-headers.json.gz')) {
      const v = (h.SalesLocation || '').trim();
      if (v) hdrLoc.set(String(h.DocNo).trim(), v);
    }
    sources.push(`ac-fidelity-do-headers.json.gz: ${hdrLoc.size} header location(s)`);
  } else sources.push('ac-fidelity-do-headers.json.gz: ABSENT');

  const lineLocs = new Map();
  const add = (doc, loc) => {
    const d = String(doc || '').trim();
    const v = String(loc || '').trim();
    if (!d || !v) return;
    if (!lineLocs.has(d)) lineLocs.set(d, new Set());
    lineLocs.get(d).add(v);
  };

  if (existsSync(join(dataDir, 'ac-partial-dos.json.gz'))) {
    let n = 0;
    for (const r of gz('ac-partial-dos.json.gz')) { add(r.DoNo, r.Location); n++; }
    sources.push(`ac-partial-dos.json.gz: ${n} line(s)`);
  } else sources.push('ac-partial-dos.json.gz: ABSENT');

  if (existsSync(join(dataDir, 'ac-reconcile-truth.json.gz'))) {
    const t = gz('ac-reconcile-truth.json.gz');
    const fields = t.line_fields || [];
    const di = fields.indexOf('docNo');
    const li = fields.indexOf('location');
    const lines = (t.types && t.types.DO && t.types.DO.lines) || [];
    if (li < 0 || di < 0) {
      /* A cut taken before the column was cut. Saying so is the point: reading
         field 13 of a 13-field row would silently hand back docSubTotal. */
      sources.push(`ac-reconcile-truth.json.gz: cut ${t.exported_at || '(undated)'} carries NO line location — contributes nothing`);
    } else {
      for (const l of lines) add(l[di], l[li]);
      sources.push(`ac-reconcile-truth.json.gz: ${lines.length} DO line(s), cut ${t.exported_at || '(undated)'}`);
    }
  } else sources.push('ac-reconcile-truth.json.gz: ABSENT');

  return { hdrLoc, lineLocs, sources };
}
