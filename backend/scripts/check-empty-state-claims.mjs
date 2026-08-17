#!/usr/bin/env node
// ----------------------------------------------------------------------------
// check-empty-state-claims.mjs — NO EMPTY STATE MAY CLAIM THE WORK IS DONE.
//
// THE RULE (owner, 2026-08-17). A screen that got back nothing may say what it
// LOOKED FOR. It may not say what is TRUE OF THE BUSINESS. "This search came
// back with no outstanding PO lines" is a report. "Every line has been
// received" is a conclusion, and this codebase cannot support it:
//
//   · COMPANY SCOPE FAILS CLOSED. `scopeToCompany` (backend/src/scm/lib/
//     companyScope.ts:312) answers an unresolvable company with
//     `.in("company_id", [])`. PostgREST returns `[]` with `error: null` — a
//     shape indistinguishable from a company that genuinely has no work left.
//   · PostgREST `db-max-rows` TRUNCATES SILENTLY. A `.limit(5000)` above the
//     server ceiling is an upper bound, not a request. A read that did not page
//     may hold a prefix and cannot speak for the rest.
//   · A SWALLOWED READ ERROR RETURNS EMPTY. 954 sites predate the ratchet in
//     check-swallowed-reads.mjs; any of them can hand a caller `[]`.
//   · A FILTER THE OPERATOR FORGOT THEY SET narrows the read invisibly.
//
// WHY A GATE AND NOT A HABIT. The from-PO picker shipped this exact lie TWICE
// inside five commits. #2367 removed the completion claim; a branch five commits
// later reintroduced it in a rewritten helper AND shipped a test asserting the
// claim was legitimate. A rule that depends on everyone remembering it keeps
// failing — and it failed here in the shape this repo keeps finding, a rule
// expressed at N call sites and present at N-1 of them: NINE sibling convert
// pickers, ONE of them corrected.
//
// WHAT THIS IS, STATED SO A GREEN RUN IS NOT OVER-READ. A regex over source
// cannot understand meaning. It cannot tell a claim from a quotation of a
// claim, and it cannot see a claim phrased in words nobody has written yet. So
// it is NOT a meaning detector — it is a REVIEWED ALLOWLIST over a fixed list of
// claim SHAPES. Every claim-shaped string in the tree is either fixed or listed
// in data/empty-state-claim-allowlist.json with a one-line reason. A NEW one
// fails the build until somebody puts it on the list deliberately. That is the
// whole mechanism: it converts silence into a decision. It does not, and cannot,
// prove that the strings which passed are honest.
//
// WHAT IT CANNOT SEE:
//   · a completion claim assembled at runtime from fragments;
//   · a claim in words not on CLAIMS below (add the shape when you meet one);
//   · whether a string it flagged is even user-facing — a doc-comment quoting a
//     bad string is a hit, and the allowlist is where that is recorded;
//   · whether the branch a string sits on is guarded by an isError arm. That is
//     a different defect (a failed read rendering as an empty one) and it is
//     check-silent-mutations.mjs / check-inband-failures.mjs territory.
//
// KEYED BY TEXT, NOT BY LINE. Line numbers shift on every merge and a
// line-keyed allowlist would rot into noise within a day. The key is
// (file, normalized matched line), so EDITING a listed string re-opens the
// review and moving it does not.
//
// Usage:
//   node backend/scripts/check-empty-state-claims.mjs            # full inventory
//   node backend/scripts/check-empty-state-claims.mjs --strict   # exit 1 on a new hit
//   node backend/scripts/check-empty-state-claims.mjs --suggest  # paste-ready entries
//   node backend/scripts/check-empty-state-claims.mjs --json
//
// NO DEPENDENCIES (node:fs / node:path only) so it runs before any npm install.
// ----------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const strict = process.argv.includes("--strict");
const jsonOut = process.argv.includes("--json");
const suggest = process.argv.includes("--suggest");

const ALLOWLIST_PATH = path.join(repoRoot, "backend", "scripts", "data", "empty-state-claim-allowlist.json");

