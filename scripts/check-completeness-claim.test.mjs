// ----------------------------------------------------------------------------
// Tests for the completeness gate's logic (scripts/lib/completeness-claim.mjs).
//
// RUN IT WITH (from the repo root):
//   node --test scripts/check-completeness-claim.test.mjs
//
// NO DEPENDENCIES, on purpose: `npm install` in a worktree destroys the main
// checkout's node_modules, so a check that needs one is a check nobody runs.
// node:test / node:assert are built in. ci.yml runs this explicitly.
//
// What these pin, in order of how badly it would hurt to lose them:
//   1. The gate FAILS a stale enumeration (this is the whole product).
//   2. The gate does NOT fire on the sentences this repo writes every day —
//      including its own pull_request_template. A gate with false positives
//      gets deleted within a day.
//   3. A PR body cannot execute arbitrary shell. It is untrusted input.
//   4. The escape hatch works and is NOT silent.
// ----------------------------------------------------------------------------
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { makeExec } from './check-completeness-claim.mjs';
import {
  ESCAPE_LABEL,
  REASON,
  VERDICT,
  diffOutput,
  evaluate,
  extractEnumerationBlocks,
  findClaims,
  normalizeOutput,
  planCommand,
  proseLines,
  stripLineNumber,
  tokenize,
} from './lib/completeness-claim.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** An `exec` that returns canned stdout, and records what it was asked to run. */
const stubExec = (stdout, seen = []) => (stages) => {
  seen.push(stages);
  return typeof stdout === 'function' ? stdout(stages) : { ok: true, stdout };
};
const never = () => {
  throw new Error('exec must not be called');
};

// ===========================================================================
// 1. THE REGRESSION THAT FORCED THIS GATE: PR #1763.
// ===========================================================================

// The real sentence from the merged body of #1763 (4f30a063), verbatim.
const PR_1763_BODY = `Owner 2026-08-09: "divan only 不需要 gap". A DIVAN ONLY product is a divan sold
WITHOUT a mattress, so there is no mattress gap to state.

isDivanOnly(itemCode) added to scm/shared/so-variant-rule.ts; itemCode threaded
through the backend gate (so-variant-check) and every desktop + mobile call
site; the vendored frontend copy of the rule was updated in lockstep.

Backend + frontend typecheck clean.`;

test('#1763: the claim is in the BODY, not the title — so body scanning is load-bearing', () => {
  const title = 'fix(scm): DIVAN ONLY lines do not require a mattress Gap';
  assert.deepEqual(findClaims(title, ''), [], 'the real title carries no claim at all');

  const claims = findClaims(title, PR_1763_BODY);
  assert.equal(claims.length, 1);
  assert.equal(claims[0].source, 'body');
  // The noun is split across a hard wrap ("call\nsite"), which is how PR
  // bodies are actually written. If this stops matching, the gate misses the
  // one PR it was built for.
  assert.match(claims[0].phrase, /every desktop \+ mobile call site|every desktop/i);
});

test('#1763: a claim with no enumeration block FAILS', () => {
  const r = evaluate({ title: '', body: PR_1763_BODY, labels: [], exec: never });
  assert.equal(r.verdict, VERDICT.FAIL);
  assert.equal(r.reason, REASON.MISSING_BLOCK);
});

test('#1763: a STALE enumeration FAILS, and names the sites that were left out', () => {
  // The author pastes 8 of the 13 call sites — the shape of the real defect,
  // where 5 never got the argument.
  const pasted = [
    'backend/src/scm/lib/so-variant-check.ts:56',
    'backend/src/scm/shared/inventory-adjustment.ts:43',
    'frontend/src/mobile/MobileNewSO.tsx:1768',
  ].join('\n');
  const actual = pasted + '\n' + [
    'frontend/src/mobile/MobileNewSO.tsx:2992',
    'frontend/src/pages/scm-v2/SalesOrderDetail.tsx:601',
  ].join('\n');

  const body = `${PR_1763_BODY}

\`\`\`enumeration
$ git grep -n "missingVariantAxes(" -- backend/src frontend/src
${pasted}
\`\`\``;

  const r = evaluate({ title: '', body, labels: [], exec: stubExec(actual) });
  assert.equal(r.verdict, VERDICT.FAIL);
  assert.equal(r.reason, REASON.OUTPUT_MISMATCH);
  assert.deepEqual(r.blocks[0].diff.extra, [
    'frontend/src/mobile/MobileNewSO.tsx:2992',
    'frontend/src/pages/scm-v2/SalesOrderDetail.tsx:601',
  ]);
  assert.deepEqual(r.blocks[0].diff.missing, []);
});

