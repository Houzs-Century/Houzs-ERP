// ----------------------------------------------------------------------------
// completeness-claim — make "every call site" a CHECKABLE claim.
//
// THE CLASS: a PR says it covered a whole population — "every desktop + mobile
// call site", "all four arms", "system-wide" — and it did not. PR #1763 is the
// worked example. Its body reads:
//
//     "itemCode threaded through the backend gate (so-variant-check) and every
//      desktop + mobile call site"
//
// Five of its thirteen call sites never got the argument, so the DIVAN ONLY
// exemption was half-applied for four days. Nothing failed: the parameter was
// optional, `tsc` was happy, and no test covered the omitted callers. The claim
// was the only artifact that was wrong, and nothing in this repo reads claims.
//
// THE REMEDY IS NOT "FIND MORE BUGS". It is to move the moment of discovery
// from production to the PR: if you assert you covered a population, you paste
// the command that ENUMERATES that population plus its output, and CI re-runs
// the command and diffs. A pasted list can be stale or invented — reproducing
// it is the entire design. The author's own words become a test.
//
// This module is PURE: parsing, trigger detection, command planning, diffing.
// Nothing here spawns a process or touches the filesystem, so all of it is
// testable with node:test and no fixtures. The runner
// (scripts/check-completeness-claim.mjs) supplies an `exec` callback.
//
// NO DEPENDENCIES, on purpose: `npm install` in a worktree destroys the main
// checkout's node_modules, so a gate that needs one is a gate nobody runs.
// ----------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 1. The trigger vocabulary.
//
// CALIBRATED, not guessed — and the numbers below are a snapshot, not a
// standing fact. AS OF 2026-08-13, run against all 3,231 commits then reachable
// from origin/main, this exact detector fires on 30 titles (0.9%) and
// 438 title-or-body messages (13.6%). Sampling those 438 by matched noun, they
// are overwhelmingly REAL scope claims: "all four arms" (x46), "every caller"
// (x49), "both surfaces" (x53), "every reader", "all six line-DELETE routes".
// That is the population this gate exists for, and roughly one PR in seven
// will be asked to prove itself.
//
// The known false-positive shape is a population noun used as a VERB — "Every
// other error still surfaces". It is rare, it still reads like a scope claim,
// and the escape label costs one click, so it is not worth more regex.
//
// Two tiers, because they fail differently:
//
//  · STANDALONE phrases are scope claims on their own ("system-wide",
//    "everywhere"). No noun needed.
//
//  · QUANTIFIER + POPULATION NOUN ("every call site", "all four arms"). The
//    noun list is deliberately about CODE POPULATIONS. It does NOT contain
//    "test", "check", "app" or "change", which is why the everyday sentences
//    this repo writes a hundred times a day — "all tests pass", "typecheck and
//    tests pass for every changed app" (the repo's OWN pull_request_template)
//    — do not trip the gate. There is a test pinning exactly that.
// ---------------------------------------------------------------------------

export const STANDALONE_TRIGGERS = [
  'system-wide',
  'system wide',
  'systemwide',
  'everywhere',
  'across the board',
  'without exception',
  'exhaustive',
  'exhaustively',
];

export const QUANTIFIERS = ['every', 'each', 'all', 'both'];

/** Population nouns. Singular forms; the matcher accepts an optional plural. */
export const POPULATION_NOUNS = [
  'call site',
  'callsite',
  'caller',
  'call path',
  'code path',
  'codepath',
  'path',
  'arm',
  'branch',
  'surface',
  'screen',
  'page',
  'route',
  'endpoint',
  'handler',
  'reader',
  'writer',
  'consumer',
  'usage',
  'use site',
  'occurrence',
  'reference',
  'place',
];