/* ── Output ──────────────────────────────────────────────────────────────────
   fs.writeSync, NOT console.log, and that is not a style choice. console.log to
   a PIPE is asynchronous, and `process.exit()` discards whatever has not
   drained — so the first version of this script printed a correct exit code
   next to a report that stopped mid-sentence at 9,146 bytes when its output was
   captured rather than shown on a terminal. CI captures. The one place a gate
   must not be economical with the truth is the list of what it found.

   BUFFERED and flushed once, from an `exit` handler. A per-line writeSync on a
   non-blocking pipe spins on EAGAIN until the reader drains, which turned a
   4-second scan into a 27-second one under vitest. Node runs `exit` listeners
   synchronously even for `process.exit()`, so one write at the end is both the
   fast answer and the complete one, and every `process.exit(n)` below stays
   exactly where it is. */
function writeAll(fd, text) {
  const buf = Buffer.from(text, "utf8");
  let off = 0;
  while (off < buf.length) {
    try {
      off += fs.writeSync(fd, buf, off, buf.length - off);
    } catch (e) {
      if (e.code === "EAGAIN") continue;
      throw e;
    }
  }
}
const OUT = [];
const ERR = [];
const say = (s = "") => OUT.push(s);
const warn = (s = "") => ERR.push(s);
process.on("exit", () => {
  if (OUT.length > 0) writeAll(1, OUT.join("\n") + "\n");
  if (ERR.length > 0) writeAll(2, ERR.join("\n") + "\n");
});

/* ── The claim shapes ────────────────────────────────────────────────────────
   Each one is a sentence pattern that states a FACT ABOUT THE WORLD rather than
   a fact about the read. They are deliberately multi-word English: a one-word
   trigger ("complete", "none") fires on hundreds of honest strings and a gate
   that cries wolf is a gate somebody deletes — which is how the previous
   generation of checks in this repo died.

   Adding a shape is expected. Removing one needs a reason, because every shape
   here was written from a string that actually shipped. */
