#!/usr/bin/env node
// ----------------------------------------------------------------------------
// check-silent-writes.mjs — a WRITE whose refusal reaches nobody, in the 943
// raw calls that check-silent-mutations structurally cannot see.
//
// WHY THIS EXISTS, AND WHY IT IS NOT THE SAME CHECK.
//
// `check-silent-mutations.mjs` reports 0 SILENT. It is right inside its own
// rules and those rules are narrow in two ways, both of which hid real bugs on
// 2026-08-21:
//
//   1. Its corpus is `useMutation(` call sites — 303 of them. There are 943
//      raw write calls (`api.post/put/patch/del`, `authedFetch` with a write
//      method, `portalApi.*`) across 141 files, and it never looks at one.
//      Six of them were the Fleet Health drawer, where a mechanic set a
//      breakdown to "Resolved", the PATCH was refused, and the dropdown went on
//      reading Resolved while the lorry stayed grounded.
//
//   2. Its verdict is per HOOK, not per CALL SITE. `consumerHandles()` returns
//      true as soon as ANY consumer file awaits `mutateAsync` or reads
//      `.isError` — so ONE handling consumer clears every other consumer of the
//      same hook. `usePostGrn` was marked CAUGHT on the strength of
//      `GrnNew.tsx`'s `await post.mutateAsync(...)`, while three other call
//      sites — including the one that confirms "Inventory will be received into
//      the warehouse" — passed no error handler at all.
//
// This check answers a different, smaller question, per SITE: **a write happens
// inside a `try`; when it throws, does anything at all happen?**
//
// WHAT IT FLAGS. A `try { … }` whose body contains a write, whose `catch` body
// neither
//   * SURFACES anything (a toast, a dialog, an error state, a console.error, a
//     rethrow), nor
//   * RECORDS anything the caller can act on (a `failed += 1`, a
//     `failures.push(…)`, a `return false`, a state setter) —
// and which carries no `silent-write-ok:` marker.
//
// WHAT IT CANNOT SEE, stated so a clean run is not over-read:
//   * whether the message it DOES show is any good, or ever reaches a screen.
//     A `setErr` nobody renders passes here. That is a reader's job.
//   * a write with no `try` at all whose promise is simply dropped —
//     `@typescript-eslint/no-floating-promises` owns that one.
//   * a 200 that reports failure IN THE BODY (`movementErrors`). That is
//     `check-inband-failures.mjs`.
//   * a failed READ rendered as a confident state — the 2FA "Enable" button on
//     an account that had 2FA on, the trial balance that read "books balance"
//     off a ledger it never loaded. That shape has no `catch` to look at, and a
//     regex over `?? []` produced 1,277 candidates and no findings when it was
//     tried. It is a reader's job and it is written down as such.
//
// The opt-out is the point, not a loophole: a best-effort telemetry ping has no
// business surfacing an error, and saying so AT THE SITE is how the next person
// knows it was decided rather than forgotten.
//
//   } catch {
//     // silent-write-ok: presence heartbeat; the next interval retries.
//   }
//
// Usage:
//   node frontend/scripts/check-silent-writes.mjs           # report
//   node frontend/scripts/check-silent-writes.mjs --strict   # exit 1 on any
//   node frontend/scripts/check-silent-writes.mjs --json
//
// NO DEPENDENCIES (node:fs / node:path only) so it runs in a worktree with no
// node_modules.
// ----------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(frontendRoot, 'src');
const strict = process.argv.includes('--strict');
const jsonOut = process.argv.includes('--json');

