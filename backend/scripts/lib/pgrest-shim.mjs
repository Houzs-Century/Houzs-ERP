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
// NOT a general client. No embedded selects (`a, rel(b)`), no `.rpc()`, no
// deletes — the day a canonical function needs one, the gap list names it and
// the shim grows a tested method.
const IDENT = /^[a-z_][a-z0-9_]*$/;

export function pgrestShim(sql, schema = "scm") {
  const gaps = [];
  const q = (id) => {
    if (!IDENT.test(String(id))) throw new Error(`pgrest-shim: unsafe identifier "${id}"`);
    return `"${id}"`;
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
        const buildWhere = () => {
          const wheres = state.filters.map((f) => {
            if (f.op === "eq") return `${q(f.col)} = ${p(f.v)}`;
            if (f.op === "in") {
              const arr = Array.isArray(f.v) ? f.v : [];
              if (arr.length === 0) return "FALSE"; // PostgREST in.() empty -> no rows
              return `${q(f.col)} IN (${arr.map((x) => p(x)).join(", ")})`;
            }
            if (f.op === "not-in") {
              const arr = Array.isArray(f.v) ? f.v : [];
              if (arr.length === 0) return "TRUE"; // excluding nothing keeps every row
              return `${q(f.col)} NOT IN (${arr.map((x) => p(x)).join(", ")})`;
            }
            if (f.op === "not-is-null") return `${q(f.col)} IS NOT NULL`;
            if (f.op === "is-null") return `${q(f.col)} IS NULL`;
            if (f.op === "cmp") return `${q(f.col)} ${f.cmp} ${p(f.v)}`;
            if (f.op === "or") {
              // f.v: [{ col, op: 'is-null' | 'lt', v? }] — parsed in .or().
              const parts = f.v.map((d) => (d.op === "is-null" ? `${q(d.col)} IS NULL` : `${q(d.col)} < ${p(d.v)}`));
              return `(${parts.join(" OR ")})`;
            }
            throw new Error(`pgrest-shim: unknown filter op ${f.op}`);
          });
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
        const where = buildWhere();

        let cols = "*";
        if (state.cols !== "*") {
          cols = String(state.cols).split(",").map((c) => {
            const t = c.trim();
            if (!t) throw new Error("pgrest-shim: empty column in select()");
            if (t.includes("(") || t.includes(":")) {
              const msg = `pgrest-shim GAP: embedded/aliased select "${t}" is not implemented`;
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

  return {
    from,
    rpc(name) {
      const msg = `pgrest-shim GAP: .rpc("${name}") is not implemented — call the function with sql.unsafe instead`;
      gaps.push(msg);
      throw new Error(msg);
    },
    __gaps: gaps,
  };
}
