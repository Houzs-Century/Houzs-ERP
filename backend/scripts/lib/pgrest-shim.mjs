// A supabase-js-SHAPED query builder over a direct `postgres` connection, so a
// repair script can drive the app's REAL costing functions (restampDoActualCost,
// restampSiFromDo, their helpers) with ONLY DATABASE_URL — no PostgREST creds.
//
// WHY (live run 2026-08-01). The W5 restamp APPLY needs the canonical TS
// functions, which talk supabase-js. The repo's GitHub environment carries no
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY secrets (the APPLY died asking for
// them), and hand-replicating restampDoActualCost's warehouse resolution +
// sofa batch map + variant keys in SQL is exactly the "subtly-different sweep
// is worse than none" trap (recompute-2990-so-allocation.mjs header). So the
// LOGIC stays canonical and only the TRANSPORT is mimicked.
//
// SCOPE — deliberately the exact surface those functions use, nothing more:
//   from(t).select(cols).eq/.in/.not(col,'is',null)/.order/.limit/.range
//          .maybeSingle()/.single()          -> { data, error }
//   from(t).update(obj).eq(...)              -> { data: null, error }
// Every OTHER method THROWS loudly AND is recorded on shim.__gaps — a caller
// can assert the gap list is empty after a run, so an unimplemented method can
// never silently no-op a money write. PostgREST semantics preserved where they
// matter: one autocommitted statement per call (no transaction — same as
// PostgREST), `.in()` with an empty list matches nothing, errors come back as
// { error: { message } } rather than throwing (the app code checks `.error`),
// and maybeSingle() returns null data for zero rows.
//
// NOT a general client. No embedded selects (`a, rel(b)`), no `.or()`, no
// `.rpc()`, no inserts/deletes — the day a canonical function needs one, the
// gap list names it and the shim grows a tested method.
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
      table, mode: "select", cols: "*", updateObj: null,
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
            if (f.op === "not-is-null") return `${q(f.col)} IS NOT NULL`;
            if (f.op === "is-null") return `${q(f.col)} IS NULL`;
            throw new Error(`pgrest-shim: unknown filter op ${f.op}`);
          });
          return wheres.length ? ` WHERE ${wheres.join(" AND ")}` : "";
        };
        const target = `"${schema}".${q(state.table)}`;

        if (state.mode === "update") {
          const entries = Object.entries(state.updateObj ?? {});
          if (entries.length === 0) return { data: null, error: null };
          const sets = entries.map(([k, v]) => `${q(k)} = ${p(v)}`).join(", ");
          const where = buildWhere();
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
      eq(col, v) { state.filters.push({ op: "eq", col, v }); return proxied; },
      in(col, arr) { state.filters.push({ op: "in", col, v: arr }); return proxied; },
      not(col, op, v) {
        if (op === "is" && v === null) { state.filters.push({ op: "not-is-null", col }); return proxied; }
        return gap(`not(${col}, ${op}, ${v})`);
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
