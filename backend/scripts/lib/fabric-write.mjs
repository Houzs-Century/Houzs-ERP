/* The write side of the fabric library, in ONE place.

   Two scripts change fabric rows now - seed-owner-fabric-catalogue.mjs and
   normalize-fabric-codes.mjs - and both have to reach every table whose
   `variants` block can name a fabric. #1964 found the GRN arm unswept by a
   sweep that only knew about two of them, and #1893 had to undo five copies of
   the colour matcher that had drifted apart. So the arm list and the two
   repoints live here, imported, never re-typed.

   THE JSONB WRITE IS jsonb_set + to_jsonb($1::text), NEVER a bound object.
   Binding a pre-serialized string to a jsonb parameter is what destroyed the
   variants column three times on 2026-08-10 - docs/jsonb-double-encoding-coe.md.
   to_jsonb($1::text) is built server-side from a plain text parameter, so no
   JSON serializer can run over it. */

/* Table names are literal constants interpolated as identifiers because an
   identifier cannot be a bind parameter; every VALUE below is still bound.

   The company test is an EXISTS, not a JOIN, so one clause serves the count and
   the UPDATE. An UPDATE ... FROM would need a surrogate key on the item table,
   and scm.mfg_sales_orders is keyed by doc_no with no id column at all (#1854). */
/* FOUR ARMS WAS NEVER THE WHOLE SYSTEM. A 2026-08-13 source audit of every
   table in the schema found fifteen line tables carrying a `variants` jsonb
   that can name a fabric colour. The four below were the whole list until then,
   which is why the catalogue has been "cleaned" repeatedly and never came out
   clean — and why the owner said 「确保真的是干净的。因为这个东西做了很多次了」.

   THE NEW ARMS TEST THE LINE'S OWN company_id, the four originals keep their
   header EXISTS. Migration 0083 stamps company_id NOT NULL on all 100 of these
   tables (verified: every table below is in its ALTER list), so the item column
   is a complete and correct predicate. The originals are left on the header
   test deliberately — they are proven in production, and switching them would
   silently change which rows are swept on any row whose item company disagrees
   with its header's. Prove that set is empty before unifying them. */
export const ARMS = [
  { name: "SO", t: "scm.mfg_sales_order_items", ex: "SELECT 1 FROM scm.mfg_sales_orders h WHERE h.doc_no = i.doc_no AND h.company_id = $1" },
  { name: "PO", t: "scm.purchase_order_items", ex: "SELECT 1 FROM scm.purchase_orders h WHERE h.id = i.purchase_order_id AND h.company_id = $1" },
  { name: "GRN", t: "scm.grn_items", ex: "SELECT 1 FROM scm.grns h WHERE h.id = i.grn_id AND h.company_id = $1" },
  { name: "DO", t: "scm.delivery_order_items", ex: "SELECT 1 FROM scm.delivery_orders h WHERE h.id = i.delivery_order_id AND h.company_id = $1" },

  // the two invoice arms — snapshot copies of a swept parent, never swept
  { name: "SI", t: "scm.sales_invoice_items", ex: "SELECT 1 WHERE i.company_id = $1" },
  { name: "PI", t: "scm.purchase_invoice_items", ex: "SELECT 1 WHERE i.company_id = $1" },
  // both return arms
  { name: "PRT", t: "scm.purchase_return_items", ex: "SELECT 1 WHERE i.company_id = $1" },
  { name: "DRT", t: "scm.delivery_return_items", ex: "SELECT 1 WHERE i.company_id = $1" },
  // the consignment module (mig 0153) — a clone of the SO/DO chain
  { name: "CSO", t: "scm.consignment_sales_order_items", ex: "SELECT 1 WHERE i.company_id = $1" },
  { name: "CDO", t: "scm.consignment_delivery_order_items", ex: "SELECT 1 WHERE i.company_id = $1" },
  { name: "CDRT", t: "scm.consignment_delivery_return_items", ex: "SELECT 1 WHERE i.company_id = $1" },
  // the purchase-consignment module (mig 0090 / 0154)
  { name: "PCO", t: "scm.purchase_consignment_order_items", ex: "SELECT 1 WHERE i.company_id = $1" },
  { name: "PCR", t: "scm.purchase_consignment_receive_items", ex: "SELECT 1 WHERE i.company_id = $1" },
  { name: "PCRT", t: "scm.purchase_consignment_return_items", ex: "SELECT 1 WHERE i.company_id = $1" },
  // the stock ledger's own line, which also carries variants + description2
  { name: "MOV", t: "scm.inventory_movements", ex: "SELECT 1 WHERE i.company_id = $1" },
];

