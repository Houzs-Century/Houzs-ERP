/* A small PostgREST-shaped fake, good enough to run a real SCM read path and
   COUNT what it costs.
 *
 * WHY IT EXISTS. The expensive thing in this codebase is not SQL, it is the
 * number of SERIAL Worker->PostgREST round trips a function makes: the SO
 * stock-allocation sweep was measured on production at 123 of them, 71 of which
 * fetched 83 rows. A test that asserts an OUTCOME cannot see that, and a test
 * that asserts "`.in` was called" passes against a filter applied to the wrong
 * column. So this fake APPLIES the predicates — including embedded ones — and
 * records one request per awaited builder, which makes round-trip count a thing
 * a test can assert.
 *
 * It is NOT a general PostgREST. It implements exactly what the code under test
 * uses, and THROWS on anything it does not understand, because a fake that
 * silently ignores a filter reports a green run for a query that would have
 * returned different rows in production ("a checker that cannot match reports a
 * clean run" — CLAUDE.md).
 *
 * Supported: select with one level of embedding (`alias:table!inner(cols)` and
 * `alias:table(cols)`), eq / neq / in / gt / is(col,null) / not(col,'is',null) /
 * not(col,'in','("A","B")') on both top-level and embedded (`alias.col`)
 * columns, order, range, update, insert, delete, maybeSingle, and the `.or(...)`
 * form the allocation lock uses.
 */

export type Row = Record<string, unknown>;

/** child table -> { column on the child, parent table, column on the parent }.
 *  PostgREST resolves an embed from a FOREIGN KEY; this is the same map, typed
 *  out, so an embed the database could not actually resolve fails here too. */
export type Relationship = { child: string; childCol: string; parent: string; parentCol: string };

type Filter = { op: string; path: string; value: unknown; not?: boolean };

type Embed = { alias: string; table: string; inner: boolean; cols: string[] };

/** Split a select list on commas that are not inside parentheses. */
function splitCols(cols: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of cols) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

function parseSelect(cols: string): { plain: string[]; embeds: Embed[] } {
  const plain: string[] = [];
  const embeds: Embed[] = [];
  for (const tok of splitCols(cols)) {
    const m = /^(?:([A-Za-z0-9_]+)\s*:\s*)?([A-Za-z0-9_]+)(!inner)?\s*\(([\s\S]*)\)$/.exec(tok);
    if (m) {
      const [, alias, table, inner, innerCols] = m;
      embeds.push({ alias: alias || table!, table: table!, inner: Boolean(inner), cols: splitCols(innerCols ?? '') });
    } else {
      plain.push(tok);
    }
  }
  return { plain, embeds };
}

/** `("CANCELLED","DRAFT")` -> ['CANCELLED','DRAFT'] */
function parseInList(v: unknown): string[] {
  const s = String(v ?? '').trim().replace(/^\(/, '').replace(/\)$/, '');
  return s.split(',').map((x) => x.trim().replace(/^"/, '').replace(/"$/, '')).filter(Boolean);
}

function matches(row: Row, f: Filter, col: string): boolean {
  const v = row[col];
  switch (f.op) {
    case 'eq':  return v === f.value;
    case 'neq': return v !== f.value;
    case 'gt':  return Number(v ?? 0) > Number(f.value);
    case 'in':  return (f.value as unknown[]).includes(v as never);
    case 'is':  return f.not ? v !== null && v !== undefined : v === null || v === undefined;
    case 'notin': return !parseInList(f.value).includes(String(v ?? ''));
    default: throw new Error(`fakePostgrest: unsupported operator ${f.op}`);
  }
}

export type FakeDb = {
  from: (table: string) => unknown;
  /** SELECT round trips per table — one per awaited read builder. */
  reads: Map<string, number>;
  /** Non-SELECT round trips per table (update / insert / delete). */
  writes: Map<string, number>;
  /** Every awaited request, in order, as `select mfg_sales_orders` etc. */
  log: string[];
  totalReads: () => number;
  tables: Record<string, Row[]>;
};

