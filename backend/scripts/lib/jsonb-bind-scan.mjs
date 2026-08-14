// ---------------------------------------------------------------------------
// jsonb-bind-scan.mjs — the pure scanner behind `npm run audit:jsonb-binds`.
//
// Separated from the CLI so its logic can be unit-tested against fixture source
// strings (tests/jsonbBindScan.node.mjs) without touching the filesystem. The
// checker that guards a class must itself be proven, or it joins the class.
//
// THE RULE IT ENFORCES, and why it is total.
//
// postgres.js asks the SERVER for parameter types before it binds
// (connection.js:238 sets `describeFirst` whenever there are parameters and the
// statement is not prepared — which is every query in this repo, because every
// client is opened with `prepare: false`). When the server answers "that
// parameter is jsonb" (OID 3802), the driver runs its own JSON.stringify over
// the value (types.js:17-19, installed under every OID in `from`). A value that
// was ALREADY a string therefore gets encoded a second time and lands as a
// jsonb STRING rather than the object or array that was meant.
//
// A jsonb string is valid jsonb. Nothing errors. `variants->>'fabricId'`
// returns NULL, `jsonb_typeof` says "string", every Array.isArray() reader sees
// nothing, and the UPDATE still reports a rowcount — which is what let three
// production apply runs report "APPLIED - stamped 146 sofa lines" on 2026-08-10
// while they destroyed the column. See docs/jsonb-double-encoding-coe.md.
//
// So: a pre-serialized string may never be bound as a query parameter, in
// either of the two shapes this repo writes.
//
//   TAGGED TEMPLATE   sql`... ${JSON.stringify(x)} ...`     FLAGGED
//                     sql`... ${sql.json(x)} ...`           correct
//
//   .unsafe(text,[]) `... $2::jsonb ...`, [JSON.stringify(x)]      FLAGGED
//                    `... $2::text::jsonb ...`, [JSON.stringify(x)] allowed
//
// The `::text::jsonb` funnel is the one legal escape: `::text` makes the SERVER
// type that parameter as text, so the driver's json serializer never runs and
// the single explicit cast does the decoding exactly once.
//
// WHY THE RULE IS NOT "grep for ::jsonb". The 2026-08-13 sweep for this class
// keyed on the cast and missed `backfill-2990-delivered-dos.mjs`, which binds a
// stringified array straight into `scm.mfg_so_audit_log.field_changes` (jsonb
// NOT NULL) with NO cast anywhere — the column type alone is enough to trigger
// the driver. The parameter, not the cast, is the thing to look at.
// ---------------------------------------------------------------------------

/** Tags whose template literals are SQL in this repo. `sql`/`tx`/`pg` are the
 *  postgres.js handle names actually used; the rest are the aliases that appear
 *  in scripts. A new alias only needs adding here. */
const SQL_TAGS = ['sql', 'tx', 'pg', 'client', 'conn', 'db', 'trx', 'dst', 'src'];

const STRINGIFY = 'JSON.stringify(';

/** Walk from `open` (index of an opening bracket) to its match, skipping over
 *  string and template literals so a bracket inside a string cannot confuse
 *  the count. Returns the index of the closing bracket, or -1. */
export function matchBracket(text, open) {
  const CLOSE = { '(': ')', '[': ']', '{': '}' };
  const want = CLOSE[text[open]];
  if (!want) return -1;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') { i++; continue; }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i++;
      for (; i < text.length; i++) {
        if (text[i] === '\\') { i++; continue; }
        // A `${` inside a template literal can itself contain any bracket or
        // quote, so recurse through it rather than scanning naively.
        if (quote === '`' && text[i] === '$' && text[i + 1] === '{') {
          const end = matchBracket(text, i + 1);
          if (end === -1) return -1;
          i = end;
          continue;
        }
        if (text[i] === quote) break;
      }
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Split the top-level comma-separated elements of an argument/array span,
 *  returning `{ start, end, text }` per element. Brackets, strings and template
 *  literals are skipped, so `f(a, [b, c], "d,e")` yields three elements. */
export function splitTopLevel(text, open, close) {
  const parts = [];
  let start = open + 1;
  for (let i = open + 1; i < close; i++) {
    const ch = text[i];
    if (ch === '\\') { i++; continue; }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i++;
      for (; i < close; i++) {
        if (text[i] === '\\') { i++; continue; }
        if (quote === '`' && text[i] === '$' && text[i + 1] === '{') {
          const end = matchBracket(text, i + 1);
          if (end === -1) break;
          i = end;
          continue;
        }
        if (text[i] === quote) break;
      }
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      const end = matchBracket(text, i);
      if (end === -1) break;
      i = end;
      continue;
    }
    if (ch === ',') {
      parts.push({ start, end: i, text: text.slice(start, i) });
      start = i + 1;
    }
  }
  parts.push({ start, end: close, text: text.slice(start, close) });
  return parts;
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

/**
 * Blank out `//` and block comments, preserving every byte position and every
 * newline so reported line numbers still point at the real source.
 *
 * This matters more than it looks. The first run of this checker flagged
 * `backend/src/scm/lib/pg-supabase-transaction.ts` — the file the COE names as
 * having been given "careful comments" instead of a fix. Its code is correct
 * (`sql.json(...)`); what matched was the comment WARNING about the trap. A
 * checker that cannot tell a warning from a violation trains people to ignore
 * it, which is the failure mode this whole exercise is about.
 */
export function blankComments(text) {
  const out = text.split('');
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i++;
      while (i < text.length) {
        if (text[i] === '\\') { i += 2; continue; }
        if (quote === '`' && text[i] === '$' && text[i + 1] === '{') {
          // Interpolations can hold comments; let the outer loop handle them
          // by simply continuing past the `${`.
          i += 2;
          continue;
        }
        if (text[i] === quote) { i++; break; }
        i++;
      }
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') { out[i] = ' '; i++; }
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      for (; i < stop; i++) if (text[i] !== '\n') out[i] = ' ';
      continue;
    }
    i++;
  }
  return out.join('');
}

