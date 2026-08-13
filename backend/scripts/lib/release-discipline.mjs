// ---------------------------------------------------------------------------
// release-discipline.mjs — the analysers behind `npm run audit:release-discipline`.
//
// NO SHEBANG, ON PURPOSE. backend/tests/releaseDiscipline.node.mjs imports this
// module, and a `#!` in an imported .mjs is a load-time SyntaxError on Windows
// vitest (CLAUDE.md, "Anything a TEST imports lives in backend/scripts/lib/").
//
// Everything here is PURE: text in, findings out. No filesystem, no database,
// no process.exit. The runner does the I/O and owns the verdict.
// ---------------------------------------------------------------------------

/**
 * Strip JavaScript comments and REGEX BODIES, leaving strings and template
 * literals intact. Every write-detection rule below runs on the stripped text.
 *
 * Comments go because most of these scripts explain in their header the exact
 * damage they repair, `DELETE FROM` and all. Regex bodies go because a pattern
 * is a matcher, not a statement: check-indexes.mjs COUNTS `/CREATE INDEX/gi` in
 * a dump file and executes nothing.
 *
 * Newlines are preserved so offsets still map to sensible line numbers.
 */
export function stripJsComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let quote = '';
  let state = 'code';
  // Last significant character emitted, used to tell `/` division from a regex
  // literal. `a / b` cannot follow one of these; `/re/` can.
  let prev = '';
  const REGEX_CAN_FOLLOW = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^', '\n']);
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (state === 'code') {
      if (c === '/' && d === '/') { state = 'line'; i += 2; continue; }
      if (c === '/' && d === '*') { state = 'block'; i += 2; continue; }
      if (c === '/' && REGEX_CAN_FOLLOW.has(prev)) { state = 'regex'; out += c; i++; continue; }
      if (c === '"' || c === "'" || c === '`') { state = 'str'; quote = c; out += c; i++; continue; }
      out += c;
      if (!/\s/.test(c) || c === '\n') prev = c;
      i++;
      continue;
    }
    if (state === 'line') { if (c === '\n') { state = 'code'; out += c; prev = '\n'; } i++; continue; }
    if (state === 'block') {
      if (c === '*' && d === '/') { state = 'code'; i += 2; continue; }
      if (c === '\n') out += c;
      i++;
      continue;
    }
    if (state === 'regex') {
      // A newline cannot appear in a regex literal: if one shows up we guessed
      // wrong about `/` and this is division. Bail back to code rather than
      // swallowing the rest of the file.
      if (c === '\n') { state = 'code'; out += c; prev = '\n'; i++; continue; }
      if (c === '\\') { i += 2; continue; }
      if (c === '[') { state = 'regexClass'; i++; continue; }
      if (c === '/') { state = 'code'; out += c; prev = '/'; i++; continue; }
      i++; continue;
    }
    if (state === 'regexClass') {
      if (c === '\\') { i += 2; continue; }
      if (c === ']') { state = 'regex'; i++; continue; }
      if (c === '\n') { state = 'code'; out += c; prev = '\n'; i++; continue; }
      i++; continue;
    }
    // state === 'str'
    if (c === '\\') { out += c + (d ?? ''); i += 2; continue; }
    if (c === quote) { state = 'code'; out += c; prev = quote; i++; continue; }
    out += c; i++;
  }
  return out;
}

/**
 * The leading comment block of a file — shebang and blank lines skipped, stops
 * at the first line of real code. This is what "stated in its header" means.
 */
export function headerComment(src) {
  const lines = src.split('\n');
  const kept = [];
  let inBlock = false;
  for (const line of lines) {
    const t = line.trim();
    if (!inBlock) {
      if (t.startsWith('#!') || t === '') { kept.push(line); continue; }
      if (t.startsWith('//')) { kept.push(line); continue; }
      if (t.startsWith('/*')) {
        kept.push(line);
        inBlock = !/\*\//.test(t.slice(2));
        continue;
      }
      break;
    }
    kept.push(line);
    if (t.includes('*/')) inBlock = false;
  }
  return kept.join('\n');
}