test('#1763: the corrected enumeration PASSES', () => {
  const list = [
    'backend/src/scm/lib/so-variant-check.ts:56',
    'backend/src/scm/shared/inventory-adjustment.ts:43',
    'frontend/src/mobile/MobileNewSO.tsx:1768',
    'frontend/src/mobile/MobileNewSO.tsx:2992',
    'frontend/src/pages/scm-v2/SalesOrderDetail.tsx:601',
  ].join('\n');
  const body = `${PR_1763_BODY}

\`\`\`enumeration
$ git grep -n "missingVariantAxes(" -- backend/src frontend/src
${list}
\`\`\``;
  const r = evaluate({ title: '', body, labels: [], exec: stubExec(list) });
  assert.equal(r.verdict, VERDICT.PASS);
  assert.equal(r.reason, REASON.VERIFIED);
});

test('an INVENTED line — in the list, not in the tree — also FAILS', () => {
  const body = [
    'Threaded through every caller.',
    '',
    '```enumeration',
    '$ grep -rn "foo(" backend/src',
    'backend/src/a.ts:1',
    'backend/src/ghost.ts:9',
    '```',
  ].join('\n');
  const r = evaluate({ title: '', body, labels: [], exec: stubExec('backend/src/a.ts:1') });
  assert.equal(r.reason, REASON.OUTPUT_MISMATCH);
  assert.deepEqual(r.blocks[0].diff.missing, ['backend/src/ghost.ts:9']);
});

// ===========================================================================
// 2. FALSE POSITIVES — the way this gate dies if it gets them wrong.
// ===========================================================================

test("the repo's OWN pull_request_template does not trip the gate", () => {
  // Every PR starts from this text. If it triggered, every PR would need an
  // enumeration block on day one and the gate would be deleted by lunch.
  // Note it contains "for every changed app" — "app" is deliberately NOT a
  // population noun.
  const template = readFileSync(join(repoRoot, '.github', 'pull_request_template.md'), 'utf8');
  assert.deepEqual(findClaims('', template), []);

  // The template also EXPLAINS the enumeration block, which means it contains
  // both the trigger words and a worked ```enumeration example. Both live
  // inside an HTML comment, so neither is submitted: an unmodified template
  // must yield no claims AND no blocks for CI to try to reproduce.
  assert.deepEqual(extractEnumerationBlocks(template), []);
});

test('an HTML comment hides a block, but must not swallow the rest of its line', () => {
  assert.deepEqual(extractEnumerationBlocks('<!--\n```enumeration\n$ grep -rn a .\n```\n-->'), []);
  assert.equal(findClaims('', 'Fixed every caller. <!-- todo: check mobile -->').length, 1);
  // Line numbers survive masking, so the report still points at the right line.
  assert.equal(findClaims('', '<!--\nx\ny\n-->\nFixed every caller.')[0].line, 5);
});

test('everyday CI sentences do not trip the gate', () => {
  for (const s of [
    'Backend + frontend typecheck clean, all tests pass.',
    'All checks green.',
    'Typecheck, tests and production build pass for every changed app.',
    'Fixed all the review comments.',
    'This affects both companies.',
    'Each migration is idempotent.',
    'Money is integer sen everywhere it is stored.', // <- this one SHOULD trip
  ].slice(0, 6)) {
    assert.deepEqual(findClaims(s, ''), [], `should not trigger: ${s}`);
  }
});

