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
  /* Tables whose primary key is a BIGINT identity rather than a uuid/text id.
     Their minted ids are NUMBERS, because handlers over such a table validate
     the path parameter with Number.isInteger — a `row-1` id would make every
     one of those handlers answer 400 in tests and pass in production, which is
     the wrong way round for a fake to be wrong. */
  numericIdTables: string[] = [],
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
    /** What the last UPDATE actually touched, for `.update(...).select(...)`. */
    let updated: Row[] | null = null;
    let wantCount = false;
    let selectCalled = false;
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
        const written = pendingRows.map((row, i) => ({ id: mintId(tables[table].length + i + 1), ...row }));
        tables[table].push(...written);
        lastInserted = written[0] ?? null;
        /* PostgREST returns the written rows when the insert asks for them
           (`.insert([...]).select('id, line_no')`) and nothing when it does
           not. The settlement upload needs the new ids to link each statement
           line to its payments, so a fake that always answered null would
           force that code into a shape production does not use. */
        return { data: selectCalled ? written : null, error: null };
      }
      if (pendingInsert) {
        const violated = uniqueViolation(pendingInsert);
        if (violated) return { data: null, error: violated };
        /* Keep the written row so `.insert(...).select('*').single()` can hand it
           back the way PostgREST does. postSiRevenue reads `je.id` off exactly
           that chain and writes the JE's lines against it, so a fake that
           returned null there would fail on the happy path for a reason that has
           nothing to do with the rule under test. */
        const written = { id: mintId(tables[table].length + 1), ...pendingInsert };
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
        /* THE ROWS THIS UPDATE MATCHED, remembered before it changes them.
           PostgREST's `.update(...).select()` is one `UPDATE … RETURNING`
           statement: the WHERE is evaluated against the rows as they were, and
           what comes back is what it actually touched. Recomputing `rows()`
           afterwards is a different question — it re-runs the filter over the
           CHANGED rows — and the two answers differ exactly when the update
           writes the column being filtered on. That is not a corner case here:
           it is how a conditional claim works (claimOutboxRow sets `claimed_at`
           while filtering on `claimed_at IS NULL`), and a fake that recomputed
           would report every successful claim as a lost one. */
        const touched = rows();
        for (const r of touched) Object.assign(r, pendingUpdate);
        updated = touched;
        return { data: null, error: null };
      }
      return { data: rows(), error: null };
    };
    const builder: any = {
      select(cols?: string, opts?: { count?: string; head?: boolean }) {
        const gone = (missing[table] ?? []).filter((c) => (cols ?? '').split(',').map((x) => x.trim()).includes(c));
        if (gone.length) columnError = { code: '42703', message: `column ${table}.${gone[0]} does not exist` };
        if (opts?.count) wantCount = true;
        selectCalled = true;
        return builder;
      },
      insert(payload: Row | Row[]) {
        if (Array.isArray(payload)) pendingRows = payload;
        else pendingInsert = payload;
        return builder;
      },
      /* PostgREST upsert — insert, or update the row the onConflict columns
         already name. Modeled the way supabase-js sends it: the conflict key
         is a comma-joined column list; a hit updates IN PLACE, a miss falls
         through to the normal insert path (unique checks included). */
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
      /* PostgREST `is`, which is the ONLY correct way to ask about NULL — `eq`
         sends `=`, and `col = NULL` is NULL rather than true in SQL, so a null
         test written as `.eq(col, null)` matches nothing against a real
         database however well it reads. Absent and null are the same answer
         here, as they are in Postgres: a column with no value is null. */
      is(col: string, val: unknown) {
        filters.push((r) => (val === null ? r[col] === null || r[col] === undefined : r[col] === val));
        return builder;
      },
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
        /* `updated` first: see the UPDATE branch in settle(). It is null on every
           chain that did not update, so nothing else changes shape. */
        if (updated) return { data: updated[0] ?? null, error: null };
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
  /* `.schema('public')` — a real supabase-js client returns a client scoped to
     that schema. The fakes model ONE table namespace, so it returns itself: a
     test's `tables` map is the whole database and has no schema dimension.
     Present because production code reaches ACROSS schemas: the SCM client is
     pinned to `scm` (db/supabase.ts), and the companies master lives in
     `public`, so `jePrefixForCompany` must say so explicitly. Without this the
     fake throws `sb.schema is not a function` and the test would be measuring
     the fake, not the code. See docs/bugs/0522. */
  const schemaCalls: string[] = [];
  const api: {
    from: (t: string) => any;
    tables: Record<string, Row[]>;
    schema: (s: string) => any;
    schemaCalls: string[];
  } = {
    from,
    tables,
    schema: (s: string) => { schemaCalls.push(s); return api; },
    schemaCalls,
  };
  return api as never as typeof api;
}
