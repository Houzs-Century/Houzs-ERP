
import { parsePgrestInList } from './pgrest-in-list';

export type Row = Record<string, any>;

/**
 * A UNIQUE index the fake should enforce on inserts.
 *
 * Declared by the caller rather than baked in, because a fake that invents
 * constraints is as misleading as one that ignores them. The one that matters
 * for the outbox is 0277's `autocount_outbox_dedupe_idx`: UNIQUE (dedupe_key)
 * WHERE status = 'pending' AND dedupe_key IS NOT NULL.
 */
export interface FakeUniqueIndex {
  table: string;
  column: string;
  covers?: (r: Row) => boolean;
  name?: string;
}

export function fakeSb(
  tables: Record<string, Row[]>,
  missing: Record<string, string[]> = {},
  unique: FakeUniqueIndex[] = [],
  numericIdTables: string[] = [],
  /* POSTGREST'S OWN RESPONSE CEILING (`db-max-rows`), when a suite needs it.
     Null means "no ceiling", which is what every existing caller gets. A read
     that asks for more rows than this gets the ceiling and NO error — the
     silent truncation that `lib/paginate-all.ts` exists to defeat and that a
     fake without it cannot reproduce. The exact production number is UNKNOWN
     (docs/bugs/0447): pass whichever value the test is arguing about. */
  maxRows: number | null = null,
) {
  const from = (table: string) => {
    const mintId = (n: number): string | number => (numericIdTables.includes(table) ? n : `row-${n}`);
    tables[table] ??= [];
    const filters: Array<(r: Row) => boolean> = [];
    const sorts: Array<{ col: string; asc: boolean }> = [];
    let limitN: number | null = null;
    let pendingInsert: Row | null = null;
    let pendingRows: Row[] | null = null;
    let pendingUpdate: Row | null = null;
    let pendingDelete = false;
    let columnError: { code: string; message: string } | null = null;
    let updated: Row[] | null = null;
    let wantCount = false;
    let headOnly = false;
    let selectCalled = false;
    let lastInserted: Row | null = null;
    let rangeFrom: number | null = null;
    let rangeTo: number | null = null;
    const matched = () => {
      const rs = tables[table].filter((r) => filters.every((f) => f(r)));
      for (const { col, asc } of [...sorts].reverse()) {
        rs.sort((a, b) => {
          const x = a[col];
          const y = b[col];
          if (x === y) return 0;
          if (x == null) return 1;
          if (y == null) return -1;
          const cmp = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
          return asc ? cmp : -cmp;
        });
      }
      return rs;
    };
    const rows = () => {
      const rs = matched();
      const windowed = rangeFrom != null ? rs.slice(rangeFrom, (rangeTo ?? rs.length - 1) + 1) : rs;
      const capped = limitN == null ? windowed : windowed.slice(0, limitN);
      return maxRows == null ? capped : capped.slice(0, maxRows);
    };
    const uniqueViolation = (payload: Row) => {
      for (const ix of unique) {
        if (ix.table !== table) continue;
        const value = payload[ix.column];
        if (value == null) continue;
        if (ix.covers && !ix.covers(payload)) continue;
        const clash = tables[table].some(
          (r) => r[ix.column] === value && (!ix.covers || ix.covers(r)),
        );
        if (clash) {
          return {
            code: '23505',
            message: `duplicate key value violates unique constraint "${ix.name ?? `${table}_${ix.column}_idx`}"`,
          };
        }
      }
      return null;
    };
    const settle = () => {
      if (columnError) return { data: null, error: columnError };
      if (headOnly) return { data: null, count: matched().length, error: null };
      if (pendingRows) {
        for (const row of pendingRows) {
          const violated = uniqueViolation(row);
          if (violated) return { data: null, error: violated };
        }
        const written = pendingRows.map((row, i) => ({ id: mintId(tables[table].length + i + 1), ...row }));
        tables[table].push(...written);
        lastInserted = written[0] ?? null;
        return { data: selectCalled ? written : null, error: null };
      }
      if (pendingInsert) {
        const violated = uniqueViolation(pendingInsert);
        if (violated) return { data: null, error: violated };
        const written = { id: mintId(tables[table].length + 1), ...pendingInsert };
        tables[table].push(written);
        lastInserted = written;
        return { data: null, error: null };
      }
      if (pendingDelete) {
        const doomedRows = rows();
        const doomed = new Set(doomedRows);
        tables[table] = tables[table].filter((r) => !doomed.has(r));
        /* DELETE … RETURNING: a chain that asks (.select().maybeSingle()) is
           handed what was removed, the way an update is — the payment DELETE
           reads the returned row to tell a version clash from a delete
           (docs/bugs/0927). The bare await keeps its null body. */
        updated = doomedRows;
        return { data: null, error: null };
      }
      if (pendingUpdate) {
        const touched = rows();
        for (const r of touched) Object.assign(r, pendingUpdate);
        updated = touched;
        return { data: null, error: null };
      }
      return wantCount
        ? { data: rows(), count: matched().length, error: null }
        : { data: rows(), error: null };
    };
    const builder: any = {
      select(cols?: string, opts?: { count?: string; head?: boolean }) {
        const gone = (missing[table] ?? []).filter((c) => (cols ?? '').split(',').map((x) => x.trim()).includes(c));
        if (gone.length) columnError = { code: '42703', message: `column ${table}.${gone[0]} does not exist` };
        if (opts?.count) wantCount = true;
        if (opts?.head) headOnly = true;
        selectCalled = true;
        return builder;
      },
      insert(payload: Row | Row[]) {
        if (Array.isArray(payload)) pendingRows = payload;
        else pendingInsert = payload;
        return builder;
      },
      upsert(payload: Row | Row[], opts?: { onConflict?: string }) {
        const rows = Array.isArray(payload) ? payload : [payload];
        const keys = String(opts?.onConflict ?? '').split(',').map((k) => k.trim()).filter(Boolean);
        const leftover: Row[] = [];
        for (const r of rows) {
          const hit = keys.length > 0
            ? tables[table].find((t) => keys.every((k) => String(t[k]) === String(r[k])))
            : undefined;
          if (hit) Object.assign(hit, r);
          else leftover.push(r);
        }
        if (leftover.length > 0) {
          if (Array.isArray(payload)) pendingRows = leftover;
          else pendingInsert = leftover[0]!;
        }
        return builder;
      },
      update(patch: Row) { pendingUpdate = patch; return builder; },
      delete() { pendingDelete = true; return builder; },
      eq(col: string, val: unknown) { filters.push((r) => String(r[col]) === String(val)); return builder; },
      is(col: string, val: unknown) {
        filters.push((r) => (val === null ? r[col] === null || r[col] === undefined : r[col] === val));
        return builder;
      },
      not(col: string, op: string, val: unknown) {
        if (op === 'in') {
          const vals = parsePgrestInList(String(val));
          filters.push((r) => !vals.includes(String(r[col])));
          return builder;
        }
        if (op === 'like') {
          const rx = new RegExp(`^${String(val).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*')}$`);
          filters.push((r) => r[col] != null && !rx.test(String(r[col])));
          return builder;
        }
        if (op !== 'is') throw new Error(`fake-postgrest: not(${op}) is not implemented`);
        filters.push((r) => !(val === null ? r[col] === null || r[col] === undefined : r[col] === val));
        return builder;
      },
      neq(col: string, val: unknown) { filters.push((r) => String(r[col]) !== String(val)); return builder; },
      in(col: string, vals: unknown[]) { filters.push((r) => vals.map(String).includes(String(r[col]))); return builder; },
      /* `.filter(col, 'in', '("a","b\\"c")')` — the ESCAPED in-list the shared
         readers now build, because supabase-js cannot serialise a value carrying
         a `"` (docs/bugs/0780). Parsed by the SAME function the app writes with:
         a second `split(',')` here would swallow the malformed list exactly the
         way the bug does, and report a clean run. Any other operator THROWS, for
         the reason `not()` above gives. */
      filter(col: string, op: string, val: unknown) {
        if (op !== 'in') throw new Error(`fake-postgrest: filter(${op}) is not implemented`);
        const vals = parsePgrestInList(String(val));
        filters.push((r) => vals.includes(String(r[col])));
        return builder;
      },
      /* `lt` compares the way gte/lte below do — by the column's type, NULL
         matching nothing. It used to be numeric-only with a `?? 0` fold, so an
         ISO timestamp became NaN and every row silently dropped: a month window
         written as gte(first) + lt(next-first) — the only correct shape for a
         timestamptz — returned an empty report against this fake while the
         real database returned the rows (docs/bugs/0785). */
      gt(col: string, val: unknown) {
        filters.push((r) => r[col] != null && (typeof r[col] === 'number' ? Number(r[col]) > Number(val) : String(r[col]) > String(val)));
        return builder;
      },
      lt(col: string, val: unknown) {
        filters.push((r) => r[col] != null && (typeof r[col] === 'number' ? Number(r[col]) < Number(val) : String(r[col]) < String(val)));
        return builder;
      },
      gte(col: string, val: unknown) {
        filters.push((r) => r[col] != null && (typeof r[col] === 'number' ? Number(r[col]) >= Number(val) : String(r[col]) >= String(val)));
        return builder;
      },
      lte(col: string, val: unknown) {
        filters.push((r) => r[col] != null && (typeof r[col] === 'number' ? Number(r[col]) <= Number(val) : String(r[col]) <= String(val)));
        return builder;
      },
      like(col: string, pattern: string) {
        const rx = new RegExp(`^${String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*')}$`);
        filters.push((r) => rx.test(String(r[col] ?? '')));
        return builder;
      },
      ilike(col: string, pattern: string) {
        const rx = new RegExp(`^${String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*')}$`, 'i');
        filters.push((r) => rx.test(String(r[col] ?? '')));
        return builder;
      },
      or(expr: string) {
        const terms = orTerms(expr);
        filters.push((r) => terms.some((f) => f(r)));
        return builder;
      },
      order(col?: string, opts?: { ascending?: boolean }) {
        if (col) sorts.push({ col, asc: opts?.ascending !== false });
        return builder;
      },
      limit(n: number) { limitN = n; return builder; },
      range(from: number, to: number) { rangeFrom = from; rangeTo = to; return builder; },
      maybeSingle: async () => {
        const settled = settle();
        if (settled.error) return { data: null, error: settled.error };
        if (updated) return { data: updated[0] ?? null, error: null };
        return { data: lastInserted ?? rows()[0] ?? null, error: null };
      },
      single: async () => {
        const settled = settle();
        if (settled.error) return { data: null, error: settled.error };
        const row = lastInserted ?? rows()[0] ?? null;
        if (!row) {
          return { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } };
        }
        return { data: row, error: null };
      },
      then(resolve: (v: unknown) => unknown) {
        return Promise.resolve(settle()).then((v) => resolve(pendingUpdate && updated && selectCalled && !(v as { error?: unknown }).error ? { data: updated, error: null } : v));
      },
    };
    return builder;
  };
  /* `.schema('public')` — a real supabase-js client returns a client scoped to
     that schema. The fakes model ONE table namespace, so it returns itself: a
     test's `tables` map is the whole database and has no schema dimension.
     Present because production code reaches ACROSS schemas: the SCM client is
     pinned to `scm` (db/supabase.ts), and the companies master lives in
     `public`, so `jePrefixForCompany` must say so explicitly. Without this the
     fake throws `sb.schema is not a function` and the test would be measuring
     the fake, not the code. See docs/bugs/0522. */
  const schemaCalls: string[] = [];
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const api: {
    from: (t: string) => any;
    tables: Record<string, Row[]>;
    schema: (s: string) => any;
    schemaCalls: string[];
    rpc: (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: { code?: string; message: string } | null }>;
    rpcCalls: Array<{ fn: string; args: Record<string, unknown> }>;
    rpcHandlers: Record<string, (args: Record<string, unknown>) => unknown>;
  } = {
    from,
    tables,
    schema: (s: string) => { schemaCalls.push(s); return api; },
    schemaCalls,
    rpcCalls,
    rpcHandlers: {},
    rpc: async (fn: string, args: Record<string, unknown> = {}) => {
      rpcCalls.push({ fn, args });
      const handler = api.rpcHandlers[fn];
      if (!handler) {
        return {
          data: null,
          error: { code: 'PGRST202', message: `Could not find the function public.${fn} in the schema cache` },
        };
      }
      try {
        return { data: handler(args) ?? null, error: null };
      } catch (e) {
        return { data: null, error: { message: String((e as Error)?.message ?? e) } };
      }
    },
  };
  return api as never as typeof api;
}