const DONE = "received|delivered|invoiced|billed|returned|converted|noted|paid|allocated|shipped";
const CLAIMS = [
  /* "every line has been fully delivered", "All PO items are already fully
     received". The middle is `[\w' ]` and not `[^.!?]` on purpose: the loose
     version matched "no commitments at all -> the pool is returned untouched"
     across an arrow, which is a test title about a data structure and not a
     claim about anybody's goods. */
  { id: "all-x-have-been", re: new RegExp(String.raw`\b(every|all)\b[\w' ]{0,40}\b(has|have|is|are|was|were)\b[\w' ]{0,20}\b(been\s+)?(already\s+)?(fully\s+)?(${DONE}|closed|done|completed)\b`, "i") },
  // "all qty already received", "Every line on this order is already delivered"
  { id: "all-x-already", re: new RegExp(String.raw`\b(every|all)\b[\w' ]{0,40}\balready\s+(been\s+)?(fully\s+)?(${DONE})\b`, "i") },
  // "Nothing left to receive", "nothing more to invoice"
  { id: "nothing-left-to", re: /\bnothing\s+(left|more|else|further)\s+to\b/i },
  // "You're caught up", "You're all caught up"
  { id: "caught-up", re: /\bcaught\s+up\b/i },
  /* "already fully invoiced". `fully` is REQUIRED. Without it the pattern fired
     on every quantity sentence in the repo — "450 already received, a revised
     qty cannot drop below this" is a number, not a verdict. */
  { id: "already-fully", re: new RegExp(String.raw`\balready\s+(been\s+)?fully\s+(${DONE})\b`, "i") },
  // "This Goods Receipt is already fully invoiced", "PO already received" as a verdict
  { id: "doc-is-already", re: new RegExp(String.raw`\b(is|are|was|were|it's)\s+already\s+(been\s+)?(fully\s+)?(${DONE})\b`, "i") },
  /* "Everything is in AutoCount". The complement is constrained — the open
     version matched "everything is unassigned with a reason", which names a
     problem rather than declaring one absent. */
  { id: "everything-is", re: /\beverything\s+(is|has|was|had)\s+(been\s+)?(in\b|done\b|sent\b|complete|received|delivered|invoiced|arrived|landed|gone through)/i },
  // "no lines remain", "nothing remains"
  { id: "nothing-remains", re: /\b(no\s+\w+|nothing)\s+remain(s|ing)?\b(?!\s*(qty|quantity|balance))/i },
  // "GRN is fully invoiced", "Receive is fully returned"
  { id: "doc-is-fully", re: new RegExp(String.raw`\b(is|are|was|were)\s+(now\s+)?fully\s+(${DONE})\b`, "i") },
  // "You're all done", "All done — thank you"
  { id: "all-done", re: /\ball\s+done\b/i },
  // "everything is up to date", "the list is up-to-date"
  { id: "up-to-date", re: /\b(is|are|you're|you are)\s+(all\s+)?up[-\s]to[-\s]date\b/i },
];

/* ── Qualifiers ──────────────────────────────────────────────────────────────
   The rule is that an empty state may not ASSERT completion. A string that
   states the claim in order to DENY it is not asserting it — the owner-approved
   from-PO wording does exactly that ("That is not the same as everything having
   been received"), and a gate that flagged the model answer would be teaching
   the wrong lesson.

   The list is deliberately short and specific. "may still be outstanding" is
   NOT on it: `PurchaseInvoiceFromGrn` used to say "it has already been fully
   invoiced. Other notes may still be outstanding." — the caveat is about the
   OTHER documents and leaves the claim about THIS one standing.

   A qualified hit is still PRINTED, in its own bucket, so the exemption is
   auditable rather than invisible. */
const QUALIFIERS = [
  /\bnot the same as\b/i,
  /\bis not evidence\b/i,
  /\bno standing to\b/i,
  /\bcannot speak for\b/i,
  /\blook identical to\b/i,
  /\bbefore treating this as\b/i,
];

/* ── Where user-facing English lives ────────────────────────────────────────
   Both trees, both extensions, INCLUDING tests. A test is exactly where the
   last one of these was declared correct, so exempting tests would exempt the
   defect this gate exists for. */
const ROOTS = [
  path.join(repoRoot, "frontend", "src"),
  path.join(repoRoot, "backend", "src"),
  /* An EXTRA root, used by tests/emptyStateClaimGate.test.ts to plant a
     violation OUTSIDE the source tree and watch this exit 1. A gate nobody has
     seen fail is not a gate, and proving it by hand once proves it for one
     afternoon — this makes CI re-prove it on every run without ever writing a
     bad string into frontend/src. Unset in every real invocation. */
  ...(process.env.EMPTY_STATE_EXTRA_ROOT ? [process.env.EMPTY_STATE_EXTRA_ROOT] : []),
];
const EXTS = [".ts", ".tsx"];
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", ".vite"]);

function walk(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, acc);
    else if (EXTS.some((x) => e.name.endsWith(x))) acc.push(full);
  }
  return acc;
}

/* ── Comment stripping ───────────────────────────────────────────────────────
   Comments in this repo are long, and several of them QUOTE the bad strings on
   purpose (GrnFromPo.tsx explains the defect by naming it). Scanning them would
   flag the explanation as the offence. A char-level scanner is used rather than
   a regex because `"http://x"` and `` `a ${ "//" } b` `` both defeat the regex
   version, and a comment stripper that eats a string literal would HIDE hits —
   a checker reporting a number that is too small is the failure this repo has
   now hit five times.

   Newlines are preserved so line numbers survive. */
/* A quote opens a STRING only where a JS string can begin. In TSX it very often
   cannot: `<Muted danger>Couldn't load the convertible lines.</Muted>` is JSX
   TEXT, and the first version of this scanner read that apostrophe as the start
   of a string literal. Everything to the next apostrophe then sat in the wrong
   state — which in MobileConvertWizard.tsx left two block comments unstripped
   and reported them as claims, and which can flip parity such that a REAL string
   is read as code and its `//` blanked. That second direction silently DELETES
   source before the scan, and a checker whose number is too small is the exact
   failure this repo has produced five times.

   A WHITELIST, so the unknown case keeps the character as text. Keeping too much
   costs an allowlist entry; dropping too much costs a missed lie. */
