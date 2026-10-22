// Read-only A/B of two vision models on operator-confirmed SO scans (HC-0006, speed).
//
// WHY: model_ms is ~95% of scan time (scan_timing events, 14-15 Oct). A faster model is the only
// lever that reaches the one-third target, so measure what it costs in accuracy before changing
// CLAUDE_MODEL. Ground truth = scm.so_scan_samples.corrected (the final, operator-confirmed SO).
//
// SCOPE LIMIT (read before quoting a number): both models get the SAME compact prompt and NO SKU
// catalogue, so SKU/fabric matching is NOT scored, and model_ms is a cold call without the cached
// catalogue prefix. Accuracy is on header fields + line count; latency is useful as a ratio.
//
// RE-RUN: Actions -> "Run a backend script on production" -> script ab-scan-model.mjs, mode plan
//   (counts eligible samples, no cost). mode apply + confirm "RUN AB" calls the models. Extra env:
//   N=30;MODELS=claude-sonnet-4-6,claude-haiku-5-5. Needs repo secrets ANTHROPIC_API_KEY,
//   CLOUDFLARE_API_TOKEN (R2 read), CLOUDFLARE_ACCOUNT_ID. Writes nothing anywhere.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import { compareSlip, summarise } from './lib/ab-scan-compare.mjs';

const MODE = (process.env.MODE || 'plan').toLowerCase();
const N = Math.max(1, Math.min(100, Number(process.env.N || 30)));
const MODELS = (process.env.MODELS || 'claude-sonnet-4-6,claude-haiku-5-5').split(',').map((s) => s.trim());
const BUCKET = process.env.R2_BUCKET || 'houzs-erp';
const CONFIRM_PHRASE = 'RUN AB';

const PROMPT = `You are reading ONE handwritten sale-order slip for a Malaysian furniture retailer.
Return VALID JSON ONLY, first char '{' last char '}', no prose, no fences. Keys, null when not readable:
{"customerName":string|null,"phones":string[],"deliveryDate":"YYYY-MM-DD"|null,"slipDate":"YYYY-MM-DD"|null,
"totalRm":number|null,"depositRm":number|null,"customerSoRef":string|null,"postcode":string|null,
"lines":[{"description":string,"qty":number|null,"unitPriceRm":number|null}]}`;

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set'); process.exit(2); }
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });

try {
  const rows = await sql`
    SELECT id, image_key, corrected, status, created_at
      FROM scm.so_scan_samples
     WHERE corrected IS NOT NULL AND image_key IS NOT NULL
       AND coalesce(document_type, 'SO') = 'SO'
     ORDER BY created_at DESC
     LIMIT ${N}`;
  const [{ total }] = await sql`
    SELECT count(*)::int AS total FROM scm.so_scan_samples
     WHERE corrected IS NOT NULL AND image_key IS NOT NULL AND coalesce(document_type, 'SO') = 'SO'`;
  console.log(`eligible samples (confirmed, with image): ${total}; using the newest ${rows.length}`);
  if (rows.length) console.log(`window: ${rows.at(-1).created_at.toISOString()} .. ${rows[0].created_at.toISOString()}`);
  if (MODE !== 'apply') { console.log('plan only: set mode apply + confirm "RUN AB" to call the models'); process.exit(0); }
  if (process.env.CONFIRM !== CONFIRM_PHRASE) { console.error(`apply needs CONFIRM="${CONFIRM_PHRASE}"`); process.exit(1); }
  if (!process.env.ANTHROPIC_API_KEY) { console.error('ANTHROPIC_API_KEY secret is not set'); process.exit(2); }

  const dir = mkdtempSync(path.join(tmpdir(), 'ab-'));
  const mimeOf = (b) => (b[0] === 0xff ? 'image/jpeg' : b[0] === 0x89 ? 'image/png' : b.slice(0, 4).toString() === 'RIFF' ? 'image/webp' : null);

  const images = [];
  for (const r of rows) {
    const file = path.join(dir, r.id);
    const g = spawnSync('npx', ['wrangler', 'r2', 'object', 'get', `${BUCKET}/${r.image_key}`, '--remote', '--file', file], { encoding: 'utf8', shell: process.platform === 'win32' });
    if (g.status !== 0) { console.log(`skip ${r.id}: r2 get failed`); continue; }
    const buf = readFileSync(file);
    const mime = mimeOf(buf);
    if (mime) images.push({ id: r.id, truth: r.corrected, b64: buf.toString('base64'), mime });
  }
  console.log(`images fetched: ${images.length}/${rows.length}`);

  async function readOnce(model, img) {
    const t0 = performance.now();
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 4096, temperature: 0, messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: img.mime, data: img.b64 } }, { type: 'text', text: PROMPT }] }] }),
    });
    const ms = Math.round(performance.now() - t0);
    const body = await res.json().catch(() => ({}));
    const txt = body?.content?.find((c) => c.type === 'text')?.text ?? '';
    let read = null;
    try { read = JSON.parse(txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1)); } catch { /* scored as all-miss */ }
    return { ms, read, httpOk: res.ok };
  }

  const out = {};
  for (const model of MODELS) {
    const results = [];
    let failed = 0;
    for (const img of images) {
      const r = await readOnce(model, img);
      if (!r.httpOk) { failed += 1; continue; }
      results.push({ cmp: compareSlip(r.read ?? {}, img.truth), ms: r.ms });
    }
    out[model] = { ...summarise(results), failedCalls: failed };
  }
  console.log(JSON.stringify(out, null, 2));
} finally {
  await sql.end();
}