/**
 * Strip SQL comments (`-- to end of line`, `/* ... *\/`) from a query string.
 *
 * Required, and found by mutation-testing this very checker. The fix applied to
 * split-collapsed-sofa-lines.mjs carries a SQL comment explaining why the cast
 * reads `$2::text::jsonb`. Reverting the CODE to `$2::jsonb` left that comment
 * in place — and the funnel test below, run over the raw query text, matched
 * the comment and passed the file. The guard would have silently stopped
 * guarding the exact site it was written for, which is the failure this whole
 * change is about. A comment must never be able to satisfy a check.
 */
export function stripSqlComments(sqlText) {
  return sqlText
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ');
}

/** Does the SQL text funnel placeholder `$n` through ::text before any json
 *  cast? That is the one safe way to bind an already-serialized string. */
export function placeholderIsTextFunnelled(sqlText, n) {
  // `$2::text::jsonb`, `$2 :: text`, `$2::TEXT::json` — whitespace and case are
  // both legal in Postgres, and a following `::jsonb` is expected, not required
  // (the column may already be jsonb).
  const re = new RegExp(`\\$${n}\\s*::\\s*text\\b`, 'i');
  return re.test(stripSqlComments(sqlText));
}

/**
 * Scan one source file's text for pre-serialized values bound as parameters.
 * Pure: takes text, returns findings. `file` is only used for reporting.
 *
 * @returns {Array<{file:string, line:number, kind:'template'|'unsafe', snippet:string}>}
 */
export function scanSource(file, rawText) {
  const findings = [];
  // Comments are blanked position-for-position: a prose WARNING about this trap
  // must not read as an instance of it, and line numbers must stay true.
  const text = blankComments(rawText);

  // ---- shape 1: a stringified value interpolated into a SQL tagged template.
  const tagRe = new RegExp(`(^|[^\\w$.])(${SQL_TAGS.join('|')})\\s*\`` , 'g');
  let m;
  while ((m = tagRe.exec(text)) !== null) {
    const backtick = m.index + m[0].length - 1;
    // Walk the template body, visiting each ${...} interpolation.
    for (let i = backtick + 1; i < text.length; i++) {
      if (text[i] === '\\') { i++; continue; }
      if (text[i] === '`') break;               // end of this template
      if (text[i] === '$' && text[i + 1] === '{') {
        const end = matchBracket(text, i + 1);
        if (end === -1) break;
        const expr = text.slice(i + 2, end);
        if (expr.includes(STRINGIFY)) {
          // `${JSON.stringify(x)}::text::jsonb` is the explicit funnel and is
          // allowed, same as the .unsafe form below.
          const after = text.slice(end + 1, end + 24);
          if (!/^\s*::\s*text\b/i.test(after)) {
            findings.push({
              file,
              line: lineOf(text, i),
              kind: 'template',
              snippet: expr.trim().slice(0, 90),
            });
          }
        }
        i = end;
        continue;
      }
    }
    tagRe.lastIndex = backtick + 1;
  }

  // ---- shape 2: .unsafe(sqlText, [ ...params ]) with a stringified param.
  const unsafeRe = /\.unsafe\s*\(/g;
  while ((m = unsafeRe.exec(text)) !== null) {
    const open = m.index + m[0].length - 1;
    const close = matchBracket(text, open);
    if (close === -1) continue;
    const args = splitTopLevel(text, open, close);
    if (args.length < 2) { unsafeRe.lastIndex = open + 1; continue; }
    const sqlText = args[0].text;
    // The params argument is an array literal; if it is a variable we cannot
    // index it, so fall back to flagging any stringify inside it.
    const paramsSpan = args[1];
    const arrOpen = paramsSpan.text.indexOf('[');
    if (arrOpen !== -1) {
      const absOpen = paramsSpan.start + arrOpen;
      const absClose = matchBracket(text, absOpen);
      if (absClose !== -1) {
        const params = splitTopLevel(text, absOpen, absClose);
        params.forEach((p, idx) => {
          if (!p.text.includes(STRINGIFY)) return;
          if (placeholderIsTextFunnelled(sqlText, idx + 1)) return;
          findings.push({
            file,
            line: lineOf(text, p.start),
            kind: 'unsafe',
            snippet: `$${idx + 1} <- ${p.text.trim().slice(0, 80)}`,
          });
        });
      }
    } else if (paramsSpan.text.includes(STRINGIFY)) {
      findings.push({
        file,
        line: lineOf(text, paramsSpan.start),
        kind: 'unsafe',
        snippet: paramsSpan.text.trim().slice(0, 90),
      });
    }
    unsafeRe.lastIndex = open + 1;
  }

  return findings.sort((a, b) => a.line - b.line);
}
