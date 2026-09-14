// PostgREST contract check for the Sales Order list's second-level filters.
//
// The unit tests pin which predicates the list appends; the pg test pins what the
// computed-field functions return in SQL. Neither runs PostgREST, and the thing
// in between — does PostgREST accept a filter on a function over a VIEW's row
// type, inside a count=exact page, a grouped aggregate and a sum aggregate — is
// exactly what production depends on. This script drives a REAL PostgREST
// (started by .github/workflows/postgrest-contract-so-list-filters.yml over the
// fixture in so-list-filters-fixture.sql) through the REAL postgrest-js client
// and the REAL prepareSoListFilters the list handler calls.
//
// Exit 0 only when every read returns the expected orders; any HTTP error or
// wrong answer exits 1 with the evidence printed.
import { PostgrestClient } from '@supabase/postgrest-js';
import { prepareSoListFilters } from '../../src/scm/lib/so-list-query-filters';

const REST = process.env.POSTGREST_URL ?? 'http://127.0.0.1:3000';
const sb = new PostgrestClient(REST, { schema: 'scm' });
const VIEW = 'mfg_sales_orders_with_payment_totals';
const WH_A = '11111111-1111-4111-8111-111111111111';
const WH_B = '22222222-2222-4222-8222-222222222222';

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      got      ${JSON.stringify(actual)}${ok ? '' : `\n      expected ${JSON.stringify(expected)}`}`);
}

async function run(label: string, raw: string[], expectedDocs: string[]): Promise<void> {
  const prepared = await prepareSoListFilters(sb, raw, null, new Date('2026-09-14T04:00:00Z'));
  if (!prepared.ok) {
    failures += 1;
    console.log(`FAIL  ${label}: prepare refused ${JSON.stringify(prepared.body)}`);
    return;
  }
  const scoped = <T>(q: T): T => prepared.apply((q as unknown as { eq: (c: string, v: number) => T }).eq('company_id', 1));

  // Page: count=exact + range, the paginated arm's shape.
  const page = await scoped(sb.from(VIEW).select('doc_no, status, balance_sen_live', { count: 'exact' }))
    .order('doc_no', { ascending: true })
    .range(0, 49);
  if (page.error) { failures += 1; console.log(`FAIL  ${label} page: ${JSON.stringify(page.error)}`); return; }
  check(`${label} — page rows`, (page.data ?? []).map((r) => r.doc_no), expectedDocs);
  check(`${label} — exact count`, page.count, expectedDocs.length);

  // Status counts: the grouped aggregate, read from the relation the prepared filter names.
  const counts = await scoped(sb.from(prepared.countFrom).select('status, cnt:doc_no.count()'));
  if (counts.error) { failures += 1; console.log(`FAIL  ${label} status counts: ${JSON.stringify(counts.error)}`); return; }
  const total = ((counts.data ?? []) as unknown as Array<{ cnt: number }>).reduce((n, r) => n + Number(r.cnt), 0);
  check(`${label} — grouped status count total`, total, expectedDocs.length);

  // Money: the sum aggregate.
  const money = await scoped(sb.from(VIEW).select('rev:local_total_sen.sum(),outLive:balance_sen_live.sum()'));
  if (money.error) { failures += 1; console.log(`FAIL  ${label} money: ${JSON.stringify(money.error)}`); return; }
  check(`${label} — money aggregate answered`, Array.isArray(money.data) && money.data.length === 1, true);

  // Head-only count, the held-count read's shape.
  const head = await scoped(sb.from(prepared.countFrom).select('*', { count: 'exact', head: true }));
  if (head.error) { failures += 1; console.log(`FAIL  ${label} head count: ${JSON.stringify(head.error)}`); return; }
  check(`${label} — head count`, head.count, expectedDocs.length);
}

async function main(): Promise<void> {
  await run('no filter', [], ['SO-1', 'SO-2', 'SO-3', 'SO-4', 'SO-5']);
  await run('warehouse A', [`warehouse:is:${WH_A}`], ['SO-1']);
  await run('warehouse B', [`warehouse:is:${WH_B}`], ['SO-1', 'SO-2']);
  await run('item category sofa', ['itemCategory:is:sofa'], ['SO-1']);
  await run('item category mattress', ['itemCategory:is:mattress'], ['SO-2']);
  await run('pending amendment yes', ['pendingAmendment:is:yes'], ['SO-1', 'SO-3']);
  await run('pending amendment no', ['pendingAmendment:is:no'], ['SO-2', 'SO-4', 'SO-5']);
  await run('warehouse B + sofa + pending', [`warehouse:is:${WH_B}`, 'itemCategory:is:sofa', 'pendingAmendment:is:yes'], ['SO-1']);
  const refused = await prepareSoListFilters(sb, ['warehouse:is:KL'], null, new Date());
  check('an invalid row is refused before PostgREST', refused.ok ? 'ok' : refused.status, 400);
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
