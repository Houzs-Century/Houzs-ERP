// Splits a .sql migration file into individual statements for postgres.js
// `.unsafe()`, which executes exactly one statement per call.
//
// WHY THIS EXISTS AS ITS OWN MODULE: pg-migrate.mjs runs on EVERY production
// deploy, so a bug here blocks every deploy. Keeping the splitter pure and
// importable is what makes it unit-testable (see tests/splitSql.test.ts).
//
// The original splitter was `sql.split(/;\s*\n/)`. That is correct only for
// files made of flat statements. It shatters any dollar-quoted body, because
// a PL/pgSQL body contains `;\n` on nearly every line — which is the reason
// every stored function in this repo lived outside the migration tree in
// scripts/scm-schema/ and had to be applied by hand.
//
// This scanner knows the four contexts in which a `;` is NOT a statement
// terminator:
//   - dollar quotes, any tag: $$ ... $$, $func$ ... $func$, $body$ ... $body$
//   - single-quoted string literals
//   - double-quoted identifiers
//   - line (`--`) and block (`/* */`, nestable in Postgres) comments
//
// Split semantics are deliberately IDENTICAL to the old regex outside those
// contexts: a `;` followed only by whitespace up to a newline ends a
// statement, the `;` is dropped, and whole-line `--` comments are stripped.
// The one intentional difference is that whole-line comment stripping now
// skips lines that begin inside a quoted or dollar-quoted region, so a
// function body arrives byte-intact.

// Sticky so they can be matched at an offset without slicing the whole file.
// A dollar tag is `$`, an optional identifier, `$` — so `$1` (a bind
// placeholder) and a bare `$` deliberately do NOT match.
const DOLLAR_TAG = /\$([A-Za-z_][A-Za-z0-9_]*)?\$/y;
// Matches the old splitter's separator exactly: `;` + whitespace + newline.
const TERMINATOR = /;\s*\n/y;

function matchAt(re, s, at) {
  re.lastIndex = at;
  const m = re.exec(s);
  return m ? m[0] : null;
}

/**
 * @param {string} sql raw file contents
 * @returns {string[]} trimmed, non-empty statements in file order
 */
export function splitSqlStatements(sql) {
  /** @type {{ text: string, protectedLines: Set<number> }[]} */
  const chunks = [];
  let i = 0;
  let text = "";
  /** Line indexes (within the current chunk) that BEGIN inside a quoted or
   *  dollar-quoted region, and so must not have `--` lines stripped. */
  let protectedLines = new Set();
  let line = 0;

  /** @type {string | null} */
  let dollarTag = null;
  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  let blockDepth = 0;

  const pushChunk = () => {
    chunks.push({ text, protectedLines });
    text = "";
    protectedLines = new Set();
    line = 0;
  };

  // Consume n chars into the current chunk, tracking which lines start inside
  // a protected region.
  const take = (n) => {
    const slice = sql.slice(i, i + n);
    for (const ch of slice) {
      if (ch !== "\n") continue;
      line += 1;
      if (dollarTag || inSingle || inDouble || blockDepth > 0) {
        protectedLines.add(line);
      }
    }
    text += slice;
    i += n;
  };

  while (i < sql.length) {
    const c = sql[i];

    if (dollarTag) {
      if (c === "$" && sql.startsWith(dollarTag, i)) {
        text += dollarTag;
        i += dollarTag.length;
        dollarTag = null;
        continue;
      }
      take(1);
      continue;
    }

    if (inLineComment) {
      if (c === "\n") inLineComment = false;
      take(1);
      continue;
    }

    if (blockDepth > 0) {
      if (c === "/" && sql[i + 1] === "*") {
        blockDepth += 1;
        take(2);
        continue;
      }
      if (c === "*" && sql[i + 1] === "/") {
        blockDepth -= 1;
        take(2);
        continue;
      }
      take(1);
      continue;
    }

    if (inSingle) {
      // standard_conforming_strings is on in Postgres, so a backslash is an
      // ordinary character; '' is the escape for a literal quote and falls
      // out naturally — the closing quote immediately reopens.
      if (c === "'") inSingle = false;
      take(1);
      continue;
    }

    if (inDouble) {
      if (c === '"') inDouble = false;
      take(1);
      continue;
    }

    if (c === "'") {
      inSingle = true;
      take(1);
      continue;
    }
    if (c === '"') {
      inDouble = true;
      take(1);
      continue;
    }
    if (c === "-" && sql[i + 1] === "-") {
      inLineComment = true;
      take(2);
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      blockDepth = 1;
      take(2);
      continue;
    }
    if (c === "$") {
      const tag = matchAt(DOLLAR_TAG, sql, i);
      if (tag) {
        dollarTag = tag;
        text += tag;
        i += tag.length;
        continue;
      }
    }
    if (c === ";") {
      const sep = matchAt(TERMINATOR, sql, i);
      if (sep) {
        // Drop the `;` + trailing whitespace/newlines, exactly like split().
        i += sep.length;
        pushChunk();
        continue;
      }
    }
    take(1);
  }
  if (text.length) pushChunk();

  return chunks
    .map(({ text: t, protectedLines: prot }) =>
      t
        .split("\n")
        // `m` flag matters even on a single line: these files are CRLF, and
        // without it `$` will not match before the trailing \r.
        .map((l, idx) => (prot.has(idx) ? l : l.replace(/^\s*--.*$/m, "")))
        .join("\n")
        .trim(),
    )
    .filter(Boolean);
}
