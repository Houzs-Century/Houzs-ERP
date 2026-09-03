import {
  soEditLeaseRefusal, soEditLeaseTakeoverAllowed, type SoEditLeaseRefusal,
} from './so-edit-lease';
import type { Sql } from 'postgres';
import { getSql, resolveDatabaseUrl } from '../../db/pg';

type QueryResult<T = unknown> = { data: T | null; error: { message: string } | null; count?: number | null };
type Predicate = { sql: string; values: unknown[] };
const txQueues = new WeakMap<object, Promise<void>>();
let savepointSequence = 0;

async function serialOnTransaction<T>(sql: Sql, operation: () => Promise<T>): Promise<T> {
  const key = sql as unknown as object;
  const previous = txQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  txQueues.set(key, previous.then(() => current));
  await previous;
  try { return await operation(); }
  finally { release(); }
}

const ident = (value: string): string => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`Unsafe SQL identifier: ${value}`);
  return `"${value}"`;
};

const columnExpr = (value: string): string => {
  const json = value.match(/^([A-Za-z_][A-Za-z0-9_]*)->>([A-Za-z_][A-Za-z0-9_]*)$/);
  if (json) return `${ident(json[1]!)}->>'${json[2]}'`;
  return ident(value);
};

const splitTopLevel = (value: string): string[] => {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of value) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === ',' && depth === 0) {
      if (current.trim()) out.push(current.trim());
      current = '';
    } else current += char;
  }
  if (current.trim()) out.push(current.trim());
  return out;
};

const selectList = (raw = '*'): string => {
  if (raw.trim() === '*') return '*';
  if (raw.trim() === 'count(*)::bigint AS count') return raw.trim();
  const columns = splitTopLevel(raw)
    // PostgREST relationship projections are presentation-only. Command code
    // never uses them for mutation decisions; omit them from the tx adapter.
    .filter((part) => !part.includes('(') && !part.includes(':'))
    .map((part) => columnExpr(part));
  return columns.length > 0 ? columns.join(', ') : '*';
};

const JSON_COLUMNS = new Set([
  'addons', 'allowed_options', 'auto_actions', 'cart', 'config',
  'custom_specials', 'default_free_gifts', 'default_variants', 'eligible',
  'eligible_reward_model_ids', 'field_changes', 'gifts', 'heights_sub_assemblies',
  'included_addons', 'lines', 'meta', 'modules', 'new_variants', 'old_snapshot',
  'option_groups', 'payload', 'pieces', 'price_matrix', 'prices_by_height',
  'pwp_prices_by_height', 'reward_combo_ids', 'seat_height_prices', 'selling_prices_by_height',
  'snapshot', 'sub_assemblies', 'trigger_combo_ids', 'variants',
]);

const NATIVE_TEXT_ARRAY_COLUMNS = new Set(['photo_urls']);
const TEXT_ARRAY_OID = 1009;

const encodePgTextArray = (values: unknown[]): string => `{${values.map((value) => {
  if (value === null) return 'NULL';
  const escaped = String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}).join(',')}}`;

const parsePgTextArray = (value: unknown): unknown => {
  if (Array.isArray(value) || typeof value !== 'string' || !value.startsWith('{') || !value.endsWith('}')) return value;
  if (value === '{}') return [];
  const out: Array<string | null> = [];
  let token = '';
  let quoted = false;
  let escaped = false;
  let tokenWasQuoted = false;
  const push = () => {
    out.push(!tokenWasQuoted && token === 'NULL' ? null : token);
    token = '';
    tokenWasQuoted = false;
  };
  for (const char of value.slice(1, -1)) {
    if (escaped) { token += char; escaped = false; continue; }
    if (char === '\\') { escaped = true; continue; }
    if (char === '"') { quoted = !quoted; tokenWasQuoted = true; continue; }
    if (char === ',' && !quoted) { push(); continue; }
    token += char;
  }
  push();
  return out;
};