test('a claim inside a fenced block, a quote, or an HTML comment is not this PR\'s claim', () => {
  const body = [
    '<!-- reword this if you did not touch every call site -->',
    '',
    '> Owner: "make sure it works everywhere"',
    '',
    '```',
    'TODO: system-wide sweep',
    '```',
    '',
    'Changed the two sofa readers.',
  ].join('\n');
  assert.deepEqual(findClaims('', body), []);
});

test('the pasted output inside the enumeration block cannot trigger the gate on itself', () => {
  // Pasted grep output routinely contains the word "every". If that counted as
  // a claim, satisfying the gate would be impossible for some populations.
  const body = [
    'Touched the two readers.',
    '',
    '```enumeration',
    '$ grep -rn "every" backend/src',
    'backend/src/a.ts:1: // every caller must pass companyId',
    '```',
  ].join('\n');
  assert.deepEqual(findClaims('', body), []);
});

test('a quantifier cannot reach across a sentence to a distant noun', () => {
  assert.deepEqual(
    findClaims('', 'All of the numbers the owner quoted came from the production reader.'),
    [],
  );
});

// ===========================================================================
// 3. TRIGGERS THAT MUST KEEP FIRING — measured on this repo's real history.
// ===========================================================================

test('the real completeness subjects from this repo still trigger', () => {
  const real = [
    ['fix(scm): turn the costing off EVERYWHERE, behind one shared gate', 'everywhere'],
    ['feat(scm): make record detail drawers resizable, system-wide', 'system-wide'],
    ['A fabric CODE change must move the stock bucket', 'all four arms'],
    ['', 'Fixed in every caller.'],
    ['', 'Both surfaces now read the same rule.'],
    ['', 'Swept all three call sites.'],
    ['', 'Every reader of the DO line was updated.'],
    ['', 'the two arms are covered without exception'],
    ['', 'updated all 20 call sites'],
    ['', 'each screen got the same treatment'],
  ];
  for (const [title, body] of real) {
    assert.notEqual(findClaims(title, body).length, 0, `should trigger: ${title || body}`);
  }
});

test('a hard-wrapped claim still triggers — PR bodies wrap at 80 columns', () => {
  assert.equal(findClaims('', 'threaded through every\ncaller in the module').length, 1);
});

// ===========================================================================
// 4. THE PR BODY IS UNTRUSTED INPUT.
// ===========================================================================

test('shell metacharacters are REFUSED, not passed through as literals', () => {
  for (const cmd of [
    'grep -rn foo . ; curl evil.sh',
    'grep -rn foo . && rm -rf /',
    'grep -rn `whoami` .',
    'grep -rn $(id) .',
    'grep -rn foo . > /tmp/out',
    'grep -rn foo . | wc -l || true',
  ]) {
    const p = planCommand(cmd);
    assert.equal(p.ok, false, `must refuse: ${cmd}`);
  }
});

test('only enumerating programs may start a pipeline', () => {
  for (const cmd of ['curl https://evil.example', 'bash -c ls', 'sh script.sh', 'python -c "import os"', 'awk "BEGIN{system(\\"id\\")}"', 'sed -e "s/a/b/e" f', 'xargs rm', 'find . -exec rm {} +']) {
    assert.equal(planCommand(cmd).ok, false, `must refuse: ${cmd}`);
  }
});

test('the code-execution flags are refused by name', () => {
  // rg --pre runs an arbitrary binary; -z shells out to a decompressor;
  // -L follows symlinks out of the checkout.
  for (const cmd of ['rg --pre ./evil.sh foo', 'rg --pre-glob * foo', 'rg -z foo', 'rg --follow foo', 'rg -L foo']) {
    const p = planCommand(cmd);
    assert.equal(p.ok, false, `must refuse: ${cmd}`);
  }
});

