// Move the rows that still point at a folded Product Model onto the Model it was
// folded into. PLAN BY DEFAULT: nothing is written unless MODE=apply and CONFIRM
// repeats the phrase this run prints.
//
// WHY. A Model merge (merge-duplicate-models.mjs, merge-orphan-models.mjs) moves
// the folded Model's SKU codes and switches the Model off. It never touched the
// rows that hang off the Model itself - photos, free gifts, fabric tier
// overrides, delivery fees, product request lines - so those stayed on a Model
// that is off and holds no code, where no screen shows them.
//
// WHICH MODELS. Read from the merge records, never guessed from names:
//   - audit_events 'scm.model.merge' written on or after SINCE: entity_id is the
//     kept Model, meta.folded[].id and meta.inactiveMoves[].fromModelId the folded
//     ones (merge-orphan-models.mjs);
//   - the TICKETS of data/duplicate-model-merges.json: keep / drops by Model code
//     in the group's category (merge-duplicate-models.mjs writes no Model audit).
// A pair acts only when the folded Model is OFF and holds no SKU, and the kept
// Model is ON. A folded Model claimed by two kept Models is refused.
//
// WHICH TABLES. Every column with a foreign key to scm.product_models, plus every
// column named model_id in scm / public, found in the live catalogue at run time.
//
// DUPLICATES. A row is SKIPPED, and listed, when moving it would collide with a
// row already on the kept Model (or one moved earlier in this run) under any
// UNIQUE index that contains the Model column. Equality is IS NOT DISTINCT FROM
// on the index's plain columns, ignoring partial predicates and expressions, so
// the check can only skip MORE than Postgres would refuse, never fewer.
//
// OUTPUT: counts and Model codes only - no document numbers, no money - because
// this repository's Actions logs are public.
//
//   DATABASE_URL  required
//   MODE          plan (default, writes nothing) | apply
//   CONFIRM       on apply, the phrase this run prints; it carries the counts it
//                 measured, so a phrase copied from an older run cannot fire
//   COMPANY_ID    default 1
//   SINCE         default 2026-11-10 (audit_events lower bound, a date)
//   TICKETS       default OWNER-2026-11-10-RELAX (comma separated; blank = none)
//
// RE-RUN: convergent. A moved row no longer points at a folded Model, so a second
// plan lists only the skipped rows and the apply writes nothing new. Every UPDATE
// re-asserts the Model it moves the row from, so a row changed in between is left
// alone and reported.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DST = process.env.DATABASE_URL;
const MODE = (process.env.MODE || "plan").toLowerCase();
const APPLY = MODE === "apply";
const CONFIRM = (process.env.CONFIRM ?? "").trim();
const CO = Number(process.env.COMPANY_ID || 1);
const SINCE = (process.env.SINCE || "2026-11-10").trim();
const TICKETS = (process.env.TICKETS ?? "OWNER-2026-11-10-RELAX").split(",").map((s) => s.trim()).filter(Boolean);

if (!DST) { console.error("REFUSED: DATABASE_URL not set."); process.exit(2); }
if (!["plan", "apply"].includes(MODE)) { console.error(`REFUSED: MODE must be plan or apply, got "${MODE}".`); process.exit(2); }
if (!Number.isInteger(CO) || CO < 1) { console.error("REFUSED: COMPANY_ID must be a positive integer."); process.exit(2); }
if (!/^\d{4}-\d{2}-\d{2}$/.test(SINCE)) { console.error(`REFUSED: SINCE must be YYYY-MM-DD, got "${SINCE}".`); process.exit(2); }
const BOOK = JSON.parse(fs.readFileSync(path.join(HERE, "data", "duplicate-model-merges.json"), "utf8"));
for (const t of TICKETS) if (!BOOK[t]) { console.error(`REFUSED: ticket "${t}" is not in data/duplicate-model-merges.json.`); process.exit(2); }

const log = (m = "") => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const out = (m = "") => console.log(m);
const jarr = (xs) => JSON.stringify([...new Set(xs)]);
/** Catalogue-sourced identifier, quoted for a column list. */
const qi = (name) => `"${String(name).replace(/"/g, '""')}"`;
const inList = (sql, xs) => sql`ARRAY(SELECT jsonb_array_elements_text(${jarr(xs)}::text::jsonb))`;