// ── Does this script write? ────────────────────────────────────────────────
// Two signals, both on the comment-stripped source:
//   1. a SQL write statement in a string or template literal;
//   2. a PostgREST chain `.from('t')….update(…)` — the shape backend/scripts/
//      lib/pgrest-shim.mjs gives scripts that import a real service function.
// A bare `.delete(` / `.update(` is NOT a signal: `map.delete(k)` and
// `crypto.createHash('md5').update(s)` are both live in this tree.
//
// Each verb is anchored to a STATEMENT position — the start of a string or
// template literal, a newline, or after `;`. Prose in a log line is not a
// write: check-indexes.mjs prints "Dump CREATE INDEX statements: 41" and
// executes nothing but two `count(*)`s.
const STATEMENT_START = String.raw`(?:^|[\n;\`'"({}\[,=]\s*)`;
const verb = (body, name) => [new RegExp(STATEMENT_START + body, 'i'), name];
const SQL_WRITE = [
  verb(String.raw`INSERT\s+INTO\b`, 'INSERT INTO'),
  // The table name is very often INTERPOLATED here — `UPDATE ${arm.t} SET`,
  // `UPDATE scm.${t.table} SET` — because one repair sweeps fifteen document
  // arms. A pattern that only accepts a literal identifier misses the two
  // scripts this whole check was written for.
  verb(String.raw`UPDATE\s+(?:\$\{[^{}]*\}|[\w."])+\s+SET\b`, 'UPDATE … SET'),
  verb(String.raw`DELETE\s+FROM\b`, 'DELETE FROM'),
  verb(String.raw`TRUNCATE\b`, 'TRUNCATE'),
  verb(String.raw`ALTER\s+(?:TABLE|VIEW|SEQUENCE)\b`, 'ALTER'),
  verb(String.raw`DROP\s+(?:TABLE|VIEW|INDEX|COLUMN|SCHEMA)\b`, 'DROP'),
  verb(String.raw`CREATE\s+(?:OR\s+REPLACE\s+)?(?:TABLE|VIEW|INDEX|SCHEMA)\b`, 'CREATE'),
  verb(String.raw`GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE|ALL|USAGE)\b`, 'GRANT'),
  verb(String.raw`REVOKE\b`, 'REVOKE'),
];
const PGREST_WRITE = /\.from\s*\(\s*['"`][^'"`]+['"`]\s*\)[\s\S]{0,300}?\.(insert|update|upsert|delete)\s*\(/;

/** A live database connection — the thing that makes a write reach production. */
const OPENS_DB = /from\s*['"]postgres['"]|pgrestShim|pgrest-shim\.mjs/;

function writeEvidence(code) {
  const found = SQL_WRITE.filter(([re]) => re.test(code)).map(([, name]) => name);
  const rest = PGREST_WRITE.exec(code);
  if (rest) found.push(`postgrest .${rest[1]}()`);
  return found;
}

/** Offset of the first write indicator, or -1. Used to place the verification. */
function firstWriteOffset(code) {
  let best = -1;
  for (const [re] of SQL_WRITE) {
    const m = re.exec(code);
    if (m && (best === -1 || m.index < best)) best = m.index;
  }
  const rest = PGREST_WRITE.exec(code);
  if (rest && (best === -1 || rest.index < best)) best = rest.index;
  return best;
}

/**
 * Every top-level `function f`, `const f = …` in a file, sliced from one
 * declaration to the next. The verification block almost always calls helpers
 * declared ABOVE the write — `damaged(v, t)`, `census(v, t)`, `arrayShapeCheck`
 * — so reading only the text after the fresh connection would judge the two
 * scripts this check was written for as asserting nothing.
 */
function topLevelSlices(code) {
  const re = /^(?:export\s+)?(?:async\s+)?(?:function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=)/gm;
  const marks = [];
  let m;
  while ((m = re.exec(code))) marks.push({ name: m[1] || m[2], at: m.index });
  const slices = new Map();
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1].at : code.length;
    slices.set(marks[i].name, code.slice(marks[i].at, end));
  }
  return slices;
}

/** The region's own text plus the bodies of the helpers it calls, one hop. */
function expandCalls(region, ...slicePools) {
  let text = region;
  for (const call of new Set([...region.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]))) {
    for (const pool of slicePools) {
      const body = pool.get(call);
      if (body) { text += `\n${body}`; break; }
    }
  }
  return text;
}

/**
 * Named exports of a scripts/lib module, sliced from one `export` to the next.
 * Whole-file matching is too blunt here: lib/fabric-write.mjs exports both
 * `repointColour` (writes) and `countColour` (reads), and a census script that
 * imports only the second is not a writer.
 *
 * lib/pgrest-shim.mjs is deliberately NOT indexed — it is a client FACTORY, so
 * its body contains every PostgREST verb. Whether an importer writes is decided
 * at the importer's own call site by PGREST_WRITE.
 */
export function indexLibExports(libFiles) {
  const index = new Map();
  for (const [name, source] of libFiles) {
    if (name === 'pgrest-shim.mjs') continue;
    const code = stripJsComments(source);
    const re = /^export\s+(?:async\s+)?(?:function\s+(\w+)|const\s+(\w+)|class\s+(\w+))/gm;
    const marks = [];
    let m;
    while ((m = re.exec(code))) marks.push({ name: m[1] || m[2] || m[3], at: m.index });
    const slices = new Map();
    for (let i = 0; i < marks.length; i++) {
      const end = i + 1 < marks.length ? marks[i + 1].at : code.length;
      slices.set(marks[i].name, code.slice(marks[i].at, end));
    }
    index.set(name, slices);
  }
  return index;
}

// ── The four requirements ──────────────────────────────────────────────────
// Each is a rule id, a human sentence, and the forms accepted. The forms are
// deliberately narrow and listed here rather than inferred: a gate whose
// accepted shapes are a mystery gets worked around instead of followed.

/**
 * MODE unset must mean PLAN. `(process.env.MODE || 'plan')` and
 * `(process.env.MODE || 'dry-run')` are both in this tree and both correct;
 * what is NOT correct is a default of 'apply', so the default is captured and
 * inspected rather than matched against one blessed spelling.
 */
const MODE_DEFAULT = /process\.env\.MODE\s*(?:\|\||\?\?)\s*['"]([^'"]*)['"]/;
const APPLY_GATE_FORMS = [
  /process\.env\.APPLY\s*===\s*['"][^'"]+['"]/,                  // process.env.APPLY === '1'
  /process\.env\.WRITE\s*===\s*['"][^'"]+['"]/,
  /process\.env\.EXECUTE\s*===\s*['"][^'"]+['"]/,
  /\bBoolean\s*\(\s*process\.env\.(APPLY|WRITE|EXECUTE)\s*\)/,
  /!!\s*process\.env\.(APPLY|WRITE|EXECUTE)\b/,
  /(?:argv|args)[\s\S]{0,40}?includes\s*\(\s*['"]--apply['"]\s*\)/,
];
/** The inverse: a switch you must SET to stay safe. Unset then writes. */
const INVERTED_GATE = /process\.env\.(DRY|DRY_RUN|PLAN|PLAN_ONLY|NO_APPLY|SAFE)\b/;

function hasApplyGate(code) {
  const mode = MODE_DEFAULT.exec(code);
  if (mode && mode[1].trim().toLowerCase() !== 'apply') return true;
  return APPLY_GATE_FORMS.some((re) => re.test(code));
}

/** A phrase long enough to be typed on purpose, not `CONFIRM=1`. */
const CONFIRM_MIN_PHRASE = 8;
// `CONFIRM_DOC` is also a CONFIRM: delete-test-so.mjs makes you repeat the
// doc_no, which is stronger than a fixed phrase because it cannot be copied
// from another script's docs.
const CONFIRM_ENV = String.raw`process\.env\.CONFIRM\w*`;
const CONFIRM_READ = String.raw`(?:\(\s*)?${CONFIRM_ENV}(?:\s*\?\?\s*["'\`][^"'\`]*["'\`]\s*\))?(?:\s*\??\.\s*trim\s*\(\s*\))?`;
const OPERAND = String.raw`(?:['"\`]([^'"\`]*)['"\`]|([A-Za-z_$][\w$]*))`;
const CONFIRM_CMP = new RegExp(
  `${CONFIRM_READ}\\s*[!=]==?\\s*${OPERAND}|${OPERAND}\\s*[!=]==?\\s*${CONFIRM_READ}`,
);
/** A local `const X = process.env.CONFIRM…` is the same read, one hop away. */
const CONFIRM_ALIAS = new RegExp(String.raw`\b(?:const|let|var)\s+(\w+)\s*=[^;\n]*${CONFIRM_ENV}`, 'g');

/**
 * What CONFIRM is compared against, and where.
 *   { kind: 'literal', value, at }  — a fixed phrase; the caller checks its length.
 *   { kind: 'runtime', name, at }   — a value supplied at run time (a doc number),
 *                                     a stronger confirmation, not a weaker one.
 *   null                            — CONFIRM is read and never compared to anything.
 */
function confirmComparand(code) {
  const aliases = new Set();
  for (const m of code.matchAll(CONFIRM_ALIAS)) aliases.add(m[1]);
  const patterns = [CONFIRM_CMP];
  for (const a of aliases) {
    patterns.push(new RegExp(`\\b${a}\\b\\s*[!=]==?\\s*${OPERAND}|${OPERAND}\\s*[!=]==?\\s*\\b${a}\\b`));
  }
  for (const re of patterns) {
    const m = re.exec(code);
    if (!m) continue;
    const literal = m[1] ?? m[3];
    if (literal !== undefined) return { kind: 'literal', value: literal, at: m.index };
    const ident = m[2] ?? m[4];
    if (!ident || aliases.has(ident)) continue;
    const decl = new RegExp(`\\b(?:const|let|var)\\s+${ident}\\s*=\\s*['"\`]([^'"\`]*)['"\`]\\s*;`).exec(code);
    return decl
      ? { kind: 'literal', value: decl[1], at: m.index }
      : { kind: 'runtime', name: ident, at: m.index };
  }
  return null;
}

/**
 * What separates a verification from a receipt: the re-read has to look at the
 * VALUE. On 2026-08-13 a repair of the jsonb double-encoding COE re-encoded 7
 * production rows, and its row count reported 7 of 7 — only the shape check saw
 * it. So a fresh connection whose only question is "how many?" does not pass.
 *
 * Two ways to pass, because both are real here:
 *   a type/shape predicate anywhere in the verification (`jsonb_typeof(...) IN
 *   ('array','string')` is a COUNT query and it is the strongest check in the
 *   tree), or a re-read that selects VALUES rather than only aggregates
 *   (`WHERE processing_date <> (proceeded_at AT TIME ZONE 'UTC')::date`).
 */
const SHAPE_ASSERTION = /jsonb_typeof|json_typeof|pg_typeof|jsonb_array_length|jsonb_object_keys|\bArray\.isArray\s*\(|\bJSON\.stringify\s*\(|\btypeof\s|\w*[Ss]hape\w*\s*[({]/;

/** Does every re-read in this region ask only for aggregate counts? */
function readsOnlyCounts(region) {
  const selects = [...region.matchAll(/\bSELECT\b([\s\S]*?)\bFROM\b/gi)].map((m) => m[1]);
  if (selects.length === 0) return false;
  return selects.every((list) => list
    .replace(/\bcount\s*\(([^()]|\([^()]*\))*\)/gi, ' ')
    .replace(/\bFILTER\s*\(([^()]|\([^()]*\))*\)/gi, ' ')
    .replace(/\bAS\s+\w+/gi, ' ')
    .replace(/::\s*\w+/g, ' ')
    .replace(/[\s,]/g, '') === '');
}

/**
 * `RE-RUN: …` in the header — the convention BUG-HISTORY set on 2026-08-13,
 * after four repair scripts were found whose SECOND run destroyed what their
 * first run created. That entry claimed every writing script already carried
 * one; 67 of 162 did not, which is exactly what a rule with no check is worth.
 *
 * The marker has to be followed by real prose. `unify-processing-date.mjs`
 * spells it as a section heading rather than a one-liner and that is fine; an
 * empty `RE-RUN:` is not.
 */
const RERUN_MARKER = /\bRE-?RUN\b/i;
// "RE-RUN: inert. The documents it removes are gone." is 39 characters of
// answer and is a complete one. "RE-RUN: yes" is not an answer.
const RERUN_MIN_PROSE = 25;

export const SCRIPT_RULES = [
  {
    id: 'mode-gate',
    what: 'a MODE / APPLY gate whose DEFAULT is plan',
    fix: "add `const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';` — copy repair-array-shaped-variants.mjs",
  },
  {
    id: 'confirm-phrase',
    what: 'a CONFIRM phrase on the apply path',
    fix: 'require CONFIRM to equal a spelled-out phrase before writing, and exit 2 when it does not',
  },
  {
    id: 'fresh-verify',
    what: 'a verification that re-reads on a FRESH connection and asserts the SHAPE',
    fix: 'open a SECOND client after the write and assert what the values now ARE — a row count is not a shape',
  },
  {
    id: 'rerun-note',
    what: 'a stated re-run behaviour in the header',
    fix: 'add a header line `RE-RUN: <what a second run does>`',
  },
];

/**
 * Analyse one backend/scripts/*.mjs file.
 *
 * @returns {{inScope: boolean, writes: boolean, evidence: string[], failed: string[], detail: Object<string,string>}}
 */
export function scanScript({ name, source, libExports = new Map() }) {
  const code = stripJsComments(source);
  const header = headerComment(source);

  const inScope = OPENS_DB.test(code);
  if (!inScope) return { name, inScope: false, writes: false, evidence: [], failed: [], detail: {} };

  const evidence = writeEvidence(code);
  const imported = new Map();
  for (const m of code.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]\.\/lib\/([\w.-]+\.mjs)['"]/g)) {
    const slices = libExports.get(m[2]);
    if (!slices) continue;
    for (const raw of m[1].split(',')) {
      const local = raw.trim().split(/\s+as\s+/)[0].trim();
      const body = slices.get(local);
      if (!body) continue;
      imported.set(local, body);
      if (writeEvidence(body).length) evidence.push(`lib/${m[2]}:${local}()`);
    }
  }
  if (evidence.length === 0) return { name, inScope: true, writes: false, evidence: [], failed: [], detail: {} };

  const failed = [];
  const detail = {};
  const locals = topLevelSlices(code);

  // 1. MODE / APPLY gate, plan by default.
  if (!hasApplyGate(code)) {
    failed.push('mode-gate');
    detail['mode-gate'] = INVERTED_GATE.test(code)
      ? 'the only switch found is an opt-OUT (DRY/PLAN style): unset, this script WRITES'
      : 'no MODE/APPLY gate found — this script writes on a bare run';
  }

  // 2. CONFIRM phrase, refused loudly.
  const confirmAt = code.search(new RegExp(CONFIRM_ENV));
  let confirmOk = false;
  if (confirmAt === -1) {
    detail['confirm-phrase'] = 'no CONFIRM phrase guards the apply path';
  } else {
    const against = confirmComparand(code);
    const strong = against !== null && (against.kind === 'runtime' || against.value.length >= CONFIRM_MIN_PHRASE);
    // The refusal has to be at the COMPARISON, not merely somewhere in the
    // file: a script that reads CONFIRM and logs about it still writes. The
    // exit is often one hop away in a local `refuse()` helper.
    const refuses = against !== null
      && /process\.exit\s*\(|throw\s/.test(expandCalls(code.slice(against.at, against.at + 600), locals, imported));
    confirmOk = strong && refuses;
    if (!confirmOk) {
      detail['confirm-phrase'] = against === null
        ? 'CONFIRM is read but never compared to a phrase'
        : !strong
          ? `CONFIRM is compared to "${against.value}", shorter than ${CONFIRM_MIN_PHRASE} characters — a phrase has to be typed on purpose`
          : 'CONFIRM is read but nothing exits or throws when it does not match';
    }
  }
  if (!confirmOk) failed.push('confirm-phrase');

  // 3. Fresh-connection re-read, asserting the SHAPE.
  const clients = [...code.matchAll(/\bpostgres\s*\(/g)].map((m) => m.index);
  const writeAt = firstWriteOffset(code);
  const verifyAt = clients.filter((at) => writeAt === -1 || at > writeAt).pop();
  if (clients.length < 2 || verifyAt === undefined) {
    failed.push('fresh-verify');
    detail['fresh-verify'] = clients.length < 2
      ? 'only one database connection is opened — the session that wrote is the worst witness that the write landed'
      : 'every connection is opened before the write; nothing re-reads on a fresh one';
  } else {
    const region = expandCalls(code.slice(verifyAt), locals, imported);
    if (!/\bSELECT\b/i.test(region)) {
      failed.push('fresh-verify');
      detail['fresh-verify'] = 'a fresh connection is opened after the write and nothing is read back on it';
    } else if (!SHAPE_ASSERTION.test(region) && readsOnlyCounts(region)) {
      failed.push('fresh-verify');
      detail['fresh-verify'] = 'the fresh-connection re-read asks only for a COUNT and nothing about the value — the double-encoding repair counted 7 of 7 while re-corrupting all 7';
    }
  }

  // 4. Re-run behaviour, in the header.
  const markerAt = header.search(RERUN_MARKER);
  const prose = markerAt === -1 ? '' : header.slice(markerAt + 6).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  if (markerAt === -1 || prose.length < RERUN_MIN_PROSE) {
    failed.push('rerun-note');
    detail['rerun-note'] = markerAt === -1
      ? 'the header does not say what a SECOND run does'
      : 'the RE-RUN marker is in the header but nothing follows it';
  }

  return { name, inScope: true, writes: true, evidence, failed, detail };
}

// ── Migrations ─────────────────────────────────────────────────────────────
// A migration is the one artefact here that cannot be rolled back by reverting
// a commit: pg-migrate applies a merged file to production on the next push to
// main and tracks it by FULL FILENAME, so the file is immutable from that
// moment. The reversal note is the only place the undo can live.
//
// 0189 is why the view clause exists. It did DROP VIEW -> DROP COLUMN -> CREATE
// VIEW to retire a column, which is correct SQL and lost the view's entire ACL,
// because a recreated view is a NEW object. Prod's Sales Order list then failed
// for every user with "permission denied for view
// mfg_sales_orders_with_payment_totals", and it took 0190 and 0191 to put back
// grants nobody had written down. A reversal note for 0189 could not have been
// written without answering "and what re-grants it?".

const REVERSAL_NOTE = /^\s*--\s*REVERSAL\s*[:\-–—]\s*(\S[^\n]*(?:\n\s*--\s{2,}[^\n]*)*)/im;
const VIEW_RECREATE = /\bDROP\s+VIEW\b/i;
const GRANT_WORDS = /grant|acl|privileg|owner/i;

export const MIGRATION_RULES = [
  {
    id: 'reversal-note',
    what: 'a `-- REVERSAL:` note saying how to undo it, or why it cannot be undone',
    fix: 'add `-- REVERSAL: <the statements that undo this, or IRREVERSIBLE — why>` to the header',
  },
  {
    id: 'reversal-note-grants',
    what: 'a reversal note that accounts for the GRANTS a recreated view loses',
    fix: 'DROP VIEW discards the ACL — say in the note which grants the reverse has to re-apply (see 0189/0190/0191)',
  },
];

/** @returns {{number: number|null, failed: string[], detail: Object<string,string>}} */
export function scanMigration({ name, source }) {
  const num = /^(\d+)/.exec(name);
  const number = num ? Number(num[1]) : null;
  const failed = [];
  const detail = {};

  const note = REVERSAL_NOTE.exec(source);
  if (!note || note[1].trim().length < 20) {
    failed.push('reversal-note');
    detail['reversal-note'] = note
      ? 'the REVERSAL note is present but says nothing'
      : 'no `-- REVERSAL:` note — this file is immutable the moment it reaches prod';
  } else if (VIEW_RECREATE.test(source) && !GRANT_WORDS.test(note[1])) {
    failed.push('reversal-note-grants');
    detail['reversal-note-grants'] = 'this migration drops a view, and the reversal note never mentions grants — that is exactly what 0189 missed';
  }

  return { name, number, failed, detail };
}

// ── The ratchet ────────────────────────────────────────────────────────────

/**
 * Reconcile the ledger against what the scan actually found. This is the half
 * of the ratchet that makes the list SHRINK — without it the ledger keeps its
 * original size forever and the count printed on every run stops meaning
 * anything.
 *
 * @returns {Array<{kind: string, name: string, rules?: string[]}>}
 *   'gone'      the entry names a file that is not there
 *   'not-writer' the entry names a script that no longer writes
 *   'empty'     the entry exempts nothing
 *   'unknown'   the entry names rule ids this gate does not have
 *   'fixed'     the script now PASSES rules it is still exempted from
 */
export function reconcileScriptLedger(scanned, exempt) {
  const known = new Set(SCRIPT_RULES.map((r) => r.id));
  const out = [];
  for (const [name, rules] of Object.entries(exempt)) {
    const s = scanned.find((x) => x.name === name);
    if (!s) { out.push({ kind: 'gone', name }); continue; }
    if (!s.writes) { out.push({ kind: 'not-writer', name }); continue; }
    if (rules.length === 0) { out.push({ kind: 'empty', name }); continue; }
    const unknown = rules.filter((r) => !known.has(r));
    // Reported alone: an unknown id is also "not currently failing", so letting
    // it fall through would print a confusing second complaint about the same row.
    if (unknown.length) { out.push({ kind: 'unknown', name, rules: unknown }); continue; }
    const fixed = rules.filter((r) => !s.failed.includes(r));
    if (fixed.length) out.push({ kind: 'fixed', name, rules: fixed });
  }
  return out;
}

/**
 * How far the migration floor should come down: the lowest number of the
 * CONTIGUOUS run of already-compliant migrations sitting directly beneath it.
 * Returns null when the file just below the floor does not comply — one
 * hand-written note deep in the tree is not a reason to move the boundary.
 */
export function floorShouldDropTo(migrations, floor) {
  const ok = new Set(migrations.filter((m) => m.number !== null && m.number < floor && m.failed.length === 0).map((m) => m.number));
  if (!ok.has(floor - 1)) return null;
  let n = floor - 1;
  while (ok.has(n)) n--;
  return n + 1;
}

/**
 * Compare two grandfather files. Growth in either dimension is the failure:
 * an entry that appeared, a rule that appeared on an existing entry, or a
 * migration floor that moved UP (which grandfathers migrations that were
 * previously required to comply).
 */
export function ratchetDiff(base, head) {
  const grew = [];
  const baseScripts = base.scripts ?? {};
  const headScripts = head.scripts ?? {};
  for (const [name, rules] of Object.entries(headScripts)) {
    const was = baseScripts[name];
    if (!was) { grew.push(`${name} — a NEW grandfather entry; the list may only shrink`); continue; }
    const added = rules.filter((r) => !was.includes(r));
    if (added.length) grew.push(`${name} — newly exempted from ${added.join(', ')}`);
  }
  const baseFloor = base.migrationReversalNoteRequiredFrom;
  const headFloor = head.migrationReversalNoteRequiredFrom;
  if (Number.isInteger(baseFloor) && Number.isInteger(headFloor) && headFloor > baseFloor) {
    grew.push(`migrationReversalNoteRequiredFrom moved UP ${baseFloor} -> ${headFloor}, exempting ${headFloor - baseFloor} more migration(s)`);
  }
  return grew;
}
