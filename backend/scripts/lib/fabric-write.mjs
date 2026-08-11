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
export const ARMS = [
  { name: "SO", t: "scm.mfg_sales_order_items", ex: "SELECT 1 FROM scm.mfg_sales_orders h WHERE h.doc_no = i.doc_no AND h.company_id = $1" },
  { name: "PO", t: "scm.purchase_order_items", ex: "SELECT 1 FROM scm.purchase_orders h WHERE h.id = i.purchase_order_id AND h.company_id = $1" },
  { name: "GRN", t: "scm.grn_items", ex: "SELECT 1 FROM scm.grns h WHERE h.id = i.grn_id AND h.company_id = $1" },
  { name: "DO", t: "scm.delivery_order_items", ex: "SELECT 1 FROM scm.delivery_orders h WHERE h.id = i.delivery_order_id AND h.company_id = $1" },
];

/* How many live lines name this colour string / this series id. */
export const countBy = (client, co, field, value) => Promise.all(ARMS.map(async (arm) => {
  const r = await client.unsafe(
    `SELECT COUNT(*)::int AS n FROM ${arm.t} i
      WHERE EXISTS (${arm.ex}) AND jsonb_typeof(i.variants) = 'object'
        AND i.variants->>'${field}' = $2`, [co, value]);
  return { arm: arm.name, n: r[0].n };
}));

export const countColour = (client, co, code) => countBy(client, co, "fabricCode", code);
export const countSeries = (client, co, id) => countBy(client, co, "fabricId", id);

/* Move every live line from one colour string to another. */
export const repointColour = (client, co, from, to) => Promise.all(ARMS.map(async (arm) => {
  const r = await client.unsafe(
    `UPDATE ${arm.t} i
        SET variants = jsonb_set(i.variants, '{fabricCode}', to_jsonb($3::text))
      WHERE EXISTS (${arm.ex}) AND jsonb_typeof(i.variants) = 'object'
        AND i.variants->>'fabricCode' = $2`, [co, from, to]);
  return { arm: arm.name, n: r.count };
}));

/* Move every live line from one series id to another. `onlyColour` narrows it
   to the lines that also carry that colour, which is what a single colour's
   re-parent needs - the rest of the old series' lines are not ours to move. */
export const repointSeries = (client, co, from, to, onlyColour = null) => Promise.all(ARMS.map(async (arm) => {
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
export const arrayShapeCheck = (client, co) => Promise.all(ARMS.map(async (arm) => {
  const r = await client.unsafe(
    `SELECT COUNT(*)::int AS n FROM ${arm.t} i
      WHERE EXISTS (${arm.ex}) AND jsonb_typeof(i.variants) = 'array'`, [co]);
  return { arm: arm.name, n: r[0].n };
}));