/** Filler allowed between the quantifier and the noun: "all FOUR arms",
 *  "every OTHER consumer", "every DESKTOP + MOBILE call site".
 *
 *  That last one is PR #1763's actual sentence, and it is why the filler is
 *  free words rather than a closed list of {the, other, four, ...}: a closed
 *  list does not contain "desktop" or "mobile", so it silently let the one PR
 *  this gate was built for sail straight through.
 *
 *  THREE filler tokens, not more. The bound is what stops a quantifier reaching
 *  down a sentence to an unrelated noun ("All of the numbers the owner quoted
 *  came from the production reader" must not match). Measured 2026-08-13 over
 *  the 3,231 commits then reachable from origin/main: 3 tokens fires on 438
 *  messages, 4 on 456 — the 18 extra are not worth the extra reach, and 3 is
 *  exactly enough for "desktop + mobile".
 *
 *  Each alternative carries its OWN trailing boundary. A shared `\b` after the
 *  group is wrong: there is no word boundary between `+` and the space that
 *  follows it, so "every desktop + mobile call site" would not match — which is
 *  the one sentence this gate exists to catch. */
const FILLER = '(?:[A-Za-z][\\w-]{0,14}\\b|\\d{1,4}\\b|[+/&])';
const MAX_FILLER = 3;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A literal space in a noun also matches a hyphen or a newline: PR bodies are
 *  hard-wrapped, and "call site" is written "call-site" about as often. */
const nounPattern = (n) => escapeRe(n).replace(/ /g, '[\\s-]+') + 's?';

const STANDALONE_RE = new RegExp(
  `\\b(?:${STANDALONE_TRIGGERS.map((t) => escapeRe(t).replace(/ /g, '[\\s-]+')).join('|')})\\b`,
  'gi',
);

// `[^\S\n]` for the gaps inside the phrase and an explicit optional newline:
// a body wraps at 80 columns, so "every desktop + mobile call\nsite" must match
// — but a BLANK line ends the thought, and the quantifier must not cross it.
const GAP = '[^\\S\\n]*\\n?[^\\S\\n]*';
const QUANTIFIED_RE = new RegExp(
  `\\b(?:${QUANTIFIERS.join('|')})\\b(?:${GAP}${FILLER}){0,${MAX_FILLER}}${GAP}(?:${POPULATION_NOUNS.map(nounPattern).join('|')})\\b`,
  'gi',
);

// ---------------------------------------------------------------------------
// 2. Reading the PR body as PROSE.
//
// A claim only counts if the AUTHOR is making it here and now. Text that is
// quoted, pasted, templated or fenced is not this PR's assertion:
//
//   · fenced blocks — including the enumeration block itself, whose pasted
//     output is very likely to contain the word "every";
//   · blockquotes — quoting the owner or a prior PR;
//   · HTML comments — the pull_request_template's instructions;
//   · git trailers — "Co-authored-by:".
//
// Line numbers are preserved so the report can point at the exact line to
// reword. `\r` is stripped: GitHub sends CRLF bodies.
// ---------------------------------------------------------------------------

/**
 * Blank out every HTML-comment span, keeping all newlines so line numbers are
 * unchanged. Character-wise rather than line-wise on purpose: the
 * pull_request_template puts its instructions in comments, and those
 * instructions necessarily SAY "every call site" and "all four arms" while
 * explaining the rule. If the template's own prose counted as a claim, every PR
 * in the repo would fail on day one — there is a test pinning exactly that.
 *
 * A same-line comment must not swallow the rest of the line either:
 * `Fixed every caller. <!-- todo -->` is still a claim.
 */
export function maskHtmlComments(text) {
  const src = String(text ?? '').replace(/\r\n?/g, '\n');
  let out = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('<!--', i);
    if (open === -1) { out += src.slice(i); break; }
    out += src.slice(i, open);
    let close = src.indexOf('-->', open + 4);
    const end = close === -1 ? src.length : close + 3;
    // Preserve the newlines inside the comment so line numbers still line up.
    out += src.slice(open, end).replace(/[^\n]/g, ' ');
    i = end;
  }
  return out;
}

export function proseLines(text) {
  const kept = [];
  let fence = null;

  const lines = maskHtmlComments(text).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const openFence = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      // Only the same fence character closes the block.
      if (openFence && openFence[1][0] === fence) fence = null;
      continue;
    }
    if (openFence) {
      fence = openFence[1][0];
      continue;
    }
    if (/^\s*>/.test(line)) continue;
    if (/^\s*(?:co-authored-by|signed-off-by|reviewed-by|reported-by):/i.test(line)) continue;

    kept.push({ line: i + 1, text: line });
  }
  return kept;
}