/* ASK THE DATABASE WHAT EXISTS — NEVER A SCHEMA FILE.
   backend/scripts/scm-schema/2990s-full-schema.sql is a point-in-time DUMP and
   the migrations are a history, not a state; a column added, renamed or dropped
   since either one leaves both of them lying. An arm list checked against a
   file is how a sweep ends up issuing `SELECT description2` against a table
   that never had it, or — far worse — quietly skipping a table that does.

   So the arms are RESOLVED AGAINST THE LIVE CATALOG before any of them runs,
   and whatever is dropped is returned to the caller, which must print it. A
   sweep that silently narrows itself is exactly the failure this file exists to
   stop. Owner 2026-08-13: 「直接去查看源代码，不要再查看它的文档了」. */
export async function resolveArms(client, arms, needed) {
  const live = await client.unsafe(
    `SELECT n.nspname || '.' || c.relname AS t, a.attname AS col
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      WHERE c.relkind IN ('r','p')`, []);
  const cols = new Map();
  for (const r of live) {
    if (!cols.has(r.t)) cols.set(r.t, new Set());
    cols.get(r.t).add(r.col);
  }
  const ok = [], skipped = [];
  for (const arm of arms) {
    const have = cols.get(arm.t);
    if (!have) { skipped.push({ ...arm, why: "table not in this database" }); continue; }
    const missing = needed(arm).filter((c) => !have.has(c));
    if (missing.length) { skipped.push({ ...arm, why: `no column ${missing.join(", ")}` }); continue; }
    ok.push(arm);
  }
  return { ok, skipped };
}

/** What each sweep needs on an arm before it can run. An arm whose company test
 *  reads the LINE's own column also needs that column to exist; the four
 *  original arms reach their company through a header and do not. */
const ownCompany = (arm) => (/i\.company_id/.test(arm.ex ?? "") ? ["company_id"] : []);
export const VARIANT_ARM_COLS = (arm) => ["variants", ...ownCompany(arm)];
export const DESC2_ARM_COLS = (arm) => ["description2", ...ownCompany(arm)];
export const VKEY_ARM_COLS = (arm) => [arm.c, "company_id"];

/* The helpers below resolve their own arms rather than trusting a caller to
   remember. Three scripts already import them, and adding eleven arms to a list
   they iterate blindly is precisely how "extend the shared thing" becomes
   "break the callers" — one of them WAS about to die on `SELECT undefined`
   because it assumed the list held exactly four names it knew.

   Resolved once per process (one database per process) and memoised. Anything
   dropped is retrievable through skippedArms() so a run can PRINT what it did
   not sweep — a sweep that silently narrows itself is the original sin here. */
let _resolved = null;
const _skipped = [];
async function armsFor(client, kind) {
  if (!_resolved) {
    const [v, d, k] = await Promise.all([
      resolveArms(client, ARMS, VARIANT_ARM_COLS),
      resolveArms(client, ARMS, DESC2_ARM_COLS),
      resolveArms(client, VKEY_ARMS, VKEY_ARM_COLS),
    ]);
    _resolved = { variants: v.ok, desc2: d.ok, vkey: k.ok };
    for (const [kind2, res] of [["variants", v], ["description2", d], ["variant_key", k]]) {
      for (const s of res.skipped) _skipped.push({ kind: kind2, table: s.t, why: s.why });
    }
  }
  return _resolved[kind];
}
/** Every arm that was dropped at resolve time, and why. Callers MUST print it. */
export const skippedArms = () => _skipped.slice();

/* THE ALIAS CHAIN. `fabricCode` is canonical, but the GRN / purchase-invoice /
   purchase-return editors write `fabricColor`, and POS writes `colorCode` /
   `colourCode` / `colourId` (so-variant-rule.ts fabricCode aliases, plus
   allowed-options-check.ts for colourId). A sweep that matches only fabricCode
   reports an arm CLEAN while it is still dirty — which is the second half of
   why the previous passes missed rows. Every count and every repoint below
   walks all five, and a repoint writes back to WHICHEVER KEY THE ROW CARRIES:
   normalising the key as a side effect of a colour merge would be a second,
   unasked-for migration hiding inside this one. */
export const COLOUR_ALIASES = ["fabricCode", "colorCode", "colourCode", "fabricColor", "colourId"];

/* Tables whose variant_key MATERIALISES the colour into a physical stock
   bucket, as `fabriccode=<lowercased>` inside a pipe-joined key. It is compared,
   never recomputed (mig 0230 says so of committed_variant_key), so stock does
   NOT follow the document unless these move too — repoint a line without them
   and its sofa detaches from its own on-hand and reappears as a shortage. */