const normalizeReturnedRows = (rows: unknown[]): unknown[] => rows.map((row) => {
  if (row == null || typeof row !== 'object' || Array.isArray(row)) return row;
  const normalized = { ...(row as Record<string, unknown>) };
  for (const column of NATIVE_TEXT_ARRAY_COLUMNS) {
    if (column in normalized) normalized[column] = parsePgTextArray(normalized[column]);
  }
  return normalized;
});

const commandParameter = (sql: Sql, column: string, value: unknown): unknown => {
  if (value === undefined || value === null || value instanceof Date) return value;
  if (JSON_COLUMNS.has(column)) {
    // Explicit OID 3802 is essential with postgres.js unsafe(): PostgreSQL's
    // describe phase otherwise discovers jsonb and JSON.stringify's an already
    // stringified value a second time.
    return sql.json(value as never);
  }
  if (NATIVE_TEXT_ARRAY_COLUMNS.has(column)) {
    if (!Array.isArray(value)) throw new Error(`${column} must be a text array`);
    // fetch_types:false deliberately does not discover array serializers. Send
    // a correctly escaped text[] literal with the explicit built-in text[] OID.
    return sql.typed(encodePgTextArray(value), TEXT_ARRAY_OID);
  }
  if (typeof value === 'object') {
    throw new Error(`Unsupported structured value for PostgreSQL column ${column}`);
  }
  return value;
};

class PgPostgrestQuery implements PromiseLike<QueryResult<any>> {
  private operation: 'select' | 'insert' | 'update' | 'delete' | 'upsert' = 'select';
  private payload: Record<string, unknown> | Array<Record<string, unknown>> | null = null;
  private projection = '*';
  private predicates: Predicate[] = [];
  private orders: string[] = [];
  private limitValue: number | null = null;
  private offsetValue: number | null = null;
  private singleMode: 'none' | 'single' | 'maybe' = 'none';
  private headCount = false;
  private conflictColumns: string[] = [];
  private ignoreDuplicates = false;

  constructor(private readonly sql: Sql, private readonly table: string) {}

