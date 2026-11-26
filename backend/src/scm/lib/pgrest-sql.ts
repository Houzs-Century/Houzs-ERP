
import { parsePgrestInList } from './pgrest-in-list';

export class PgrestSqlUnsupported extends Error {}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A double-quoted SQL identifier, refused unless it is a plain column name. */
export function sqlIdent(col: string): string {
  if (!IDENT.test(col)) throw new PgrestSqlUnsupported(`unsupported column: ${col}`);
  return `"${col}"`;
}

const COMPUTED_FIELDS: Readonly<Record<string, string>> = {
  so_line_warehouse_ids: 'scm.so_line_warehouse_ids',
  so_line_categories: 'scm.so_line_categories',
  so_has_open_amendment: 'scm.so_has_open_amendment',
};

/** A filter column on the aliased relation `t`. */
export function colRef(col: string): string {
  const fn = COMPUTED_FIELDS[col];
  return fn ? `${fn}(t)` : `t.${sqlIdent(col)}`;
}

/** A select-list column on `t`, keeping its PostgREST name. */
export function selectCol(col: string): string {
  return COMPUTED_FIELDS[col] ? `${colRef(col)} AS ${sqlIdent(col)}` : colRef(col);
}

const likePattern = (v: string): string => v.replace(/\*/g, '%');

function unquote(raw: string): string {
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    return raw.slice(1, -1).replace(/\\(.)/g, '$1');
  }
  return raw;
}

/** Split an `or=` body on its top-level commas: not inside (), {} or "". */
export function splitOrTerms(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let cur = '';
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]!;
    if (quoted) {
      cur += ch;
      if (ch === '\\' && i + 1 < body.length) { cur += body[i + 1]!; i += 1; continue; }
      if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') { quoted = true; cur += ch; continue; }
    if (ch === '(' || ch === '{') depth += 1;
    if (ch === ')' || ch === '}') depth -= 1;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((t) => t.trim()).filter((t) => t !== '');
}

/** Builds one parameterised WHERE. Values are sent as untyped text, as PostgREST
 *  sends them, so Postgres casts each to its column's type the same way. */
export class SqlParams {
  readonly values: string[] = [];
  constructor(private readonly offset = 0) {}
  add(v: unknown): string {
    this.values.push(String(v));
    return `$${this.offset + this.values.length}`;
  }
}

const CMP: Record<string, string> = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' };

function condition(col: string, opAndValue: string, p: SqlParams): string {
  const c = colRef(col);
  if (opAndValue.startsWith('not.')) return `NOT (${condition(col, opAndValue.slice(4), p)})`;
  const dot = opAndValue.indexOf('.');
  if (dot < 0) throw new PgrestSqlUnsupported(`malformed condition: ${col}.${opAndValue}`);
  const op = opAndValue.slice(0, dot);
  const raw = opAndValue.slice(dot + 1);
  if (CMP[op]) return `${c} ${CMP[op]} ${p.add(unquote(raw))}`;
  switch (op) {
    case 'like': return `${c} LIKE ${p.add(likePattern(unquote(raw)))}`;
    case 'ilike': return `${c} ILIKE ${p.add(likePattern(unquote(raw)))}`;
    case 'is': {
      const v = raw.toLowerCase();
      if (v === 'null') return `${c} IS NULL`;
      if (v === 'true') return `${c} IS TRUE`;
      if (v === 'false') return `${c} IS FALSE`;
      if (v === 'unknown') return `${c} IS UNKNOWN`;
      throw new PgrestSqlUnsupported(`unsupported is value: ${raw}`);
    }
    case 'in': {
      const vals = parsePgrestInList(raw);
      return vals.length === 0 ? 'FALSE' : `${c} IN (${vals.map((v) => p.add(v)).join(', ')})`;
    }
    case 'ov': return `${c} && ${p.add(raw)}`;
    case 'cs': return `${c} @> ${p.add(raw)}`;
    case 'cd': return `${c} <@ ${p.add(raw)}`;
    default: throw new PgrestSqlUnsupported(`unsupported operator: ${op}`);
  }
}

function term(t: string, p: SqlParams): string {
  const group = t.match(/^(not\.)?(and|or)\((.*)\)$/s);
  if (group) {
    const inner = splitOrTerms(group[3]!).map((x) => term(x, p));
    const joined = `(${inner.join(group[2] === 'and' ? ' AND ' : ' OR ')})`;
    return group[1] ? `NOT ${joined}` : joined;
  }
  const dot = t.indexOf('.');
  if (dot < 0) throw new PgrestSqlUnsupported(`malformed term: ${t}`);
  return condition(t.slice(0, dot), t.slice(dot + 1), p);
}