export const VKEY_ARMS = [
  { name: "MOV", t: "scm.inventory_movements", c: "variant_key" },
  { name: "LOT", t: "scm.inventory_lots", c: "variant_key" },
  { name: "LOTC", t: "scm.inventory_lot_consumptions", c: "variant_key" },
  { name: "XFER", t: "scm.stock_transfer_lines", c: "variant_key" },
  { name: "TAKE", t: "scm.stock_take_lines", c: "variant_key" },
  { name: "RACK", t: "scm.warehouse_rack_items", c: "variant_key" },
  { name: "RACKM", t: "scm.warehouse_rack_movements", c: "variant_key" },
  { name: "DO-COMMIT", t: "scm.delivery_order_items", c: "committed_variant_key" },
];

/* How many live lines name this colour string / this series id. */
export const countBy = async (client, co, field, value) => Promise.all((await armsFor(client, 'variants')).map(async (arm) => {
  const r = await client.unsafe(
    `SELECT COUNT(*)::int AS n FROM ${arm.t} i
      WHERE EXISTS (${arm.ex}) AND jsonb_typeof(i.variants) = 'object'
        AND i.variants->>'${field}' = $2`, [co, value]);
  return { arm: arm.name, n: r[0].n };
}));

/* Counting a COLOUR must walk the whole alias chain — see COLOUR_ALIASES. */
export const countColour = async (client, co, code) => Promise.all((await armsFor(client, 'variants')).map(async (arm) => {
  const r = await client.unsafe(
    `SELECT COUNT(*)::int AS n FROM ${arm.t} i
      WHERE EXISTS (${arm.ex}) AND jsonb_typeof(i.variants) = 'object'
        AND (${COLOUR_ALIASES.map((k) => `i.variants->>'${k}' = $2`).join(" OR ")})`, [co, code]);
  return { arm: arm.name, n: r[0].n };
}));
export const countSeries = (client, co, id) => countBy(client, co, "fabricId", id);

/* COUNT MANY COLOURS IN ONE PASS, because counting them one at a time stopped
   being viable the moment the arm list went from 4 to 15.

   normalize-fabric-codes asks for a reference count PER CODE, and the library
   holds ~800 of them: 800 x 15 arms is twelve thousand round trips, and a prod
   plan run that used to finish in a minute was still going after fifteen. The
   widening was right; the per-code loop behind it was not.

   One query per arm, GROUP BY the colour the row actually carries, restricted
   to the codes asked for. Returns Map<UPPERCASE code, total across all arms> —
   uppercase because the callers hold normColour'd codes and a Map is
   case-sensitive where the comparison should not be.

   The COALESCE picks whichever alias the row uses, in the same order
   COLOUR_ALIASES declares, so a row is counted once and under one name even
   when it carries two of them. */
export const countColoursBulk = async (client, co, codes) => {
  const want = [...new Set(codes.map((c) => String(c).trim()).filter(Boolean))];
  const out = new Map(want.map((c) => [c.toUpperCase(), 0]));
  if (!want.length) return out;
  const pick = `COALESCE(${COLOUR_ALIASES.map((k) => `i.variants->>'${k}'`).join(", ")})`;
  for (const arm of await armsFor(client, "variants")) {
    const rows = await client.unsafe(
      `SELECT ${pick} AS code, COUNT(*)::int AS n FROM ${arm.t} i
        WHERE EXISTS (${arm.ex}) AND jsonb_typeof(i.variants) = 'object'
          AND ${pick} = ANY($2)
        GROUP BY 1`, [co, want]);
    for (const r of rows) {
      const k = String(r.code).toUpperCase();
      out.set(k, (out.get(k) ?? 0) + r.n);
    }
  }
  return out;
};

/* Move every live line from one colour string to another, on every alias the
   row might be carrying it under, writing back to that same key. */
export const repointColour = async (client, co, from, to) => Promise.all((await armsFor(client, 'variants')).map(async (arm) => {
  let n = 0;
  for (const key of COLOUR_ALIASES) {
    const r = await client.unsafe(
      `UPDATE ${arm.t} i
          SET variants = jsonb_set(i.variants, '{${key}}', to_jsonb($3::text))
        WHERE EXISTS (${arm.ex}) AND jsonb_typeof(i.variants) = 'object'
          AND i.variants->>'${key}' = $2`, [co, from, to]);
    n += r.count;
  }
  return { arm: arm.name, n };
}));