/** Every completeness claim in the PR title and body, with where it was said.
 *
 *  The prose is scanned as ONE string, not line by line. PR #1763's claim is
 *  "every desktop + mobile call\nsite" — hard-wrapped mid-phrase — so a
 *  line-at-a-time scan misses the exact PR this gate was built for. The kept
 *  lines are joined and an offset->original-line map is carried alongside, so
 *  the report can still point at the line to reword. */
export function findClaims(title, body) {
  const claims = [];

  const scan = (text, source, lineAt) => {
    for (const re of [STANDALONE_RE, QUANTIFIED_RE]) {
      re.lastIndex = 0;
      for (const m of text.matchAll(re)) {
        claims.push({ phrase: m[0].replace(/\s+/g, ' ').trim(), source, line: lineAt(m.index) });
      }
    }
  };

  // A title is never fenced or quoted, so it is scanned whole.
  scan(String(title ?? '').replace(/\r\n?/g, '\n'), 'title', () => 1);

  const kept = proseLines(body);
  const joined = kept.map((k) => k.text).join('\n');
  // starts[i] is the offset of kept[i] inside `joined`.
  const starts = [];
  let at = 0;
  for (const k of kept) { starts.push(at); at += k.text.length + 1; }
  const lineAt = (index) => {
    let lo = 0, hi = starts.length - 1, best = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] <= index) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return kept[best]?.line ?? 1;
  };
  scan(joined, 'body', lineAt);

  return claims;
}

// ---------------------------------------------------------------------------
// 3. The enumeration block.
//
//     ```enumeration
//     $ git grep -n "missingVariantAxes(" -- backend/src frontend/src
//     backend/src/scm/lib/so-variant-check.ts:56:  const missing = ...
//     ...
//     ```
//
// One `$ ` line — the command that enumerates the population — then its exact
// output. More than one block is allowed and ALL of them must reproduce: "all
// four arms AND every caller" is two populations and deserves two proofs.
// ---------------------------------------------------------------------------

export const BLOCK_TAG = 'enumeration';