  select(columns = '*', options?: { count?: string; head?: boolean }) {
    this.projection = columns;
    if (options?.head) {
      this.projection = 'count(*)::bigint AS count';
      this.headCount = true;
    }
    return this;
  }
  insert(value: Record<string, unknown> | Array<Record<string, unknown>>) { this.operation = 'insert'; this.payload = value; return this; }
  update(value: Record<string, unknown>) { this.operation = 'update'; this.payload = value; return this; }
  delete() { this.operation = 'delete'; return this; }
  upsert(value: Record<string, unknown> | Array<Record<string, unknown>>, options?: { onConflict?: string; ignoreDuplicates?: boolean }) {
    this.operation = 'upsert'; this.payload = value;
    this.conflictColumns = (options?.onConflict ?? '').split(',').map((v) => v.trim()).filter(Boolean);
    this.ignoreDuplicates = Boolean(options?.ignoreDuplicates);
    return this;
  }
  eq(column: string, value: unknown) { return this.where(column, '=', value); }
  neq(column: string, value: unknown) { return this.where(column, '<>', value); }
  gt(column: string, value: unknown) { return this.where(column, '>', value); }
  gte(column: string, value: unknown) { return this.where(column, '>=', value); }
  lt(column: string, value: unknown) { return this.where(column, '<', value); }
  lte(column: string, value: unknown) { return this.where(column, '<=', value); }
  is(column: string, value: unknown) {
    this.predicates.push({ sql: `${columnExpr(column)} IS ${value === null ? 'NULL' : value === true ? 'TRUE' : value === false ? 'FALSE' : 'NULL'}`, values: [] });
    return this;
  }
  in(column: string, values: unknown[]) {
    if (values.length === 0) this.predicates.push({ sql: 'FALSE', values: [] });
    else this.predicates.push({ sql: `${columnExpr(column)} IN (${values.map(() => '$$').join(', ')})`, values });
    return this;
  }
  not(column: string, operator: string, value: unknown) {
    if (operator === 'in') {
      const parsed = String(value).replace(/^\(|\)$/g, '').split(',').map((v) => v.trim().replace(/^"|"$/g, ''));
      this.predicates.push({ sql: `${columnExpr(column)} NOT IN (${parsed.map(() => '$$').join(', ')})`, values: parsed });
      return this;
    }
    if (operator === 'is') {
      this.predicates.push({ sql: `${columnExpr(column)} IS NOT ${value === null ? 'NULL' : String(value).toUpperCase()}`, values: [] });
      return this;
    }
    throw new Error(`Unsupported PostgREST not operator: ${operator}`);
  }
  filter(column: string, operator: string, value: unknown) {
    const ops: Record<string, string> = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' };
    const op = ops[operator];
    if (!op) throw new Error(`Unsupported PostgREST filter operator: ${operator}`);
    return this.where(column, op, value);
  }
  or(expression: string) {
    const pieces = splitTopLevel(expression).map((piece) => {
      const match = piece.match(/^([A-Za-z_][A-Za-z0-9_]*(?:->>[A-Za-z_][A-Za-z0-9_]*)?)\.(is|eq|lt|lte|gt|gte)\.(.*)$/);
      if (!match) throw new Error(`Unsupported PostgREST or expression: ${piece}`);
      const [, column, op, raw] = match;
      if (op === 'is') return { sql: `${columnExpr(column!)} IS ${raw === 'null' ? 'NULL' : raw!.toUpperCase()}`, values: [] };
      const sqlOp = ({ eq: '=', lt: '<', lte: '<=', gt: '>', gte: '>=' } as Record<string, string>)[op!]!;
      return { sql: `${columnExpr(column!)} ${sqlOp} $$`, values: [raw] };
    });
    this.predicates.push({ sql: `(${pieces.map((p) => p.sql).join(' OR ')})`, values: pieces.flatMap((p) => p.values) });
    return this;
  }
  order(column: string, options?: { ascending?: boolean; nullsFirst?: boolean }) {
    this.orders.push(`${columnExpr(column)} ${options?.ascending === false ? 'DESC' : 'ASC'}${options?.nullsFirst === true ? ' NULLS FIRST' : options?.nullsFirst === false ? ' NULLS LAST' : ''}`);
    return this;
  }
  limit(value: number) { this.limitValue = value; return this; }
  range(from: number, to: number) {
    this.offsetValue = from;
    this.limitValue = Math.max(0, to - from + 1);
    return this;
  }
  maybeSingle() { this.singleMode = 'maybe'; return this.execute(); }
  single() { this.singleMode = 'single'; return this.execute(); }

  private where(column: string, operator: string, value: unknown) {
    if (value === null && operator === '=') this.predicates.push({ sql: `${columnExpr(column)} IS NULL`, values: [] });
    else this.predicates.push({ sql: `${columnExpr(column)} ${operator} $$`, values: [value] });
    return this;
  }

  private compilePredicates(startAt: number): { text: string; values: unknown[] } {
    const values: unknown[] = [];
    let next = startAt;
    const sql = this.predicates.map((predicate) => {
      let local = predicate.sql;
      for (const value of predicate.values) {
        local = local.replace('$$', `$${next++}`);
        values.push(value);
      }
      return local;
    });
    return { text: sql.length > 0 ? ` WHERE ${sql.join(' AND ')}` : '', values };
  }

  private returning(): string {
    return ` RETURNING ${selectList(this.projection)}`;
  }

