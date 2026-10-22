// ----------------------------------------------------------------------------
// so-ref-lookup — the Sales Order's customer reference for rows that are NOT
// the order itself (owner 2026-09-25: every search box must find a record by
// its SO's reference number).
//
// The pair is sent RAW (`ref`, `customer_so_no`), the way GET /so-amendments
// and GET /cancel-requests already send it, so the frontend resolves it through
// its one display rule (customerRefOf = ref || customer_so_no) and a row here
// can never show a different reference from the order's own screen.
//
// Batched: one chunked read per page of rows, never one per row. The caller
// passes the SAME company scope its own read used — a parent key (so_doc_no) is
// not company scope, and document numbers are only unique within a company.
//
// Display/search enrichment only: a failed read is logged and the rows keep
// null references. Nothing here decides money or stock.
// ----------------------------------------------------------------------------

import { chunkIn } from './paginate-all';

export type SoRefPair = { ref: string | null; customer_so_no: string | null };

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- PostgREST builders are chained structurally, as in paginate-all
type Builder = any;
type Scope = (q: Builder) => Builder;

const keysOf = (values: ReadonlyArray<unknown>): string[] =>
  [...new Set(values.filter((v): v is string => typeof v === 'string' && v !== ''))];

/** Read `ref` + `customer_so_no` for the given SO document numbers. */
export async function readSoRefs(
  sb: Builder,
  docNos: ReadonlyArray<unknown>,
  scope: Scope,
): Promise<{ byDoc: Map<string, SoRefPair>; error: string | null }> {
  const byDoc = new Map<string, SoRefPair>();
  const keys = keysOf(docNos);
  if (keys.length === 0) return { byDoc, error: null };
  const { data, error } = await chunkIn<{ doc_no: string; ref: string | null; customer_so_no: string | null }>(
    keys,
    (batch, from, to) => scope(sb.from('mfg_sales_orders').select('doc_no, ref, customer_so_no').in('doc_no', batch)).range(from, to),
  );
  for (const r of data) byDoc.set(r.doc_no, { ref: r.ref ?? null, customer_so_no: r.customer_so_no ?? null });
  return { byDoc, error: error ? error.message : null };
}

/** Delivery Order id → its Sales Order's reference pair (via so_doc_no). */
export async function readSoRefsByDoId(
  sb: Builder,
  doIds: ReadonlyArray<unknown>,
  scope: Scope,
): Promise<{ byDoId: Map<string, SoRefPair>; error: string | null }> {
  const byDoId = new Map<string, SoRefPair>();
  const keys = keysOf(doIds);
  if (keys.length === 0) return { byDoId, error: null };
  const dos = await chunkIn<{ id: string; so_doc_no: string | null }>(
    keys,
    (batch, from, to) => scope(sb.from('delivery_orders').select('id, so_doc_no').in('id', batch)).range(from, to),
  );
  if (dos.error) return { byDoId, error: dos.error.message };
  const refs = await readSoRefs(sb, dos.data.map((d) => d.so_doc_no), scope);
  for (const d of dos.data) {
    const pair = d.so_doc_no ? refs.byDoc.get(d.so_doc_no) : undefined;
    if (pair) byDoId.set(d.id, pair);
  }
  return { byDoId, error: refs.error };
}

const logFailure = (label: string, error: string | null): void => {
  if (error) console.error(`[${label}] SO reference read failed; rows carry no SO reference:`, error);
};

/** Stamp `so_ref` + `so_customer_so_no` onto snake_case rows, keyed by the
 *  SO document number held in `docNoKey`. Mutates in place. */
export async function stampSoRefs(
  sb: Builder,
  rows: Array<Record<string, unknown>>,
  docNoKey: string,
  scope: Scope,
  label: string,
): Promise<void> {
  if (rows.length === 0) return;
  const { byDoc, error } = await readSoRefs(sb, rows.map((r) => r[docNoKey]), scope);
  logFailure(label, error);
  for (const r of rows) {
    const pair = byDoc.get(String(r[docNoKey] ?? ''));
    r.so_ref = pair?.ref ?? null;
    r.so_customer_so_no = pair?.customer_so_no ?? null;
  }
}

/** Stamp `soRef` + `soCustomerSoNo` onto camelCase rows. `docNoOf` names the
 *  row's SO document number. Mutates in place. */
export async function stampSoRefsCamel<R extends object>(
  sb: Builder,
  rows: R[],
  docNoOf: (r: R) => string | null,
  scope: Scope,
  label: string,
): Promise<void> {
  if (rows.length === 0) return;
  const { byDoc, error } = await readSoRefs(sb, rows.map(docNoOf), scope);
  logFailure(label, error);
  for (const r of rows) {
    const pair = byDoc.get(docNoOf(r) ?? '');
    Object.assign(r, { soRef: pair?.ref ?? null, soCustomerSoNo: pair?.customer_so_no ?? null });
  }
}

/** The camelCase stamp for Delivery Order LINES (the DO→SI / DO→DR pickers),
 *  keyed by `deliveryOrderId`. Mutates in place. */
export async function stampDoLineSoRefs<R extends { deliveryOrderId: string }>(
  sb: Builder,
  rows: R[],
  scope: Scope,
  label: string,
): Promise<void> {
  if (rows.length === 0) return;
  const { byDoId, error } = await readSoRefsByDoId(sb, rows.map((r) => r.deliveryOrderId), scope);
  logFailure(label, error);
  for (const r of rows) {
    const pair = byDoId.get(r.deliveryOrderId);
    Object.assign(r, { soRef: pair?.ref ?? null, soCustomerSoNo: pair?.customer_so_no ?? null });
  }
}
