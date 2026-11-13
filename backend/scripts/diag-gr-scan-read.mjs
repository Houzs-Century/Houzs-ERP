// Read-only: re-run the goods-receipt delivery-order read on one stored scan and
// print the SHAPE of what came back (counts, stop reason, error class), never the
// content. Actions logs are public, so no supplier, item, price or rack value is
// printed.
//
// WHY: 2026-11-13 Hookka DO-2611-037 (3 scanned pages) came back "no lines" on
// every upload, with no saved sample to say why.
//
// RE-RUN: Actions -> "Run a backend script on production" -> diag-gr-scan-read.mjs,
//   mode plan (prints the job and file only), mode apply + confirm "READ SCAN"
//   calls the model. Env: JOB_ID=<scan_jobs.id>. Writes nothing anywhere.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import { callClaudeGrExtract } from '../src/scm/lib/grn-scan-extract';
import { cutPdf, pdfPageCount } from '../src/scm/lib/scan-split';
import { toBase64 } from '../src/scm/lib/scan-ocr';

const MODE = (process.env.MODE || 'plan').toLowerCase();
const JOB_ID = process.env.JOB_ID || '';
const BUCKET = process.env.R2_BUCKET || 'houzs-erp';
const CONFIRM_PHRASE = 'READ SCAN';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set'); process.exit(2); }
if (!/^[0-9a-f-]{36}$/.test(JOB_ID)) { console.error('set JOB_ID to a scan_jobs id'); process.exit(1); }
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });

const shape = (call) => {
  const p = call.parsed;
  const err = call.errorMsg ? call.errorMsg.split(' Raw:')[0].slice(0, 200) : 'none';
  if (!p) return `parsed=null truncated=${call.truncated} textLen=${call.claudeText.length} error=${err}`;
  const racks = p.lines.filter((l) => l.rack).length;
  return `lines=${p.lines.length} racks=${racks} supplier=${p.supplierName ? 'yes' : 'no'} doNo=${p.doNo ? 'yes' : 'no'} poNo=${p.poNo ? 'yes' : 'no'} truncated=${call.truncated} textLen=${call.claudeText.length} error=${err}`;
};

try {
  const [job] = await sql`SELECT id, image_keys, page_from, page_to, created_at FROM scm.scan_jobs WHERE id = ${JOB_ID}`;
  if (!job) { console.log('job not found'); process.exit(0); }
  const key = (job.image_keys || [])[0];
  console.log(`job ${job.id} pages=${job.page_from}..${job.page_to} key=${key ? 'yes' : 'none'}`);
  if (!key) process.exit(0);
  if (MODE !== 'apply') { console.log(`plan only: mode apply + confirm "${CONFIRM_PHRASE}" reads it`); process.exit(0); }
  if (process.env.CONFIRM !== CONFIRM_PHRASE) { console.error(`apply needs CONFIRM="${CONFIRM_PHRASE}"`); process.exit(1); }
  if (!process.env.ANTHROPIC_API_KEY) { console.error('ANTHROPIC_API_KEY secret is not set'); process.exit(2); }

  const file = path.join(mkdtempSync(path.join(tmpdir(), 'gr-')), 'doc');
  const g = spawnSync('npx', ['wrangler', 'r2', 'object', 'get', `${BUCKET}/${key}`, '--remote', '--file', file], { encoding: 'utf8' });
  if (g.status !== 0) { console.log('r2 get failed'); process.exit(0); }
  const buf = readFileSync(file);
  const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const isPdf = buf.subarray(0, 4).toString() === '%PDF';
  const pages = isPdf ? await pdfPageCount(bytes) : 1;
  const filters = [...new Set((buf.toString('latin1').match(/\/Filter\s*\/\w+/g) || []).map((s) => s.replace(/\s+/g, ' ')))];
  console.log(`file bytes=${buf.byteLength} pdf=${isPdf} pages=${pages} filters=${filters.join(',') || 'none'}`);
  const usage = null;

  const t0 = Date.now();
  const whole = await callClaudeGrExtract(process.env.ANTHROPIC_API_KEY, [
    { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: toBase64(bytes) } },
  ], '', usage);
  console.log(`whole file (${Math.round((Date.now() - t0) / 1000)}s): ${shape(whole)}`);

  if (isPdf && pages > 1) {
    const parts = await cutPdf(bytes, Array.from({ length: pages }, (_, i) => ({ startPage: i + 1, endPage: i + 1 })));
    for (const p of parts) {
      const t1 = Date.now();
      const c = await callClaudeGrExtract(process.env.ANTHROPIC_API_KEY, [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: toBase64(p.bytes) } },
      ], '', usage);
      console.log(`page ${p.chunk.startPage} (${Math.round((Date.now() - t1) / 1000)}s): ${shape(c)}`);
    }
  }

  // What the model says it can see, as counts only.
  const probe = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 300, temperature: 0, messages: [{ role: 'user', content: [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: toBase64(bytes) } },
      { type: 'text', text: 'Answer with JSON only: {"pagesSeen":n,"pages":[{"imageVisible":true|false,"tableRows":n,"handwriting":true|false}]}. Counts only, no text from the document.' },
    ] }] }),
  });
  const pb = await probe.json().catch(() => ({}));
  const pt = pb?.content?.find((c) => c.type === 'text')?.text ?? '';
  const m = pt.match(/\{[\s\S]*\}/);
  let counts = 'unparsed';
  try { const j = JSON.parse(m ? m[0] : ''); counts = JSON.stringify({ pagesSeen: j.pagesSeen, pages: (j.pages || []).map((x) => ({ imageVisible: !!x.imageVisible, tableRows: Number(x.tableRows) || 0, handwriting: !!x.handwriting })) }); } catch { /* counts stay unparsed */ }
  console.log(`probe http=${probe.status} input_tokens=${pb?.usage?.input_tokens ?? '?'} ${counts}`);
} finally {
  await sql.end();
}
