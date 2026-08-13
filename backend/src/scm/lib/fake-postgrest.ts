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

/* Supports the shapes these modules use: select/eq/neq/in/lt/order/limit/
   maybeSingle, insert and update. `missing` names columns the table does NOT
   have: asking for one fails the whole query with 42703 and a null body,
   exactly as PostgREST does — the only way a test can catch a read that quietly
   becomes "this document has no lines". */
export function fakeSb(
  tables: Record<string, Row[]>,
  missing: Record<string, string[]> = {},
  unique: FakeUniqueIndex[] = [],
) {
  const from = (table: string) => {
    tables[table] ??= [];
    const filters: Array<(r: Row) => boolean> = [];
    let limitN: number | null = null;
    let pendingInsert: Row | null = null;
    let pendingUpdate: Row | null = null;
    let columnError: { code: string; message: string } | null = null;
    let wantCount = false;
    const rows = () => {
      const rs = tables[table].filter((r) => filters.every((f) => f(r)));
      return limitN == null ? rs : rs.slice(0, limitN);
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
      if (pendingInsert) {
        const violated = uniqueViolation(pendingInsert);
        if (violated) return { data: null, error: violated };
        tables[table].push({ id: `row-${tables[table].length + 1}`, ...pendingInsert });
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
      insert(payload: Row) { pendingInsert = payload; return builder; },
      update(patch: Row) { pendingUpdate = patch; return builder; },
      eq(col: string, val: unknown) { filters.push((r) => String(r[col]) === String(val)); return builder; },
      neq(col: string, val: unknown) { filters.push((r) => String(r[col]) !== String(val)); return builder; },
      in(col: string, vals: unknown[]) { filters.push((r) => vals.map(String).includes(String(r[col]))); return builder; },
      lt(col: string, val: unknown) { filters.push((r) => Number(r[col] ?? 0) < Number(val)); return builder; },
      order() { return builder; },
      limit(n: number) { limitN = n; return builder; },
      maybeSingle: async () => (columnError ? { data: null, error: columnError } : { data: rows()[0] ?? null, error: null }),
      then(resolve: (v: unknown) => unknown) { return Promise.resolve(settle()).then(resolve); },
    };
    return builder;
  };
  return { from, tables } as never as { from: (t: string) => any; tables: Record<string, Row[]> };
}