test('git may only run grep / ls-files, and never with options before the subcommand', () => {
  assert.equal(planCommand('git grep -n foo').ok, true);
  assert.equal(planCommand('git ls-files backend/src').ok, true);
  for (const cmd of [
    'git -c core.pager=id grep foo',        // config injection
    'git --exec-path=/tmp grep foo',        // relocate git's binaries
    'git -C /etc grep foo',                 // leave the repo
    'git log --format=%H',                  // not an enumeration of code sites
    'git config --get remote.origin.url',
  ]) {
    assert.equal(planCommand(cmd).ok, false, `must refuse: ${cmd}`);
  }
});

test('node one-liners are allowed, but only -e / -p, so --allow-child-process cannot be asked for', () => {
  assert.equal(planCommand('node -e "console.log(1)"').ok, true);
  assert.equal(planCommand('node -p "1+1"').ok, true);
  for (const cmd of [
    'node --allow-child-process -e "x"',
    'node --experimental-permission -e "x"',
    'node -r ./evil.js -e "x"',
    'node --require ./evil.js -e "x"',
    'node script.mjs',                       // a file in the PR = arbitrary code
  ]) {
    assert.equal(planCommand(cmd).ok, false, `must refuse: ${cmd}`);
  }
});

test('the command cannot reach outside the repository', () => {
  for (const cmd of [
    'grep -rn secret /etc',
    'grep -rn secret /home/runner/work/_temp',
    'grep -rn secret ../../..',
    'grep -rn secret ~/.ssh',
    'grep -rn x /proc/self/environ',
  ]) {
    assert.equal(planCommand(cmd).ok, false, `must refuse: ${cmd}`);
  }
  // ...but a regex that merely looks like a path is fine.
  assert.equal(planCommand('grep -rn "/api/scm" backend/src').ok, true);
});

test('a pipeline is built here, not by a shell, and is capped', () => {
  const p = planCommand('git grep -n "foo(" -- backend/src | wc -l');
  assert.equal(p.ok, true);
  assert.deepEqual(p.stages, [['git', 'grep', '-n', 'foo(', '--', 'backend/src'], ['wc', '-l']]);
  assert.equal(planCommand('grep -rn a . | sort | uniq -c | wc -l').ok, false, 'four stages is too many');
});

test('bundled and attached short flags are expanded and checked one by one', () => {
  assert.deepEqual(planCommand('grep -rn foo backend').stages, [['grep', '-r', '-n', 'foo', 'backend']]);
  assert.deepEqual(planCommand('grep -A3 foo backend').stages, [['grep', '-A', '3', 'foo', 'backend']]);
  // -Z (--null) is not on grep's allowlist; bundling must not smuggle it in.
  assert.equal(planCommand('grep -rnZ foo backend').ok, false);
});

test('tokenize quotes without expanding anything', () => {
  assert.deepEqual(tokenize(`grep -rn "a b" 'c d' e\\ f`).stages, [['grep', '-rn', 'a b', 'c d', 'e f']]);
  // $ and backticks inside quotes are ordinary characters: there is no shell.
  assert.deepEqual(tokenize(`grep -n "foo$"`).stages, [['grep', '-n', 'foo$']]);
  assert.equal(tokenize('grep -n "unterminated').ok, false);
});

// ===========================================================================
// 5. THE ESCAPE HATCH — present, and deliberately loud.
// ===========================================================================

test(`${ESCAPE_LABEL} waives the proof`, () => {
  const r = evaluate({ title: 'fix: resizable drawers, system-wide', body: '', labels: [ESCAPE_LABEL], exec: never });
  assert.equal(r.verdict, VERDICT.PASS);
  assert.equal(r.reason, REASON.ESCAPE_LABEL);
});

test('...but it is NOT silent: it asks for the wording back, and quotes it', () => {
  const r = evaluate({ title: 'fix: resizable drawers, system-wide', body: '', labels: ['CompleteNess-Not-Claimed'], exec: never });
  assert.equal(r.reason, REASON.ESCAPE_LABEL, 'the label is matched case-insensitively');
  const text = r.notes.join('\n');
  assert.match(text, /STILL PRESENT/);
  assert.match(text, /reword/i);
  assert.match(text, /"system-wide"/, 'the offending phrase is quoted back');
});