/** A whole `or=` body (what supabase-js `.or(body)` sends) as one SQL group. */
export function orBodyToSql(body: string, p: SqlParams): string {
  const terms = splitOrTerms(body).map((t) => term(t, p));
  if (terms.length === 0) throw new PgrestSqlUnsupported('empty or()');
  return `(${terms.join(' OR ')})`;
}

const scalar = (v: unknown): string => {
  if (v === null || v === undefined) throw new PgrestSqlUnsupported('null comparison value');
  return String(v);
};

/**
 * A stand-in for the supabase-js filter builder that records SQL instead of a
 * URL. Only the filter methods the list closures call exist; any other method is
 * undefined, so calling it throws and the caller falls back.
 */
export class SqlFilterRecorder {
  readonly parts: string[] = [];
  constructor(readonly p: SqlParams) {}
  private push(sql: string): this { this.parts.push(sql); return this; }
  private cmp(op: string, col: string, v: unknown): this { return this.push(`${colRef(col)} ${CMP[op]} ${this.p.add(scalar(v))}`); }
  eq(col: string, v: unknown) { return this.cmp('eq', col, v); }
  neq(col: string, v: unknown) { return this.cmp('neq', col, v); }
  gt(col: string, v: unknown) { return this.cmp('gt', col, v); }
  gte(col: string, v: unknown) { return this.cmp('gte', col, v); }
  lt(col: string, v: unknown) { return this.cmp('lt', col, v); }
  lte(col: string, v: unknown) { return this.cmp('lte', col, v); }
  like(col: string, v: string) { return this.push(`${colRef(col)} LIKE ${this.p.add(likePattern(v))}`); }
  ilike(col: string, v: string) { return this.push(`${colRef(col)} ILIKE ${this.p.add(likePattern(v))}`); }
  is(col: string, v: unknown) {
    if (v === null) return this.push(`${colRef(col)} IS NULL`);
    if (v === true) return this.push(`${colRef(col)} IS TRUE`);
    if (v === false) return this.push(`${colRef(col)} IS FALSE`);
    throw new PgrestSqlUnsupported(`unsupported is value: ${String(v)}`);
  }
  in(col: string, vals: readonly unknown[]) {
    const uniq = [...new Set(vals.map(scalar))];
    return this.push(uniq.length === 0 ? 'FALSE' : `${colRef(col)} IN (${uniq.map((v) => this.p.add(v)).join(', ')})`);
  }
  overlaps(col: string, v: string | readonly unknown[]) {
    const lit = typeof v === 'string' ? v : `{${v.map(scalar).join(',')}}`;
    return this.push(`${colRef(col)} && ${this.p.add(lit)}`);
  }
  not(col: string, op: string, v: unknown) { return this.push(condition(col, `not.${op}.${String(v)}`, this.p)); }
  filter(col: string, op: string, v: unknown) { return this.push(condition(col, `${op}.${String(v)}`, this.p)); }
  or(body: string, opts?: { foreignTable?: string; referencedTable?: string }) {
    if (opts?.foreignTable || opts?.referencedTable) throw new PgrestSqlUnsupported('or() on an embedded table');
    return this.push(orBodyToSql(body, this.p));
  }
  where(): string {
    return this.parts.length === 0 ? 'TRUE' : this.parts.join(' AND ');
  }
}

/** Prefix for every statement's WHERE. Hyperdrive caches a read for up to 60 s
 *  unless its text names a volatile / stable function (Cloudflare docs, "Query
 *  caching"); PostgREST reads are never cached, so without this a pill could lag
 *  the page it sits above after a save. now() is evaluated once per statement. */
export const FRESH_READ = 'now() IS NOT NULL';

/** Run a PostgREST filter closure and return its WHERE (without the keyword). */
export function whereOf(apply: (q: SqlFilterRecorder) => unknown, p: SqlParams): string {
  const rec = new SqlFilterRecorder(p);
  let out: unknown;
  try { out = apply(rec); } catch (e) {
    if (e instanceof PgrestSqlUnsupported) throw e;
    throw new PgrestSqlUnsupported(`filter closure: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (out !== rec) throw new PgrestSqlUnsupported('filter closure did not return its builder');
  return rec.where();
}