  private async execute(): Promise<QueryResult<any>> {
    const table = `scm.${ident(this.table)}`;
    let text = '';
    let values: unknown[] = [];
    if (this.operation === 'select') {
      const where = this.compilePredicates(1);
      text = `SELECT ${selectList(this.projection)} FROM ${table}${where.text}`;
      values = where.values;
      if (this.orders.length > 0) text += ` ORDER BY ${this.orders.join(', ')}`;
      if (this.limitValue !== null) { values.push(this.limitValue); text += ` LIMIT $${values.length}`; }
      if (this.offsetValue !== null) { values.push(this.offsetValue); text += ` OFFSET $${values.length}`; }
    } else if (this.operation === 'update') {
      const patch = this.payload as Record<string, unknown>;
      const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
      values = entries.map(([column, value]) => commandParameter(this.sql, column, value));
      const where = this.compilePredicates(values.length + 1);
      values.push(...where.values);
      text = `UPDATE ${table} SET ${entries.map(([key], index) => `${ident(key)} = $${index + 1}`).join(', ')}${where.text}${this.returning()}`;
    } else if (this.operation === 'delete') {
      const where = this.compilePredicates(1);
      values = where.values;
      text = `DELETE FROM ${table}${where.text}${this.returning()}`;
    } else {
      const rows = (Array.isArray(this.payload) ? this.payload : [this.payload]) as Array<Record<string, unknown>>;
      const columns = [...new Set(rows.flatMap((row) => Object.keys(row).filter((key) => row[key] !== undefined)))];
      let index = 1;
      const tuples = rows.map((row) => `(${columns.map((column) => {
        if (row[column] === undefined) return 'DEFAULT';
        values.push(commandParameter(this.sql, column, row[column]));
        return `$${index++}`;
      }).join(', ')})`);
      text = `INSERT INTO ${table} (${columns.map(ident).join(', ')}) VALUES ${tuples.join(', ')}`;
      if (this.operation === 'upsert') {
        const conflict = this.conflictColumns.length > 0 ? ` (${this.conflictColumns.map(ident).join(', ')})` : '';
        if (this.ignoreDuplicates) text += ` ON CONFLICT${conflict} DO NOTHING`;
        else {
          const updates = columns.filter((column) => !this.conflictColumns.includes(column));
          text += ` ON CONFLICT${conflict} DO UPDATE SET ${updates.map((column) => `${ident(column)} = EXCLUDED.${ident(column)}`).join(', ')}`;
        }
      }
      text += this.returning();
    }

    const outcome = await serialOnTransaction(this.sql, async () => {
      const savepoint = `scm_cmd_${++savepointSequence}`;
      await this.sql.unsafe(`SAVEPOINT ${savepoint}`);
      try {
        const rawRows = await this.sql.unsafe(text, values as never[]);
        const rows = normalizeReturnedRows(rawRows as unknown[]);
        await this.sql.unsafe(`RELEASE SAVEPOINT ${savepoint}`);
        return { rows, error: null as { message: string } | null };
      } catch (error) {
        await this.sql.unsafe(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        await this.sql.unsafe(`RELEASE SAVEPOINT ${savepoint}`);
        return { rows: [] as unknown[], error: { message: error instanceof Error ? error.message : String(error) } };
      }
    });
    if (outcome.error) {
      // Voucher minting retries a random code, while mirrored amendment
      // dispatch resolves a duplicate idempotency key by reading the existing
      // command. These are the two expected statement errors inside commands;
      // the savepoint keeps the transaction usable for their retry/read path.
      if ((this.table === 'pwp_codes' || this.table === 'sync_command')
          && (this.operation === 'insert' || this.operation === 'upsert')
          && /duplicate key|unique constraint/i.test(outcome.error.message)) {
        return { data: null, error: outcome.error, count: 0 };
      }
      throw new Error(outcome.error.message);
    }
    const rows = outcome.rows;
    if (this.headCount) {
      return { data: null, error: null, count: Number((rows[0] as { count?: unknown } | undefined)?.count ?? 0) };
    }
    const data = this.singleMode === 'single' || this.singleMode === 'maybe'
      ? (rows[0] ?? null)
      : rows;
    if (this.singleMode === 'single' && rows.length !== 1) throw new Error(`Expected one ${this.table} row, got ${rows.length}`);
    return { data, error: null, count: rows.length };
  }

  then<TResult1 = QueryResult<any>, TResult2 = never>(
    onfulfilled?: ((value: QueryResult<any>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }
}

export const pgTransactionSupabase = (sql: Sql) => ({
  __atomicCommand: true,
  from: (table: string) => new PgPostgrestQuery(sql, table),
  rpc: async (name: string, args: Record<string, unknown> = {}) => {
    if (name === 'pg_try_advisory_lock') {
      const rows = await sql.unsafe<Array<{ locked: boolean }>>(
        'SELECT pg_try_advisory_xact_lock($1::bigint) AS locked',
        [args.key] as never[],
      );
      return { data: rows[0]?.locked ?? false, error: null };
    }
    if (name === 'pg_advisory_unlock') {
      // Transaction-scoped locks release automatically on commit/rollback.
      return { data: true, error: null };
    }
    if (name === 'rebuild_mfg_so_delivery_lines') {
      /* Atomic SVC-DELIVERY* rebuild (migration 0214). It must be reachable from
         inside an atomic command too: the delivery fee re-derives at the end of
         every line PATCH, and those PATCHes run in this transaction wrapper. The
         function's own pg_advisory_xact_lock is what serializes concurrent
         rebuilds of the same SO — holding it inside the caller's transaction is
         exactly the intent (it releases at commit/rollback).

         It RETURNS false without writing when p_expect_state — the operator-owned
         fee state the caller derived from — has moved under that lock (0314). The
         caller re-derives and calls again, and in THIS path that retry is
         guaranteed to converge: the advisory xact lock the first call took is
         held for the rest of this transaction, so nothing can move the state
         under attempt two. Returned as `data` rather than raised, precisely so a
         stale derivation does not roll the whole command back. */
      try {
        const rows = await sql.unsafe(
          'SELECT scm.rebuild_mfg_so_delivery_lines($1::text, $2::text, $3::bigint, $4::jsonb, $5::jsonb) AS rebuilt',
          [
            args.p_doc_no,
            args.p_source_doc_no,
            args.p_delivery_fee_sen,
            // sql.json(), NOT JSON.stringify(): binding a pre-stringified string
            // to a $n::jsonb parameter double-serializes it. postgres.js's
            // describe phase discovers the jsonb OID and runs its OWN serializer
            // over our string, so `[]` went in as the jsonb STRING `"[]"` and the
            // RPC's jsonb_populate_recordset("non-array") aborted the whole
            // approve-so transaction (owner-reported 2026-07-29, SO-2606-049 KL
            // address amendment; the fee re-derive produced zero SVC lines →
            // empty rows → the string that provoked it). sql.json sends the raw
            // value once with OID 3802 — the exact fix commandParameter() above
            // already applies to every other jsonb column on this shim.
            sql.json((args.p_rows ?? []) as never),
            /* Same rule for the expectation object. null means "do not check". */
            // eslint-disable-next-line no-restricted-syntax -- sql.json's parameter is JSONValue and p_expect_state arrives as unknown off the rpc args bag; this is the same cast the p_rows line above already needs, for the same reason.
            args.p_expect_state == null ? null : sql.json(args.p_expect_state as never),
          ] as never[],
        );
        /* Optional on purpose: a driver that returns no row must read as "it
           wrote", never as "it refused" — a silent no-op is not a refusal. */
        const rebuilt = (rows as Array<{ rebuilt?: boolean }>)[0]?.rebuilt;
        return { data: rebuilt ?? true, error: null };
      } catch (e) {
        return { data: null, error: { message: e instanceof Error ? e.message : String(e) } };
      }
    }
    throw new Error(`Unsupported SCM transaction RPC: ${name}`);
  },
});

class CommandRollback {
  constructor(readonly response: Response) {}
}

const AFTER_COMMIT = Symbol('scm-command-after-commit');

/** Register a non-database side effect that must never run before commit. */
export function deferScmAfterCommit(c: any, effect: () => Promise<void>): void {
  const effects = ((c as any)[AFTER_COMMIT] ??= []) as Array<() => Promise<void>>;
  effects.push(effect);
}

export type SoCommandLeaseCheck =
  | { ok: true; version: number }
  | { ok: false; reason: 'not_found' }
  /* WHICH of the three, because one message for four states sent the owner
     looking for a colleague who was not there - see so-edit-lease.ts. */
  | { ok: false; reason: 'lease'; lease: SoEditLeaseRefusal };

/** Lock the SO generation row and prove the lease on that same connection. */
export async function lockSoCommandLease(
  sql: Sql,
  docNo: string,
  leaseToken: string | null | undefined,
  companyId: number | null | undefined,
  /* REQUIRED, not optional: its absence decides whether a caller may take a
     lock back, so a call site that forgot it must not silently get the old
     behaviour. Pass an explicit null where there is no authenticated user. */
  callerUserId: number | null,
): Promise<SoCommandLeaseCheck> {
  const locked = await sql.unsafe<Array<{
    version: number;
    edit_lease_token: string | null;
    edit_lease_expires_at: string | Date | null;
    edit_lease_user_id: number | string | null;
  }>>(
    `SELECT version, edit_lease_token, edit_lease_expires_at, edit_lease_user_id
       FROM scm.mfg_sales_orders
      WHERE doc_no = $1
        AND ($2::bigint IS NULL OR company_id = $2::bigint)
      FOR UPDATE`,
    [docNo, companyId ?? null] as never[],
  );
  const row = locked[0];
  if (!row) return { ok: false, reason: 'not_found' };
  const expiry = row.edit_lease_expires_at instanceof Date
    ? row.edit_lease_expires_at.getTime()
    : Date.parse(String(row.edit_lease_expires_at ?? ''));
  const heldByAnother = Boolean(row.edit_lease_token)
    && Number.isFinite(expiry) && expiry > Date.now()
    && row.edit_lease_token !== leaseToken;
  if (!leaseToken) return { ok: false, reason: 'lease', lease: 'missing' };
  /* THE SAME PERSON TAKES THEIR OWN LOCK BACK - mig 0348. A lock left by the
     caller's own crashed save is not a colleague editing, and making them wait
     it out protects nobody. Version CAS still decides who wins the write. */
  if (heldByAnother && soEditLeaseTakeoverAllowed(row.edit_lease_user_id, callerUserId)) {
    return { ok: true, version: Number(row.version ?? 1) };
  }
  if (heldByAnother) return { ok: false, reason: 'lease', lease: 'held' };
  if (row.edit_lease_token !== leaseToken
      || !Number.isFinite(expiry)
      || expiry <= Date.now()) {
    return { ok: false, reason: 'lease', lease: 'expired' };
  }
  return { ok: true, version: Number(row.version ?? 1) };
}

/**
 * Execute an SCM command on one physical PostgreSQL transaction/connection.
 * A non-2xx handler response is also rolled back. There is deliberately no D1
 * fallback: SCM data lives in the `scm` PostgreSQL schema, not public D1. If a
 * deployment removes Hyperdrive/DATABASE_URL these multi-write commands fail
 * closed instead of reverting to partial PostgREST writes.
 */
export async function runScmPgCommand(
  c: any,
  command: (sb: ReturnType<typeof pgTransactionSupabase>) => Promise<Response>,
  options?: { docNo?: string; leaseToken?: string | null; companyId?: number; userId?: number | null },
): Promise<Response> {
  const url = resolveDatabaseUrl(c.env);
  if (!url) {
    return c.json({
      error: 'scm_pg_command_required',
      message: 'This operation requires the PostgreSQL command transaction service.',
    }, 503);
  }
  const sql = getSql(url);
  try {
    (c as any)[AFTER_COMMIT] = [];
    const response = await sql.begin(async (tx) => {
      if (options?.docNo) {
        const lease = await lockSoCommandLease(
          tx as unknown as Sql,
          options.docNo,
          options.leaseToken,
          options.companyId,
          options.userId ?? null,
        );
        if (!lease.ok && lease.reason === 'not_found') {
          throw new CommandRollback(c.json({ error: 'not_found' }, 404));
        }
        if (!lease.ok) {
          throw new CommandRollback(c.json(soEditLeaseRefusal(lease.lease), 409));
        }
      }
      const response = await command(pgTransactionSupabase(tx as unknown as Sql));
      if (!response.ok) throw new CommandRollback(response);
      return response;
    });
    const effects = ((c as any)[AFTER_COMMIT] ?? []) as Array<() => Promise<void>>;
    for (const effect of effects) {
      try { await effect(); }
      catch (error) { console.error('[scm-command] after-commit effect failed:', error); }
    }
    return response;
  } catch (error) {
    if (error instanceof CommandRollback) return error.response;
    console.error('[scm-command] transaction rolled back:', error);
    return c.json({ error: 'command_failed', message: 'The operation was rolled back. Please try again.' }, 500);
  } finally {
    delete (c as any)[AFTER_COMMIT];
  }
}