test('an unrelated label does not waive anything', () => {
  const r = evaluate({ title: 'fix: resizable drawers, system-wide', body: '', labels: ['bug', 'needs-review'], exec: never });
  assert.equal(r.verdict, VERDICT.FAIL);
});

// ===========================================================================
// 6. BLOCK PARSING AND DIFFING.
// ===========================================================================

test('the block needs a "$ " command line, and holds exactly one', () => {
  const noPrompt = extractEnumerationBlocks('```enumeration\ngrep -rn x .\n```');
  assert.equal(noPrompt[0].ok, false);
  assert.match(noPrompt[0].reason, /must be the enumerating command/);

  const two = extractEnumerationBlocks('```enumeration\n$ grep -rn a .\nout\n$ grep -rn b .\n```');
  assert.equal(two[0].ok, false);
  assert.match(two[0].reason, /exactly ONE command/);

  const unclosed = extractEnumerationBlocks('```enumeration\n$ grep -rn a .\n');
  assert.equal(unclosed[0].ok, false);
  assert.match(unclosed[0].reason, /never closed/);
});

test('an untagged fence is ignored; only ```enumeration counts', () => {
  assert.deepEqual(extractEnumerationBlocks('```\n$ grep -rn a .\n```'), []);
  assert.deepEqual(extractEnumerationBlocks('```bash\n$ grep -rn a .\n```'), []);
});

test('two populations, two blocks — and BOTH must reproduce', () => {
  const body = [
    'Swept every reader and both writers.',
    '',
    '```enumeration',
    '$ grep -rn readerA backend/src',
    'a',
    '```',
    '',
    '```enumeration',
    '$ grep -rn writerB backend/src',
    'b',
    '```',
  ].join('\n');
  const isReaderA = (stages) => stages.flat().includes('readerA');
  const good = evaluate({ title: '', body, labels: [], exec: (s) => ({ ok: true, stdout: isReaderA(s) ? 'a' : 'b' }) });
  assert.equal(good.verdict, VERDICT.PASS);
  assert.equal(good.blocks.length, 2);

  const bad = evaluate({ title: '', body, labels: [], exec: (s) => ({ ok: true, stdout: isReaderA(s) ? 'a' : 'b\nc' }) });
  assert.equal(bad.verdict, VERDICT.FAIL);
  assert.equal(bad.blocks[0].verdict, VERDICT.PASS);
  assert.equal(bad.blocks[1].verdict, VERDICT.FAIL);
});

test('a long command may be continued with a trailing backslash', () => {
  const b = extractEnumerationBlocks('```enumeration\n$ git grep -n "foo" -- \\\n    backend/src frontend/src\nout\n```');
  assert.equal(b[0].ok, true);
  assert.equal(b[0].command, 'git grep -n "foo" -- backend/src frontend/src');
});

test('the diff is order-insensitive — rg walks in parallel and its order is not stable', () => {
  assert.equal(diffOutput('a\nb\nc', 'c\na\nb').ok, true);
  // ...but a duplicate is a real difference, not a reordering.
  assert.equal(diffOutput('a\nb', 'a\nb\nb').ok, false);
});

test('normalisation absorbs CRLF, trailing spaces and surrounding blank lines', () => {
  assert.deepEqual(normalizeOutput('\r\n a \t\r\nb  \n\n'), [' a', 'b']);
  assert.equal(diffOutput('a\r\nb', '\na\nb  \n\n').ok, true);
});

// ===========================================================================
// 5b. THE COORDINATE. A `git grep -n` block embeds a LINE NUMBER per member,
//     and an unrelated merge into a 12,000-line router shifts every one of
//     them. The population did not change; only where it sits did. These pin
//     BOTH directions — the forgiveness AND the teeth — because a gate that
//     stops failing on a moved line is only correct if it still fails on an
//     added one.
// ===========================================================================