function orTerms(expr: string): Array<(r: Row) => boolean> {
  const parts: string[] = [];
  let cur = '', depth = 0, quoted = false;
  for (let i = 0; i < String(expr).length; i += 1) {
    const ch = String(expr)[i]!;
    if (quoted && ch === '\\') { cur += ch + (String(expr)[i + 1] ?? ''); i += 1; continue; }
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === '(' || ch === '{')) depth += 1;
    else if (!quoted && (ch === ')' || ch === '}')) depth -= 1;
    else if (!quoted && depth === 0 && ch === ',') { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  parts.push(cur);
  return parts.map((t): ((r: Row) => boolean) => {
    if (t.startsWith('and(') && t.endsWith(')')) {
      const all = orTerms(t.slice(4, -1));
      return (r: Row) => all.every((f) => f(r));
    }
    const [col, op, ...rest] = t.split('.');
    const val = rest.join('.');
    if (op === 'in') {
      const vals = parsePgrestInList(val);
      return (r: Row) => r[col!] != null && vals.includes(String(r[col!]));
    }
    if (op === 'ov') {
      const vals = val.replace(/^\{|\}$/g, '').split(',');
      return (r: Row) => Array.isArray(r[col!]) && (r[col!] as unknown[]).some((x) => vals.includes(String(x)));
    }
    if (op === 'ilike') {
      const rx = new RegExp(`^${val.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*')}$`, 'i');
      return (r: Row) => rx.test(String(r[col!] ?? ''));
    }
    if (op === 'eq') return (r: Row) => String(r[col!]) === val;
    if (op === 'neq') return (r: Row) => r[col!] != null && String(r[col!]) !== val;
    if (op === 'gte') return (r: Row) => r[col!] != null && String(r[col!]) >= val;
    if (op === 'lte') return (r: Row) => r[col!] != null && String(r[col!]) <= val;
    if (op === 'gt') return (r: Row) => r[col!] != null && String(r[col!]) > val;
    if (op === 'lt') return (r: Row) => r[col!] != null && String(r[col!]) < val;
    if (op === 'is' && (val === 'true' || val === 'false')) return (r: Row) => r[col!] === (val === 'true');
    if (op === 'is' && val === 'null') return (r: Row) => r[col!] === null || r[col!] === undefined;
    throw new Error(`fake-postgrest: or(${t}) is not implemented`);
  });
}
