// The questions. Each one is here because it has been ANSWERED WRONG, or
// answered differently twice, and the wrong answer is named in `why`.
//
// Adding a question is cheap and is meant to be: when a question costs someone
// a re-read of the codebase, it belongs here rather than in their head.
//
// HARD RULE for anything added: the answer must be computed from files under the
// repo root, with no network and no git. Determinism is not a nicety — it is the
// property the owner asked for ("同一个问题问三次...同样的答案"), and
// scripts/explain.test.mjs asserts it by running every question three times and
// comparing bytes.

import fs from 'node:fs';
import path from 'node:path';

const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const exists = (root, rel) => fs.existsSync(path.join(root, rel));

/** Files directly in a directory, sorted — sorted so two runs agree. */
function filesIn(root, rel, ext) {
  const dir = path.join(root, rel);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((n) => n.endsWith(ext))
    .sort()
    .map((n) => `${rel}/${n}`);
}

/** Every file under a directory, recursively, sorted. */
function walk(root, rel, test) {
  const out = [];
  const stack = [rel];
  while (stack.length) {
    const cur = stack.pop();
    const abs = path.join(root, cur);
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const next = `${cur}/${e.name}`;
      if (e.isDirectory()) stack.push(next);
      else if (test(e.name)) out.push(next);
    }
  }
  return out.sort();
}

/** 1-based line number of the first line matching `re`, or null. */
function lineOf(text, re) {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) if (re.test(lines[i])) return i + 1;
  return null;
}

// ---------------------------------------------------------------------------

