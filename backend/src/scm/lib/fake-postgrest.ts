// ----------------------------------------------------------------------------
// A PostgREST stand-in over in-memory tables. TEST HELPER ONLY — nothing the
// Worker ships imports it.
//
// It moved out of autocount-outbox.test.ts when a SECOND suite needed it
// (autocount-requeue.test.ts). A copied fake is the failure mode worth avoiding
// here: the value of this thing is that it answers like the real edge — a column
// the table does not have fails the WHOLE query with 42703 rather than being
// dropped — and a copy that quietly lost that would make its suite prove less
// than its test names claim.
// ----------------------------------------------------------------------------

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
  /** Rows the index covers. A partial index only constrains these. */
  covers?: (r: Row) => boolean;
  name?: string;
}

/* Supports the shapes these modules use: select/eq/neq/in/lt/like/order/limit/
   single/maybeSingle, insert (one row or an array), update and delete. `missing`
   names columns the table does NOT have: asking for one fails the whole query
   with 42703 and a null body, exactly as PostgREST does — the only way a test
   can catch a read that quietly becomes "this document has no lines", and the
   only way to simulate the transient blip that defeats an idempotency guard. */
export function fakeSb(
  tables: Record<string, Row[]>,
  missing: Record<string, string[]> = {},
  unique: FakeUniqueIndex[] = [],
) {
  const from = (table: string) => {
    tables[table] ??= [];
    const filters: Array<(r: Row) => boolean> = [];
    const sorts: Array<{ col: string; asc: boolean }> = [];
    let limitN: number | null = null;
    let pendingInsert: Row | null = null;
    let pendingRows: Row[] | null = null;
    let pendingUpdate: Row | null = null;
    let pendingDelete = false;
    let columnError: { code: string; message: string } | null = null;
    let wantCount = false;
    let lastInserted: Row | null = null;
    /* ORDER BY is applied for real, not ignored. `nextJeNo` mints the next
       accounting voucher number from `.order('je_no', { ascending: false })
       .limit(1)`, so a fake that returned insertion order would hand out a
       number that already exists and a test called "does not collide" would
       pass while production duplicated a JE. */
    let rangeFrom: number | null = null;
    let rangeTo: number | null = null;
    const rows = () => {
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
      /* PostgREST `.range(from, to)` is an INCLUSIVE offset window applied
         after sorting — paginateAll (lib/paginate-all.ts) is built on it, so a
         fake without it forces every paged read into bespoke pagination the
         production code does not use. Faithful semantics: slice AFTER sort,
         inclusive of `to`, composable with `.limit()` the way PostgREST
         composes them (limit caps the window). */
      const windowed = rangeFrom != null ? rs.slice(rangeFrom, (rangeTo ?? rs.length - 1) + 1) : rs;
      return limitN == null ? windowed : windowed.slice(0, limitN);
    };
    /* The insert-time half of a UNIQUE index. Postgres answers 23505 and the
       row is NOT written; enqueueAcOp reads that as "the same intent is already
       queued" and returns false. A fake that accepted the duplicate would let a
       test called "does not double-queue" pass while production really did. */
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
      /* head:true asks for the COUNT and no rows. conversionIsPartial reads it
         to decide whether a transfer leaves any of the parent's lines behind,
         and a fake that answered `undefined` would make every test take the
         refusal branch for the wrong reason. */
      if (wantCount) return { data: null, count: rows().length, error: null };
      if (pendingRows) {
        /* Bulk insert. PostgREST takes an array and writes every row in ONE
           statement; postSiRevenue posts both GL lines that way, so a fake that
           stored the array as a single row would let a test assert "two lines"
           against one object that merely looks like two. */
        for (const row of pendingRows) {
          const violated = uniqueViolation(row);
          if (violated) return { data: null, error: violated };
        }
        const written = pendingRows.map((row, i) => ({ id: `row-${tables[table].length + i + 1}`, ...row }));
        tables[table].push(...written);
        lastInserted = written[0] ?? null;
        return { data: null, error: null };
      }
      if (pendingInsert) {
        const violated = uniqueViolation(pendingInsert);
        if (violated) return { data: null, error: violated };
        /* Keep the written row so `.insert(...).select('*').single()` can hand it
           back the way PostgREST does. postSiRevenue reads `je.id` off exactly
           that chain and writes the JE's lines against it, so a fake that
           returned null there would fail on the happy path for a reason that has
           nothing to do with the rule under test. */
        const written = { id: `row-${tables[table].length + 1}`, ...pendingInsert };
        tables[table].push(written);
        lastInserted = written;
        /* data stays null on the bare `await sb.from(t).insert(x)` path — three
           suites already assert that shape. The written row is handed back only
           through .select().single()/.maybeSingle(), which is the chain that
           asks for it. */
        return { data: null, error: null };
      }
      if (pendingDelete) {
        const doomed = new Set(rows());
        tables[table] = tables[table].filter((r) => !doomed.has(r));
        return { data: null, error: null };
      }
      if (pendingUpdate) {
        for (const r of rows()) Object.assign(r, pendingUpdate);
        return { data: null, error: null };
      }
      return { data: rows(), error: null };
    };
    const builder: any = {
      select(cols?: string, opts?: { count?: string; head?: boolean }) {
        const gone = (missing[table] ?? []).filter((c) => (cols ?? '').split(',').map((x) => x.trim()).includes(c));
        if (gone.length) columnError = { code: '42703', message: `column ${table}.${gone[0]} does not exist` };
        if (opts?.count) wantCount = true;
        return builder;
      },
      insert(payload: Row | Row[]) {
        if (Array.isArray(payload)) pendingRows = payload;
        else pendingInsert = payload;
        return builder;
      },
      update(patch: Row) { pendingUpdate = patch; return builder; },
      delete() { pendingDelete = true; return builder; },
      eq(col: string, val: unknown) { filters.push((r) => String(r[col]) === String(val)); return builder; },
      neq(col: string, val: unknown) { filters.push((r) => String(r[col]) !== String(val)); return builder; },
      in(col: string, vals: unknown[]) { filters.push((r) => vals.map(String).includes(String(r[col]))); return builder; },
      lt(col: string, val: unknown) { filters.push((r) => Number(r[col] ?? 0) < Number(val)); return builder; },
      /* gte/lte compare as PostgREST does for the column's type: numbers
         numerically, everything else lexically — which is exactly how ISO
         date/timestamp strings order, the use these appear in (accounting's
         entry_date and paid_at windows). */
      gte(col: string, val: unknown) {
        filters.push((r) => (typeof r[col] === 'number' ? Number(r[col]) >= Number(val) : String(r[col] ?? '') >= String(val)));
        return builder;
      },
      lte(col: string, val: unknown) {
        filters.push((r) => (typeof r[col] === 'number' ? Number(r[col]) <= Number(val) : String(r[col] ?? '') <= String(val)));
        return builder;
      },
      /* PostgREST `like` with SQL wildcards. Only `%` is used in this codebase
         (`JE-2607-%`), and the anchoring matters: an unanchored match would let
         one company's JE sequence see the other's ("2990-JE-2607-1" matching
         "JE-2607-%"), which is the collision the prefix exists to prevent. */
      like(col: string, pattern: string) {
        const rx = new RegExp(`^${String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*')}$`);
        filters.push((r) => rx.test(String(r[col] ?? '')));
        return builder;
      },
      /* `ilike` is `like` with the `i` flag and nothing else — same anchoring,
         same escaping. The outbox page searches a document number the operator
         typed off paper, where case is not a fact about the document. */
      ilike(col: string, pattern: string) {
        const rx = new RegExp(`^${String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*')}$`, 'i');
        filters.push((r) => rx.test(String(r[col] ?? '')));
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
        return { data: lastInserted ?? rows()[0] ?? null, error: null };
      },
      /* `.single()` on zero rows is an ERROR in PostgREST (PGRST116), not a null
         body — the exact difference CLAUDE.md's maybeSingle rule turns on. A fake
         that answered null here would let a handler's honest 404 path go
         untested while production returned a 500. */
      single: async () => {
        const settled = settle();
        if (settled.error) return { data: null, error: settled.error };
        const row = lastInserted ?? rows()[0] ?? null;
        if (!row) {
          return { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } };
        }
        return { data: row, error: null };
      },
      then(resolve: (v: unknown) => unknown) { return Promise.resolve(settle()).then(resolve); },
    };
    return builder;
  };
  return { from, tables } as never as { from: (t: string) => any; tables: Record<string, Row[]> };
}
