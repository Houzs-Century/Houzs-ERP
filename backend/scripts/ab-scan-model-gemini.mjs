// HC-0006: Claude vs Gemini on the REAL sales-slip scan prompt. Local, read-only, not wired into the app.
//
// Same inputs as a background scan (runScanJob): buildCachedPrefix(catalogue) + loadPromptInjections
// (aliases, rules, rep rules, few-shot) + the job's original files from R2, then normalizeSlip on the
// reply. The private loaders are reached through a throwaway copy of scan-so.ts with an export line
// appended (deleted on exit), so the prompt cannot drift from prod.
// ponytail: the copy trick breaks if scan-so.ts stops being importable under node; export the loaders then.
//
// Truth = so_scan_samples.corrected on CONFIRMED rows (operator edited the draft). Fields the operator
// did not touch are carried from the old Claude read, so "all fields" favours Claude; the "fixed" column
// (fields where corrected != extracted) is the fair test.
//
// RUN (from backend/):
//   npx tsx scripts/ab-scan-model-gemini.mjs            plan: list the slips, no model calls
//   APPLY=1 npx tsx scripts/ab-scan-model-gemini.mjs    call both models, write the report JSON
//   npx tsx scripts/ab-scan-model-gemini.mjs --selftest
// Env: DATABASE_URL (prod Postgres; every query runs in a READ ONLY transaction), ANTHROPIC_API_KEY and
//   GEMINI_API_KEY (from ~/.houzs-ab.env, else process env); optional N=30, GEMINI_MODEL, GEMINI_THINKING (thinking budget, e.g. 0), OUT=path.
//   R2 reads go through `wrangler r2 object get` (wrangler login). Keys are never printed.
import { spawnSync } from 'node:child_process';
import { copyFileSync, appendFileSync, rmSync, readFileSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { parseEnv } from 'node:util';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ---------- scoring (pure) ----------
const norm = (v) => (v == null ? null : String(v).toLowerCase().replace(/\s+/g, ' ').trim() || null);
const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const code = (l) => norm(l?.skuMatch?.code);

/** Per-field hits for one read vs truth. Lines pair by SKU code (order-free); an unpaired truth line
 *  misses code, qty and price. `orig` (the old extracted blob) marks which truth fields the operator fixed. */
export function scoreSlip(read, truth, orig) {
  const out = [];
  const push = (field, hit, fixed) => out.push({ field, hit, fixed });
  const tName = norm(truth?.customerName);
  if (tName) push('customer', norm(read?.customerName) === tName, norm(orig?.customerName) !== tName);
  const pool = [...(read?.lines ?? [])];
  const origPool = [...(orig?.lines ?? [])];
  for (const t of truth?.lines ?? []) {
    const c = code(t);
    if (!c) continue;
    const take = (arr) => { const i = arr.findIndex((l) => code(l) === c); return i < 0 ? null : arr.splice(i, 1)[0]; };
    const r = take(pool);
    const o = take(origPool);
    push('code', !!r, !o);
    const tq = num(t.qtyGuess);
    if (tq != null) push('qty', !!r && num(r.qtyGuess) === tq, !o || num(o.qtyGuess) !== tq);
    const tp = num(t.priceRmGuess);
    if (tp != null) push('price', !!r && num(r.priceRmGuess) != null && Math.abs(num(r.priceRmGuess) - tp) < 0.5,
      !o || num(o.priceRmGuess) == null || Math.abs(num(o.priceRmGuess) - tp) >= 0.5);
  }
  return out;
}

export const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] : null);