export function extractEnumerationBlocks(body) {
  const blocks = [];
  // Commented out is NOT submitted. The pull_request_template ships a worked
  // example inside an HTML comment; leaving it in place must not make CI try
  // to reproduce a placeholder.
  const lines = maskHtmlComments(body).split('\n');
  let open = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s*(`{3,}|~{3,})\s*(\S*)/.exec(line);
    if (!fence) continue;

    if (open) {
      if (fence[1][0] !== open.char) continue; // a nested fence of the other kind
      if (open.tagged) {
        blocks.push(parseEnumerationBlock(lines.slice(open.start, i), open.start + 2));
      }
      open = null;
      continue;
    }
    open = { char: fence[1][0], start: i + 1, tagged: fence[2].toLowerCase() === BLOCK_TAG };
  }
  // An unterminated ```enumeration fence is a formatting mistake worth naming
  // rather than silently ignoring — otherwise the author sees "no block found"
  // while looking straight at their block.
  if (open?.tagged) {
    blocks.push({
      ok: false,
      reason: `the \`\`\`${BLOCK_TAG} block opened on line ${open.start} is never closed`,
      startLine: open.start,
    });
  }
  return blocks;
}

export function parseEnumerationBlock(contentLines, firstLineNo) {
  let i = 0;
  while (i < contentLines.length && contentLines[i].trim() === '') i++;

  const commandLines = [];
  const head = contentLines[i] ?? '';
  const m = /^\s*\$\s+(.*)$/.exec(head);
  if (!m) {
    return {
      ok: false,
      startLine: firstLineNo,
      reason:
        `the first line of an \`\`\`${BLOCK_TAG} block must be the enumerating command, ` +
        `written after a "$ " prompt — got ${JSON.stringify(head.slice(0, 60))}`,
    };
  }
  // A long command may be continued with a trailing backslash.
  let command = m[1];
  while (command.endsWith('\\')) {
    i++;
    command = command.slice(0, -1).trimEnd() + ' ' + String(contentLines[i] ?? '').trim();
  }
  commandLines.push(command);
  i++;

  const rest = contentLines.slice(i);
  for (const line of rest) {
    if (/^\s*\$\s+/.test(line)) {
      return {
        ok: false,
        startLine: firstLineNo,
        reason:
          `an \`\`\`${BLOCK_TAG} block holds exactly ONE command and its output; ` +
          `found a second "$ " line: ${JSON.stringify(line.trim().slice(0, 60))}. ` +
          `Two populations need two blocks.`,
      };
    }
  }

  return {
    ok: true,
    startLine: firstLineNo,
    command: commandLines[0].trim(),
    output: rest.join('\n'),
  };
}

// ---------------------------------------------------------------------------
// 4. Planning the command.
//
// THE PR BODY IS UNTRUSTED INPUT. Anyone who can open a PR can write this
// string, so it is never handed to a shell. It is tokenised HERE, checked
// against a per-program flag allowlist, and executed with `shell: false`.
//
// What that buys, concretely:
//   · no `;` / `&&` / backtick / `$(...)` chaining — there is no shell to
//     interpret them, and unquoted shell metacharacters are REJECTED rather
//     than passed through as literals, because a command that means something
//     different here than in the author's terminal is worse than a rejection;
//   · no redirection, no glob expansion, no variable expansion;
//   · a pipeline is built by this module (max 3 stages), not by a shell.
//
// The runner adds the rest of the box: a scrubbed environment (so no
// GITHUB_TOKEN or secret is reachable), a wall-clock timeout, an output cap,
// and `--permission --allow-fs-read=<repo>` for node, which turns off
// child_process, fs writes, workers and native addons.
// ---------------------------------------------------------------------------

/** Programs that may START a pipeline: they enumerate. */
const ENUMERATORS = new Set(['grep', 'rg', 'git', 'node']);
/** Programs that may only appear DOWNSTREAM of a pipe: they reduce. */
const REDUCERS = new Set(['wc', 'sort', 'uniq', 'head', 'tail', 'cut', 'tr', 'grep', 'rg']);

export const ALLOWED_PROGRAMS = [...new Set([...ENUMERATORS, ...REDUCERS])].sort();

/**
 * Per-program flag allowlist. An allowlist and not a denylist: an unknown flag
 * is refused by name, which is a message an author can act on, and a flag that
 * gains a dangerous meaning in a future release cannot arrive silently.
 *
 * The deliberate exclusions, each of which is remote code execution or a way
 * out of the repo:
 *   rg  --pre, --pre-glob     run an arbitrary preprocessor binary
 *   rg  -z, --search-zip      shell out to a decompressor
 *   rg  -L, --follow          follow symlinks out of the checkout
 *   git -c, -C, --exec-path   inject config / relocate git before the subcommand
 *   sed, awk, xargs, find     `s///e`, system(), and -exec are code execution,
 *                             which is why none of them are on the list at all
 */
const FLAGS = {
  grep: {
    value: ['-e', '--regexp', '-f', '--file', '--include', '--exclude', '--exclude-dir', '-m', '--max-count', '-A', '-B', '-C', '--binary-files'],
    bare: ['-r', '-R', '-n', '-H', '-h', '-i', '-I', '-w', '-x', '-c', '-l', '-L', '-o', '-v', '-E', '-F', '-P', '-s', '-a', '-z',
      '--recursive', '--line-number', '--with-filename', '--no-filename', '--ignore-case', '--word-regexp', '--line-regexp',
      '--count', '--files-with-matches', '--files-without-match', '--only-matching', '--invert-match',
      '--extended-regexp', '--fixed-strings', '--perl-regexp', '--basic-regexp', '--no-messages', '--text', '--null',
      '--color', '--colour', '--no-color', '--no-colour'],
  },
  rg: {
    value: ['-e', '--regexp', '-g', '--glob', '--iglob', '-t', '--type', '-T', '--type-not', '--sort', '--sortr', '-m', '--max-count',
      '-A', '--after-context', '-B', '--before-context', '-C', '--context', '--max-depth', '--max-filesize', '-f', '--file'],
    bare: ['-n', '--line-number', '-N', '--no-line-number', '-H', '--with-filename', '-I', '--no-filename', '--no-heading', '--heading',
      '-i', '--ignore-case', '-S', '--smart-case', '-s', '--case-sensitive', '-w', '--word-regexp', '-x', '--line-regexp',
      '-c', '--count', '--count-matches', '-l', '--files-with-matches', '--files-without-match', '--files', '-o', '--only-matching',
      '-v', '--invert-match', '-F', '--fixed-strings', '-P', '--pcre2', '-U', '--multiline', '--multiline-dotall',
      '-u', '-uu', '--unrestricted', '--hidden', '--no-ignore', '--no-ignore-vcs', '--binary', '--text', '-a',
      '--color', '--colour', '--no-color', '--no-colour', '--null', '--trim'],
  },
  git: {
    // Checked after the subcommand is validated; see planStage.
    value: ['-e', '--max-depth', '--max-count', '-A', '-B', '-C', '-m', '-f'],
    bare: ['-n', '-i', '-I', '-w', '-x', '-c', '-l', '-L', '-h', '-H', '-v', '-E', '-F', '-P', '-o', '-z', '-a',
      '--line-number', '--ignore-case', '--word-regexp', '--name-only', '--files-with-matches', '--files-without-match',
      '--count', '--invert-match', '--extended-regexp', '--fixed-strings', '--perl-regexp', '--basic-regexp',
      '--heading', '--no-heading', '--break', '--no-color', '--color', '--full-name', '--untracked', '--cached',
      '--and', '--or', '--not', '--all-match', '--text', '--others', '--exclude-standard', '--deduplicate'],
  },
  node: {
    // The runner injects --permission and --allow-fs-read=<repo>. Nothing else
    // is accepted, so a body cannot ask for --allow-child-process.
    value: ['-e', '--eval', '-p', '--print'],
    bare: ['--input-type=module', '--input-type=commonjs'],
  },
  wc: { value: [], bare: ['-l', '-c', '-w', '-m', '--lines', '--chars', '--words', '--bytes'] },
  sort: { value: ['-k', '-t', '--key', '--field-separator'], bare: ['-u', '-n', '-r', '-f', '-b', '-h', '-V', '--unique', '--numeric-sort', '--reverse', '--ignore-case'] },
  uniq: { value: ['-f', '-s', '-w'], bare: ['-c', '-d', '-u', '-i', '--count', '--repeated', '--unique', '--ignore-case'] },
  head: { value: ['-n', '-c', '--lines', '--bytes'], bare: [] },
  tail: { value: ['-n', '-c', '--lines', '--bytes'], bare: [] },
  cut: { value: ['-d', '-f', '-c', '-b', '--delimiter', '--fields', '--characters'], bare: ['-s', '--only-delimited'] },
  tr: { value: [], bare: ['-d', '-s', '-c', '-t', '--delete', '--squeeze-repeats', '--complement'] },
};

const GIT_SUBCOMMANDS = new Set(['grep', 'ls-files']);

const MAX_STAGES = 3;

/** Shell metacharacters that would mean something in a terminal and nothing
 *  here. Refused rather than silently taken as literals — a command that means
 *  one thing in the author's shell and another in CI is worse than a rejection.
 *
 *  This is checked by the TOKENIZER, which is the only place that knows about
 *  quoting. Checking it on tokenized values instead would refuse
 *  `git grep -n "missingVariantAxes("` — the single most natural enumeration
 *  command in this repo — because the quotes are gone by then. `|` is handled
 *  separately, as the pipeline separator. */
const UNQUOTED_META = /[;&<>(){}`]/;

/**
 * Split a command string into tokens the way a shell would QUOTE (single
 * quotes literal, double quotes literal, backslash escapes) — but with no
 * expansion of any kind, and with `|` surfaced as a pipeline separator.
 */
export function tokenize(command) {
  const stages = [];
  let argv = [];
  let cur = '';
  let has = false;
  let quote = null;

  const push = () => { if (has) { argv.push(cur); cur = ''; has = false; } };

  const src = String(command ?? '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];

    if (quote) {
      if (ch === quote) { quote = null; continue; }
      if (quote === '"' && ch === '\\' && i + 1 < src.length && '"\\'.includes(src[i + 1])) {
        cur += src[++i]; has = true; continue;
      }
      cur += ch; has = true; continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; has = true; continue; }
    if (ch === '\\') {
      if (i + 1 >= src.length) return { ok: false, reason: 'the command ends with a dangling backslash' };
      cur += src[++i]; has = true; continue;
    }
    if (UNQUOTED_META.test(ch)) {
      return {
        ok: false,
        reason:
          `\`${ch}\` is a shell metacharacter and this command is NOT run through a shell, ` +
          `so it would not mean here what it means in your terminal. ` +
          `Quote it if you meant it literally, or simplify the command.`,
      };
    }
    if (/\s/.test(ch)) { push(); continue; }
    if (ch === '|') {
      if (src[i + 1] === '|') return { ok: false, reason: '`||` is not supported; an enumeration is one command, optionally piped into a reducer' };
      push();
      if (argv.length === 0) return { ok: false, reason: 'a pipeline stage is empty' };
      stages.push(argv); argv = [];
      continue;
    }
    cur += ch; has = true;
  }
  if (quote) return { ok: false, reason: `the command has an unterminated ${quote === '"' ? 'double' : 'single'} quote` };
  push();
  if (argv.length) stages.push(argv);

  if (stages.length === 0) return { ok: false, reason: 'the command is empty' };
  for (const s of stages) if (s.length === 0) return { ok: false, reason: 'a pipeline stage is empty' };
  return { ok: true, stages };
}