const OPENERS = new Set(["=", "(", "[", "{", ",", ";", ":", "?", "+", "&", "|", "!", "\n", undefined]);
const OPENER_WORDS = new Set(["return", "typeof", "case", "in", "of", "await", "throw", "new", "delete", "void", "yield", "do", "else", "from", "import", "export", "extends", "as", "satisfies"]);
function opensString(src, at) {
  let j = at - 1;
  while (j >= 0 && (src[j] === " " || src[j] === "\t")) j--;
  const prev = j < 0 ? undefined : src[j];
  if (OPENERS.has(prev)) return true;
  if (prev === undefined) return true;
  // `return 'x'` / `case 'x':` — a keyword, not an identifier ending in text.
  if (/[A-Za-z]/.test(prev)) {
    let k = j;
    while (k >= 0 && /[A-Za-z]/.test(src[k])) k--;
    return OPENER_WORDS.has(src.slice(k + 1, j + 1));
  }
  return false;
}

function stripComments(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  // 0 code, 1 line comment, 2 block comment, 3 '..', 4 "..", 5 `..`
  let state = 0;
  let tplDepth = 0; // ${ } nesting inside a template literal
  const tplStack = [];
  while (i < n) {
    const ch = src[i];
    const nx = src[i + 1];
    if (state === 0) {
      if (ch === "/" && nx === "/") { state = 1; out += "  "; i += 2; continue; }
      if (ch === "/" && nx === "*") { state = 2; out += "  "; i += 2; continue; }
      if (ch === "'" && opensString(src, i)) { state = 3; out += ch; i++; continue; }
      if (ch === '"' && opensString(src, i)) { state = 4; out += ch; i++; continue; }
      if (ch === "`") { state = 5; out += ch; i++; continue; }
      if (ch === "}" && tplStack.length > 0 && tplDepth === 0) {
        state = 5; tplDepth = tplStack.pop(); out += ch; i++; continue;
      }
      if (ch === "{" && tplStack.length > 0) tplDepth++;
      if (ch === "}" && tplStack.length > 0 && tplDepth > 0) tplDepth--;
      out += ch; i++; continue;
    }
    if (state === 1) {
      if (ch === "\n") { state = 0; out += ch; } else out += " ";
      i++; continue;
    }
    if (state === 2) {
      if (ch === "*" && nx === "/") { state = 0; out += "  "; i += 2; continue; }
      out += ch === "\n" ? "\n" : " ";
      i++; continue;
    }
    // inside a string of some kind
    if (ch === "\\") { out += ch + (nx ?? ""); i += 2; continue; }
    if (state === 3 && ch === "'") { state = 0; out += ch; i++; continue; }
    if (state === 4 && ch === '"') { state = 0; out += ch; i++; continue; }
    if (state === 5) {
      if (ch === "`") { state = 0; out += ch; i++; continue; }
      if (ch === "$" && nx === "{") { tplStack.push(tplDepth); tplDepth = 0; state = 0; out += "${"; i += 2; continue; }
    }
    out += ch; i++;
  }
  return out;
}

const norm = (s) => s.trim().replace(/\s+/g, " ");

