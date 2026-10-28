// The shape every answerable question must have, and the check that it does.
//
// WHY THIS EXISTS. The owner's complaint, in his words: *"现在有的问题就是每次
// 问的答案都不一样"* — the same question asked twice gives two answers. That is
// not a memory problem, it is a METHOD problem: the answer was re-derived by
// reading code, and reading is not repeatable. Two sweeps of this repo counted
// the same population as 632 and 1019; CLAUDE.md itself carried a required-check
// list that was wrong; `codebase-map-facts.md` sat stale for three weeks.
//
// So an answer here is not written down and it is not remembered. It is
// COMPUTED from the tree, every time, and it carries the two things that make it
// checkable by someone who does not trust it:
//
//   · a DENOMINATOR — what population the answer is over. "76 modules have no
//     guide" is unusable; "76 of 141" can be argued with.
//   · REFS — file:line, so the reader can go and look rather than believe.
//
// And it must REFUSE rather than answer from nothing. Three checkers in this
// repo have reported a clean run because their pattern stopped matching; the
// rule CLAUDE.md draws from that is "a verdict computed over nothing must never
// read as a pass". `minCorpus` is that rule, made mandatory rather than optional.

/**
 * @typedef {object} Answer
 * @property {string} value       one line, the answer itself
 * @property {number} corpus      the DENOMINATOR — how many things were examined
 * @property {string[]} refs      `path:line` or `path`, so the reader can check
 * @property {string[]} [detail]  optional extra lines, printed under the answer
 */

/**
 * @typedef {object} Question
 * @property {string} id          stable slug, used on the command line
 * @property {string} question    the question in plain words
 * @property {string} why         why this one is here — which wrong answer it replaces
 * @property {number} minCorpus   below this, the question REFUSES instead of answering
 * @property {(root: string) => Answer} answer
 */

/** Every field is required. A question missing one cannot be registered. */
export function validateQuestion(q) {
  const problems = [];
  for (const field of ['id', 'question', 'why']) {
    if (typeof q?.[field] !== 'string' || !q[field].trim()) problems.push(`${field} must be a non-empty string`);
  }
  if (!/^[a-z][a-z0-9-]*$/.test(q?.id ?? '')) problems.push('id must be lower-kebab-case');
  if (!Number.isInteger(q?.minCorpus) || q.minCorpus < 1) {
    problems.push('minCorpus must be an integer >= 1 — a question that can answer from nothing is not a question');
  }
  if (typeof q?.answer !== 'function') problems.push('answer must be a function');
  return problems;
}

/**
 * Run one question and enforce the contract on its RESULT, not just its shape.
 * Throws rather than returning a bad answer: the caller is a CLI and a gate, and
 * both of them must fail loudly rather than print something plausible.
 */
export function ask(q, root) {
  const a = q.answer(root);
  if (!a || typeof a.value !== 'string' || !a.value.trim()) {
    throw new Error(`${q.id}: answer() returned no value`);
  }
  if (!Number.isInteger(a.corpus)) {
    throw new Error(`${q.id}: answer() returned no corpus — an answer with no denominator cannot be checked`);
  }
  if (a.corpus < q.minCorpus) {
    throw new Error(
      `${q.id}: examined ${a.corpus} item(s), and this question declares it needs at least ${q.minCorpus}.\n` +
        `  REFUSING to answer. This is not "the answer is zero" — it is "the scan found almost nothing",\n` +
        `  which in this repo has three times meant a pattern stopped matching while the check stayed green.`,
    );
  }
  if (!Array.isArray(a.refs) || a.refs.length === 0) {
    throw new Error(`${q.id}: answer() returned no refs — an answer nobody can go and check is not usable here`);
  }
  return a;
}
