/* Rename fabric codes, and move them under the series the new code spells.
   NO SHEBANG: backend/tests and backend/tests-pg import this module.

   A fabric code is stored in far more places than scm.fabric_trackings, and no
   foreign key guards any of them (lib/colour-carriers.mjs). Editing the Fabric
   Converter row alone orphans every order line, stock bucket, model pool and
   KPI rule that names the old code, and nothing errors: the price-tier lookup
   falls back to its default.

   A rename can also change the SERIES. The selling library files a code under
   the id its spelling gives (src/scm/lib/fabric-series.ts): KN01 is a series of
   its own, EM-09 belongs to EM. variants.fabricId (the selling tier add-on),
   hr_item_kpi.ref (one bonus per series) and the old fabric_library rows are
   keyed on that id and have to follow.

   planFabricCodeRename is pure: state in, plan out. Whatever it cannot do
   without a business decision is a refusal, and a plan with a refusal writes
   nothing. */
import { parse, canonId } from "./fabric-code.mjs";
import { nonFabricCodeWord } from "./non-fabric-code.mjs";
import {
  ARMS, VKEY_ARMS, COLOUR_ALIASES, resolveArms, VARIANT_ARM_COLS, DESC2_ARM_COLS, VKEY_ARM_COLS,
} from "./fabric-write.mjs";
import { CARRIERS, resolveCarriers, baseCol } from "./colour-carriers.mjs";

/** The selling-library id a code is filed under. Held identical to seriesOf in
 *  src/scm/lib/fabric-series.ts by backend/tests/fabricCodeRenamePlan.test.mjs. */
export const seriesIdOf = (code) => {
  const v = String(code ?? "").trim().toUpperCase();
  const m = /^(.+)[\s-]+\d{1,3}$/.exec(v);
  const head = (m ? m[1] : v.split("-")[0]) || v;
  return head.replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, "") || v;
};

/** The Fabric Converter row id a code is given (routes/fabric-tracking.ts, POST
 *  and bulk-upsert). The CSV export leaves the id out and the import derives it
 *  again, so a row left on its old id comes back as a second row. */
export const trackingIdOf = (code) => String(code ?? "").trim().toUpperCase().replace(/\s+/g, "_");

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
/** Any of the codes, bounded so KN01 cannot match inside KN011 or PKN01. */
export const anyCodeRegex = (codes) => `(^|[^A-Za-z0-9])(${codes.map(esc).join("|")})([^A-Za-z0-9]|$)`;
const oneCodeRegex = (code) => `(?<![A-Za-z0-9])${esc(code)}(?![A-Za-z0-9])`;
const replacement = (s) => String(s).replace(/\\/g, "\\\\");

const uniq = (list) => [...new Set(list)];
const byCode = (a, b) => String(a).localeCompare(String(b), "en", { numeric: true });

/** The variants keys a sweep rewrites. A line holding an old code under any
 *  other key is refused rather than left half renamed. */
const TEXT_KEYS = ["colourLabel", "summary"];
export const HANDLED_VARIANT_KEYS = [...COLOUR_ALIASES, "fabricId", "fabricLabel", ...TEXT_KEYS];

/* The shared carrier list knows where a COLOUR code is stored. A series rename
   also has to see the series ids, the KPI rules and the caches. `writer` marks
   what a run rewrites; `retained` marks the superseded fabric_library rows,
   which stay by rule (nothing is deleted) and are checked for being off. */
const ARM_TABLES = new Set(ARMS.map((a) => a.t));
const sharedWriter = (c) =>
  (c.kind === "variants" && c.col === "variants" && ARM_TABLES.has(c.table))
  || (c.kind === "text" && c.col === "description2" && ARM_TABLES.has(c.table))
  || c.kind === "vkey"
  || (c.table === "scm.product_models" && c.kind === "jsonarr")
  || (c.table === "scm.fabric_colours" && c.col === "colour_id")
  || (c.table === "scm.fabric_trackings" && c.col === "fabric_code")
  || (c.table === "scm.product_request_lines" && c.col === "fabric_code");

export const RENAME_CARRIERS = [
  ...CARRIERS.map((c) => ({ ...c, writer: sharedWriter(c), retained: false })),
  { table: "scm.fabric_colours", kind: "col", col: "fabric_id", live: true, writer: true, retained: false },
  { table: "scm.fabric_trackings", kind: "col", col: "id", live: true, writer: true, retained: false },
  { table: "scm.fabric_library", kind: "col", col: "id", live: true, writer: false, retained: true },
  { table: "scm.fabric_library", kind: "col", col: "label", live: true, writer: false, retained: true },
  { table: "scm.hr_item_kpi", kind: "col", col: "ref", live: true, writer: true, retained: false },
  { table: "scm.hr_item_kpi", kind: "col", col: "label", live: true, writer: true, retained: false },
  { table: "scm.product_fabrics", kind: "col", col: "fabric_id", live: true, writer: false, retained: false },
  // recomputed on their own schedule / a finished scan: reported, never rewritten
  { table: "scm.mrp_snapshots", kind: "blob", col: "result", live: false, writer: false, retained: false },
  { table: "scm.mrp_list_snapshots", kind: "blob", col: "result", live: false, writer: false, retained: false },
  { table: "scm.scan_jobs", kind: "blob", col: "review", live: false, writer: false, retained: false },
];

