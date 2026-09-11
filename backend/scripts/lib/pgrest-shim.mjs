// A supabase-js-SHAPED query builder over a direct `postgres` connection, so a
// repair script can drive the app's REAL costing functions (restampDoActualCost,
// restampSiFromDo, their helpers) with ONLY DATABASE_URL — no PostgREST creds.
//
// WHY (live run 2026-08-01). The W5 restamp APPLY needs the canonical TS
// functions, which talk supabase-js. The repo's GitHub environment carries no
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY secrets (the APPLY died asking for
// them), and hand-replicating restampDoActualCost's warehouse resolution +
// sofa batch map + variant keys in SQL is exactly the "subtly-different sweep
// is worse than none" trap (recompute-so-allocation.mjs header). So the
// LOGIC stays canonical and only the TRANSPORT is mimicked.
//
// SCOPE — deliberately the exact surface those functions use, nothing more:
//   from(t).select(cols).eq/.neq/.in/.not(col,'is',null)/.not(col,'in','(A,B)')
//          /.or('a.is.null,b.lt.X')/.order/.limit/.range
//          .maybeSingle()/.single()          -> { data, error }
//   from(t).update(obj).eq(...)[.or(...)][.select(cols).maybeSingle()]
//                                            -> { data, error } (RETURNING)
//   from(t).insert(rowOrRows)                -> { data: null, error }
// Every OTHER method THROWS loudly AND is recorded on shim.__gaps — a caller
// can assert the gap list is empty after a run, so an unimplemented method can
// never silently no-op a money write. PostgREST semantics preserved where they
// matter: one autocommitted statement per call (no transaction — same as
// PostgREST), `.in()` with an empty list matches nothing, errors come back as
// { error: { message } } rather than throwing (the app code checks `.error`),
// and maybeSingle() returns null data for zero rows.
//
// 2026-08-01 growth (recompute-so-allocation.mjs — the canonical
// recomputeSoStockAllocation + advanceSoGeneration + recordSoAudit surface):
//   .not(col,'in','(A,B,C)')  — PostgREST's parenthesised bare-value list,
//                               the allocator's status exclusion
//   .or('a.is.null,b.lt.X')   — EXACTLY the two-op disjunction grammar the
//                               lock claim and the SO edit-lease CAS use
//                               (is.null | lt.<value>); anything else gaps
//   update(...).select(...)   — UPDATE ... RETURNING, honouring maybeSingle,
//                               because the lock claim and the lease CAS read
//                               the row they claimed (data:null = not claimed)
//   .insert(rowOrRows)        — the audit/status-change appends; column set
//                               is the UNION across rows (a missing key
//                               inserts NULL, matching PostgREST's behaviour
//                               for hetero batches close enough for these
//                               best-effort audit writes)
//
// 2026-08-10 growth (the go-live allocation recompute):
//   .gt/.gte/.lt/.lte(col, v)  — scalar comparisons, the allocator's open-lot
//                               filter .gt('qty', 0). Same shape as .eq with no
//                               PostgREST-specific semantics; covered by
//                               tests/pgrestShim.node.mjs
//
// 2026-09-07 growth (docs/bugs/0670 — the dispatchable recompute has been
// unable to run since 2026-08-16):
//   select('id, so:t!inner(c), kids:t2!inner(c1, c2)')  — ONE level of `!inner`
//                               embed, plus dotted filter columns on an embed
//                               (.not('so.status','in','(...)'),
//                               .gt('po_items.received_qty', 0)).
// This is the shape `recomputeSoStockAllocation` has used since 24b379034
// (#2298) inverted its two hot reads. Before this, `q()` threw
// `unsafe identifier "so.status"` and the whole recompute refused — for three
// weeks, under a run that exited 0.
//
// HOW IT IS TRANSLATED, and why that is faithful rather than a guess:
//   * The RELATIONSHIP IS READ FROM pg_constraint at run time, exactly once per
//     (parent, embed) pair, the same way PostgREST resolves an embed. Not one
//     FK between the two tables, or more than one? That is a GAP with the count
//     printed — never a guessed join column. `mfg_sales_order_items` joins its
//     header on `doc_no`, NOT on an id, so an assumed `parent_id` convention
//     would have silently joined nothing here.
//   * A to-ONE embed (the parent holds the FK) becomes an INNER JOIN and its
//     filters go in the main WHERE — equivalent under an inner join.
//   * A to-MANY embed (the child holds the FK) becomes a correlated
//     `json_agg` subquery for the data plus an `EXISTS` for `!inner`, so the
//     PARENT row set is never multiplied. That matters: `.range()` pages over
//     parents, and a join that fanned out would page over joined rows and both
//     repeat and skip parents.
//   * `!inner` is required. A plain `rel(...)` embed is a GAP, because a LEFT
//     embed changes which parents come back and no caller here wants one.
//
// NOT a general client. One level of embedding only, no `.rpc()`, no deletes —
// the day a canonical function needs one, the gap list names it and the shim
// grows a tested method.
const IDENT = /^[a-z_][a-z0-9_]*$/;
/* PostgREST's EMBEDDED-FILTER spelling — `.not('so.status', 'in', ...)`,
   `.gt('po_items.received_qty', 0)`. It filters the parent by a column of an
   embedded relation, so it belongs to the same unimplemented feature as
   `select('a, rel(b)')` below and must be reported the same way.

   IT WAS NOT. A dotted name fell through to the plain "unsafe identifier"
   throw, which records NO gap — so the shim's whole safety net (every caller
   aborts non-zero on a non-empty `__gaps`) never fired for the one shape the
   allocator actually uses. `so-stock-allocation.ts` acquired two of these on
   2026-08-16 with its inverted DO-line and PO-link reads, and from that day
   `recompute-so-allocation` returned `ok=false … unsafe identifier "so.status"`
   while its report printed "(no line changed — the projection already matches
   the allocator's own answer)". PROVEN on three separate production
   dispatches, all of them green: runs 34099835565, 34127825188, 34132871751
   (2026-09-07). Same composition as docs/bugs/0599, one layer lower. */
/* The ONE parser for PostgREST's `in.(…)` list, imported rather than restated —
   `filter(col,'in',…)` below is the escaped form of the same grammar the app now
   WRITES with `pgrestInList`, and two implementations of one grammar is how the
   bug being routed around got in. A `.ts` import is safe here: every script that
   loads this shim runs under `npx tsx` (verified across .github/workflows), and
   vitest resolves it for tests/pgrestShim.test.*. */
import { parsePgrestInList } from '../../src/scm/lib/pgrest-in-list.ts';

const EMBEDDED_FILTER = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/;

/* Split on commas at parenthesis depth 0, so an embed's own column list stays
   in one piece: "id, so:t!inner(a, b), c" -> ["id", "so:t!inner(a, b)", "c"]. */
export function splitTopLevel(s) {
  const out = [];
  let depth = 0, cur = "";
  for (const ch of String(s ?? "")) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim() !== "" || out.length === 0) out.push(cur);
  return out.map((x) => x.trim()).filter((x) => x !== "");
}