/** The real shape of `git grep -n` output: path, line number, then the code. */
const SITE = (file, line, text) => `${file}:${line}:${text}`;
const CALL = '  missingVariantAxes(itemCode)';

test('a call site that merely MOVES still PASSES — the merge shifted it, the PR did not', () => {
  const pasted = [
    SITE('backend/src/scm/lib/so-variant-check.ts', 56, CALL),
    SITE('frontend/src/mobile/MobileNewSO.tsx', 1768, CALL),
    SITE('frontend/src/pages/scm-v2/SalesOrderDetail.tsx', 601, CALL),
  ].join('\n');
  // Same three sites, same file, same code — main grew above each of them.
  const afterMerge = [
    SITE('backend/src/scm/lib/so-variant-check.ts', 92, CALL),
    SITE('frontend/src/mobile/MobileNewSO.tsx', 2044, CALL),
    SITE('frontend/src/pages/scm-v2/SalesOrderDetail.tsx', 655, CALL),
  ].join('\n');

  const d = diffOutput(pasted, afterMerge);
  assert.equal(d.ok, true, 'a pure coordinate shift must not fail the gate');
  assert.equal(d.pastedCount, 3);
  assert.equal(d.actualCount, 3);
});

test('...but a call site that is ADDED still FAILS, even when every other one moved', () => {
  const pasted = [
    SITE('backend/src/scm/lib/so-variant-check.ts', 56, CALL),
    SITE('frontend/src/mobile/MobileNewSO.tsx', 1768, CALL),
  ].join('\n');
  const afterMerge = [
    SITE('backend/src/scm/lib/so-variant-check.ts', 92, CALL),      // moved
    SITE('frontend/src/mobile/MobileNewSO.tsx', 2044, CALL),        // moved
    SITE('frontend/src/pages/scm-v2/SalesOrderDetail.tsx', 601, CALL), // NEW — #1763
  ].join('\n');

  const d = diffOutput(pasted, afterMerge);
  assert.equal(d.ok, false, 'a new member of the population must still fail');
  assert.deepEqual(d.extra, [SITE('frontend/src/pages/scm-v2/SalesOrderDetail.tsx', 601, CALL)]);
  assert.deepEqual(d.missing, []);
});

test('...and a call site that is REMOVED still FAILS', () => {
  const pasted = [
    SITE('backend/src/scm/lib/so-variant-check.ts', 56, CALL),
    SITE('frontend/src/mobile/MobileNewSO.tsx', 1768, CALL),
  ].join('\n');
  const afterMerge = SITE('backend/src/scm/lib/so-variant-check.ts', 92, CALL);

  const d = diffOutput(pasted, afterMerge);
  assert.equal(d.ok, false);
  assert.deepEqual(d.missing, [SITE('frontend/src/mobile/MobileNewSO.tsx', 1768, CALL)]);
});

test('the PATH is kept, so a site that moved to a DIFFERENT FILE still FAILS', () => {
  const d = diffOutput(
    SITE('frontend/src/mobile/MobileNewSO.tsx', 1768, CALL),
    SITE('frontend/src/pages/scm-v2/SalesOrderDetail.tsx', 1768, CALL),
  );
  assert.equal(d.ok, false, 'only movement WITHIN a file is forgiven');
});

test('two sites in ONE file are still counted, so losing one of them FAILS', () => {
  // Identical text, same file, different lines: after stripping the coordinate
  // they collapse to the same key, and only the MULTISET count keeps them apart.
  const pasted = [
    SITE('frontend/src/mobile/MobileNewSO.tsx', 1768, CALL),
    SITE('frontend/src/mobile/MobileNewSO.tsx', 2992, CALL),
  ].join('\n');
  assert.equal(diffOutput(pasted, pasted).ok, true);
  assert.equal(
    diffOutput(pasted, SITE('frontend/src/mobile/MobileNewSO.tsx', 1768, CALL)).ok,
    false,
    'dropping one of two same-file sites must fail',
  );
});

