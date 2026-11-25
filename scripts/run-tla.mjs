#!/usr/bin/env node
// Run the TLC model checker on one TLA+ config with a pinned, checksummed jar.
//
//   node scripts/run-tla.mjs formal/ac-outbox-claim/AcOutboxClaim.cfg
//   node scripts/run-tla.mjs --expect-violation formal/ac-outbox-claim/AcOutboxClaimBroken.cfg
//
// The module is the only .tla beside the cfg, or the optional second argument.
// --expect-violation exits 0 only when TLC reports an invariant violation.
// Needs java on PATH (CI: actions/setup-java, temurin 21).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const TLA_VERSION = 'v1.7.4';
export const JAR_URL = `https://github.com/tlaplus/tlaplus/releases/download/${TLA_VERSION}/tla2tools.jar`;
export const JAR_SHA256 = '936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(ROOT, 'formal', '.cache');

/** argv (without node and script) -> { cfg, tla, expectViolation } or { error }. */
export function parseArgs(argv) {
  let expectViolation = false;
  const pos = [];
  for (const a of argv) {
    if (a === '--expect-violation') expectViolation = true;
    else if (a.startsWith('--')) return { error: `unknown flag ${a}` };
    else pos.push(a);
  }
  if (pos.length < 1 || pos.length > 2) return { error: 'usage: run-tla.mjs [--expect-violation] <model.cfg> [<model.tla>]' };
  if (!pos[0].endsWith('.cfg')) return { error: `first argument must be a .cfg, got ${pos[0]}` };
  if (pos[1] && !pos[1].endsWith('.tla')) return { error: `second argument must be a .tla, got ${pos[1]}` };
  return { cfg: pos[0], tla: pos[1] ?? null, expectViolation };
}

/**
 * TLC's output -> 'pass' | 'invariant' | 'property' | 'deadlock' | 'error'.
 * 'error' covers a parse/semantic failure or a run that never finished, so a
 * broken model is never read as a pass or as the expected violation.
 */
export function verdictOf(output) {
  if (/Error: Invariant \S+ is violated/.test(output)) return 'invariant';
  if (/Error: Temporal properties were violated/.test(output)) return 'property';
  if (/Error: Deadlock reached/.test(output)) return 'deadlock';
  if (/Model checking completed\. No error has been found\./.test(output)) return 'pass';
  return 'error';
}

/** Exit code for a verdict: 0 only for what was asked for. */
export function exitCodeFor(verdict, expectViolation) {
  return expectViolation ? (verdict === 'invariant' ? 0 : 1) : (verdict === 'pass' ? 0 : 1);
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

async function ensureJar() {
  const jar = join(CACHE, 'tla2tools.jar');
  if (existsSync(jar) && sha256(readFileSync(jar)) === JAR_SHA256) return jar;
  mkdirSync(CACHE, { recursive: true });
  console.log(`downloading ${JAR_URL}`);
  const res = await fetch(JAR_URL);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = sha256(buf);
  if (got !== JAR_SHA256) throw new Error(`tla2tools.jar sha256 mismatch: got ${got}, want ${JAR_SHA256}`);
  writeFileSync(jar, buf);
  return jar;
}

function tlaFor(cfg) {
  const dir = dirname(cfg);
  const tlas = readdirSync(dir).filter((f) => f.endsWith('.tla'));
  if (tlas.length !== 1) throw new Error(`${dir} holds ${tlas.length} .tla files; pass the module explicitly`);
  return join(dir, tlas[0]);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) { console.error(args.error); process.exit(2); }
  const cfg = resolve(args.cfg);
  const tla = resolve(args.tla ?? tlaFor(cfg));
  const jar = await ensureJar();
  const metadir = join(CACHE, 'states', basename(cfg, '.cfg'));
  const run = spawnSync('java', [
    '-XX:+UseParallelGC', '-cp', jar, 'tlc2.TLC',
    '-config', cfg, '-workers', 'auto', '-metadir', metadir,
    // Terminal states (every row sent or failed) are the expected end, not a
    // deadlock; a row stuck pending is caught by the liveness property instead.
    '-deadlock',
    basename(tla),
  ], { cwd: dirname(tla), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (run.error) { console.error(`could not start java: ${run.error.message}`); process.exit(2); }
  const out = `${run.stdout}${run.stderr}`;
  process.stdout.write(out);
  const verdict = verdictOf(out);
  const code = exitCodeFor(verdict, args.expectViolation);
  console.log(`\nverdict: ${verdict}${args.expectViolation ? ' (expected: invariant)' : ' (expected: pass)'} -> ${code === 0 ? 'OK' : 'FAIL'}`);
  process.exit(code);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(2); });
}