/* THE MARK THAT STOPS A REPAIR REACHING THE ACCOUNT BOOK.
   Spelled as a string here and as Symbol.for(...) in
   src/scm/lib/ac-repair-suppression.ts — the registry key IS the contract
   between the two files, because this module is plain ESM loaded by `node` as
   well as by `tsx` and cannot import the TypeScript one. If you change it,
   change it in both; ac-repair-suppression.test.ts pins the behaviour. */
const REPAIR_CLIENT = Symbol.for("houzs.ac.repairClient");

/**
 * @param sql      a `postgres` connection
 * @param schema   the Postgres schema these reads resolve in
 * @param opts.writeback
 *   "suppress" (DEFAULT) — nothing this client does may be written back to
 *   AutoCount. A cutover repair COPIES a value out of the account book, so
 *   sending it back is pointless where they agree and overwrites the owner's
 *   source of truth where they do not (owner, 2026-09-09: 「正常来说你的这批更改
 *   不应该是syncback autocount啊 应该remain啊」).
 *
 *   "enqueue" — this tool's PURPOSE is to push. Only the deliberate re-queue
 *   tools pass it, by name, and it must stay a short list:
 *     rebuild-ac-document.mjs · requeue-autocount-skipped.mjs
 *     recompose-autocount-transfer.mjs · sync-ac-delta.mjs (LANES=push)
 *
 * The DEFAULT is the safe one on purpose. A repair that forgets gets
 * suppression; pushing is the thing that has to be typed out, so it is the
 * thing a reviewer can see. The opposite polarity puts the silent failure on
 * the common path, which is backwards.
 */