/** Absolute paths and `..` escapes: the command must enumerate THIS REPO.
 *  Only roots that actually exist on a CI runner are refused, so an ordinary
 *  regex like "/api/scm" is not caught by this. */
const OUTSIDE_REPO =
  /^(?:~|\/(?:etc|home|root|usr|var|proc|sys|dev|opt|srv|boot|run|tmp|private|Users|System|Library|Applications|github|__w)(?:\/|$))/;

function checkToken(tok) {
  if (OUTSIDE_REPO.test(tok) || /(?:^|\/)\.\.(?:\/|$)/.test(tok)) {
    return `${JSON.stringify(tok)} points outside the repository. An enumeration must enumerate THIS checkout.`;
  }
  return null;
}

function planStage(argv, index) {
  const program = argv[0];
  const pos = index === 0 ? 'first' : `stage ${index + 1}`;

  if (index === 0 ? !ENUMERATORS.has(program) : !REDUCERS.has(program)) {
    const allowed = (index === 0 ? [...ENUMERATORS] : [...REDUCERS]).sort().join(', ');
    return { ok: false, reason: `\`${program}\` is not allowed as the ${pos} stage of an enumeration. Allowed here: ${allowed}.` };
  }

  let rest = argv.slice(1);
  const out = [program];

  if (program === 'git') {
    const sub = rest[0];
    if (!GIT_SUBCOMMANDS.has(sub)) {
      return {
        ok: false,
        reason: `\`${`git ${sub ?? ''}`.trim()}\` is not allowed — only \`git grep\` and \`git ls-files\`. ` +
          `Options before the subcommand (\`-c\`, \`-C\`, \`--exec-path\`) are refused outright: they can relocate or reconfigure git.`,
      };
    }
    out.push(sub);
    rest = rest.slice(1);
  }

  const spec = FLAGS[program];
  let literalsOnly = false;

  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    const bad = checkToken(tok);
    if (bad) return { ok: false, reason: bad };

    if (literalsOnly || !tok.startsWith('-') || tok === '-') { out.push(tok); continue; }
    if (tok === '--') { out.push(tok); literalsOnly = true; continue; }

    // --flag=value
    const eq = tok.indexOf('=');
    if (tok.startsWith('--') && eq > 2) {
      const name = tok.slice(0, eq);
      if (!spec.value.includes(name) && !spec.bare.includes(tok) && !spec.bare.includes(name)) {
        return { ok: false, reason: `\`${name}\` is not an allowed option for \`${program}\` in an enumeration.` };
      }
      out.push(tok);
      continue;
    }
    if (spec.bare.includes(tok)) { out.push(tok); continue; }
    if (spec.value.includes(tok)) {
      const val = rest[i + 1];
      if (val === undefined) return { ok: false, reason: `\`${tok}\` needs a value.` };
      const badVal = checkToken(val);
      if (badVal) return { ok: false, reason: badVal };
      out.push(tok, val);
      i++;
      continue;
    }
    // Short flags: bundled (-rn), or with an attached numeric value (-A3).
    const bundled = /^-([A-Za-z]+)(\d*)$/.exec(tok);
    if (bundled) {
      const chars = bundled[1].split('');
      const attached = bundled[2];
      const expanded = [];
      for (let c = 0; c < chars.length; c++) {
        const flag = `-${chars[c]}`;
        const last = c === chars.length - 1;
        if (spec.bare.includes(flag)) { expanded.push(flag); continue; }
        if (spec.value.includes(flag) && last) {
          if (attached) { expanded.push(flag, attached); continue; }
          const val = rest[i + 1];
          if (val === undefined) return { ok: false, reason: `\`${flag}\` needs a value.` };
          const badVal = checkToken(val);
          if (badVal) return { ok: false, reason: badVal };
          expanded.push(flag, val);
          i++;
          continue;
        }
        return { ok: false, reason: `\`${flag}\` is not an allowed option for \`${program}\` in an enumeration.` };
      }
      out.push(...expanded);
      continue;
    }
    return { ok: false, reason: `\`${tok}\` is not an allowed option for \`${program}\` in an enumeration.` };
  }

  if (program === 'node') {
    // A ONE-LINER, and only a one-liner. `node enumerate.mjs` would run a file
    // out of the PR's own diff, which is arbitrary code execution with extra
    // steps — the flag allowlist alone does not catch it, because a script path
    // is a positional argument, not a flag.
    const evalFlags = ['-e', '--eval', '-p', '--print'];
    const idx = out.findIndex((t) => evalFlags.includes(t));
    if (idx === -1) {
      return { ok: false, reason: 'a `node` enumeration must be a one-liner: pass the program to `-e` or `-p`. Running a script FILE is not allowed — it would execute code from this PR.' };
    }
    // Everything after the program string would be argv for the script.
    if (out.length > idx + 2) {
      return { ok: false, reason: `\`node\` takes only the one-liner itself; unexpected extra argument \`${out[idx + 2]}\`.` };
    }
  }

  return { ok: true, argv: out };
}