/* ── SELF-TEST ───────────────────────────────────────────────────────────────
   Five checkers in this repo have reported a plausible WRONG number from a
   pattern that could not match. Assert the machinery on known inputs before
   trusting a single count out of it. A checker that cannot detect the thing it
   is named after must SAY SO, not print zero and exit 0. */
{
  const failures = [];
  const mustHit = [
    ['x = "every line has been fully delivered";', "all-x-have-been"],
    ["x = 'All PO items are already fully received';", "already-fully"],
    ['x = "Nothing left to receive on this document.";', "nothing-left-to"],
    ['x = "You\'re all caught up";', "caught-up"],
    ['x = "GRN is fully invoiced";', "doc-is-fully"],
    ['x = "Everything is in AutoCount.";', "everything-is"],
  ];
  for (const [probe, id] of mustHit) {
    const line = stripComments(probe);
    if (!CLAIMS.some((c) => c.re.test(line))) failures.push(`pattern ${id} did not fire on: ${probe}`);
  }
  const mustMiss = [
    'x = "This search came back with no outstanding PO lines.";',
    'x = "No rows match the current filters.";',
    'x = "We couldn\'t load the outstanding lines, so this list is incomplete.";',
    // Numbers, not verdicts. The loose first draft flagged all three.
    'x = `${n} already received — a revised qty cannot drop below this.`;',
    "x = 'Cannot approve — quantity already received';",
    "it('no commitments at all -> the pool is returned untouched', () => {",
  ];
  for (const probe of mustMiss) {
    const line = stripComments(probe);
    const hit = CLAIMS.find((c) => c.re.test(line));
    if (hit) failures.push(`pattern ${hit.id} FALSE-POSITIVED on honest text: ${probe}`);
  }
  // The qualifier arm must actually fire on the owner-approved model wording.
  {
    const model = 'x = "That is not the same as everything having been received — open the purchase order before treating this as nothing left to receive.";';
    if (!CLAIMS.some((c) => c.re.test(model))) failures.push("no claim shape fires inside the model wording — the qualifier arm is untested");
    if (!QUALIFIERS.some((q) => q.test(model))) failures.push("QUALIFIERS did not recognise the owner-approved from-PO wording");
    if (QUALIFIERS.some((q) => q.test('x = "it has already been fully invoiced. Other notes may still be outstanding.";'))) {
      failures.push("QUALIFIERS exempted a claim whose caveat is about OTHER documents");
    }
  }
  // The stripper must remove a comment and KEEP a string that looks like one.
  if (norm(stripComments('// "everything is done"\nconst u = "http://a//b";')) !== 'const u = "http://a//b";') {
    failures.push("stripComments mangled a URL or failed to drop a line comment");
  }
  if (/everything/i.test(stripComments('/* everything is received */ const a = 1;'))) {
    failures.push("stripComments left a block comment in place");
  }
  if (!/caught up/i.test(stripComments('const a = `you are caught up ${n}`;'))) {
    failures.push("stripComments ate a template literal's text");
  }
  /* THE JSX APOSTROPHE. An apostrophe in JSX text is not a string delimiter, and
     reading it as one desynchronises everything after it. Both halves are
     asserted: the comment after it must still be stripped, and the JSX text
     itself must survive. */
  {
    const jsx = "if (e) return <M>Couldn't load them.</M>;\n/* everything is received */\nconst z = 1;";
    const s = stripComments(jsx);
    if (/everything is received/i.test(s)) failures.push("a JSX apostrophe left a later block comment unstripped");
    if (!/Couldn't load them/.test(s)) failures.push("stripComments ate JSX text");
  }
  // …while a real single-quoted literal is still tracked, so its `//` survives.
  if (!/http:\/\/a/.test(stripComments("const u = 'http://a';"))) {
    failures.push("stripComments blanked the inside of a single-quoted literal");
  }
  if (!/caught up/i.test(stripComments("if (x) return 'you are caught up';"))) {
    failures.push("stripComments lost a string opened after a keyword");
  }
  if (failures.length > 0) {
    warn("check-empty-state-claims: internal SELF-TEST FAILED — not reporting a number.");
    for (const f of failures) warn("  - " + f);
    process.exit(2);
  }
}

/* ── Allowlist ───────────────────────────────────────────────────────────── */
let allowRaw;
try {
  allowRaw = JSON.parse(fs.readFileSync(ALLOWLIST_PATH, "utf8"));
} catch (err) {
  warn(`check-empty-state-claims: cannot read ${path.relative(repoRoot, ALLOWLIST_PATH)} — ${err.message}`);
  process.exit(2);
}
const allowEntries = Array.isArray(allowRaw.reviewed) ? allowRaw.reviewed : [];
const badEntries = allowEntries.filter((e) => !e || typeof e.file !== "string" || typeof e.text !== "string" || typeof e.why !== "string" || norm(e.why).length < 12);
if (badEntries.length > 0) {
  warn("check-empty-state-claims: allowlist entries need {file, text, why} and a why of real words:");
  for (const e of badEntries) warn("  - " + JSON.stringify(e));
  process.exit(2);
}
const allowKey = (file, text) => `${file} ${norm(text)}`;
const allowed = new Map(allowEntries.map((e) => [allowKey(e.file, e.text), e]));

/* ── Scan ────────────────────────────────────────────────────────────────── */
const files = ROOTS.flatMap((r) => walk(r));
if (files.length < 500) {
  warn(`check-empty-state-claims: only ${files.length} source files found — the walk is broken, not the tree.`);
  process.exit(2);
}

const hits = [];
for (const abs of files) {
  const rel = path.relative(repoRoot, abs).split(path.sep).join("/");
  const stripped = stripComments(fs.readFileSync(abs, "utf8"));
  const lines = stripped.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const text = norm(lines[i]);
    if (!text) continue;
    const claim = CLAIMS.find((c) => c.re.test(text));
    if (!claim) continue;
    const qualified = QUALIFIERS.some((q) => q.test(text));
    hits.push({ file: rel, line: i + 1, shape: claim.id, text, qualified });
  }
}