test('a `grep -c` COUNT is never mistaken for a coordinate — there the number IS the claim', () => {
  // `path:12` has no trailing colon, so it is not a `path:NNN:` coordinate.
  assert.equal(stripLineNumber('backend/src/scm/routes/mfg-sales-orders.ts:12'),
    'backend/src/scm/routes/mfg-sales-orders.ts:12');
  assert.equal(
    diffOutput('backend/src/a.ts:12', 'backend/src/a.ts:13').ok,
    false,
    'a changed count is a changed population',
  );
});

test('stripLineNumber drops the coordinate and nothing else', () => {
  assert.equal(stripLineNumber('a/b.ts:56:  foo()'), 'a/b.ts:  foo()');
  // A colon INSIDE the matched code is content, not a coordinate.
  assert.equal(stripLineNumber('a/b.ts:56:  const x = { a: 1 }'), 'a/b.ts:  const x = { a: 1 }');
  // No number, no strip.
  assert.equal(stripLineNumber('a/b.ts:  foo()'), 'a/b.ts:  foo()');
  // A bare leading number has no path in front of it and is left alone.
  assert.equal(stripLineNumber('56:  foo()'), '56:  foo()');
});

test('a BARE `NNN:` coordinate still FAILS, but is diagnosed instead of being baffling', () => {
  // `grep -n pattern onefile` prints no path. A leading number with nothing in
  // front of it cannot be told apart from content, so the gate does NOT forgive
  // it — it explains it.
  const d = diffOutput('56:  foo()\n77:  foo()', '92:  foo()\n120:  foo()');
  assert.equal(d.ok, false, 'the gate must not silently forgive a bare number');
  assert.equal(d.coordinatesOnly, true, 'but it must say that is all that differs');
});

test('coordinatesOnly stays FALSE when the population really changed', () => {
  const d = diffOutput('56:  foo()', '92:  foo()\n120:  bar()');
  assert.equal(d.ok, false);
  assert.equal(d.coordinatesOnly, false, 'a real change must never be reported as a coordinate shift');
});

test('the whole gate passes a moved enumeration end to end, and fails an added one', () => {
  const claim = 'itemCode threaded through every desktop + mobile call site.';
  const block = (list) => `${claim}\n\n\`\`\`enumeration\n$ git grep -n "missingVariantAxes(" -- backend/src frontend/src\n${list}\n\`\`\``;
  const pasted = [
    SITE('backend/src/scm/lib/so-variant-check.ts', 56, CALL),
    SITE('frontend/src/mobile/MobileNewSO.tsx', 1768, CALL),
  ].join('\n');
  const moved = [
    SITE('backend/src/scm/lib/so-variant-check.ts', 92, CALL),
    SITE('frontend/src/mobile/MobileNewSO.tsx', 2044, CALL),
  ].join('\n');

  const ok = evaluate({ title: '', body: block(pasted), labels: [], exec: stubExec(moved) });
  assert.equal(ok.verdict, VERDICT.PASS);
  assert.equal(ok.reason, REASON.VERIFIED);

  const grew = evaluate({
    title: '',
    body: block(pasted),
    labels: [],
    exec: stubExec(`${moved}\n${SITE('frontend/src/pages/scm-v2/SalesOrderDetail.tsx', 601, CALL)}`),
  });
  assert.equal(grew.verdict, VERDICT.FAIL);
  assert.equal(grew.reason, REASON.OUTPUT_MISMATCH);
});

test('an empty population is a legitimate enumeration', () => {
  const body = 'Removed the pattern from every call site.\n\n```enumeration\n$ grep -rn gone backend/src\n```';
  const r = evaluate({ title: '', body, labels: [], exec: stubExec('') });
  assert.equal(r.verdict, VERDICT.PASS);
  assert.equal(r.blocks[0].diff.actualCount, 0);
});