async function readPairs(sql) {
  const claims = [];
  const audits = await sql`
    SELECT entity_id, meta FROM audit_events
     WHERE action = 'scm.model.merge' AND created_at >= ${SINCE}::date`;
  for (const a of audits) {
    let m; try { m = JSON.parse(a.meta); } catch { continue; }
    if (Number(m?.company_id ?? CO) !== CO || !a.entity_id) continue;
    const olds = [...(m.folded ?? []).map((f) => f.id), ...(m.inactiveMoves ?? []).map((x) => x.fromModelId)];
    for (const o of olds) if (o && o !== a.entity_id) claims.push({ old: String(o), kept: String(a.entity_id), source: "audit" });
  }
  for (const t of TICKETS) {
    for (const g of BOOK[t].groups ?? []) {
      const codes = [g.keep, ...(g.drops ?? [])];
      const rows = await sql`
        SELECT id::text AS id, model_code FROM scm.product_models
         WHERE company_id = ${CO} AND category::text = ${g.category} AND model_code = ANY(${inList(sql, codes)})`;
      const kept = rows.filter((r) => r.model_code === g.keep);
      if (kept.length !== 1) { out(`  ticket ${t}: kept Model "${g.keep}" matches ${kept.length} rows, group skipped`); continue; }
      for (const r of rows) if (r.model_code !== g.keep) claims.push({ old: r.id, kept: kept[0].id, source: `ticket ${t}` });
    }
  }
  const ids = [...new Set(claims.flatMap((c) => [c.old, c.kept]))];
  const models = ids.length === 0 ? [] : await sql`
    SELECT m.id::text AS id, m.model_code, m.active,
           (SELECT COUNT(*)::int FROM scm.mfg_products p WHERE p.company_id = m.company_id AND p.model_id = m.id) AS skus
      FROM scm.product_models m WHERE m.company_id = ${CO} AND m.id::text = ANY(${inList(sql, ids)})`;
  const byId = new Map(models.map((m) => [m.id, m]));
  const pairs = [];
  const refused = [];
  for (const old of [...new Set(claims.map((c) => c.old))]) {
    const keeps = [...new Set(claims.filter((c) => c.old === old).map((c) => c.kept))];
    const o = byId.get(old);
    const k = byId.get(keeps[0]);
    const name = o?.model_code ?? old;
    if (keeps.length > 1) refused.push(`"${name}": claimed by ${keeps.length} kept Models`);
    else if (!o || !k) refused.push(`"${name}": Model not found in company ${CO}`);
    else if (o.active) refused.push(`"${name}": still ON`);
    else if (o.skus > 0) refused.push(`"${name}": still holds ${o.skus} SKU(s)`);
    else if (!k.active) refused.push(`"${name}" -> "${k.model_code}": kept Model is OFF`);
    else pairs.push({ old, kept: k.id, oldCode: o.model_code, keptCode: k.model_code });
  }
  return { pairs, refused };
}

async function readRefColumns(sql) {
  const rows = await sql`
    SELECT n.nspname AS schema, c.relname AS tbl, a.attname AS col
      FROM pg_constraint k
      JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1]
     WHERE k.contype = 'f' AND k.confrelid = 'scm.product_models'::regclass AND array_length(k.conkey, 1) = 1
    UNION
    SELECT table_schema, table_name, column_name FROM information_schema.columns
     WHERE table_schema IN ('scm', 'public') AND column_name = 'model_id'
       AND table_name IN (SELECT table_name FROM information_schema.tables t WHERE t.table_schema = columns.table_schema AND t.table_type = 'BASE TABLE')
     ORDER BY 1, 2, 3`;
  const cols = [];
  for (const r of rows) {
    const fq = `${r.schema}.${r.tbl}`;
    const meta = await sql`
      SELECT bool_or(column_name = 'company_id') AS has_co, bool_or(column_name = 'id') AS has_id
        FROM information_schema.columns WHERE table_schema = ${r.schema} AND table_name = ${r.tbl}`;
    const uniq = await sql`
      SELECT i.indexrelid::regclass::text AS name,
             ARRAY(SELECT a.attname FROM unnest(i.indkey) WITH ORDINALITY u(n, o)
                     JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = u.n ORDER BY u.o) AS cols
        FROM pg_index i
       WHERE i.indrelid = ${fq}::regclass AND i.indisunique
         AND (SELECT attnum FROM pg_attribute WHERE attrelid = i.indrelid AND attname = ${r.col}) = ANY(i.indkey)`;
    cols.push({ fq, schema: r.schema, tbl: r.tbl, col: r.col, hasCo: meta[0].has_co, hasId: meta[0].has_id,
      uniques: uniq.map((u) => ({ name: u.name, others: u.cols.filter((c) => c !== r.col) })) });
  }
  return cols;
}