/* THE PRINTED TEXT. description2 is a STORED render of the variant summary, and
   every PDF prints it; nothing recomputes it at read time. Repointing variants
   without touching it leaves the SO line saying M2402-08 while its own printed
   line, and every DO / invoice derived from it, still says M2402-8-YELLOW.

   This SUBSTITUTES the code rather than re-rendering. Re-rendering would mean a
   second copy of buildVariantSummary in SQL, and a second copy is exactly how
   the colour matcher drifted into five versions (#1893). The substitution is
   bounded by a non-alphanumeric on each side so "M2402-08" cannot match inside
   "M2402-081". Its limit, stated rather than hidden: if the two colours also
   carry different NAMES, the name text in description2 stays stale — which is
   why a merge whose colour names disagree must be refused, not patched here. */
export const repointDescription2 = async (client, co, from, to) => Promise.all((await armsFor(client, 'desc2')).map(async (arm) => {
  const r = await client.unsafe(
    `UPDATE ${arm.t} i
        SET description2 = regexp_replace(description2, $2, '\\1' || $3 || '\\2', 'g')
      WHERE EXISTS (${arm.ex}) AND description2 ~ $2`,
    [co, `(^|[^A-Za-z0-9])${from.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")}([^A-Za-z0-9]|$)`, to]);
  return { arm: arm.name, n: r.count };
}));

/* THE STOCK BUCKET. Move the colour inside every materialised variant_key, or
   the documents move and the stock does not. Company-scoped on the line's own
   column (0083 stamps all of these NOT NULL). */
export const repointVariantKey = async (client, co, from, to) => Promise.all((await armsFor(client, 'vkey')).map(async (arm) => {
  const r = await client.unsafe(
    `UPDATE ${arm.t}
        SET ${arm.c} = replace(${arm.c}, 'fabriccode=' || $2, 'fabriccode=' || $3)
      WHERE company_id = $1
        AND ('|' || COALESCE(${arm.c}, '') || '|') LIKE ('%|fabriccode=' || $2 || '|%')`,
    [co, String(from).toLowerCase(), String(to).toLowerCase()]);
  return { arm: arm.name, n: r.count };
}));

/* THE MODEL'S WHITELIST. product_models.allowed_options->'fabrics' is the ON/OFF
   authority for which colours a model offers. Leave a retired code in it and the
   SURVIVOR is unpickable — and on the OCR scan path that does not error, it
   silently degrades the line. Rewrites the array element in place and
   de-duplicates, so a model already holding both ends up with one. */
export const repointAllowedOptions = async (client, co, from, to) => {
  const r = await client.unsafe(
    `UPDATE scm.product_models
        SET allowed_options = jsonb_set(allowed_options, '{fabrics}', (
              SELECT COALESCE(jsonb_agg(DISTINCT v), '[]'::jsonb)
                FROM jsonb_array_elements_text(allowed_options->'fabrics') e,
                     LATERAL (SELECT CASE WHEN e = $2 THEN $3 ELSE e END AS v) x))
      WHERE company_id = $1
        AND jsonb_typeof(allowed_options->'fabrics') = 'array'
        AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(allowed_options->'fabrics') e WHERE e = $2)`,
    [co, from, to]);
  return { arm: "MODELS", n: r.count };
};

/* Move every live line from one series id to another. `onlyColour` narrows it
   to the lines that also carry that colour, which is what a single colour's
   re-parent needs - the rest of the old series' lines are not ours to move. */
export const repointSeries = async (client, co, from, to, onlyColour = null) => Promise.all((await armsFor(client, 'variants')).map(async (arm) => {
  const extra = onlyColour ? ` AND i.variants->>'fabricCode' = $4` : "";
  const args = onlyColour ? [co, from, to, onlyColour] : [co, from, to];
  const r = await client.unsafe(
    `UPDATE ${arm.t} i
        SET variants = jsonb_set(i.variants, '{fabricId}', to_jsonb($3::text))
      WHERE EXISTS (${arm.ex}) AND jsonb_typeof(i.variants) = 'object'
        AND i.variants->>'fabricId' = $2${extra}`, args);
  return { arm: arm.name, n: r.count };
}));

export const sum = (rows) => rows.reduce((a, b) => a + b.n, 0);
export const busy = (rows) => rows.filter((x) => x.n).map((x) => `${x.arm}:${x.n}`).join(" ");

/* No variants block anywhere may have been turned into an ARRAY by a bad jsonb
   write. This is the shape the 2026-08-10 COE is about, and every writer here
   has to prove it did not happen. */
export const arrayShapeCheck = async (client, co) => Promise.all((await armsFor(client, 'variants')).map(async (arm) => {
  const r = await client.unsafe(
    `SELECT COUNT(*)::int AS n FROM ${arm.t} i
      WHERE EXISTS (${arm.ex}) AND jsonb_typeof(i.variants) = 'array'`, [co]);
  return { arm: arm.name, n: r[0].n };
}));