/** @type {import('./registry.mjs').Question[]} */
export const QUESTIONS = [
  {
    id: 'test-suites',
    question: 'How many test suites are there, where does each run, and is any collected by nobody?',
    why:
      'On 2026-08-14 seventeen suites ran under `node --test` and contributed NOTHING to the ' +
      'coverage report, so twelve tested modules read as untested. A suite collected by no ' +
      'project does not fail — it is absent, and CI reports fewer files and goes green.',
    minCorpus: 100,
    answer(root) {
      const suites = walk(root, 'backend/tests', (n) => /\.test\.(ts|mjs)$/.test(n))
        .concat(walk(root, 'backend/src', (n) => /\.test\.(ts|mjs)$/.test(n)));
      const src = read(root, 'backend/scripts/lib/classify-tests.mjs');
      const needsWorkers = /const NEEDS_WORKERS = (\/.+\/);/.exec(src)?.[1];
      const decl = /const PROJECT_DECL = (\/.+\/[a-z]*);/.exec(src)?.[1];

      let workers = 0;
      let declared = 0;
      const re = needsWorkers ? new RegExp(needsWorkers.slice(1, needsWorkers.lastIndexOf('/'))) : null;
      for (const rel of suites) {
        const body = read(root, rel);
        if (decl && /^[ \t]*\/\/[ \t]*@vitest-project[ \t]+(light|workers)\b/m.test(body)) declared += 1;
        else if (re && re.test(body)) workers += 1;
      }
      return {
        value: `${suites.length} suites: ~${suites.length - workers - declared} light, ~${workers} workers, ${declared} declaring their project explicitly.`,
        corpus: suites.length,
        refs: [
          `backend/scripts/lib/classify-tests.mjs:${lineOf(src, /export async function classifyTests/) ?? 1}`,
          'backend/scripts/audit-test-projects.mjs',
        ],
        detail: [
          'The authority is the gate, not this estimate: `npm --prefix backend run audit:test-projects`',
          'refuses if any suite on disk is claimed by neither project.',
        ],
      };
    },
  },

  {
    id: 'route-guides',
    question: 'How many route modules are named in no module guide?',
    why:
      'CLAUDE.md makes reading the module guide MANDATORY before working in a module. A module ' +
      'with no guide is the gap that rule points at, and the count has been quoted from memory ' +
      'rather than measured.',
    minCorpus: 50,
    answer(root) {
      const modules = filesIn(root, 'backend/src/scm/routes', '.ts')
        .concat(filesIn(root, 'backend/src/routes', '.ts'))
        .filter((p) => !/\.test\.ts$/.test(p));
      const guides = filesIn(root, 'docs/modules', '.md');
      const guideText = guides.map((g) => read(root, g)).join('\n');
      const missing = modules.filter((m) => !guideText.includes(path.basename(m)));
      return {
        value: `${missing.length} of ${modules.length} route modules are named in none of the ${guides.length} module guides.`,
        corpus: modules.length,
        refs: ['docs/modules/', 'backend/src/scm/routes/', 'backend/src/routes/'],
        detail: missing.length
          ? ['first ten with no guide:', ...missing.slice(0, 10).map((m) => `  ${m}`)]
          : [],
      };
    },
  },

  {
    id: 'so-statuses',
    question: 'What statuses can a Sales Order be in, and which backward moves are legal?',
    why:
      'The set was grepped out of pills, the allocator and the delivery sync three separate ' +
      'times. It has ONE definition; this reads that one.',
    minCorpus: 5,
    answer(root) {
      const rel = 'backend/src/scm/lib/so-lifecycle-guards.ts';
      const src = read(root, rel);
      const set = /SO_STATUSES = new Set\(\[([\s\S]*?)\]\)/.exec(src)?.[1] ?? '';
      const statuses = [...set.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
      const regressions = [...(/SO_LEGAL_REGRESSIONS = new Set\(\[([\s\S]*?)\]\)/.exec(src)?.[1] ?? '')
        .matchAll(/'([A-Z_]+>[A-Z_]+)'/g)].map((m) => m[1]);
      return {
        value: `${statuses.length} statuses: ${statuses.join(', ')}. ${regressions.length} backward moves are legal.`,
        corpus: statuses.length,
        refs: [
          `${rel}:${lineOf(src, /SO_STATUSES = new Set/) ?? 1}`,
          `${rel}:${lineOf(src, /SO_LEGAL_REGRESSIONS = new Set/) ?? 1}`,
        ],
        detail: [
          'legal regressions: ' + (regressions.join(', ') || '(none)'),
          'ON_HOLD is deliberately UNRANKED, and ON_HOLD -> DRAFT is refused — that pair was a',
          'laundry route to DRAFT, which is what unlocks DELETE.',
        ],
      };
    },
  },

  {
    id: 'migration-trees',
    question: 'Which migration directory reaches production, and how many files are in each?',
    why:
      'There are two trees and only one is real. A migration put in the other one ships, passes ' +
      'CI, merges — and production never changes. CLAUDE.md calls this out precisely because it ' +
      'has happened.',
    minCorpus: 2,
    answer(root) {
      const live = filesIn(root, 'backend/src/db/migrations-pg', '.sql');
      const dead = filesIn(root, 'backend/src/db/migrations', '.sql');
      const deployRel = '.github/workflows/deploy.yml';
      const deploy = exists(root, deployRel) ? read(root, deployRel) : '';
      const line = lineOf(deploy, /pg-migrate\.mjs/);
      return {
        value: `LIVE is backend/src/db/migrations-pg (${live.length} files). backend/src/db/migrations is the D1/test tree (${dead.length} files) and production never reads it.`,
        corpus: live.length + dead.length,
        refs: [line ? `${deployRel}:${line}` : deployRel, 'backend/src/db/migrations-pg/', 'backend/src/db/migrations/'],
        detail: [
          line
            ? `deploy.yml runs scripts/pg-migrate.mjs at line ${line} — that is what makes the -pg tree live.`
            : 'deploy.yml does not mention pg-migrate.mjs — CHECK THIS, the live tree may have moved.',
        ],
      };
    },
  },

  {
    id: 'file-size-debt',
    question: 'How many lines of file-size ceiling debt is the repo carrying?',
    why:
      'Two readings hours apart gave 14 files / 1,430 lines and then 13 / 1,391, and one file ' +
      'moved six times in a day. Any number typed into a doc is stale before it merges.',
    minCorpus: 10,
    answer(root) {
      const manifestRel = 'scripts/file-size-ceilings.json';
      const manifest = JSON.parse(read(root, manifestRel));
      const ceilings = manifest.ceilings ?? {};
      const countNL = (t) => { let n = 0; for (let i = 0; i < t.length; i += 1) if (t.charCodeAt(i) === 10) n += 1; return n; };
      let debt = 0;
      const over = [];
      for (const [rel, ceiling] of Object.entries(ceilings).sort()) {
        if (!exists(root, rel)) continue;
        const lines = countNL(read(root, rel));
        if (lines > ceiling) { debt += lines - ceiling; over.push(`${rel}: ${lines} vs ${ceiling} (+${lines - ceiling})`); }
      }
      return {
        value: `${debt} line(s) over ceiling across ${over.length} file(s), of ${Object.keys(ceilings).length} carrying a ceiling.`,
        corpus: Object.keys(ceilings).length,
        refs: [manifestRel, 'scripts/check-file-size.mjs'],
        detail: over.length ? ['worst five:', ...over.slice(0, 5).map((s) => `  ${s}`)] : [],
      };
    },
  },
];
