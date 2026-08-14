#!/usr/bin/env node
// ----------------------------------------------------------------------------
// check-completeness-claim — the runner.
//
// If a PR claims it covered a whole population ("every desktop + mobile call
// site", "all four arms", "system-wide"), it must paste the command that
// ENUMERATES that population together with the command's output, inside a
// ```enumeration block. This script RE-RUNS the command against the PR head and
// fails if the output differs. A pasted list can be stale or invented;
// reproducing it is the point.
//
// See scripts/lib/completeness-claim.mjs for the parsing/diffing logic and for
// why PR #1763 is the worked example. This file owns the two things that must
// not live in a pure module: reading the event, and EXECUTING an untrusted
// string safely.
//
// USAGE
//   In CI:      node scripts/check-completeness-claim.mjs
//               (reads $GITHUB_EVENT_PATH)
//   Locally:    node scripts/check-completeness-claim.mjs --body-file pr.md \
//                 [--title "..."] [--label completeness-not-claimed] [--repo .]
//
// Zero dependencies and no `npm ci`: it runs on a bare checkout.
// ----------------------------------------------------------------------------

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  ESCAPE_LABEL,
  REASON,
  VERDICT,
  evaluate,
} from './lib/completeness-claim.mjs';

// ---------------------------------------------------------------------------
// The execution box.
//
// The command comes from a PR body, which anyone who can open a PR controls.
// Layers, each independent of the others:
//
//  1. NO SHELL. `shell: false`, and the argv was built by our own tokenizer.
//     Unquoted `;`, `&`, backticks and `$(` were already refused upstream.
//  2. A per-program FLAG ALLOWLIST (upstream) — rg's `--pre`, `-z` and `-L`,
//     and any option before a git subcommand, cannot get through.
//  3. A SCRUBBED ENVIRONMENT. The child sees PATH, HOME, LANG and nothing
//     else. GITHUB_TOKEN, secrets and NODE_OPTIONS are simply not there.
//  4. cwd pinned to the repo root; absolute paths and `..` refused upstream.
//  5. For `node`, the Node 22 permission model: --permission with a single
//     --allow-fs-read of the repo. That turns OFF child_process, worker
//     threads, native addons, and every filesystem write. Verified on
//     node v22.14: `require('child_process').execSync` raises
//     "Access to this API has been restricted".
//  6. A wall-clock TIMEOUT and an output CAP, so a pasted infinite loop or a
//     `grep -r . /` cannot wedge or flood the runner.
//
// The workflow adds `permissions: contents: read`, so even a hypothetical
// escape holds a token that can only read what the PR author can already read.
// ---------------------------------------------------------------------------

const TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

function childEnv() {
  const { PATH, HOME, LANG, LC_ALL, SYSTEMROOT } = process.env;
  return { PATH, HOME, LANG: LANG ?? 'C.UTF-8', LC_ALL: LC_ALL ?? 'C.UTF-8', ...(SYSTEMROOT ? { SYSTEMROOT } : {}) };
}

function hardenArgv(argv, repoRoot) {
  if (argv[0] !== 'node') return argv;
  // Injected here, never accepted from the body: the flag allowlist has no
  // --allow-* entry, so a PR cannot ask for child_process back.
  return ['node', '--permission', `--allow-fs-read=${repoRoot}`, ...argv.slice(1)];
}

export function makeExec(repoRoot) {
  return (stages) => {
    let input;
    for (let i = 0; i < stages.length; i++) {
      const argv = hardenArgv(stages[i], repoRoot);
      const r = spawnSync(argv[0], argv.slice(1), {
        cwd: repoRoot,
        env: childEnv(),
        shell: false,
        encoding: 'utf8',
        input,
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        killSignal: 'SIGKILL',
      });

      const shown = argv.join(' ');
      if (r.error) {
        if (r.error.code === 'ENOENT') {
          return { ok: false, error: `\`${argv[0]}\` is not installed on this runner. Use grep, git grep or node instead.` };
        }
        if (r.error.code === 'ETIMEDOUT') {
          return { ok: false, error: `\`${shown}\` did not finish within ${TIMEOUT_MS / 1000}s.` };
        }
        return { ok: false, error: `\`${shown}\` could not be executed: ${r.error.message}` };
      }
      // grep / rg / git grep exit 1 for "no matches", and an empty population
      // is a legitimate enumeration ("removed from every call site"). Anything
      // above 1 is a real error — bad regex, unreadable path — and the author
      // deserves stderr.
      //
      // NOT node, though: a one-liner that throws also exits 1. Tolerating that
      // would turn a crashed command into an empty enumeration, so a PR
      // claiming "gone from every call site" with an empty pasted list would go
      // GREEN on a command that never ran. That is the exact failure mode this
      // gate exists to prevent, so it must not be built into the gate itself.
      const emptyIsFine = argv[0] === 'grep' || argv[0] === 'rg' || argv[0] === 'git';
      if (r.status !== 0 && !(emptyIsFine && r.status === 1)) {
        const why = (r.stderr || '').trim().split('\n').slice(0, 5).join('\n');
        return { ok: false, error: `\`${shown}\` exited ${r.status}${why ? `:\n${why}` : '.'}` };
      }
      input = r.stdout ?? '';
    }
    return { ok: true, stdout: input ?? '' };
  };
}