const usedKeys = new Set();
for (const h of hits) {
  const k = allowKey(h.file, h.text);
  const e = allowed.get(k);
  if (e) { h.allowed = true; h.why = e.why; usedKeys.add(k); }
}
const qualifiedHits = hits.filter((h) => h.qualified && !h.allowed);
const reviewedHits = hits.filter((h) => h.allowed);
const unreviewed = hits.filter((h) => !h.allowed && !h.qualified);
const stale = allowEntries.filter((e) => !usedKeys.has(allowKey(e.file, e.text)));

if (jsonOut) {
  say(JSON.stringify({ scanned: files.length, hits, unreviewed, qualified: qualifiedHits, stale }, null, 2));
  process.exit(strict && unreviewed.length > 0 ? 1 : 0);
}

say(`check-empty-state-claims — ${files.length} source files scanned, ${CLAIMS.length} claim shapes.`);
say(`  ${hits.length} claim-shaped line(s): ${reviewedHits.length} reviewed, ${qualifiedHits.length} self-qualified, ${unreviewed.length} NOT reviewed.\n`);

if (qualifiedHits.length > 0) {
  /* Printed, not failed — and printed rather than dropped so the exemption can
     be argued with. Each of these states a claim in order to deny it. */
  say("SELF-QUALIFIED — states the claim in order to deny it:");
  for (const h of qualifiedHits) {
    say(`  ${h.file}:${h.line}  [${h.shape}]`);
    say(`      ${h.text.slice(0, 200)}`);
  }
  say("");
}

if (reviewedHits.length > 0) {
  say("REVIEWED — on the allowlist with a reason:");
  for (const h of reviewedHits) {
    say(`  ${h.file}:${h.line}  [${h.shape}]`);
    say(`      ${h.text.slice(0, 200)}`);
    say(`      why: ${h.why}`);
  }
  say("");
}

if (stale.length > 0) {
  /* PRINTED, NEVER FAILED. A stale entry means somebody FIXED a string, and a
     gate that punishes the fix is a gate that stops fixes. It is still noise
     that has to be cleared, so it is loud. */
  say(`STALE allowlist entries — ${stale.length} listed string(s) no longer in the tree. Delete them:`);
  for (const e of stale) say(`  ${e.file}  ${e.text.slice(0, 120)}`);
  say("");
}

if (unreviewed.length === 0) {
  say("No unreviewed completion claims.");
  say("This is NOT proof every empty state is honest — it is proof every claim-shaped");
  say("string in the tree has been looked at by a person. See the header for the limits.");
  process.exit(0);
}

say(`NOT REVIEWED — ${unreviewed.length} completion claim(s) with no decision recorded:\n`);
for (const h of unreviewed) {
  say(`  ${h.file}:${h.line}  [${h.shape}]`);
  say(`      ${h.text.slice(0, 240)}`);
}
say(`
An empty read is only ever evidence that THE QUERY FOUND NOTHING. Company scope
fails closed (backend/src/scm/lib/companyScope.ts:312 -> .in("company_id", [])
returns [] with error: null), PostgREST truncates at db-max-rows without saying
so, and a swallowed read error is indistinguishable from an empty one.

Either REWRITE the string to say what was searched and what would explain a
false empty — the owner-approved model is the from-PO picker,
frontend/src/pages/scm-v2/GrnFromPo.tsx — or add it to
backend/scripts/data/empty-state-claim-allowlist.json with a one-line reason.
Run with --suggest for paste-ready entries.`);

if (suggest) {
  say("\nPaste-ready (fill in every `why` — a placeholder is rejected):\n");
  const seen = new Set();
  const out = [];
  for (const h of unreviewed) {
    const k = allowKey(h.file, h.text);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ file: h.file, text: h.text, why: "TODO explain why this is not a completion claim" });
  }
  say(JSON.stringify(out, null, 2));
}

process.exit(strict ? 1 : 0);
