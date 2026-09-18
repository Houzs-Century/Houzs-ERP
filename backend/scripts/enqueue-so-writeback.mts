// Re-enqueue the AutoCount write-back for specific Sales Orders so their CORRECTED
// outstanding balance reaches the account book (AutoCount's UDF_BALANCE).
//
// WHY: a raw-SQL data repair (docs/bugs/0785 — the orphan scan-deposit fix) edits
// the SO row directly and therefore does NOT go through the app's edit path, so it
// never enqueues a write-back. AutoCount is left holding the pre-repair balance
// (HC-SO-2609-011: AutoCount RM288 vs correct RM2488; -049: RM1500 vs RM2900).
//
// HOW: reuses the app's OWN composer — `enqueueEdit` -> `soEditHeader`, which reads
// the LIVE outstanding via `readSoOutstandingSen` and builds the exact payload the
// app would. It is equivalent to re-saving the SO header in the app; it does NOT
// hand-craft any accounting payload. The supabase-js-shaped `pgrestShim` lets the
// real function run on ONLY DATABASE_URL (no PostgREST creds in CI — same access
// path as requeue-autocount-skipped.mjs). Run under tsx so the real TS enqueue is
// imported from src.
//
// DRY-RUN by default: reads each SO and PREVIEWS the balance it would push; writes
// nothing. MODE=apply enqueues the edit — the ~5-min outbox drain then sends it.
//   MODE=apply DOCS="HC-SO-2609-011,HC-SO-2609-049" npx tsx scripts/enqueue-so-writeback.mts
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { enqueueEdit } from '../src/scm/lib/autocount-outbox';
import { readSoOutstandingSen } from '../src/scm/lib/autocount-read';

const apply = String(process.env.MODE || 'dry-run').toLowerCase() === 'apply';
const docs = (process.env.DOCS || 'HC-SO-2609-011,HC-SO-2609-049')
  .split(',').map((s) => s.trim()).filter(Boolean);

function resolveUrl(): string | undefined {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try { return readFileSync('.dev.vars', 'utf8').match(/DATABASE_URL="([^"]+)"/)?.[1]; } catch { return undefined; }
}
const url = resolveUrl();
if (!url) { console.error('DATABASE_URL required (env or .dev.vars).'); process.exit(1); }

const pg = postgres(url, { ssl: 'require', prepare: false, max: 1 });
// supabase-js shape over the pg connection, with write-back ENQUEUE enabled (same
// as requeue-autocount-skipped.mjs) so enqueueEdit may write its outbox row.
const sb = pgrestShim(pg, 'scm', { writeback: 'enqueue' }) as any;
const rm = (sen: number | null | undefined) => (sen == null ? '(null)' : `RM ${(sen / 100).toFixed(2)}`);

try {
  console.log(`MODE: ${apply ? 'APPLY (enqueue write-back)' : 'DRY-RUN (read + preview, no write)'}`);
  console.log(`DOCS: ${docs.join(', ')}\n`);

  let enqueued = 0;
  for (const docNo of docs) {
    const { data: header, error } = await sb
      .from('mfg_sales_orders').select('*').eq('doc_no', docNo).maybeSingle();
    if (error) { console.error(`${docNo}: read failed — ${error.message}`); process.exitCode = 1; continue; }
    if (!header) { console.error(`${docNo}: NOT FOUND`); process.exitCode = 1; continue; }

    const outstanding = await readSoOutstandingSen(sb, header as Record<string, unknown>);
    console.log(`${docNo}  (status ${(header as { status?: string }).status ?? '?'})  outstanding to push = ${rm(outstanding)}`);

    if (apply) {
      const companyId = Number((header as { company_id?: number }).company_id ?? 1);
      const ok = await enqueueEdit(sb, { companyId, docType: 'SO', docNo, createdBy: null });
      if (ok === false) console.log('  -> enqueueEdit SKIPPED (write-back off, or no AutoCount counterpart)');
      else { console.log('  -> ENQUEUED — the ~5-min outbox drain will send it to AutoCount'); enqueued += 1; }
    }
  }

  console.log(
    apply
      ? `\nEnqueued ${enqueued} edit(s). Confirm AutoCount's balance after the next drain (~5 min).`
      : '\nDRY-RUN only — nothing enqueued. Re-run with MODE=apply to push.',
  );
} finally {
  await pg.end({ timeout: 5 });
}