/** A write leaving this app. `authedFetch` is only a write when it says so. */
const WRITE =
  /\bapi\s*\.\s*(post|put|patch|del|delete)\s*[<(]|\bportalApi\s*\.\s*(post|put|patch|del|delete)\s*[<(]|\bauthedFetch\s*[<(][\s\S]{0,300}?method:\s*['"](POST|PUT|PATCH|DELETE)['"]/;

/** Something a PERSON can see, or something that propagates. */
const SURFACES =
  /\bset(Err|Error)\w*\s*\(|\w*(Err|Error)\s*\(|\btoast\b|\bdialog\b|\bDialog\b|\balert\s*\(|console\s*\.\s*(error|warn)|\bnotify\s*\(|\bserviceNotify\b|\bwriteFailed\b|\bthrow\b|\breject\b|captureException/;

/** Something the CALLER can act on: a tally, a flag, a returned failure. */
const RECORDS = /\+\+|\+=|\.\s*push\s*\(|\breturn\b|\bset[A-Z]\w*\s*\(|=\s*(true|false|null)\b|=\s*\{/;

const OPT_OUT = /silent-write-ok:/;

/* SELF-TEST. A scan whose pattern cannot match reports "all clean", which is
   indistinguishable from success — this repo has been burned by that five
   times, and the rule is that a verdict computed over nothing must never read
   as a pass. Assert every pattern, in BOTH directions, before scanning. */
{
  const checks = [
    ['WRITE api.post', WRITE.test('await api.post(`/api/x`, body)'), true],
    ['WRITE api.patch', WRITE.test('api.patch(`/api/x/${id}`, patch)'), true],
    ['WRITE api.del', WRITE.test('await api.del(`/api/x/${id}`)'), true],
    ['WRITE portalApi.post', WRITE.test('await portalApi.post("/api/portal/x", token)'), true],
    ['WRITE authedFetch PATCH', WRITE.test("authedFetch(`/grns/${id}/post`, { method: 'PATCH' })"), true],
    ['WRITE not a read', WRITE.test('const d = await api.get<Row[]>("/api/x")'), false],
    ['WRITE not authedFetch GET', WRITE.test('authedFetch<Row[]>(`/grns?status=DRAFT`)'), false],
    ['SURFACES setErr', SURFACES.test('setErr(apiErrText(e));'), true],
    ['SURFACES notify', SURFACES.test('void notify({ title: "Could not save", tone: "error" });'), true],
    ['SURFACES toast', SURFACES.test('toast.error(e.message);'), true],
    ['SURFACES throw', SURFACES.test('throw new Error("nope");'), true],
    ['SURFACES console.error', SURFACES.test('console.error(e);'), true],
    ['SURFACES not a comment', SURFACES.test('/* best-effort; nothing to do. */'), false],
    ['SURFACES not empty', SURFACES.test('  '), false],
    ['RECORDS tally', RECORDS.test('failed += 1;'), true],
    ['RECORDS push', RECORDS.test('failures.push(`${id}: ${msg}`);'), true],
    ['RECORDS return', RECORDS.test('return false;'), true],
    ['RECORDS setter', RECORDS.test('setResults((s) => ({ ...s, [id]: "err" }));'), true],
    ['RECORDS not a comment', RECORDS.test('// ignore — the next poll retries'), false],
    ['OPT_OUT marker', OPT_OUT.test('// silent-write-ok: heartbeat'), true],
    ['OPT_OUT not a bare comment', OPT_OUT.test('// best-effort'), false],
  ];
  const bad = checks.filter(([, got, want]) => got !== want);
  if (bad.length) {
    console.error('check-silent-writes: internal pattern self-test FAILED — not reporting.');
    for (const [name, got, want] of bad) console.error(`  ${name}: got ${got}, wanted ${want}`);
    process.exit(2);
  }
}

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : walk(full);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [full] : [];
  });
}

/** The balanced `{ … }` starting at `openIdx`. */
function block(src, openIdx) {
  if (src[openIdx] !== '{') return null;
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return { text: src.slice(openIdx, i + 1), end: i };
    }
  }
  return null;
}

const findings = [];
let writeSites = 0;
let surfaced = 0;
let recorded = 0;
let waived = 0;

for (const file of walk(SRC).sort()) {
  const src = fs.readFileSync(file, 'utf8');
  const rel = path.relative(frontendRoot, file).split(path.sep).join('/');
  const re = /\btry\s*\{/g;
  let m;
  while ((m = re.exec(src))) {
    const tryB = block(src, src.indexOf('{', m.index));
    if (!tryB) continue;
    if (!WRITE.test(tryB.text)) continue;

    /* The catch that goes with THIS try. A `finally`-only try has none, and a
       write whose failure propagates to an outer handler is that handler's
       business, not this site's. */
    const tail = src.slice(tryB.end + 1, tryB.end + 60);
    const cm = /^\s*catch\s*(\([^)]*\))?\s*\{/.exec(tail);
    if (!cm) continue;
    const catchOpen = src.indexOf('{', tryB.end + 1 + tail.indexOf('catch'));
    const catchB = block(src, catchOpen);
    if (!catchB) continue;

    writeSites++;
    const body = catchB.text.slice(1, -1);
    if (OPT_OUT.test(body)) { waived++; continue; }
    if (SURFACES.test(body)) { surfaced++; continue; }
    if (RECORDS.test(body)) { recorded++; continue; }

    const before = src.slice(0, m.index);
    const owner =
      [...before.matchAll(/(?:export\s+)?(?:function|const)\s+([A-Za-z_$][\w$]*)/g)].pop()?.[1] ?? '(anonymous)';
    findings.push({
      file: rel,
      line: before.split('\n').length,
      owner,
      catchBody: body.replace(/\s+/g, ' ').trim().slice(0, 90),
    });
  }
}

if (jsonOut) {
  console.log(JSON.stringify({ writeSites, surfaced, recorded, waived, findings }, null, 2));
} else {
  console.log(
    `Checked ${writeSites} write-inside-try site(s) in frontend/src.\n` +
      `  ${surfaced} SURFACE  - the catch shows or rethrows something.\n` +
      `  ${recorded} RECORD   - the catch tallies a failure the caller reports.\n` +
      `  ${waived} WAIVED   - marked "silent-write-ok:" with a reason at the site.\n` +
      `  ${findings.length} SILENT   - a refusal reaches NOBODY.\n` +
      `\nThis does NOT see: a dropped promise with no try (that is\n` +
      `no-floating-promises), a 200 that reports failure in its body (that is\n` +
      `check-inband-failures), or a failed READ rendered as a confident state\n` +
      `(no catch to look at — that one still needs a reader).\n`,
  );
  if (findings.length) {
    console.log('=== SILENT ===');
    let last = '';
    for (const f of findings) {
      if (f.file !== last) { console.log(`\n${f.file}`); last = f.file; }
      console.log(`  L${String(f.line).padEnd(5)} ${f.owner}  catch { ${f.catchBody} }`);
    }
    console.log(
      '\nGive it an error path, or mark it at the site:\n' +
        '    } catch {\n' +
        '      // silent-write-ok: <why a person must not be told>\n' +
        '    }\n',
    );
  }
}

process.exit(strict && findings.length ? 1 : 0);