async function planMoves(sql, { pairs, cols }) {
  const oldIds = pairs.map((p) => p.old);
  const keptOf = new Map(pairs.map((p) => [p.old, p]));
  const tables = [];
  for (const t of cols) {
    const coPred = t.hasCo ? sql`AND company_id = ${CO}` : sql``;
    const total = await sql`
      SELECT ${sql(t.col)}::text AS old, COUNT(*)::int AS n, COUNT(*) FILTER (WHERE ${t.hasCo ? sql`company_id IS DISTINCT FROM ${CO}` : sql`false`})::int AS other_co
        FROM ${sql(t.fq)} WHERE ${sql(t.col)}::text = ANY(${inList(sql, oldIds)}) GROUP BY 1`;
    const entry = { ...t, perOld: total, moves: [], skips: [], refusal: null };
    tables.push(entry);
    const n = total.reduce((s, r) => s + r.n - r.other_co, 0);
    if (n === 0) continue;
    if (!t.hasId) { entry.refusal = "no id column, not moved"; continue; }
    const keyCols = [...new Set(t.uniques.flatMap((u) => u.others))];
    const keySel = keyCols.map((c) => `, ${qi(c)}::text AS ${qi(`k_${c}`)}`).join("");
    const rows = await sql`
      SELECT id::text AS id, ${sql(t.col)}::text AS old ${sql.unsafe(keySel)}
        FROM ${sql(t.fq)} WHERE ${sql(t.col)}::text = ANY(${inList(sql, oldIds)}) ${coPred} ORDER BY id`;
    const taken = new Set();
    for (const r of rows) {
      const p = keptOf.get(r.old);
      let clash = null;
      for (const u of t.uniques) {
        const key = `${u.name}|${p.kept}|${JSON.stringify(u.others.map((c) => r[`k_${c}`] ?? null))}`;
        if (taken.has(key)) { clash = `${u.name} (another row moved in this run)`; break; }
        const conds = u.others.map((c) => sql`${sql(c)}::text IS NOT DISTINCT FROM ${r[`k_${c}`] ?? null}`);
        const where = conds.length ? sql`AND ${conds.reduce((a, b) => sql`${a} AND ${b}`)}` : sql``;
        const [hit] = await sql`SELECT COUNT(*)::int AS n FROM ${sql(t.fq)} WHERE ${sql(t.col)}::text = ${p.kept} ${coPred} ${where}`;
        if (hit.n > 0) { clash = u.name; break; }
      }
      if (clash) { entry.skips.push({ id: r.id, old: r.old, kept: p.kept, why: clash }); continue; }
      for (const u of t.uniques) taken.add(`${u.name}|${p.kept}|${JSON.stringify(u.others.map((c) => r[`k_${c}`] ?? null))}`);
      entry.moves.push({ id: r.id, old: r.old, kept: p.kept });
    }
  }
  return tables;
}