/** Turn a pasted command string into an executable plan, or an explained no. */
export function planCommand(command) {
  const tokens = tokenize(command);
  if (!tokens.ok) return tokens;
  if (tokens.stages.length > MAX_STAGES) {
    return { ok: false, reason: `at most ${MAX_STAGES} pipeline stages are allowed; this has ${tokens.stages.length}.` };
  }
  const stages = [];
  for (let i = 0; i < tokens.stages.length; i++) {
    const planned = planStage(tokens.stages[i], i);
    if (!planned.ok) return planned;
    stages.push(planned.argv);
  }
  return { ok: true, stages };
}

// ---------------------------------------------------------------------------
// 5. Diffing pasted output against reproduced output.
//
// Compared as a SORTED MULTISET, not line-for-line. `rg` walks directories in
// parallel and its output order is NOT stable between runs, so an ordered diff
// would fail honest PRs at random — the single fastest way to get a gate
// deleted. Sorting keeps every real difference visible (a line that appeared, a
// line that vanished, a count that moved) and drops only the difference that
// carries no meaning.
//
// Trailing whitespace and surrounding blank lines are normalised away; GitHub
// bodies arrive CRLF and editors trim differently.
// ---------------------------------------------------------------------------

export function normalizeOutput(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/\s+$/, ''));
  while (lines.length && lines[0] === '') lines.shift();
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function diffOutput(pasted, actual) {
  const want = normalizeOutput(pasted);
  const got = normalizeOutput(actual);

  const counts = new Map();
  for (const l of want) counts.set(l, (counts.get(l) ?? 0) + 1);
  const extra = [];
  for (const l of got) {
    const n = counts.get(l) ?? 0;
    if (n > 0) counts.set(l, n - 1);
    else extra.push(l);
  }
  const missing = [];
  for (const [l, n] of counts) for (let i = 0; i < n; i++) missing.push(l);

  return {
    ok: extra.length === 0 && missing.length === 0,
    pastedCount: want.length,
    actualCount: got.length,
    /** In the tree but NOT in the pasted list — the stale-enumeration shape. */
    extra: extra.sort(),
    /** In the pasted list but NOT in the tree — invented, moved or deleted. */
    missing: missing.sort(),
  };
}