// ---------------------------------------------------------------------------
// Inputs: the pull_request event in CI, flags locally (and for the mutation
// proof, which is how anyone confirms this gate can actually fail).
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { labels: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) { console.error(`[completeness] ${a} needs a value`); process.exit(2); }
      return v;
    };
    if (a === '--body-file') out.bodyFile = next();
    else if (a === '--title-file') out.titleFile = next();
    else if (a === '--title') out.title = next();
    else if (a === '--label') out.labels.push(next());
    else if (a === '--repo') out.repo = next();
    else if (a === '--event') out.event = next();
    else { console.error(`[completeness] unknown argument ${JSON.stringify(a)}`); process.exit(2); }
  }
  return out;
}

function loadInputs(args) {
  if (args.bodyFile || args.titleFile || args.title !== undefined) {
    return {
      title: args.title ?? (args.titleFile ? readFileSync(args.titleFile, 'utf8').trim() : ''),
      body: args.bodyFile ? readFileSync(args.bodyFile, 'utf8') : '',
      labels: args.labels,
      origin: 'command line',
    };
  }
  const path = args.event ?? process.env.GITHUB_EVENT_PATH;
  if (!path) {
    console.error('[completeness] no --body-file and no $GITHUB_EVENT_PATH; nothing to check.');
    process.exit(2);
  }
  const event = JSON.parse(readFileSync(path, 'utf8'));
  const pr = event.pull_request;
  if (!pr) {
    console.log('[completeness] SKIP: this event carries no pull_request payload.');
    process.exit(0);
  }
  return {
    title: pr.title ?? '',
    body: pr.body ?? '',
    labels: (pr.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name)),
    origin: `PR #${pr.number}`,
  };
}

// ---------------------------------------------------------------------------
// Report. A gate that fails without saying exactly what to do next is a gate
// people route around, so every failure prints the fix.
// ---------------------------------------------------------------------------

const HOW_TO =
  'Add a fenced block tagged `enumeration` to the PR body:\n' +
  '\n' +
  '    ```enumeration\n' +
  '    $ git grep -n "missingVariantAxes(" -- backend/src frontend/src\n' +
  '    <paste the command\'s exact output here>\n' +
  '    ```\n' +
  '\n' +
  'CI re-runs that command against this PR head and diffs the output, so the\n' +
  'list proves itself. One command per block; add another block for another\n' +
  'population.\n' +
  '\n' +
  `If the wording was not meant as a claim about a population, either reword it\n` +
  `or add the \`${ESCAPE_LABEL}\` label.`;

function bullet(lines, limit = 25) {
  const shown = lines.slice(0, limit).map((l) => `      ${l}`);
  if (lines.length > limit) shown.push(`      ... and ${lines.length - limit} more`);
  return shown.join('\n');
}

function report(result, inputs) {
  const tag = '[completeness]';
  console.log(`${tag} ${inputs.origin}: ${result.claims.length} completeness claim(s) found.`);

  for (const c of result.claims) {
    console.log(`${tag}   ${c.source} line ${c.line}: "${c.phrase}"`);
  }

  if (result.reason === REASON.NO_CLAIM) {
    console.log(`${tag} PASS: the PR does not assert coverage of a population, so there is nothing to reproduce.`);
    return;
  }

  if (result.reason === REASON.ESCAPE_LABEL) {
    console.log('');
    for (const n of result.notes) console.log(`${tag} ${n}`);
    console.log(`${tag} PASS (waived).`);
    return;
  }

  console.log('');
  for (const b of result.blocks) {
    const where = `block at body line ${b.startLine}`;
    if (b.verdict === VERDICT.PASS) {
      console.log(`${tag} ${where}: REPRODUCED (${b.diff.actualCount} line(s)).`);
      console.log(`${tag}   $ ${b.plan.map((s) => s.join(' ')).join(' | ')}`);
      continue;
    }
    console.log(`${tag} ${where}: FAILED — ${b.reason}`);
    if (b.detail) console.log(`${tag}   ${b.detail}`);
    if (b.plan) console.log(`${tag}   re-ran: ${b.plan.map((s) => s.join(' ')).join(' | ')}`);
    if (b.diff) {
      console.log(`${tag}   pasted ${b.diff.pastedCount} line(s); the tree has ${b.diff.actualCount}.`);
      if (b.diff.extra.length) {
        console.log(`${tag}   IN THE TREE BUT NOT IN YOUR LIST (${b.diff.extra.length}) — this is the stale-enumeration shape,`);
        console.log(`${tag}   and each of these is a member of the population your PR says it covered:`);
        console.log(bullet(b.diff.extra));
      }
      if (b.diff.missing.length) {
        console.log(`${tag}   IN YOUR LIST BUT NOT IN THE TREE (${b.diff.missing.length}) — moved, deleted, or never there:`);
        console.log(bullet(b.diff.missing));
      }
    }
  }

  if (result.reason === REASON.MISSING_BLOCK) {
    console.log(`${tag} This PR claims completeness but carries no \`\`\`enumeration block.`);
  }

  if (result.verdict === VERDICT.PASS) {
    console.log(`${tag} PASS: every completeness claim in this PR reproduces against the PR head.`);
    return;
  }

  console.log('');
  for (const line of HOW_TO.split('\n')) console.log(`${tag} ${line}`);
}

// ---------------------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv.slice(2));
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(args.repo ?? process.env.GITHUB_WORKSPACE ?? resolve(here, '..'));

  const inputs = loadInputs(args);
  const result = evaluate({ ...inputs, exec: makeExec(repoRoot) });

  report(result, inputs);

  if (result.verdict === VERDICT.FAIL) {
    console.error('[completeness] FAIL: a completeness claim in this PR could not be reproduced.');
    process.exit(1);
  }
  process.exit(0);
}

// Only when RUN, not when imported: the test suite imports `makeExec` to
// exercise the real spawn path (the sandbox is the part that must not be
// tested against a stub).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
