/* The property the whole thing exists for: THE SAME QUESTION GIVES THE SAME
   ANSWER.

   Owner, 2026-08-14: *"我问你同一个问题问三次，你应该给出的都是同样的答案"*.
   That is not a wish about diligence, it is a testable property, so it is
   tested — every question, three runs, compared BYTE FOR BYTE.

   It is not automatic. A question that iterates a directory without sorting, or
   that stamps a date, or that reaches the network, answers differently on the
   second run and nobody notices until two people compare notes. The three-run
   assertion is what stops that shipping.

   The second property is the one this repo keeps paying for: a scan whose
   pattern stops matching must REFUSE, not report zero. Three checkers here have
   reported a clean run over an empty corpus. `minCorpus` makes that a hard error
   and this file proves the error fires. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { QUESTIONS } from './lib/explain/questions.mjs';
import { ask, validateQuestion } from './lib/explain/registry.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serialise = (a) => JSON.stringify({ value: a.value, corpus: a.corpus, refs: a.refs, detail: a.detail ?? [] });

test('there are questions, and every one is registerable', () => {
  assert.ok(QUESTIONS.length >= 5, `only ${QUESTIONS.length} question(s) — the registry is not loading`);
  for (const q of QUESTIONS) {
    assert.deepEqual(validateQuestion(q), [], `${q?.id ?? '(no id)'} is not registerable`);
  }
});

test('THREE runs of every question give a byte-identical answer', () => {
  for (const q of QUESTIONS) {
    const runs = [ask(q, ROOT), ask(q, ROOT), ask(q, ROOT)].map(serialise);
    assert.equal(runs[0], runs[1], `${q.id}: run 1 and run 2 disagree`);
    assert.equal(runs[1], runs[2], `${q.id}: run 2 and run 3 disagree`);
  }
});

test('every answer carries a denominator and refs — an unfalsifiable answer is refused', () => {
  for (const q of QUESTIONS) {
    const a = ask(q, ROOT);
    assert.ok(a.corpus >= q.minCorpus, `${q.id}: corpus ${a.corpus} under its own floor`);
    assert.ok(a.refs.length > 0, `${q.id}: no refs`);
    for (const r of a.refs) {
      assert.match(r, /^[\w./-]+(:\d+)?$/, `${q.id}: "${r}" is not a path or path:line`);
    }
  }
});

test('a question whose scan finds almost nothing REFUSES rather than answering', () => {
  const hollow = {
    id: 'hollow',
    question: 'q?',
    why: 'w',
    minCorpus: 10,
    answer: () => ({ value: '0 of 0 — all clear', corpus: 0, refs: ['x'] }),
  };
  assert.deepEqual(validateQuestion(hollow), []);
  assert.throws(() => ask(hollow, ROOT), /REFUSING to answer/,
    'a verdict computed over nothing must never read as a pass');
});

test('an answer with no denominator is refused even if it looks fine', () => {
  const noCorpus = { id: 'no-corpus', question: 'q?', why: 'w', minCorpus: 1, answer: () => ({ value: 'fine', refs: ['x'] }) };
  assert.throws(() => ask(noCorpus, ROOT), /no corpus/);
});

test('an answer with no refs is refused — nobody could check it', () => {
  const noRefs = { id: 'no-refs', question: 'q?', why: 'w', minCorpus: 1, answer: () => ({ value: 'fine', corpus: 99, refs: [] }) };
  assert.throws(() => ask(noRefs, ROOT), /no refs/);
});

/* The first bug this tool shipped, pinned. `--write` filled the EXAMPLE block
   inside docs/EXPLAIN.md's ``` fence, so the page that teaches you to write an
   empty block demonstrated a filled one. A doc has to be able to show the empty
   form. */
test('--write leaves a block inside a ``` fence alone', () => {
  const doc = fs.readFileSync(path.join(ROOT, 'docs/EXPLAIN.md'), 'utf8');
  const fenced = /```markdown\s*\n(<!--\s*explain:[\s\S]*?<!--\s*\/explain\s*-->)\s*\n```/.exec(doc);
  assert.ok(fenced, 'docs/EXPLAIN.md no longer shows a fenced example block — this guard is reading the wrong shape');
  assert.match(
    fenced[1].replace(/\r/g, ''),
    /^<!--\s*explain:[^>]*-->\n<!--\s*\/explain\s*-->$/,
    'the fenced example has been FILLED. --write must skip fenced regions:\n' + fenced[1],
  );
});

test('a question may not declare that it can answer from nothing', () => {
  for (const bad of [0, -1, null, undefined, 1.5]) {
    const q = { id: 'x', question: 'q?', why: 'w', minCorpus: bad, answer: () => ({}) };
    assert.ok(validateQuestion(q).some((p) => p.includes('minCorpus')), `minCorpus ${bad} should be rejected`);
  }
});