/** What is wrong with the list itself, before any database is read. */
export function validateRenamePairs(pairs) {
  if (!Array.isArray(pairs) || pairs.length === 0) return ["the rename list is empty"];
  const problems = [];
  for (const p of pairs) {
    for (const side of ["from", "to"]) {
      const c = p?.[side];
      if (typeof c !== "string" || c === "" || c !== c.trim() || c !== c.toUpperCase()) {
        problems.push(`${side} code ${JSON.stringify(c)} must be upper-case text with no padding`);
      }
    }
  }
  if (problems.length) return problems;

  const froms = pairs.map((p) => p.from), tos = pairs.map((p) => p.to);
  for (const [name, list] of [["old", froms], ["new", tos]]) {
    const twice = uniq(list.filter((c, i) => list.indexOf(c) !== i));
    if (twice.length) problems.push(`${name} code listed twice: ${twice.join(", ")}`);
  }
  const both = froms.filter((c) => tos.includes(c));
  if (both.length) problems.push(`a code is both an old and a new code: ${both.join(", ")}`);
  for (const to of tos) {
    const p = parse(to);
    if (!p || canonId(p) !== to || p.series !== seriesIdOf(to)) {
      problems.push(`new code "${to}" is not in the SERIES-NUMBER form${p ? ` (it would be "${canonId(p)}")` : ""}`);
    }
    const word = nonFabricCodeWord(to);
    if (word) problems.push(`new code "${to}" reads as a product (${word}), not a fabric`);
  }
  const series = uniq(tos.map(seriesIdOf));
  if (series.length > 1) problems.push(`the new codes spell more than one series (${series.join(", ")}); rename one series per run`);
  return problems;
}

/** A model's fabric pool with the old codes renamed, in the same order. A pool
 *  entry is a colour code or a series id (shared/fabric-pool.ts); the colour
 *  reading wins, because the 2990 POS reads the pool as colour ids only. */