async function main() {
  log(`mode=${MODE} company=${CO} since=${SINCE} tickets=${TICKETS.join(",") || "none"}`);
  const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
  const { pairs, refused } = await readPairs(sql);
  const cols = await readRefColumns(sql);
  const tables = await planMoves(sql, { pairs, cols });
  const codeOf = new Map(pairs.flatMap((p) => [[p.old, p.oldCode], [p.kept, p.keptCode]]));

  out("");
  out(`FOLDED MODELS: ${pairs.length} acting, ${refused.length} refused`);
  for (const p of pairs) out(`  "${p.oldCode}" -> "${p.keptCode}"`);
  for (const r of refused) out(`  REFUSED ${r}`);
  out("");
  out(`REFERENCE COLUMNS FOUND: ${cols.length}`);
  for (const t of tables) {
    const n = t.perOld.reduce((s, r) => s + r.n, 0);
    const other = t.perOld.reduce((s, r) => s + r.other_co, 0);
    out(`  ${t.fq}.${t.col}: ${n} row(s) on folded Models${other ? ` (${other} in another company, not moved)` : ""}; unique keys with the Model column: ${t.uniques.map((u) => u.name).join(", ") || "none"}`);
    if (n === 0) continue;
    for (const r of t.perOld) out(`      "${codeOf.get(r.old) ?? r.old}": ${r.n}`);
    if (t.refusal) out(`      REFUSED: ${t.refusal}`);
    out(`      move ${t.moves.length}, skip ${t.skips.length} (would duplicate on the kept Model)`);
    for (const s of t.skips) out(`      SKIP row ${s.id}: "${codeOf.get(s.old)}" -> "${codeOf.get(s.kept)}" clashes on ${s.why}`);
  }
  const moves = tables.reduce((s, t) => s + t.moves.length, 0);
  const skips = tables.reduce((s, t) => s + t.skips.length, 0);
  const phrase = `REPOINT ${moves} ROWS OFF ${pairs.length} FOLDED MODELS, SKIP ${skips}`;
  out("");
  log(`TOTALS move ${moves} row(s), skip ${skips} duplicate(s), ${pairs.length} folded Model(s), ${refused.length} refused`);

  if (!APPLY) { log(`PLAN ONLY, nothing written. To apply: MODE=apply CONFIRM="${phrase}"`); await sql.end(); return; }
  if (CONFIRM !== phrase) { console.error(`REFUSED: CONFIRM must be exactly "${phrase}".`); await sql.end(); process.exit(2); }
  if (moves === 0) { log("Nothing to move."); await sql.end(); return; }

  const undo = tables.filter((t) => t.moves.length).map((t) => ({ table: t.fq, col: t.col, rows: t.moves.map((m) => ({ id: m.id, from: m.old, to: m.kept })) }));
  const lost = [];
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO audit_events (actor_id, actor_email, action, entity_type, entity_id, summary, meta, request_id)
      VALUES (null, 'repoint-folded-model-refs.mjs', 'scm.model.refs.repoint', 'product_model', null,
              ${`Repointed ${moves} row(s) off ${pairs.length} folded Model(s)`}, ${JSON.stringify({ company_id: CO, undo })}, null)`;
    for (const t of tables) {
      const coPred = t.hasCo ? tx`AND company_id = ${CO}` : tx``;
      for (const m of t.moves) {
        const res = await tx`UPDATE ${tx(t.fq)} SET ${tx(t.col)} = ${m.kept} WHERE id::text = ${m.id} AND ${tx(t.col)}::text = ${m.old} ${coPred}`;
        if (res.count !== 1) lost.push(`${t.fq} row ${m.id} changed since the plan, left alone`);
      }
    }
  });
  await sql.end();

  const v = postgres(DST, { ssl: "require", prepare: false, max: 1 });
  const problems = [...lost];
  for (const t of tables) {
    if (!t.moves.length) continue;
    const rows = await v`SELECT id::text AS id, ${v(t.col)}::text AS model FROM ${v(t.fq)} WHERE id::text = ANY(${inList(v, t.moves.map((m) => m.id))})`;
    const want = new Map(t.moves.map((m) => [m.id, m.kept]));
    for (const r of rows) if (r.model !== want.get(r.id)) problems.push(`${t.fq} row ${r.id} points at "${codeOf.get(r.model) ?? r.model}", wanted "${codeOf.get(want.get(r.id))}"`);
    if (rows.length !== t.moves.length) problems.push(`${t.fq}: ${t.moves.length - rows.length} moved row(s) are gone`);
    const [left] = await v`SELECT COUNT(*)::int AS n FROM ${v(t.fq)} WHERE ${v(t.col)}::text = ANY(${inList(v, pairs.map((p) => p.old))}) ${t.hasCo ? v`AND company_id = ${CO}` : v``}`;
    if (left.n !== t.skips.length) problems.push(`${t.fq}: ${left.n} row(s) still on folded Models, expected the ${t.skips.length} skipped`);
  }
  const keptIds = [...new Set(pairs.map((p) => p.kept))];
  const [on] = await v`SELECT COUNT(*) FILTER (WHERE active)::int AS n FROM scm.product_models WHERE company_id = ${CO} AND id::text = ANY(${inList(v, keptIds)})`;
  if (on.n !== keptIds.length) problems.push(`${keptIds.length - on.n} kept Model(s) are no longer ON`);
  await v.end();
  log(`APPLIED: ${moves - lost.length} of ${moves} row(s) repointed`);
  if (problems.length) { for (const p of problems) console.error(`VERIFY FAILED: ${p}`); process.exit(1); }
  log("VERIFIED on a fresh connection: every moved row points at its kept Model, only the skipped rows remain on folded Models, every kept Model is ON.");
}

main().catch((e) => { console.error(e); process.exit(1); });
