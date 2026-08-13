/* EVERY place a fabric COLOUR code is stored, and how to count it there.

   WHY THIS FILE EXISTS. The write side (fabric-write.mjs) reaches the tables a
   sweep must REPAIR. This file is the wider census: it also names the masters,
   the whitelists, the carts and the history blobs — everywhere a retired code
   can still be READ from — so a merge can be proved complete rather than
   assumed complete. As of 2026-08-13 that is 58 carriers, 51 of them live.

   THE ARM LISTS BELOW ARE IMPORTED, NEVER RE-TYPED. This file used to declare
   its own copy of the fifteen line tables, the eight variant_key buckets and
   the five-key colour alias chain, beside the copies fabric-write.mjs already
   held. Two lists for one fact is how the GRN arm went unswept in #1964, how
   five copies of the colour matcher drifted apart in #1893, and how extending
   the shared arm list from 4 to 15 did nothing for a merger that was not
   reading it. Add an arm in fabric-write.mjs and it appears here for free.

   NOTHING IN THE DATABASE WILL CATCH A MISS. There is not one foreign key to
   scm.fabric_colours; every reference is an unenforced TEXT string inside jsonb
   or inside a pipe-joined key. So this list IS the safety mechanism, and the
   only honest way to prove a merge is complete is to COUNT the retired code in
   every carrier and require zero. Not to reason that it must be zero.

   LIVE vs HISTORY. A snapshot, an audit log and an outbox payload are supposed
   to still say what they said at the time — rewriting them would be forging the
   record. They are counted and REPORTED, never required to be zero, and never
   rewritten. Everything else is live and must reach zero.

   HOW A COLOUR HIDES, by carrier kind:
     variants  a jsonb line bag. The canonical key is fabricCode, but the GRN /
               purchase-invoice / purchase-return editors write fabricColor and
               POS writes colorCode / colourCode / colourId. Matching only
               fabricCode is how an arm reports clean while still dirty.
     vkey      the physical stock bucket: a pipe-joined key with the colour
               embedded as `fabriccode=<lowercased code>`. MATERIALISED at post
               time and compared, never recomputed — stock does not follow the
               document unless this moves too.
     text      description2 / variant_label — rendered text that prints the code
               BARE on every PDF. Stored, not derived at read time.
     jsonarr   product_models.allowed_options->'fabrics' — the ON/OFF whitelist
               of colours a model offers. A retired code left here makes the
               SURVIVOR unpickable; on the scan path that fails silently.
     col       a plain text column holding the code itself.
     blob      a whole jsonb document searched as text — used for history. */

import { ARMS, VKEY_ARMS, COLOUR_ALIASES } from './fabric-write.mjs';

/** The alias chain the app treats as ONE fabric axis. Order matters only for
 *  reporting; a row is dirty if ANY of them names the code.
 *  ONE definition, in fabric-write.mjs, which is where the repoints that write
 *  these keys back live — a census that walked a different chain than the
 *  repair would report clean rows the repair had never touched. Re-exported so
 *  census-fabric-colour.mjs keeps importing it from here. */
export const COLOUR_KEYS = COLOUR_ALIASES;

/** Line tables carrying a `variants` jsonb. Each also carries description2.
 *  Derived from fabric-write.mjs's ARMS — the same fifteen tables the repair
 *  sweeps, in the same order. The census must not be able to know a table the
 *  repair does not, nor the reverse; that gap IS the bug this pair keeps
 *  producing. Only the NAMES are taken: an arm's `ex` is a company predicate
 *  written for a bound $1, and this file builds its own predicates per kind.
 *
 *  Every one of these has its own company_id (migrations 0083 / 0089 / 0090),
 *  which is what the caller filters on: the service-role client bypasses RLS,
 *  so that predicate is the only isolation. */
const LINE_TABLES = ARMS.map((a) => a.t);

/** Tables whose variant_key materialises the colour into a stock bucket —
 *  fabric-write.mjs's VKEY_ARMS, name and column, nothing else. Includes the
 *  ship commitment's frozen bucket, compared and never recomputed (mig 0230). */
const VKEY_TABLES = VKEY_ARMS.map((a) => [a.t, a.c]);

export const CARRIERS = [
  ...LINE_TABLES.map((t) => ({ table: t, kind: 'variants', col: 'variants', live: true })),
  ...LINE_TABLES.map((t) => ({ table: t, kind: 'text', col: 'description2', live: true })),
  ...VKEY_TABLES.map(([t, c]) => ({ table: t, kind: 'vkey', col: c, live: true })),
  { table: 'scm.stock_take_lines', kind: 'text', col: 'variant_label', live: true },

  // the masters
  { table: 'scm.fabric_colours', kind: 'col', col: 'colour_id', live: true },
  { table: 'scm.fabric_trackings', kind: 'col', col: 'fabric_code', live: true },

  // what a model is ALLOWED to offer, and what a SKU defaults to
  { table: 'scm.product_models', kind: 'jsonarr', col: "allowed_options->'fabrics'", live: true },
  { table: 'scm.mfg_products', kind: 'col', col: 'fabric_color', live: true },
  { table: 'scm.mfg_products', kind: 'variants', col: 'default_variants', live: true },

  // open amendments are LIVE intent — they will be applied to a document
  { table: 'scm.so_amendment_lines', kind: 'variants', col: 'new_variants', live: true },
  { table: 'scm.po_amendment_lines', kind: 'variants', col: 'new_variants', live: true },

  // a queued push would replay the retired colour into AutoCount
  { table: 'scm.autocount_outbox', kind: 'blob', col: 'payload', live: true },

  // in-progress carts are live, not history
  { table: 'scm.quotes', kind: 'blob', col: 'cart', live: true },
  { table: 'scm.pos_carts', kind: 'blob', col: 'lines', live: true },

  // legacy POS-era columns — value space unproven, so counted and surfaced
  { table: 'scm.purchase_order_lines', kind: 'col', col: 'colour', live: true },
  { table: 'scm.order_items', kind: 'blob', col: 'config', live: true },

  /* HISTORY — reported, never required to be zero, never rewritten. Rewriting
     an audit row or a frozen revision would be forging the record. */
  { table: 'scm.so_revisions', kind: 'blob', col: 'snapshot', live: false },
  { table: 'scm.po_revisions', kind: 'blob', col: 'snapshot', live: false },
  { table: 'scm.po_amendment_lines', kind: 'blob', col: 'old_snapshot', live: false },
  { table: 'scm.mfg_so_audit_log', kind: 'blob', col: 'field_changes', live: false },
  { table: 'scm.entity_audit_log', kind: 'blob', col: 'field_changes', live: false },
  { table: 'scm.so_scan_samples', kind: 'blob', col: 'extracted', live: false },
  { table: 'scm.so_scan_samples', kind: 'blob', col: 'corrected', live: false },
];

/** LIKE-escape: % _ and the escape char itself. Fabric codes really do contain
 *  '#' (XQ#18) and '_' is legal, so a raw LIKE pattern is not safe. */
export const likeEscape = (s) => String(s).replace(/([\\%_])/g, '\\$1');

/** Regex-escape for the `text` kind, with the non-alphanumeric boundaries. */
export const boundedRegex = (code) =>
  `(^|[^A-Za-z0-9])${String(code).replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}([^A-Za-z0-9]|$)`;