export function renamePool(pool, pairs, sweepSeries, targetId) {
  const map = new Map(pairs.map((p) => [p.from, p.to]));
  const out = [];
  for (const e of pool) {
    const v = map.get(e) ?? (sweepSeries.includes(e) ? targetId : e);
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

const pricedAs = (r) => [r.tier, r.default_surcharge, r.sofa_tier, r.bedframe_tier].map((v) => v ?? "-").join(" / ");
// The same tuple for a message: the surcharge is money and the run log is
// public, so it is said to exist, not what it is.
const pricedText = (r) => `${r.tier ?? "-"} / sofa ${r.sofa_tier ?? "-"} / bedframe ${r.bedframe_tier ?? "-"}${Number(r.default_surcharge) ? " / with a surcharge" : ""}`;
const unstamped = (label) => String(label ?? "").replace(/\s*\[renamed to .*$/s, "").trim();

/**
 * @param {object} input
 * @param {number} input.companyId
 * @param {Array<{from: string, to: string}>} input.pairs
 * @param {boolean} input.descriptionLeadsWithNewCode refuse a pair whose Fabric
 *   Converter description does not already start with its new code
 * @param {string} input.stamp the date written into a superseded series' label
 * @param {object} input.state what readRenameState returned
 */
export function planFabricCodeRename({ companyId, pairs, descriptionLeadsWithNewCode, stamp, state }) {
  const plan = {
    refusals: validateRenamePairs(pairs),
    masters: "unknown",
    target: null,
    trackingMoves: [],
    colourMoves: [],
    sweepSeries: [],
    seriesLabels: [],
    supersede: [],
    kpi: null,
    pools: [],
    hits: { rewritten: [], retained: [], history: [], unwritable: [] },
    work: false,
  };
  if (plan.refusals.length) return plan;

  const co = Number(companyId);
  const mine = (r) => Number(r.company_id) === co;
  const refuse = (m) => plan.refusals.push(m);
  const froms = pairs.map((p) => p.from);
  const targetId = seriesIdOf(pairs[0].to);

  // ── the masters, pair by pair ───────────────────────────────────────────
  let pending = 0, done = 0;
  for (const p of pairs) {
    const tFrom = state.trackings.filter((r) => r.fabric_code === p.from);
    const tTo = state.trackings.filter((r) => r.fabric_code === p.to);
    const cFrom = state.colours.filter((r) => mine(r) && r.colour_id === p.from);
    const cTo = state.colours.filter((r) => mine(r) && r.colour_id === p.to);
    const isPending = tFrom.length === 1 && tTo.length === 0 && cFrom.length === 1 && cTo.length === 0;
    const isDone = tFrom.length === 0 && tTo.length === 1 && cFrom.length === 0
      && cTo.length === 1 && cTo[0].fabric_id === targetId;
    if (!isPending && !isDone) {
      refuse(`${p.from} -> ${p.to}: the Fabric Converter holds ${tFrom.length} row(s) on the old code and ${tTo.length} on the new, `
        + `the selling library ${cFrom.length} and ${cTo.length}. Expected one old and no new (not renamed yet) or no old and one new (renamed).`);
      continue;
    }
    if (isDone) { done++; continue; }
    pending++;

    const row = tFrom[0];
    const newId = trackingIdOf(p.to);
    if (state.trackings.some((r) => r.id === newId)) refuse(`${p.to}: another Fabric Converter row already has the id "${newId}"`);
    if (state.colours.some((r) => !mine(r) && r.fabric_id === targetId && r.colour_id === p.to)) {
      refuse(`${p.to}: another organisation already holds this colour under series "${targetId}" (the key is global)`);
    }
    const desc = String(row.fabric_description ?? "").trim();
    if (descriptionLeadsWithNewCode && desc !== p.to && !desc.startsWith(`${p.to} `)) {
      refuse(`${p.from}: its description reads "${desc}", which does not lead with ${p.to}`);
    }
    plan.trackingMoves.push({ from: p.from, to: p.to, oldId: row.id, newId, description: desc, supplierCode: row.supplier_code ?? null });
    plan.colourMoves.push({ from: p.from, to: p.to, fromSeries: cFrom[0].fabric_id, label: cFrom[0].label ?? null });
  }
  if (pending && done) refuse(`${done} of ${pairs.length} codes are renamed already and ${pending} are not; this list is renamed as one piece`);
  plan.masters = pending && done ? "mixed" : pending ? "pending" : done ? "done" : "unknown";

  // ── the series ──────────────────────────────────────────────────────────
  const movedSeries = uniq(plan.colourMoves.map((m) => m.fromSeries)).filter((s) => s !== targetId);
  plan.sweepSeries = uniq([...froms.map(seriesIdOf), ...movedSeries]).filter((s) => s !== targetId);
  const libraryRow = (id) => state.library.find((r) => r.id === id) ?? null;

  for (const s of plan.sweepSeries) {
    const row = libraryRow(s);
    if (row && !mine(row)) { refuse(`series "${s}" belongs to another organisation`); continue; }
    if (!row && movedSeries.includes(s)) { refuse(`series "${s}" holds colours but has no fabric_library row`); continue; }
    const others = state.seriesColours.filter((c) => c.fabric_id === s && !(mine(c) && froms.includes(c.colour_id)));
    if (others.length) {
      refuse(`series "${s}" also holds ${others.map((c) => c.colour_id).sort(byCode).join(", ")}, which this list does not rename; `
        + `moving its order lines to "${targetId}" would take those colours along`);
    }
  }

  const targetRow = libraryRow(targetId);
  if (targetRow && !mine(targetRow)) refuse(`series id "${targetId}" already belongs to another organisation (fabric_library ids are global)`);
  if (targetRow && mine(targetRow) && targetRow.active === false) refuse(`series "${targetId}" exists but is switched off`);
  if (!targetRow && plan.masters === "done") refuse(`the codes are renamed but series "${targetId}" has no fabric_library row`);

  const movedRows = movedSeries.map(libraryRow).filter((r) => r && mine(r));
  const priced = new Map();
  for (const r of [...movedRows, ...(targetRow && mine(targetRow) ? [targetRow] : [])]) {
    const k = pricedAs(r);
    priced.set(k, [...(priced.get(k) ?? []), r]);
  }
  if (priced.size > 1) {
    refuse(`the series do not share one selling tier and surcharge: `
      + [...priced.values()].map((list) => `${list.map((r) => r.id).sort(byCode).join(", ")} = ${pricedText(list[0])}`).join("; ")
      + `. One series has one tier, so merging would re-price order lines.`);
  }

  let create = null;
  if (!targetRow && plan.masters === "pending" && movedRows.length) {
    const first = [...plan.colourMoves].sort((a, b) => byCode(a.to, b.to))[0];
    const template = libraryRow(first.fromSeries);
    if (template && mine(template)) {
      create = {
        templateId: template.id, tier: template.tier, defaultSurcharge: template.default_surcharge,
        sofaTier: template.sofa_tier ?? null, bedframeTier: template.bedframe_tier ?? null, sortOrder: template.sort_order ?? 0,
      };
    }
  }
  plan.target = { id: targetId, label: targetRow && mine(targetRow) ? (targetRow.label ?? targetId) : targetId, create };
  plan.supersede = movedRows.map((r) => ({ id: r.id, label: `${unstamped(r.label) || r.id} [renamed to ${targetId} on ${stamp}]` }));
  plan.seriesLabels = uniq([...plan.sweepSeries, ...movedRows.map((r) => r.label)])
    .filter((l) => typeof l === "string" && l !== "" && l !== plan.target.label);

  // ── item KPI: one rule per series, so the rules have to be one rule ─────
  const oldRules = state.kpiRules.filter((r) => plan.sweepSeries.includes(r.ref));
  const targetRules = state.kpiRules.filter((r) => r.ref === targetId);
  const targetHadColours = state.seriesColours.some((c) => c.fabric_id === targetId && !pairs.some((p) => p.to === c.colour_id));
  if (targetRules.length > 1) refuse(`series "${targetId}" has ${targetRules.length} item KPI rules; it would pay each of them`);
  if (oldRules.length) {
    const perRef = new Map();
    for (const r of oldRules) perRef.set(r.ref, (perRef.get(r.ref) ?? 0) + 1);
    const doubled = [...perRef].filter(([, n]) => n > 1).map(([ref]) => ref);
    if (doubled.length) refuse(`more than one item KPI rule on ${doubled.sort(byCode).join(", ")}; settle those in HR first`);
    const all = [...oldRules, ...targetRules];
    const terms = uniq(all.map((r) => `RM ${(Number(r.bonus_sen) / 100).toFixed(2)}${r.active ? "" : " (off)"}`));
    if (terms.length > 1) refuse(`the item KPI rules on these fabrics do not agree (${terms.join(", ")}); a series carries one rule, so one amount has to be chosen`);
    const unruled = movedSeries.filter((s) => !perRef.has(s));
    if (unruled.length && targetRules.length === 0) {
      refuse(`${perRef.size} of ${movedSeries.length} series carry an item KPI rule; one rule on "${targetId}" would start paying ${unruled.sort(byCode).join(", ")}`);
    }
    if (targetRules.length === 0 && targetHadColours) refuse(`series "${targetId}" already sells colours that earn no item KPI; the merged rule would start paying them`);
    const keep = targetRules[0] ?? [...oldRules].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || byCode(a.id, b.id))[0];
    plan.kpi = {
      keepId: keep.id, deleteIds: all.filter((r) => r.id !== keep.id).map((r) => r.id),
      ref: targetId, label: plan.target.label, bonusSen: Number(keep.bonus_sen), active: keep.active === true, retarget: keep.ref !== targetId,
    };
  } else if (targetRules.length === 1 && plan.masters === "pending" && targetHadColours) {
    refuse(`series "${targetId}" carries an item KPI rule and these fabrics carry none; moving them under it would start paying them`);
  }

  // ── what this script has no writer for ──────────────────────────────────
  const onProducts = state.productFabrics.reduce((a, r) => a + Number(r.n), 0);
  if (onProducts) refuse(`scm.product_fabrics holds ${onProducts} row(s) on ${state.productFabrics.map((r) => r.fabric_id).sort(byCode).join(", ")}; this script does not move per-product fabric rows`);

  for (const m of state.models) {
    if (!Array.isArray(m.fabrics)) continue;
    if (m.fabrics.some((e) => typeof e !== "string")) { refuse(`model ${m.model_code}: its fabric pool holds an entry that is not text`); continue; }
    const after = renamePool(m.fabrics, pairs, plan.sweepSeries, targetId);
    if (after.length !== m.fabrics.length || after.some((v, i) => v !== m.fabrics[i])) {
      plan.pools.push({ id: String(m.id), modelCode: m.model_code, before: m.fabrics, after });
    }
  }

  for (const c of state.census) {
    if (!c.n) continue;
    if (c.retained) plan.hits.retained.push(c);
    else if (!c.live) plan.hits.history.push(c);
    else if (c.writer) plan.hits.rewritten.push(c);
    else {
      plan.hits.unwritable.push(c);
      refuse(`${c.n} row(s) of ${c.table}.${c.col} name an old code and this script has no writer for that column`);
    }
  }
  for (const k of state.variantKeys) {
    if (k.type !== "string" || !HANDLED_VARIANT_KEYS.includes(k.key)) {
      refuse(`${k.table}: ${k.n} line(s) hold an old code under variants.${k.key} (${k.type}), which this script does not rewrite`);
    }
  }
  for (const s of state.variantShapes) {
    if (s.n) refuse(`${s.table}: ${s.n} line(s) naming an old code carry a variants block that is not an object (repair-array-shaped-variants.mjs first)`);
  }

  plan.work = plan.masters === "pending" || plan.pools.length > 0 || plan.kpi !== null || plan.hits.rewritten.length > 0;
  return plan;
}

// ── reads ───────────────────────────────────────────────────────────────────

/** Which carriers this database has. Resolved once per run and reused: the
 *  catalogue does not change between the plan, the write and the re-read. */
export const resolveRenameCarriers = (client) => resolveCarriers(client, RENAME_CARRIERS);

/** Rows that name any of the codes, per carrier. One scan per table. */
export async function censusCodes(client, companyId, codes, carriers) {
  const re = anyCodeRegex(codes);
  const byTable = new Map();
  for (const c of carriers) byTable.set(c.table, [...(byTable.get(c.table) ?? []), c]);
  const out = [];
  for (const [table, list] of byTable) {
    const scoped = list[0].hasCompany;
    const cols = list.map((c, i) => `COUNT(*) FILTER (WHERE (${c.col})::text ~* $1)::int AS n${i}`).join(", ");
    const [row] = await client.unsafe(
      `SELECT ${cols} FROM ${table}${scoped ? " WHERE company_id = $2" : ""}`, scoped ? [re, companyId] : [re]);
    list.forEach((c, i) => out.push({ ...c, n: row[`n${i}`] }));
  }
  return out;
}

const LISTED = new Set(RENAME_CARRIERS.map((c) => `${c.table}.${baseCol(c)}`));

/** Every text / json column of every scm and public table, counted for the
 *  codes. The carrier list is kept by hand; this asks the catalogue instead, so
 *  a column nobody listed still shows (it is how product_request_lines was
 *  found). It returns counts and names, never a row: the run log is public. */
export async function scanEveryColumn(client, companyId, codes) {
  const re = anyCodeRegex(codes);
  const cols = await client.unsafe(
    `SELECT n.nspname AS s, c.relname AS t, a.attname AS col,
            EXISTS (SELECT 1 FROM pg_attribute x
                     WHERE x.attrelid = c.oid AND x.attname = 'company_id' AND NOT x.attisdropped) AS scoped
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      WHERE c.relkind IN ('r', 'p') AND n.nspname IN ('scm', 'public')
        AND format_type(a.atttypid, NULL) IN ('text', 'jsonb', 'json', 'character varying', 'character', 'text[]', 'character varying[]')
      ORDER BY 1, 2, a.attnum`, []);
  const byTable = new Map();
  for (const c of cols) byTable.set(`${c.s}.${c.t}`, [...(byTable.get(`${c.s}.${c.t}`) ?? []), c]);
  const hits = [], failed = [];
  for (const [table, list] of byTable) {
    const scope = list[0].scoped ? " AND company_id = $2" : "";
    const counts = list.map((c, i) => `COUNT(*) FILTER (WHERE "${c.col}"::text ~* $1${scope})::int AS n${i}`).join(", ");
    try {
      const [row] = await client.unsafe(
        `SELECT ${counts} FROM "${list[0].s}"."${list[0].t}"`, list[0].scoped ? [re, Number(companyId)] : [re]);
      list.forEach((c, i) => {
        if (row[`n${i}`]) hits.push({ table, col: c.col, n: row[`n${i}`], scoped: c.scoped, listed: LISTED.has(`${table}.${c.col}`) });
      });
    } catch (e) {
      failed.push(`${table}: ${e.message}`);
    }
  }
  return { tables: byTable.size, columns: cols.length, hits, failed };
}

async function tableExists(client, name) {
  const [r] = await client.unsafe("SELECT to_regclass($1)::text AS t", [name]);
  return r.t !== null;
}

/** Everything planFabricCodeRename needs, read with SELECTs only. */
export async function readRenameState(client, companyId, pairs, carriers) {
  const co = Number(companyId);
  const froms = pairs.map((p) => p.from), tos = pairs.map((p) => p.to);
  const codes = [...froms, ...tos];
  const targetId = seriesIdOf(tos[0]);

  const trackings = await client.unsafe(
    `SELECT id, fabric_code, fabric_description, series, supplier_code, is_active, company_id
       FROM scm.fabric_trackings
      WHERE company_id = $1 AND (fabric_code = ANY($2::text[]) OR id = ANY($3::text[]))
      ORDER BY id`, [co, codes, codes.map(trackingIdOf)]);
  // fabric_library and fabric_colours are keyed globally, so the other
  // organisations' rows are read too: a collision there is a refusal.
  const colours = await client.unsafe(
    `SELECT fabric_id, colour_id, label, active, company_id FROM scm.fabric_colours WHERE colour_id = ANY($1::text[])`, [codes]);
  const seriesIds = uniq([
    targetId, ...froms.map(seriesIdOf),
    ...colours.filter((c) => Number(c.company_id) === co && froms.includes(c.colour_id)).map((c) => c.fabric_id),
  ]);
  const oldSeriesIds = seriesIds.filter((s) => s !== targetId);
  const library = await client.unsafe(
    `SELECT id, label, tier::text AS tier, default_surcharge, sofa_tier::text AS sofa_tier,
            bedframe_tier::text AS bedframe_tier, active, sort_order, company_id
       FROM scm.fabric_library WHERE id = ANY($1::text[])`, [seriesIds]);
  const seriesColours = await client.unsafe(
    `SELECT fabric_id, colour_id, company_id FROM scm.fabric_colours WHERE fabric_id = ANY($1::text[])`, [seriesIds]);
  const kpiRules = await client.unsafe(
    `SELECT id::text AS id, ref, label, bonus_sen, active, created_at::text AS created_at
       FROM scm.hr_item_kpi
      WHERE company_id = $1 AND flag_type::text = 'fabric' AND ref = ANY($2::text[])
      ORDER BY created_at, id`, [co, seriesIds]);
  const productFabrics = (await tableExists(client, "scm.product_fabrics"))
    ? await client.unsafe(
      `SELECT fabric_id, COUNT(*)::int AS n FROM scm.product_fabrics WHERE fabric_id = ANY($1::text[]) GROUP BY 1`, [oldSeriesIds])
    : [];
  const models = await client.unsafe(
    `SELECT id::text AS id, model_code, allowed_options->'fabrics' AS fabrics
       FROM scm.product_models
      WHERE company_id = $1 AND jsonb_typeof(allowed_options->'fabrics') = 'array'
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(allowed_options->'fabrics') e
                     WHERE jsonb_typeof(e) = 'string' AND (e #>> '{}') = ANY($2::text[]))
      ORDER BY model_code`, [co, uniq([...froms, ...oldSeriesIds])]);

  const census = await censusCodes(client, co, froms, carriers);

  // Under which variants key each line holds an old code. The sweeps rewrite a
  // fixed set of keys; anything else has to be seen before it is half renamed.
  const re = anyCodeRegex(froms);
  const variantKeys = [], variantShapes = [];
  for (const c of census.filter((x) => x.kind === "variants" && x.live && x.n > 0)) {
    const scope = c.hasCompany ? "company_id = $2 AND " : "";
    const args = c.hasCompany ? [re, co] : [re];
    // The CASE keeps jsonb_each off a block that is not an object, whichever
    // order the planner evaluates the row filter in.
    const keys = await client.unsafe(
      `SELECT e.key, jsonb_typeof(e.value) AS type, COUNT(*)::int AS n
         FROM ${c.table} i,
              LATERAL jsonb_each(CASE WHEN jsonb_typeof(i.${c.col}) = 'object' THEN i.${c.col} ELSE '{}'::jsonb END) e
        WHERE ${scope}i.${c.col}::text ~* $1 AND e.value::text ~* $1
        GROUP BY 1, 2 ORDER BY 1`, args);
    for (const k of keys) variantKeys.push({ table: c.table, col: c.col, key: k.key, type: k.type, n: k.n });
    const [shape] = await client.unsafe(
      `SELECT COUNT(*)::int AS n FROM ${c.table}
        WHERE ${scope}jsonb_typeof(${c.col}) <> 'object' AND ${c.col}::text ~* $1`, args);
    variantShapes.push({ table: c.table, col: c.col, n: shape.n });
  }

  return { trackings, colours, library, seriesColours, kpiRules, productFabrics, models, census, variantKeys, variantShapes };
}

// ── writes ──────────────────────────────────────────────────────────────────

/**
 * Write the plan. `tx` is a transaction: a throw rolls every step back.
 * Returns what each step touched.
 */
export async function applyFabricCodeRename(tx, { companyId, pairs, plan, carriers }) {
  if (plan.refusals.length) throw new Error(`the plan has ${plan.refusals.length} refusal(s); nothing is written`);
  const co = Number(companyId);
  const report = { masters: {}, sweeps: [], skippedArms: [] };

  if (plan.target.create) {
    const r = await tx.unsafe(
      `INSERT INTO scm.fabric_library (id, label, tier, default_surcharge, active, sort_order, sofa_tier, bedframe_tier, company_id)
       SELECT $2::text, $3::text, s.tier, s.default_surcharge, true, s.sort_order, s.sofa_tier, s.bedframe_tier, s.company_id
         FROM scm.fabric_library s WHERE s.company_id = $1 AND s.id = $4`,
      [co, plan.target.id, plan.target.label, plan.target.create.templateId]);
    expectRows(`series ${plan.target.id}`, r.count, 1);
    report.masters.seriesCreated = plan.target.id;
  }

  if (plan.colourMoves.length) {
    const r = await tx.unsafe(
      `UPDATE scm.fabric_colours c
          SET fabric_id = $2, colour_id = r.neu
         FROM unnest($3::text[], $4::text[], $5::text[]) AS r(old, neu, series)
        WHERE c.company_id = $1 AND c.colour_id = r.old AND c.fabric_id = r.series`,
      [co, plan.target.id, plan.colourMoves.map((m) => m.from), plan.colourMoves.map((m) => m.to), plan.colourMoves.map((m) => m.fromSeries)]);
    expectRows("selling colours", r.count, plan.colourMoves.length);
    report.masters.colours = r.count;
  }

  if (plan.trackingMoves.length) {
    const r = await tx.unsafe(
      `UPDATE scm.fabric_trackings t
          SET id = r.new_id, fabric_code = r.neu
         FROM unnest($2::text[], $3::text[], $4::text[], $5::text[]) AS r(old_id, old, new_id, neu)
        WHERE t.company_id = $1 AND t.id = r.old_id AND t.fabric_code = r.old`,
      [co, plan.trackingMoves.map((m) => m.oldId), plan.trackingMoves.map((m) => m.from),
        plan.trackingMoves.map((m) => m.newId), plan.trackingMoves.map((m) => m.to)]);
    expectRows("Fabric Converter rows", r.count, plan.trackingMoves.length);
    report.masters.trackings = r.count;
  }

  for (const sweep of [await sweepVariants(tx, co, pairs, plan), await sweepDescription2(tx, co, pairs), await sweepVariantKeys(tx, co, pairs)]) {
    report.sweeps.push(...sweep.done);
    report.skippedArms.push(...sweep.skipped.map((s) => `${s.t} (${s.why})`));
  }

  for (const pool of plan.pools) {
    // The pool is compared with what the plan read: a tick changed in the
    // Modular drawer meanwhile is not overwritten.
    const r = await tx.unsafe(
      `UPDATE scm.product_models
          SET allowed_options = jsonb_set(allowed_options, '{fabrics}', $3::text::jsonb)
        WHERE company_id = $1 AND id::text = $2 AND allowed_options->'fabrics' = $4::text::jsonb`,
      [co, pool.id, JSON.stringify(pool.after), JSON.stringify(pool.before)]);
    expectRows(`fabric pool of model ${pool.modelCode}`, r.count, 1);
  }
  report.pools = plan.pools.length;

  const requests = await tx.unsafe(
    `UPDATE scm.product_request_lines l
        SET fabric_code = r.neu
       FROM unnest($2::text[], $3::text[]) AS r(old, neu)
      WHERE l.company_id = $1 AND l.fabric_code = r.old`, [co, pairs.map((p) => p.from), pairs.map((p) => p.to)]);
  if (requests.count) report.sweeps.push({ arm: "PDR", key: "fabric_code", n: requests.count });

  if (plan.kpi) {
    if (plan.kpi.retarget) {
      const r = await tx.unsafe(
        `UPDATE scm.hr_item_kpi SET ref = $3, label = $4, updated_at = now()
          WHERE company_id = $1 AND id::text = $2 AND flag_type::text = 'fabric'`,
        [co, plan.kpi.keepId, plan.kpi.ref, plan.kpi.label]);
      expectRows("item KPI rule kept", r.count, 1);
    }
    if (plan.kpi.deleteIds.length) {
      const r = await tx.unsafe(
        `DELETE FROM scm.hr_item_kpi WHERE company_id = $1 AND flag_type::text = 'fabric' AND id::text = ANY($2::text[])`,
        [co, plan.kpi.deleteIds]);
      expectRows("item KPI rules folded into one", r.count, plan.kpi.deleteIds.length);
    }
    report.kpi = { kept: plan.kpi.keepId, removed: plan.kpi.deleteIds.length };
  }

  for (const s of plan.supersede) {
    const r = await tx.unsafe(
      `UPDATE scm.fabric_library SET active = false, label = $3
        WHERE company_id = $1 AND id = $2
          AND NOT EXISTS (SELECT 1 FROM scm.fabric_colours c WHERE c.fabric_id = $2)`, [co, s.id, s.label]);
    expectRows(`series ${s.id} superseded`, r.count, 1);
  }
  report.masters.superseded = plan.supersede.length;

  // Before the commit: no live carrier may still name an old code. A key or a
  // table the sweeps did not reach rolls the whole rename back.
  const left = (await censusCodes(tx, co, pairs.map((p) => p.from), carriers.filter((c) => c.live && !c.retained)))
    .filter((c) => c.n > 0);
  if (left.length) {
    throw new Error(`after the sweeps ${left.map((c) => `${c.table}.${c.col} still has ${c.n}`).join("; ")}. Rolled back.`);
  }
  return report;
}

const nested = (source, count, first) => {
  let expr = source;
  for (let k = 0; k < count; k++) expr = `regexp_replace(${expr}, $${first + 2 * k}::text, $${first + 1 + 2 * k}::text, 'g')`;
  return expr;
};

/* Every line table, every key that can hold the code. jsonb_set over
   to_jsonb(<text>), never a bound object: binding a serialized string to a jsonb
   parameter is what destroyed the variants column on 2026-08-10
   (docs/jsonb-double-encoding-coe.md). One statement per arm and key instead of
   one per code, so the transaction holds its row locks for seconds. */
async function sweepVariants(client, co, pairs, plan) {
  const froms = pairs.map((p) => p.from), tos = pairs.map((p) => p.to);
  const { ok: arms, skipped } = await resolveArms(client, ARMS, VARIANT_ARM_COLS);
  const done = [];
  const note = (arm, key, r) => { if (r.count) done.push({ arm: arm.name, key, n: r.count }); };
  for (const arm of arms) {
    const live = `EXISTS (${arm.ex}) AND jsonb_typeof(i.variants) = 'object'`;
    for (const key of COLOUR_ALIASES) {
      note(arm, key, await client.unsafe(
        `UPDATE ${arm.t} i
            SET variants = jsonb_set(i.variants, '{${key}}', to_jsonb(r.neu))
           FROM unnest($2::text[], $3::text[]) AS r(old, neu)
          WHERE ${live} AND i.variants->>'${key}' = r.old`, [co, froms, tos]));
    }
    if (plan.sweepSeries.length) {
      note(arm, "fabricId", await client.unsafe(
        `UPDATE ${arm.t} i
            SET variants = jsonb_set(i.variants, '{fabricId}', to_jsonb($3::text))
          WHERE ${live} AND i.variants->>'fabricId' = ANY($2::text[])`, [co, plan.sweepSeries, plan.target.id]));
    }
    if (plan.seriesLabels.length) {
      note(arm, "fabricLabel", await client.unsafe(
        `UPDATE ${arm.t} i
            SET variants = jsonb_set(i.variants, '{fabricLabel}', to_jsonb($3::text))
          WHERE ${live} AND i.variants->>'fabricLabel' = ANY($2::text[])`, [co, plan.seriesLabels, plan.target.label]));
    }
    // colourLabel ("KN07 Sand") and the POS build summary print the code inside
    // free text. A stale colourLabel would print "EM-02 KN07 Sand" on the next save.
    for (const key of TEXT_KEYS) {
      note(arm, key, await client.unsafe(
        `UPDATE ${arm.t} i
            SET variants = jsonb_set(i.variants, '{${key}}', to_jsonb(${nested(`i.variants->>'${key}'`, pairs.length, 3)}))
          WHERE ${live} AND jsonb_typeof(i.variants->'${key}') = 'string' AND i.variants->>'${key}' ~ $2`,
        [co, anyCodeRegex(froms), ...pairs.flatMap((p) => [oneCodeRegex(p.from), replacement(p.to)])]));
    }
  }
  return { done, skipped };
}

/* description2 is a stored render of the variant summary and every PDF prints
   it. The code is substituted, not re-rendered: a second copy of
   buildVariantSummary in SQL is how five colour matchers drifted apart. */
async function sweepDescription2(client, co, pairs) {
  const { ok: arms, skipped } = await resolveArms(client, ARMS, DESC2_ARM_COLS);
  const done = [];
  for (const arm of arms) {
    const r = await client.unsafe(
      `UPDATE ${arm.t} i
          SET description2 = ${nested("i.description2", pairs.length, 3)}
        WHERE EXISTS (${arm.ex}) AND i.description2 ~ $2`,
      [co, anyCodeRegex(pairs.map((p) => p.from)), ...pairs.flatMap((p) => [oneCodeRegex(p.from), replacement(p.to)])]);
    if (r.count) done.push({ arm: arm.name, key: "description2", n: r.count });
  }
  return { done, skipped };
}

/* The stock bucket carries the colour as `fabriccode=<lowercased code>` and is
   compared, never recomputed. Unless it moves with the order line, the sofa
   detaches from its own stock and reads as a shortage. */
async function sweepVariantKeys(client, co, pairs) {
  const { ok: arms, skipped } = await resolveArms(client, VKEY_ARMS, VKEY_ARM_COLS);
  const lower = pairs.map((p) => ({ from: p.from.toLowerCase(), to: p.to.toLowerCase() }));
  const any = `(^|\\|)fabriccode=(${lower.map((p) => esc(p.from)).join("|")})(\\||$)`;
  const done = [];
  for (const arm of arms) {
    const r = await client.unsafe(
      `UPDATE ${arm.t}
          SET ${arm.c} = ${nested(arm.c, lower.length, 3)}
        WHERE company_id = $1 AND ${arm.c} ~ $2`,
      [co, any, ...lower.flatMap((p) => [`(^|\\|)fabriccode=${esc(p.from)}(\\||$)`, `\\1fabriccode=${replacement(p.to)}\\2`])]);
    if (r.count) done.push({ arm: arm.name, key: arm.c, n: r.count });
  }
  return { done, skipped };
}

const expectRows = (what, got, want) => {
  if (got !== want) throw new Error(`${what}: ${got} row(s) written, ${want} planned. Nothing is committed; plan again.`);
};

/** How the renamed codes read back: every variants block naming one must still
 *  be an object, and the series must be the target's. A row count cannot see a
 *  block that was written as a jsonb string. */
export async function shapeOfRenamedLines(client, companyId, pairs, targetId) {
  const co = Number(companyId);
  const tos = pairs.map((p) => p.to);
  const { ok: arms } = await resolveArms(client, ARMS, VARIANT_ARM_COLS);
  const out = [];
  for (const arm of arms) {
    const [r] = await client.unsafe(
      `SELECT COUNT(*)::int AS lines,
              COUNT(*) FILTER (WHERE jsonb_typeof(i.variants) <> 'object')::int AS not_object,
              COUNT(*) FILTER (WHERE i.variants->>'fabricId' IS NOT NULL AND i.variants->>'fabricId' <> $3)::int AS other_series
         FROM ${arm.t} i
        WHERE EXISTS (${arm.ex}) AND i.variants::text ~ $2`, [co, anyCodeRegex(tos), targetId]);
    if (r.lines) out.push({ arm: arm.name, ...r });
  }
  return out;
}