function selftest() {
  const assert = (c, m) => { if (!c) throw new Error(m); };
  const truth = { customerName: 'Tan Ah Kow', lines: [
    { skuMatch: { code: 'A-1' }, qtyGuess: 2, priceRmGuess: 100 },
    { skuMatch: { code: 'B-2' }, qtyGuess: 1, priceRmGuess: 50 }] };
  const orig = { customerName: 'tan ah kow', lines: [{ skuMatch: { code: 'A-1' }, qtyGuess: 1, priceRmGuess: 100 }] };
  const read = { customerName: ' TAN  ah kow', lines: [
    { skuMatch: { code: 'B-2' }, qtyGuess: 1, priceRmGuess: 50.2 },
    { skuMatch: { code: 'A-1' }, qtyGuess: 2, priceRmGuess: 90 }] };
  const s = scoreSlip(read, truth, orig);
  const get = (f, i = 0) => s.filter((x) => x.field === f)[i];
  assert(get('customer').hit && !get('customer').fixed, 'customer');
  assert(get('code').hit && !get('code').fixed && get('code', 1).hit && get('code', 1).fixed, 'code order-free + fixed');
  assert(get('qty').hit && get('qty').fixed, 'qty fixed by operator');
  assert(!get('price').hit && get('price', 1).hit, 'price tolerance');
  assert(scoreSlip({}, truth, orig).filter((x) => x.hit).length === 0, 'empty read misses all');
  assert(pct([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90) === 9 && pct([5], 50) === 5, 'pct');
  console.log('selftest ok');
}
if (process.argv.includes('--selftest')) { selftest(); process.exit(0); }

// ---------- env ----------
// API keys: C:\Users\User\.houzs-ab.env (KEY=value lines) first, then process env. Values never printed.
const KEY_FILE = path.join(homedir(), '.houzs-ab.env');
const fileEnv = existsSync(KEY_FILE) ? parseEnv(readFileSync(KEY_FILE, 'utf8')) : null;
for (const k of ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY']) if (fileEnv?.[k]?.trim()) process.env[k] = fileEnv[k].trim();
const APPLY = process.env.APPLY === '1';
if (APPLY) {
  const noKey = ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY'].filter((k) => !process.env[k]?.trim());
  if (noKey.length) {
    console.error(fileEnv ? `${KEY_FILE} has no value for: ${noKey.map((k) => `${k}=`).join(', ')}` : `${KEY_FILE} not found; add lines: ${noKey.map((k) => `${k}=`).join(', ')}`);
    process.exit(2);
  }
}
if (!process.env.DATABASE_URL) { console.error('Set DATABASE_URL first'); process.exit(2); }
const N = Math.max(1, Math.min(100, Number(process.env.N || 30)));
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GEMINI_THINKING = process.env.GEMINI_THINKING;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.env.OUT || path.join(HERE, '..', '..', 'docs', 'pipeline', '2026-10-16', 'hc0006-model-ab.json');

// ---------- read-only DB + Supabase/D1 shims over it ----------
const { default: postgres } = await import('postgres');
const sql = postgres(process.env.DATABASE_URL, { max: 2, prepare: false, connection: { search_path: 'scm,public' } });
const ro = (text, params = []) => sql.begin('read only', (tx) => tx.unsafe(text, params));
const ident = (s) => '"' + String(s).replace(/"/g, '""') + '"';

// The subset of the supabase-js builder loadCatalogFresh / loadPromptInjections use, executed read-only.
function from(table) {
  const st = { cols: '*', where: [], params: [], order: [], limit: null, offset: null, single: false };
  const p = (v) => { st.params.push(v); return `$${st.params.length}`; };
  const b = {
    select(c) { st.cols = c.split(',').map((x) => ident(x.trim())).join(', '); return b; },
    eq(c, v) { st.where.push(`${ident(c)} = ${p(v)}`); return b; },
    ilike(c, v) { st.where.push(`${ident(c)} ILIKE ${p(v)}`); return b; },
    not(c, op, v) { if (op !== 'is' || v !== null) throw new Error(`shim: not(${op})`); st.where.push(`${ident(c)} IS NOT NULL`); return b; },
    order(c, o = {}) { st.order.push(`${ident(c)} ${o.ascending === false ? 'DESC' : 'ASC'}`); return b; },
    limit(n) { st.limit = n; return b; },
    range(a, z) { st.offset = a; st.limit = z - a + 1; return b; },
    maybeSingle() { st.single = true; st.limit = 1; return b; },
    then(res, rej) {
      const q = `SELECT ${st.cols} FROM ${ident(table)}${st.where.length ? ' WHERE ' + st.where.join(' AND ') : ''}` +
        `${st.order.length ? ' ORDER BY ' + st.order.join(', ') : ''}${st.limit != null ? ` LIMIT ${st.limit}` : ''}${st.offset ? ` OFFSET ${st.offset}` : ''}`;
      return ro(q, st.params).then((rows) => ({ data: st.single ? rows[0] ?? null : [...rows], error: null }),
        (e) => ({ data: null, error: { message: e.message, code: e.code } })).then(res, rej);
    },
  };
  return b;
}
const sb = { from };
const d1 = {
  prepare(q) {
    let args = [];
    let i = 0;
    const text = q.replace(/\?/g, () => `$${++i}`);
    const s = { bind(...a) { args = a; return s; }, all: async () => ({ results: [...await ro(text, args)] }), first: async () => (await ro(text, args))[0] ?? null };
    return s;
  },
};

// ---------- the real prompt builders, via a throwaway export copy ----------
const ROUTES = path.join(HERE, '..', 'src', 'scm', 'routes');
const COPY = path.join(ROUTES, `.ab-scan-so-${process.pid}.ts`);
copyFileSync(path.join(ROUTES, 'scan-so.ts'), COPY);
appendFileSync(COPY, '\nexport { loadCatalogFresh as __loadCatalogFresh, loadPromptInjections as __loadPromptInjections, normalizeSlip as __normalizeSlip };\n');
let mod;
let ocr;
let branding;
try {
  mod = await import(pathToFileURL(COPY).href);
  ocr = await import(pathToFileURL(path.join(HERE, '..', 'src', 'scm', 'lib', 'scan-ocr.ts')).href);
  branding = await import(pathToFileURL(path.join(HERE, '..', 'src', 'services', 'branding.ts')).href);
} finally {
  rmSync(COPY, { force: true });
}
const CLAUDE_MODEL = ocr.CLAUDE_MODEL;

// ---------- pick the slips ----------
const FINAL = 'Extract the sale-order slip above using the rules + catalog. ' +
  "OUTPUT FORMAT: Your response must be VALID JSON ONLY. Do NOT write any preamble, explanation, analysis, or chain-of-thought. Do NOT start with phrases like 'Looking at the image…'. Do NOT wrap in markdown fences. The very first character of your response must be '{' and the very last must be '}'.";

try {
  const cands = await ro(`
    SELECT s.id, s.salesperson, s.extracted, s.corrected, s.created_at, s.image_key,
           j.id AS job_id, j.image_keys, (to_jsonb(j) ->> 'company_id')::int AS company_id
      FROM so_scan_samples s
      LEFT JOIN LATERAL (SELECT * FROM scan_jobs j WHERE j.sample_id = s.id ORDER BY j.created_at DESC LIMIT 1) j ON true
     WHERE s.status = 'CONFIRMED' AND s.corrected IS NOT NULL AND s.extracted IS NOT NULL
       AND coalesce(s.document_type, 'SO') = 'SO'
       AND (coalesce(array_length(j.image_keys, 1), 0) > 0 OR s.image_key IS NOT NULL)
     ORDER BY s.created_at DESC LIMIT 200`);
  const companyName = (await branding.getBranding({ DB: d1 })).companyName;
  const catalogs = new Map();
  const slips = [];
  let leaked = 0;
  for (const c of cands) {
    if (slips.length >= N) break;
    const inj = await mod.__loadPromptInjections(sb, c.salesperson ?? '');
    // A slip whose own answer sits in the few-shot block would be copied, not read: skip it.
    if (inj.fewShotText.includes(JSON.stringify(c.corrected))) { leaked += 1; continue; }
    const ck = String(c.company_id ?? 'all');
    if (!catalogs.has(ck)) catalogs.set(ck, mod.buildCachedPrefix(await mod.__loadCatalogFresh(sb, d1, c.company_id ?? null), companyName));
    const keys = c.image_keys?.length ? c.image_keys : [c.image_key];
    slips.push({ ...c, keys, inj, prefix: catalogs.get(ck) });
  }
  console.log(`CONFIRMED samples with files: ${cands.length} (newest 200 max); skipped ${leaked} already in the few-shot block; using ${slips.length}`);
  for (const s of slips) console.log(`  ${s.created_at.toISOString().slice(0, 10)} ${s.id} files=${s.keys.length} rep=${s.salesperson ?? '-'}`);
  if (!APPLY) { console.log('plan only: APPLY=1 to call the models'); process.exit(0); }

  // ---------- R2 files (wrangler) ----------
  const dir = mkdtempSync(path.join(tmpdir(), 'ab-gem-'));
  const sniff = (b) => (b[0] === 0xff ? 'image/jpeg' : b[0] === 0x89 ? 'image/png' : b.subarray(0, 4).toString() === 'RIFF' ? 'image/webp' : b.subarray(0, 4).toString() === '%PDF' ? 'application/pdf' : null);
  function files(s) {
    const out = [];
    s.keys.forEach((key, i) => {
      const f = path.join(dir, `${s.id}-${i}`);
      const g = spawnSync('npx', ['wrangler', 'r2', 'object', 'get', `houzs-erp/${key}`, '--remote', '--file', f], { encoding: 'utf8', shell: process.platform === 'win32' });
      if (g.status !== 0) throw new Error(`r2 get failed for ${key}`);
      const buf = readFileSync(f);
      out.push({ mime: sniff(buf) ?? 'image/jpeg', b64: buf.toString('base64') });
    });
    return out;
  }
  const texts = (s) => [s.inj.globalAliasText, s.inj.globalRulesText, s.inj.repRulesText, s.inj.fewShotText].filter(Boolean);

  // ---------- the two calls ----------
  async function claude(s, fl, maxTokens = 8192) {
    const content = [{ type: 'text', text: s.prefix, cache_control: { type: 'ephemeral', ttl: '1h' } },
      ...(maxTokens > 1 ? [...texts(s).map((text) => ({ type: 'text', text })),
        ...fl.map((f) => (f.mime === 'application/pdf'
          ? { type: 'document', source: { type: 'base64', media_type: f.mime, data: f.b64 } }
          : { type: 'image', source: { type: 'base64', media_type: f.mime, data: f.b64 } })),
        { type: 'text', text: FINAL }] : [{ type: 'text', text: 'warm' }])];
    const t0 = performance.now();
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: AbortSignal.timeout(180_000),
      headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'extended-cache-ttl-2025-04-11' },
      body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: maxTokens, temperature: 0, messages: [{ role: 'user', content }] }),
    });
    const body = await r.json().catch(() => ({}));
    const ms = performance.now() - t0;
    return { ms, ok: r.ok, err: r.ok ? null : `${r.status} ${body?.error?.type ?? ''}`, text: body?.content?.find((b) => b.type === 'text')?.text ?? '' };
  }
  async function gemini(s, fl, maxTokens = 16384) {
    const parts = [{ text: s.prefix }, ...(maxTokens > 1 ? [...texts(s).map((text) => ({ text })),
      ...fl.map((f) => ({ inline_data: { mime_type: f.mime, data: f.b64 } })), { text: FINAL }] : [{ text: 'warm' }])];
    const generationConfig = { temperature: 0, maxOutputTokens: maxTokens, responseMimeType: 'application/json' };
    if (GEMINI_THINKING != null && GEMINI_THINKING !== '') generationConfig.thinkingConfig = { thinkingBudget: Number(GEMINI_THINKING) };
    const t0 = performance.now();
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
      method: 'POST', signal: AbortSignal.timeout(180_000),
      headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
      body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig }),
    });
    const body = await r.json().catch(() => ({}));
    const ms = performance.now() - t0;
    const text = (body?.candidates?.[0]?.content?.parts ?? []).filter((p) => !p.thought).map((p) => p.text ?? '').join('');
    return { ms, ok: r.ok, err: r.ok ? null : `${r.status} ${body?.error?.status ?? ''}`, text };
  }
  function parse(res) {
    const t0 = performance.now();
    let slip = null;
    try { slip = mod.__normalizeSlip(JSON.parse(ocr.stripJsonFences(res.text))); } catch { /* scored as all-miss */ }
    return { slip, parseMs: performance.now() - t0 };
  }

  // Warm each distinct prefix once per model (prod keeps Claude's cache warm with a cron).
  for (const prefix of new Set(slips.map((s) => s.prefix))) {
    const s = slips.find((x) => x.prefix === prefix);
    await claude(s, [], 1);
    await gemini(s, [], 1);
  }

  const rows = [];
  for (const [i, s] of slips.entries()) {
    const fl = files(s);
    const row = { id: s.id, date: s.created_at.toISOString().slice(0, 10), files: fl.length };
    // Alternate who goes first so time-of-day noise does not favour one model.
    const order = i % 2 ? ['gemini', 'claude'] : ['claude', 'gemini'];
    for (const m of order) {
      const res = m === 'claude' ? await claude(s, fl) : await gemini(s, fl);
      const { slip, parseMs } = parse(res);
      const sc = scoreSlip(slip ?? {}, s.corrected, s.extracted);
      row[m] = { modelMs: Math.round(res.ms), totalMs: Math.round(res.ms + parseMs), ok: res.ok && !!slip, err: res.err, score: sc };
    }
    rows.push(row);
    const f = (m) => `${m} ${(row[m].modelMs / 1000).toFixed(1)}s ${row[m].score.filter((x) => x.hit).length}/${row[m].score.length}${row[m].ok ? '' : ' FAIL ' + (row[m].err ?? 'parse')}`;
    console.log(`${i + 1}/${slips.length} ${s.id} ${f('claude')} | ${f('gemini')}`);
  }

  const summary = {};
  for (const m of ['claude', 'gemini']) {
    const ms = rows.map((r) => r[m].modelMs).sort((a, b) => a - b);
    const tot = rows.map((r) => r[m].totalMs).sort((a, b) => a - b);
    const all = rows.flatMap((r) => r[m].score);
    const rate = (xs) => (xs.length ? `${xs.filter((x) => x.hit).length}/${xs.length}` : '0/0');
    summary[m] = {
      model: m === 'claude' ? CLAUDE_MODEL : GEMINI_MODEL + (GEMINI_THINKING ? ` thinking=${GEMINI_THINKING}` : ''),
      failed: rows.filter((r) => !r[m].ok).length,
      modelMs: { median: pct(ms, 50), p90: pct(ms, 90) }, totalMs: { median: pct(tot, 50), p90: pct(tot, 90) },
      allFields: rate(all), fixedFields: rate(all.filter((x) => x.fixed)),
      byField: Object.fromEntries(['customer', 'code', 'qty', 'price'].map((f) => [f, rate(all.filter((x) => x.field === f))])),
    };
  }
  writeFileSync(OUT, JSON.stringify({ ranAt: new Date().toISOString(), summary, rows }, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  console.log(`wrote ${OUT}`);
} finally {
  await sql.end();
}