test('a refused command reports WHY, and never reaches exec', () => {
  const body = 'Fixed every caller.\n\n```enumeration\n$ curl https://evil.example\n```';
  const r = evaluate({ title: '', body, labels: [], exec: never });
  assert.equal(r.reason, REASON.COMMAND_REFUSED);
  assert.match(r.blocks[0].detail, /not allowed as the first stage/);
});

test('a command that errors out is a failure, not a silent pass', () => {
  const body = 'Fixed every caller.\n\n```enumeration\n$ grep -rn "[" backend/src\nx\n```';
  const r = evaluate({ title: '', body, labels: [], exec: () => ({ ok: false, error: 'unbalanced [' }) });
  assert.equal(r.verdict, VERDICT.FAIL);
  assert.equal(r.reason, REASON.COMMAND_FAILED);
});

test('proseLines keeps real line numbers so the report can point at the wording', () => {
  const kept = proseLines('one\n```\nfenced\n```\nfour claims every caller');
  assert.deepEqual(kept.map((k) => k.line), [1, 5]);
});

// ===========================================================================
// 7. THE REAL SPAWN PATH.
//
// The sandbox is the one part that must NOT be tested against a stub: a stub
// would happily "prove" isolation that the real spawn does not have. These run
// the actual executor against this actual checkout.
// ===========================================================================

test('the sandbox really does deny child_process to a node one-liner', () => {
  const r = makeExec(repoRoot)([['node', '-e', "require('child_process').execSync('id')"]]);
  assert.equal(r.ok, false);
  assert.match(r.error, /Access to this API has been restricted/);
});

test('the sandbox really does deny reading outside the repo', () => {
  const r = makeExec(repoRoot)([['node', '-p', "require('fs').readFileSync('/etc/hosts','utf8')"]]);
  assert.equal(r.ok, false);
  assert.match(r.error, /Access to this API has been restricted|ERR_ACCESS_DENIED/);
});

test('the child sees no secrets: the parent environment does not reach it', () => {
  // Asserted by BEHAVIOUR, not by an exact key list: macOS injects
  // __CF_USER_TEXT_ENCODING into every process on its own, so an allowlist of
  // key names would be a test about the operating system rather than about
  // this gate. What matters is that a variable the runner holds — GITHUB_TOKEN
  // in CI — is not visible to a command written by a PR author.
  process.env.HOUZS_FAKE_SECRET = 'must-not-leak';
  try {
    const r = makeExec(repoRoot)([['node', '-p', 'String(process.env.HOUZS_FAKE_SECRET)']]);
    assert.equal(r.ok, true, r.error);
    assert.equal(r.stdout.trim(), 'undefined');
  } finally {
    delete process.env.HOUZS_FAKE_SECRET;
  }
});

test('a CRASHED node one-liner is a failure, not an empty population', () => {
  // node exits 1 when it throws, exactly like grep exits 1 for "no matches".
  // Conflating the two would let a PR claiming "gone from every call site"
  // go green on a command that never ran — this gate's own failure mode.
  const r = makeExec(repoRoot)([['node', '-e', 'throw new Error("boom")']]);
  assert.equal(r.ok, false);
  assert.match(r.error, /exited 1/);
});

test('...but grep finding nothing IS an empty population, and succeeds', () => {
  // Assembled at runtime so the token cannot match this file itself.
  const absent = ['zzz', 'no', 'such', 'token'].join('-') + '-zzz';
  const r = makeExec(repoRoot)([['grep', '-rn', absent, 'scripts']]);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.stdout.trim(), '');
});

test('the pipeline is really wired stage to stage', () => {
  const r = makeExec(repoRoot)([['git', 'grep', '-l', 'completeness'], ['wc', '-l']]);
  assert.equal(r.ok, true, r.error);
  assert.ok(Number(r.stdout.trim()) > 0);
});

test('an unknown program reports something an author can act on', () => {
  const r = makeExec(repoRoot)([['definitely-not-a-real-binary-xyz']]);
  assert.equal(r.ok, false);
  assert.match(r.error, /not installed on this runner/);
});