// ---------------------------------------------------------------------------
// 6. The verdict.
// ---------------------------------------------------------------------------

export const ESCAPE_LABEL = 'completeness-not-claimed';

export const VERDICT = { PASS: 'PASS', FAIL: 'FAIL' };
export const REASON = {
  NO_CLAIM: 'NO_CLAIM',
  ESCAPE_LABEL: 'ESCAPE_LABEL',
  VERIFIED: 'VERIFIED',
  MISSING_BLOCK: 'MISSING_BLOCK',
  BAD_BLOCK: 'BAD_BLOCK',
  COMMAND_REFUSED: 'COMMAND_REFUSED',
  COMMAND_FAILED: 'COMMAND_FAILED',
  OUTPUT_MISMATCH: 'OUTPUT_MISMATCH',
};

/**
 * @param {object} input
 * @param {string} input.title
 * @param {string} input.body
 * @param {string[]} input.labels
 * @param {(stages: string[][]) => {ok: boolean, stdout?: string, error?: string}} input.exec
 */
export function evaluate({ title, body, labels = [], exec }) {
  const claims = findClaims(title, body);
  const notes = [];

  if (claims.length === 0) {
    return { verdict: VERDICT.PASS, reason: REASON.NO_CLAIM, claims, blocks: [], notes };
  }

  if (labels.some((l) => String(l).toLowerCase() === ESCAPE_LABEL)) {
    // NOT silent, by design. The label is an escape from the PROOF, not from
    // the problem: the words are still in the PR, and a reader still has to
    // decide whether to believe them.
    notes.push(
      `This PR carries the \`${ESCAPE_LABEL}\` label, so the enumeration proof is waived.`,
      `The completeness wording is STILL PRESENT and still reads as a promise to whoever reviews this later:`,
      ...claims.map((c) => `  ${c.source} line ${c.line}: "${c.phrase}"`),
      `Please reword it — say what you DID cover ("the three desktop call sites") instead of asserting a population you have not enumerated.`,
    );
    return { verdict: VERDICT.PASS, reason: REASON.ESCAPE_LABEL, claims, blocks: [], notes };
  }

  const blocks = extractEnumerationBlocks(body);
  if (blocks.length === 0) {
    return { verdict: VERDICT.FAIL, reason: REASON.MISSING_BLOCK, claims, blocks: [], notes };
  }

  const results = [];
  let worst = null;
  for (const block of blocks) {
    if (!block.ok) {
      // `block.reason` is the human explanation from the parser; the verdict
      // reason is an enum. Keep both, and do not let one clobber the other.
      results.push({ ...block, verdict: VERDICT.FAIL, reason: REASON.BAD_BLOCK, detail: block.reason });
      worst ??= REASON.BAD_BLOCK;
      continue;
    }
    const plan = planCommand(block.command);
    if (!plan.ok) {
      results.push({ ...block, verdict: VERDICT.FAIL, reason: REASON.COMMAND_REFUSED, detail: plan.reason });
      worst ??= REASON.COMMAND_REFUSED;
      continue;
    }
    const run = exec(plan.stages);
    if (!run.ok) {
      results.push({ ...block, verdict: VERDICT.FAIL, reason: REASON.COMMAND_FAILED, detail: run.error, plan: plan.stages });
      worst ??= REASON.COMMAND_FAILED;
      continue;
    }
    const diff = diffOutput(block.output, run.stdout);
    if (!diff.ok) {
      results.push({ ...block, verdict: VERDICT.FAIL, reason: REASON.OUTPUT_MISMATCH, diff, plan: plan.stages });
      worst ??= REASON.OUTPUT_MISMATCH;
      continue;
    }
    results.push({ ...block, verdict: VERDICT.PASS, reason: REASON.VERIFIED, diff, plan: plan.stages });
  }

  return worst
    ? { verdict: VERDICT.FAIL, reason: worst, claims, blocks: results, notes }
    : { verdict: VERDICT.PASS, reason: REASON.VERIFIED, claims, blocks: results, notes };
}