export function pgrestShim(sql, schema = "scm", opts = {}) {
  const writeback = opts.writeback ?? "suppress";
  if (writeback !== "suppress" && writeback !== "enqueue") {
    throw new Error(`pgrestShim: writeback must be "suppress" or "enqueue", got ${JSON.stringify(writeback)}`);
  }
  const gaps = [];
  const q = (id) => {
    if (EMBEDDED_FILTER.test(String(id))) {
      const msg = `pgrest-shim GAP: embedded filter "${id}" is not implemented — the shim has no embedded relations to filter on, so this read cannot be executed`;
      gaps.push(msg);
      throw new Error(msg);
    }
    if (!IDENT.test(String(id))) throw new Error(`pgrest-shim: unsafe identifier "${id}"`);
    return `"${id}"`;
  };

  /* One catalog probe per (parent, embed) pair per shim instance. PostgREST
     resolves an embed from the FOREIGN KEY; so does this. */
  const relCache = new Map();
  const resolveRelation = async (parent, child) => {
    const key = `${parent}|${child}`;
    if (relCache.has(key)) return relCache.get(key);
    const rows = await sql.unsafe(
      `SELECT src.relname AS src_table, tgt.relname AS tgt_table,
              (SELECT a.attname FROM pg_attribute a WHERE a.attrelid = c.conrelid  AND a.attnum = c.conkey[1])  AS src_col,
              (SELECT a.attname FROM pg_attribute a WHERE a.attrelid = c.confrelid AND a.attnum = c.confkey[1]) AS tgt_col
         FROM pg_constraint c
         JOIN pg_class src ON src.oid = c.conrelid
         JOIN pg_namespace sn ON sn.oid = src.relnamespace
         JOIN pg_class tgt ON tgt.oid = c.confrelid
         JOIN pg_namespace tn ON tn.oid = tgt.relnamespace
        WHERE c.contype = 'f' AND array_length(c.conkey, 1) = 1
          AND sn.nspname = $1 AND tn.nspname = $1
          AND ((src.relname = $2 AND tgt.relname = $3) OR (src.relname = $3 AND tgt.relname = $2))`,
      [schema, parent, child]);
    const rel = { rows: [...rows] };
    relCache.set(key, rel);
    return rel;
  };

  const from = (table) => {
    q(table);
    const state = {
      table, mode: "select", cols: "*", updateObj: null, insertRows: null,
      filters: [], order: [], limit: null, offset: null, single: null,
    };

    const gap = (name) => {
      const msg = `pgrest-shim GAP: .${name}(...) is not implemented (table "${table}") — the canonical function needs a method the shim must grow (with a test) before this run can be trusted`;
      gaps.push(msg);
      throw new Error(msg);
    };

    const exec = async () => {
      try {
        const params = [];
        const p = (v) => {
          params.push(v);
          return `$${params.length}`;
        };
        // Placeholders are minted in emission order, so WHERE is built where it
        // is emitted: after SET for updates, first for selects.
        /* `ref` turns a filter's column into a SQL reference. The default is
           the bare quoted column, byte-identical to what this shim emitted
           before embeds existed; the embed path passes a qualifier. */
        const clausesFor = (list, ref = (c) => q(c)) => list.map((f) => {
          if (f.op === "eq") return `${ref(f.col)} = ${p(f.v)}`;
          if (f.op === "in") {
            const arr = Array.isArray(f.v) ? f.v : [];
            if (arr.length === 0) return "FALSE"; // PostgREST in.() empty -> no rows
            return `${ref(f.col)} IN (${arr.map((x) => p(x)).join(", ")})`;
          }
          if (f.op === "not-in") {
            const arr = Array.isArray(f.v) ? f.v : [];
            if (arr.length === 0) return "TRUE"; // excluding nothing keeps every row
            return `${ref(f.col)} NOT IN (${arr.map((x) => p(x)).join(", ")})`;
          }
          if (f.op === "not-is-null") return `${ref(f.col)} IS NOT NULL`;
          if (f.op === "is-null") return `${ref(f.col)} IS NULL`;
          if (f.op === "cmp") return `${ref(f.col)} ${f.cmp} ${p(f.v)}`;
          if (f.op === "or") {
            // f.v: [{ col, op: 'is-null' | 'lt', v? }] — parsed in .or().
            const parts = f.v.map((d) => (d.op === "is-null" ? `${ref(d.col)} IS NULL` : `${ref(d.col)} < ${p(d.v)}`));
            return `(${parts.join(" OR ")})`;
          }
          throw new Error(`pgrest-shim: unknown filter op ${f.op}`);
        });
        const buildWhere = () => {
          const wheres = clausesFor(state.filters);
          return wheres.length ? ` WHERE ${wheres.join(" AND ")}` : "";
        };
        const target = `"${schema}".${q(state.table)}`;

        if (state.mode === "upsert") {
          /* 2026-08-29 growth (docs/bugs/0562): the allocator's self-retry
             enqueue — stock-allocation-queue.ts upserts the GLOBAL singleton
             with { onConflict: 'job_key' }. PostgREST semantics: insert, and
             on the named conflict target update every OTHER provided column.
             Only the shapes that call site uses; anything fancier gaps. */
          const rows = Array.isArray(state.insertRows) ? state.insertRows : [state.insertRows];
          if (rows.length === 0) return { data: null, error: null };
          const conflict = String(state.upsertOnConflict ?? "").trim();
          if (!conflict || !IDENT.test(conflict)) {
            return gap(`upsert onConflict ${JSON.stringify(state.upsertOnConflict)} (table "${state.table}")`);
          }
          const cols = [...new Set(rows.flatMap((r) => Object.keys(r ?? {})))];
          if (cols.length === 0) return { data: null, error: null };
          const tuples = rows.map((r) => `(${cols.map((cName) => p(Object.prototype.hasOwnProperty.call(r ?? {}, cName) ? r[cName] : null)).join(", ")})`);
          const updates = cols.filter((cName) => cName !== conflict).map((cName) => `${q(cName)} = EXCLUDED.${q(cName)}`);
          const onConf = updates.length ? `DO UPDATE SET ${updates.join(", ")}` : "DO NOTHING";
          await sql.unsafe(`INSERT INTO ${target} (${cols.map((cName) => q(cName)).join(", ")}) VALUES ${tuples.join(", ")} ON CONFLICT (${q(conflict)}) ${onConf}`, params);
          return { data: null, error: null };
        }
        if (state.mode === "insert") {
          const rows = Array.isArray(state.insertRows) ? state.insertRows : [state.insertRows];
          if (rows.length === 0) return { data: null, error: null };
          // Column set = UNION across rows; a row missing a key inserts NULL.
          const cols = [...new Set(rows.flatMap((r) => Object.keys(r ?? {})))];
          if (cols.length === 0) return { data: null, error: null };
          const tuples = rows.map((r) => `(${cols.map((cName) => p(Object.prototype.hasOwnProperty.call(r ?? {}, cName) ? r[cName] : null)).join(", ")})`);
          await sql.unsafe(`INSERT INTO ${target} (${cols.map((cName) => q(cName)).join(", ")}) VALUES ${tuples.join(", ")}`, params);
          return { data: null, error: null };
        }
        if (state.mode === "update") {
          const entries = Object.entries(state.updateObj ?? {});
          if (entries.length === 0) return { data: null, error: null };
          const sets = entries.map(([k, v]) => `${q(k)} = ${p(v)}`).join(", ");
          const where = buildWhere();
          // The lock claim / lease CAS chain .select(...).maybeSingle() after
          // update — they must SEE the row they claimed (or null). RETURNING
          // serves exactly that; an update without .select() keeps data:null.
          if (state.cols !== "*" || state.single) {
            const retCols = state.cols === "*" ? "*" : String(state.cols).split(",").map((cName) => q(cName.trim())).join(", ");
            const rows = await sql.unsafe(`UPDATE ${target} SET ${sets}${where} RETURNING ${retCols}`, params);
            if (state.single === "maybe") {
              if (rows.length > 1) return { data: null, error: { message: `maybeSingle: ${rows.length} rows` } };
              return { data: rows[0] ?? null, error: null };
            }
            if (state.single === "single") {
              if (rows.length !== 1) return { data: null, error: { message: `single: ${rows.length} rows` } };
              return { data: rows[0], error: null };
            }
            return { data: [...rows], error: null };
          }
          await sql.unsafe(`UPDATE ${target} SET ${sets}${where}`, params);
          return { data: null, error: null };
        }
        /* ── the embedded-select path ──────────────────────────────────────
           Entered only when select() actually names an embed, so every
           non-embedded read below emits exactly the SQL it always did. */
        const parts = state.cols === "*" ? ["*"] : splitTopLevel(state.cols);
        const embedSpecs = parts.filter((t) => t.includes("("));
        if (embedSpecs.length > 0) {
          const embeds = [];
          for (const t of embedSpecs) {
            const m = /^(?:([A-Za-z_][A-Za-z0-9_]*)\s*:\s*)?([A-Za-z_][A-Za-z0-9_]*)(!inner)?\s*\((.*)\)$/.exec(t);
            if (!m) return gap(`embedded select ${JSON.stringify(t)} — unparseable`);
            if (!m[3]) return gap(`embedded select ${JSON.stringify(t)} without !inner — a LEFT embed changes which parent rows come back`);
            const embedCols = splitTopLevel(m[4]);
            if (embedCols.some((c) => c.includes("(") || c.includes(":"))) {
              return gap(`embedded select ${JSON.stringify(t)} — only ONE level of embedding is implemented`);
            }
            const alias = m[1] || m[2];
            /* "p" is this translation's own name for the parent table. */
            if (alias === "p") return gap(`embed aliased "p" — that name is taken by the parent row`);
            if (embedCols.length === 0) return gap(`embedded select ${JSON.stringify(t)} names no columns`);
            embeds.push({ alias, table: m[2], cols: embedCols });
          }
          const byAlias = new Map(embeds.map((e) => [e.alias, e]));
          const baseCols = parts.filter((t) => !t.includes("("));
          if (baseCols.includes("*")) return gap(`select("*") alongside an embed`);

          /* Route every filter to the parent or to the embed it names. An
             alias nobody declared is a gap, never silently a parent column. */
          const parentFilters = [];
          for (const f of state.filters) {
            const cols = f.op === "or" ? f.v.map((d) => d.col) : [f.col];
            const aliases = [...new Set(cols.map((c) => (String(c).includes(".") ? String(c).split(".")[0] : null)))];
            if (aliases.length !== 1) return gap(`a filter spanning ${JSON.stringify(aliases)} — one target per filter`);
            const alias = aliases[0];
            if (alias === null) { parentFilters.push(f); continue; }
            const e = byAlias.get(alias);
            if (!e) return gap(`filter on "${alias}.*" but select() declares no embed called "${alias}"`);
            const strip = (c) => String(c).slice(alias.length + 1);
            e.filters = e.filters ?? [];
            e.filters.push(f.op === "or"
              ? { ...f, v: f.v.map((d) => ({ ...d, col: strip(d.col) })) }
              : { ...f, col: strip(f.col) });
          }

          /* The relationship, from the catalog. */
          for (const e of embeds) {
            const rel = await resolveRelation(state.table, e.table);
            if (rel.rows.length !== 1) {
              return gap(`embed "${e.alias}": ${rel.rows.length} single-column foreign key(s) between ${schema}.${state.table} and ${schema}.${e.table} — PostgREST resolves an embed through exactly one`);
            }
            const r = rel.rows[0];
            e.toOne = r.src_table === state.table;
            e.parentCol = e.toOne ? r.src_col : r.tgt_col;
            e.childCol = e.toOne ? r.tgt_col : r.src_col;
          }

          /* Emission order is TEXT order, deliberately: placeholders are minted
             as clauses are built, so building in the order the statement reads
             keeps $1, $2, ... ascending across it. They would bind correctly
             either way — each clause carries its own index — but a statement
             whose numbers jump is a statement nobody can check by eye in a log. */
          const P = `"p"`;
          const A = (e) => q(e.alias);
          const C = (e) => `"c_${e.alias}"`;
          const childFrom = (e, extra) => `FROM "${schema}".${q(e.table)} ${C(e)} WHERE ${C(e)}.${q(e.childCol)} = ${P}.${q(e.parentCol)}${extra}`;
          const embedWhere = (e) => {
            const f = clausesFor(e.filters ?? [], (c) => `${C(e)}.${q(c)}`);
            return f.length ? ` AND ${f.join(" AND ")}` : "";
          };
          const selectList = [...baseCols.map((c) => `${P}.${q(c)}`)];
          for (const e of embeds) {
            if (e.toOne) {
              selectList.push(`json_build_object(${e.cols.map((c) => `'${c}', ${A(e)}.${q(c)}`).join(", ")}) AS ${A(e)}`);
            } else {
              /* to-MANY: aggregate in a correlated subquery so the parent row
                 set is never multiplied. */
              const obj = `json_build_object(${e.cols.map((c) => `'${c}', ${C(e)}.${q(c)}`).join(", ")})`;
              selectList.push(`(SELECT COALESCE(json_agg(${obj}), '[]'::json) ${childFrom(e, embedWhere(e))}) AS ${A(e)}`);
            }
          }
          const joins = embeds.filter((e) => e.toOne)
            .map((e) => `JOIN "${schema}".${q(e.table)} ${A(e)} ON ${A(e)}.${q(e.childCol)} = ${P}.${q(e.parentCol)}`);
          const allWhere = [
            ...clausesFor(parentFilters, (c) => `${P}.${q(c)}`),
            ...embeds.filter((e) => e.toOne).flatMap((e) => clausesFor(e.filters ?? [], (c) => `${A(e)}.${q(c)}`)),
            /* `!inner` on a to-many: at least one child must survive the same
               narrowing the aggregate applied. */
            ...embeds.filter((e) => !e.toOne).map((e) => `EXISTS (SELECT 1 ${childFrom(e, embedWhere(e))})`),
          ];
          const eOrder = state.order.length
            ? ` ORDER BY ${state.order.map((o) => `${P}.${q(o.col)} ${o.asc ? "ASC" : "DESC"}`).join(", ")}`
            : "";
          const eLimit = state.limit != null ? ` LIMIT ${Number(state.limit)}` : "";
          const eOffset = state.offset != null ? ` OFFSET ${Number(state.offset)}` : "";
          const text = `SELECT ${selectList.join(", ")} FROM "${schema}".${q(state.table)} ${P}`
            + (joins.length ? ` ${joins.join(" ")}` : "")
            + (allWhere.length ? ` WHERE ${allWhere.join(" AND ")}` : "")
            + eOrder + eLimit + eOffset;
          const rows = await sql.unsafe(text, params);
          if (state.single === "maybe") {
            if (rows.length > 1) return { data: null, error: { message: `maybeSingle: ${rows.length} rows` } };
            return { data: rows[0] ?? null, error: null };
          }
          if (state.single === "single") {
            if (rows.length !== 1) return { data: null, error: { message: `single: ${rows.length} rows` } };
            return { data: rows[0], error: null };
          }
          return { data: [...rows], error: null };
        }

        const where = buildWhere();

        let cols = "*";
        if (state.cols !== "*") {
          cols = parts.map((c) => {
            const t = c.trim();
            if (!t) throw new Error("pgrest-shim: empty column in select()");
            if (t.includes(":")) {
              const msg = `pgrest-shim GAP: aliased select "${t}" is not implemented`;
              gaps.push(msg);
              throw new Error(msg);
            }
            return q(t);
          }).join(", ");
        }
        const order = state.order.length
          ? ` ORDER BY ${state.order.map((o) => `${q(o.col)} ${o.asc ? "ASC" : "DESC"}`).join(", ")}`
          : "";
        const limit = state.limit != null ? ` LIMIT ${Number(state.limit)}` : "";
        const offset = state.offset != null ? ` OFFSET ${Number(state.offset)}` : "";
        const rows = await sql.unsafe(`SELECT ${cols} FROM ${target}${where}${order}${limit}${offset}`, params);

        if (state.single === "maybe") {
          if (rows.length > 1) return { data: null, error: { message: `maybeSingle: ${rows.length} rows` } };
          return { data: rows[0] ?? null, error: null };
        }
        if (state.single === "single") {
          if (rows.length !== 1) return { data: null, error: { message: `single: ${rows.length} rows` } };
          return { data: rows[0], error: null };
        }
        return { data: [...rows], error: null };
      } catch (e) {
        return { data: null, error: { message: String(e?.message ?? e), code: e?.code } };
      }
    };

    const builder = {
      select(cols) { state.cols = cols ?? "*"; return proxied; },
      update(obj) { state.mode = "update"; state.updateObj = obj; return proxied; },
      insert(rows) { state.mode = "insert"; state.insertRows = rows; return proxied; },
      upsert(rows, opts) { state.mode = "upsert"; state.insertRows = rows; state.upsertOnConflict = opts?.onConflict; return proxied; },
      eq(col, v) { state.filters.push({ op: "eq", col, v }); return proxied; },
      /* PostgREST's neq is SQL's <>, NULL semantics and all: a row whose column
         IS NULL is excluded by both, so the literal translation is faithful.
         `neq(col, null)` is NOT that — PostgREST spells "has a value" as
         not(col,'is',null), which this shim already has — so it is a loud gap
         rather than a silent `<> NULL` that matches nothing. */
      neq(col, v) {
        if (v === null) return gap(`neq(${col}, null) — use .not('${col}', 'is', null)`);
        state.filters.push({ op: "cmp", cmp: "<>", col, v });
        return proxied;
      },
      in(col, arr) { state.filters.push({ op: "in", col, v: arr }); return proxied; },
      /* filter(col, 'in', '("a","b\\"c")') — the ESCAPED in-list. Four repair
         scripts drive autocount-outbox.ts through this shim, and that file reads
         supplier bindings through lib/supplier-bindings.ts, which stopped using
         `.in()` because supabase-js cannot serialise a value carrying a `"`
         (docs/bugs/0780). Parsed by the SAME function PostgREST's grammar is
         written in, never by a second `split(",")` here — a naive split is the
         very defect being routed around. Any other operator is a loud gap. */
      filter(col, op, v) {
        if (op === "in" && typeof v === "string" && v.startsWith("(") && v.endsWith(")")) {
          state.filters.push({ op: "in", col, v: parsePgrestInList(v) });
          return proxied;
        }
        return gap(`filter(${col}, ${op}, ${v}) — only the 'in' operator with a parenthesised list is implemented`);
      },
      /* Scalar comparisons. The allocator filters open lots with .gt('qty', 0);
         these four are the same shape as .eq and carry no PostgREST-specific
         semantics, so they are safe to translate literally. */
      gt(col, v) { state.filters.push({ op: "cmp", cmp: ">", col, v }); return proxied; },
      gte(col, v) { state.filters.push({ op: "cmp", cmp: ">=", col, v }); return proxied; },
      lt(col, v) { state.filters.push({ op: "cmp", cmp: "<", col, v }); return proxied; },
      lte(col, v) { state.filters.push({ op: "cmp", cmp: "<=", col, v }); return proxied; },
      not(col, op, v) {
        if (op === "is" && v === null) { state.filters.push({ op: "not-is-null", col }); return proxied; }
        if (op === "in" && typeof v === "string" && v.startsWith("(") && v.endsWith(")")) {
          // PostgREST parenthesised bare-value list: not('status','in','(A,B)').
          const arr = v.slice(1, -1).split(",").map((s) => s.trim()).filter(Boolean);
          state.filters.push({ op: "not-in", col, v: arr });
          return proxied;
        }
        return gap(`not(${col}, ${op}, ${v})`);
      },
      or(expr) {
        // EXACTLY the disjunction grammar the lock claim / lease CAS use:
        // 'a.is.null,b.lt.<value>' — value may itself contain dots (ISO
        // timestamps), so only the first two dots delimit. Anything outside
        // the two supported ops is a loud gap, never a guess.
        const disjuncts = [];
        for (const part of String(expr ?? "").split(",")) {
          const first = part.indexOf(".");
          const second = part.indexOf(".", first + 1);
          if (first < 0 || second < 0) return gap(`or(${expr})`);
          const col = part.slice(0, first);
          const op = part.slice(first + 1, second);
          const v = part.slice(second + 1);
          if (op === "is" && v === "null") disjuncts.push({ col, op: "is-null" });
          else if (op === "lt") disjuncts.push({ col, op: "lt", v });
          else return gap(`or(${expr})`);
        }
        if (disjuncts.length === 0) return gap(`or(${expr})`);
        state.filters.push({ op: "or", v: disjuncts });
        return proxied;
      },
      is(col, v) {
        if (v === null) { state.filters.push({ op: "is-null", col }); return proxied; }
        return gap(`is(${col}, ${v})`);
      },
      order(col, opts) { state.order.push({ col, asc: opts?.ascending !== false }); return proxied; },
      limit(n) { state.limit = n; return proxied; },
      range(a, b) { state.offset = a; state.limit = b - a + 1; return proxied; },
      maybeSingle() { state.single = "maybe"; return proxied; },
      single() { state.single = "single"; return proxied; },
      then(res, rej) { return exec().then(res, rej); },
    };
    const proxied = new Proxy(builder, {
      get(t, prop) {
        if (prop in t) return t[prop];
        if (typeof prop === "symbol" || prop === "catch" || prop === "finally") return undefined;
        return () => gap(String(prop));
      },
    });
    return proxied;
  };

  const client = {
    from,
    rpc(name) {
      const msg = `pgrest-shim GAP: .rpc("${name}") is not implemented — call the function with sql.unsafe instead`;
      gaps.push(msg);
      throw new Error(msg);
    },
    __gaps: gaps,
  };
  /* Non-enumerable, so it never leaks into a spread or a JSON payload. */
  if (writeback === "suppress") {
    Object.defineProperty(client, REPAIR_CLIENT, {
      value: true, enumerable: false, writable: false, configurable: false,
    });
  }
  return client;
}