export function makeFakePostgrest(
  tables: Record<string, Row[]>,
  relationships: Relationship[],
): FakeDb {
  const reads = new Map<string, number>();
  const writes = new Map<string, number>();
  const log: string[] = [];
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

  const relFor = (from: string, target: string): Relationship => {
    const rel = relationships.find(
      (r) => (r.child === from && r.parent === target) || (r.parent === from && r.child === target),
    );
    if (!rel) throw new Error(`fakePostgrest: no relationship between ${from} and ${target} — PostgREST would answer 400 here`);
    return rel;
  };

  const makeBuilder = (table: string): unknown => {
    let mode: 'select' | 'update' | 'insert' | 'delete' = 'select';
    let cols = '*';
    let payload: Row | null = null;
    let inserted: Row[] = [];
    const filters: Filter[] = [];
    const orders: string[] = [];
    let range: [number, number] | null = null;
    let single = false;
    let settled = false;

    const applyTop = (rows: Row[]): Row[] => rows.filter((r) => filters.every((f) => {
      if (f.path.includes('.')) return true; // embedded filter, applied below
      return matches(r, f, f.path);
    }));

    const run = () => {
      if (settled) throw new Error('fakePostgrest: builder awaited twice');
      settled = true;
      const all = tables[table] ?? (tables[table] = []);
      if (mode === 'insert') {
        bump(writes, table); log.push(`insert ${table}`);
        all.push(...inserted);
        return { data: inserted, error: null };
      }
      let rows = applyTop(all);
      if (mode === 'update') {
        bump(writes, table); log.push(`update ${table}`);
        for (const r of rows) Object.assign(r, payload ?? {});
        return { data: single ? (rows[0] ?? null) : rows, error: null };
      }
      if (mode === 'delete') {
        bump(writes, table); log.push(`delete ${table}`);
        for (const r of rows) all.splice(all.indexOf(r), 1);
        return { data: single ? (rows[0] ?? null) : rows, error: null };
      }

      bump(reads, table); log.push(`select ${table}`);
      const { plain, embeds } = parseSelect(cols);
      let out: Row[] = rows.map((r) => {
        const projected: Row = {};
        if (plain.includes('*') || cols === '*') Object.assign(projected, r);
        else for (const c of plain) projected[c] = r[c];
        return { __src: r, ...projected } as Row;
      });

      for (const e of embeds) {
        const rel = relFor(table, e.table);
        const childRows = tables[e.table] ?? [];
        const embedFilters = filters.filter((f) => f.path.startsWith(`${e.alias}.`));
        const kept: Row[] = [];
        for (const parent of out) {
          const src = parent.__src as Row;
          const linkVal = rel.parent === table ? src[rel.parentCol] : src[rel.childCol];
          const children = (rel.parent === table
            ? childRows.filter((cr) => cr[rel.childCol] === linkVal)
            : childRows.filter((cr) => cr[rel.parentCol] === linkVal))
            .filter((cr) => embedFilters.every((f) => matches(cr, f, f.path.slice(e.alias.length + 1))));
          if (e.inner && children.length === 0) continue;
          const projectedChildren = children.map((cr) => {
            const pc: Row = {};
            for (const c of e.cols) pc[c] = cr[c];
            return pc;
          });
          /* PostgREST returns an OBJECT for a to-one embed and an ARRAY for a
             to-many one. The direction is the FK's, not the caller's wish. */
          const toOne = rel.child === table;
          parent[e.alias] = toOne ? (projectedChildren[0] ?? null) : projectedChildren;
          kept.push(parent);
        }
        out = kept;
      }

      for (const r of out) delete r.__src;
      for (const o of [...orders].reverse()) {
        out = [...out].sort((a, b) => String(a[o] ?? '').localeCompare(String(b[o] ?? '')));
      }
      if (range) out = out.slice(range[0], range[1] + 1);
      return { data: single ? (out[0] ?? null) : out, error: null };
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const builder: any = new Proxy(() => undefined, {
      get(_t, prop: string) {
        if (prop === 'then') {
          return (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
            Promise.resolve().then(run).then(onFulfilled, onRejected);
        }
        return (...args: unknown[]) => {
          switch (prop) {
            case 'select': cols = String(args[0] ?? '*'); return builder;
            case 'update': mode = 'update'; payload = args[0] as Row; return builder;
            case 'insert': mode = 'insert'; inserted = (Array.isArray(args[0]) ? args[0] : [args[0]]) as Row[]; return builder;
            case 'upsert': mode = 'insert'; inserted = (Array.isArray(args[0]) ? args[0] : [args[0]]) as Row[]; return builder;
            case 'delete': mode = 'delete'; return builder;
            case 'eq':  filters.push({ op: 'eq',  path: String(args[0]), value: args[1] }); return builder;
            case 'neq': filters.push({ op: 'neq', path: String(args[0]), value: args[1] }); return builder;
            case 'gt':  filters.push({ op: 'gt',  path: String(args[0]), value: args[1] }); return builder;
            case 'in':  filters.push({ op: 'in',  path: String(args[0]), value: args[1] }); return builder;
            /* `.is(col, null)` — the positive form of the `.not(col,'is',null)`
               below. Needed to run the unlinked-DO coverage read, which selects
               exactly the lines whose so_item_id was blanked. */
            case 'is':
              if (args[1] !== null) throw new Error(`fakePostgrest: unsupported .is(${String(args[1])})`);
              filters.push({ op: 'is', path: String(args[0]), value: null });
              return builder;
            case 'not':
              if (args[1] === 'is') filters.push({ op: 'is', path: String(args[0]), value: null, not: true });
              else if (args[1] === 'in') filters.push({ op: 'notin', path: String(args[0]), value: args[2] });
              else throw new Error(`fakePostgrest: unsupported .not(${String(args[1])})`);
              return builder;
            case 'order': orders.push(String(args[0])); return builder;
            case 'range': range = [Number(args[0]), Number(args[1])]; return builder;
            case 'limit': range = [0, Number(args[0]) - 1]; return builder;
            case 'maybeSingle': single = true; return builder;
            case 'single': single = true; return builder;
            /* The allocation lock's `locked_by.is.null,locked_until.lt.<now>`.
               The fixture always holds a free lock, so this is a pass-through —
               spelled out rather than swallowed by a default branch. */
            case 'or': return builder;
            default: throw new Error(`fakePostgrest: unsupported builder method .${prop}()`);
          }
        };
      },
    });
    return builder;
  };

  return {
    from: makeBuilder,
    reads,
    writes,
    log,
    totalReads: () => [...reads.values()].reduce((a, b) => a + b, 0),
    tables,
  };
}
