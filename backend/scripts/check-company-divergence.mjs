#!/usr/bin/env node
// ----------------------------------------------------------------------------
// check-company-divergence.mjs — ONE SYSTEM, TWO ORGANISATIONS.
//
// THE RULE (owner, 2026-08-18), which is the whole specification:
//   "两个公司不是用着同一个系统吗？他们只是 Multi-Organization 关系而已啊."
//
// One system. One set of behaviours. Two organisations' DATA. A company may
// legitimately have its own documents, its own numbering prefix, its own
// branding, and a very small number of per-company RULES THE OWNER STATED
// HIMSELF (the deposit threshold is the worked example: HOUZS 30% / 2990 50%).
// It must NOT have different CAPABILITIES by accident.
//
// So this gate does not ask "is there a company branch here". There are, and
// several are correct. It asks the only question that separates a rule from a
// defect: HAS A PERSON SAID, IN WRITING, WHY THIS ONE IS DELIBERATE. Every
// company-keyed branch in the tree is either removed or listed in
// data/company-divergence-allowlist.json with a one-line reason. A NEW one
// fails the build until somebody lists it on purpose. That is the entire
// mechanism: it converts silence into a decision.
//
// ─── WHAT THIS GATE CANNOT SEE ──────────────────────────────────────────────
// Read this before treating a green run as coverage. It is a regex over source.
// It sees CODE THAT NAMES A COMPANY. Every other way this codebase has actually
// produced a per-company difference is invisible to it, and the list is not
// hypothetical — each item below is a divergence that was really found:
//
//   · A CONFIG OR MASTER ROW THAT EXISTS FOR ONE COMPANY AND NOT THE OTHER.
//     The single largest class. `state_delivery_regions` holds 26 rows for one
//     company and 22 for the other, and the delivery board merges both; exactly
//     one warehouse in the database carries `is_consignment`. No amount of
//     reading source can tell you that — it needs a query. THIS GATE CANNOT
//     COUNT ROWS AND WILL NEVER FAIL ON ONE.
//
//   · A DATA-SHAPE DIFFERENCE. A column one company's importer writes and the
//     other's does not; a link column absent from one source schema entirely.
//     Identical code, different columns underneath.
//
//   · A GUARD KEYED ON A PROXY THAT CORRELATES WITH COMPANY. This is the one
//     that matters most, because IT IS THE BUG THAT CAUSED THIS GATE TO BE
//     WRITTEN AND THIS GATE WOULD NOT HAVE CAUGHT IT. The desktop "Transfer to
//     Sales Invoice" button was gated on a hand-typed `["signed","delivered"]`
//     while the system's own declaration of "this delivery has shipped" is five
//     states wide. Not one company term anywhere in it. It fired on one
//     organisation only because that organisation's source system had no
//     "delivered" step, so its deliveries sit at DISPATCHED. A gate that
//     searched for the word "company" would have returned zero and read as a
//     pass while an operator was staring at a missing button.
//
//     What DOES catch that class is not a regex — it is the rule the repo
//     already follows: ONE DECLARATION PER CONCEPT, mirrored rather than
//     re-typed, pinned by check-shared-mirrors.mjs. `DO_SHIPPED_STATES` now has
//     exactly one home and a frontend twin. That is the real defence; this file
//     is the smaller, cheaper half.
//
//   · WHETHER A LISTED REASON IS TRUE. The allowlist records that somebody
//     decided. It cannot check that they decided correctly.
//
// A clean run means: no company-keyed branch has appeared that nobody has
// looked at. It does NOT mean the two organisations see the same system.
//
// ─── KEYED BY TEXT, NOT BY LINE ─────────────────────────────────────────────
// Line numbers shift on every merge and a line-keyed allowlist rots into noise
// within a day. The key is (file, normalized matched line), so EDITING a listed
// branch re-opens the review and MOVING it does not.
//
// Usage:
//   node backend/scripts/check-company-divergence.mjs            # full inventory
//   node backend/scripts/check-company-divergence.mjs --strict   # exit 1 on a new branch
//   node backend/scripts/check-company-divergence.mjs --suggest  # paste-ready entries
//   node backend/scripts/check-company-divergence.mjs --json
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

const ALLOWLIST_PATH = path.join(repoRoot, "backend", "scripts", "data", "company-divergence-allowlist.json");

/* ── Output ──────────────────────────────────────────────────────────────────
   fs.writeSync into a buffer flushed from an `exit` handler, not console.log.
   console.log to a PIPE is asynchronous and `process.exit()` discards whatever
   has not drained, so a captured run (i.e. every CI run) can print a correct
   exit code next to a report that stops mid-sentence. Copied deliberately from
   check-empty-state-claims.mjs, which was corrected for exactly that. */
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

/* ── The company-keyed shapes ────────────────────────────────────────────────
   Each names ONE company, or branches on which company you are in. Ordered
   most-specific first so the reported `shape` is the useful one.

   THE LITERAL-ONLY GREP IS NOT ENOUGH, and that is why half of these exist. A
   sweep for `company_id === <n>` / `companyCode === '…'` finds 27 lines and
   misses every rule expressed against a CONSTANT — BASE_COMPANY_CODE,
   MIRRORED_COMPANY_CODE, HOUZS_COMPANY_CODE — and every rule expressed against
   a DOC-NUMBER PREFIX, which is how the SO-PO edit lock is scoped to one
   company without ever naming it. Those are real per-company rules and they
   were invisible.

   NOT INCLUDED, on purpose: a bare mention of the word "company". Scoping code
   (`scopeToCompany`, `company_id` as a column in a select or an insert) is the
   system working correctly — flagging it would bury the signal and get the gate
   switched off, which is how the previous generation of checks here died. */
const COMPANY_CODES = "HOUZS|2990";
const SHAPES = [
  /* `company_id === 1`, `companyId !== 2`, `co.companyId == 1`. The id compared
     against a bare number is the plainest form of "do something different for
     this one organisation". */
  {
    id: "company-id-literal",
    re: /\b(company_?[Ii]d)\s*[=!]==?\s*-?\d+|-?\d+\s*[=!]==?\s*\b(company_?[Ii]d)\b/,
  },
  /* `companyCode === '2990'`, `code !== "HOUZS"`. The `typeof` guard is what
     keeps the three `typeof j.companyCode === 'string'` coercions in this tree
     out of the report — they are a type test, not a company branch, and a gate
     that lists them teaches people to skim it. */
  {
    id: "company-code-literal",
    re: new RegExp(String.raw`[=!]==?\s*['"](${COMPANY_CODES})['"]|['"](${COMPANY_CODES})['"]\s*[=!]==?`),
    reject: /\btypeof\b/,
  },
  /* Compared against a company-code CONSTANT. Invisible to a literal grep and
     the reason several real rules were missed by the first sweep. */
  {
    id: "company-code-constant",
    re: /[=!]==?\s*(HOUZS_COMPANY_CODE|BASE_COMPANY_CODE|MIRRORED_COMPANY_CODE|HOUZS)\b/,
  },
  /* A rule scoped by DOC-NUMBER PREFIX rather than by company id. This is how
     the SO-PO edit lock is confined to one organisation while looking
     company-neutral, and it is exactly the "guard keyed on a proxy" shape. */
  {
    id: "company-doc-prefix",
    /* `companyDocPrefix` is deliberately NOT here. Minting a document number
       with the active company's prefix is the numbering rule working for every
       company, at ~40 call sites — listing it would add 40 identical allowlist
       entries and teach people to scroll past this report. The names kept are
       the ones that TEST a prefix to decide behaviour, which is the actual
       proxy-guard shape. */
    re: /\b(isMirroredDocNo|mintsIntoMirroredNamespace|MIGRATED_NUMBER_PREFIX|DOC_PREFIX_BY_COMPANY)\b/,
  },
  /* A lookup table keyed by company: `DOC_PREFIX_BY_COMPANY`, `X_BY_COMPANY`,
     `{ HOUZS: … }`. A per-company map is a per-company rule with extra steps. */
  {
    id: "per-company-map",
    re: /\b\w+_BY_COMPANY\b|\{\s*(HOUZS|['"]HOUZS['"])\s*:/,
  },
  /* An identifier that NAMES a company and is used as a CONDITION: isHouzs,
     is2990, isHouzsHost, isHouzsBrand, houzsOwns2990, houzsCompanyIds. The USES
     count as well as the declaration, because each use is its own behavioural
     fork.

     AN EXPLICIT LIST OF IDENTIFIER NAMES, not a pattern over "any word
     containing a company name". The first draft here was
     `\b\w*(2990)\w*\b` with a loose "is it in a condition" guard, and it
     reported 1013 lines — every `@2990s/shared` import, every `Scm2990Shell`,
     every type annotation with a colon in it. That is not a stricter gate, it
     is a gate somebody switches off in week two, and this repo has already
     buried one generation of checks that way. Narrow and true beats wide and
     ignored: a new company-named boolean costs one line here, and the cost is
     the point — adding it is the moment somebody decides. */
  {
    id: "company-named-identifier",
    re: /\b(isHouzs\w*|is2990\w*|houzsOwns2990|houzsCompanyIds|houzsCompanySql)\b/,
  },
];

/* ── Where company-keyed code lives ─────────────────────────────────────────
   Both trees, both extensions, INCLUDING tests — a test is exactly where a
   per-company assumption gets declared correct and frozen. */
const ROOTS = [
  path.join(repoRoot, "frontend", "src"),
  path.join(repoRoot, "backend", "src"),
  /* An EXTRA root, used by tests/companyDivergenceGate.test.ts to plant a
     violation OUTSIDE the source tree and watch this exit 1. A gate nobody has
     seen fail is not a gate — check-trgm-coverage.mjs sat in this repo with
     BOTH exit paths at exit 0 and in no workflow at all, and read as a pass for
     weeks. Unset in every real invocation. */
  ...(process.env.COMPANY_DIVERGENCE_EXTRA_ROOT ? [process.env.COMPANY_DIVERGENCE_EXTRA_ROOT] : []),
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
   Comments in this repo are long and several of them QUOTE the branch they are
   explaining — including, now, the two files this run's fix touched. Scanning
   comments would flag the explanation as the offence, and every explanation
   would need an allowlist entry, which is how a gate becomes noise.

   Char-level rather than regex, because `"http://x"` and a template literal both
   defeat the regex version, and a stripper that eats a string literal HIDES
   hits — a checker whose number is too small is the failure this repo has now
   hit five times. Lifted from check-empty-state-claims.mjs, which was corrected
   for the JSX-apostrophe bug this inherits the fix for. Newlines preserved so
   line numbers survive. */
const OPENERS = new Set(["=", "(", "[", "{", ",", ";", ":", "?", "+", "&", "|", "!", "\n", undefined]);
const OPENER_WORDS = new Set(["return", "typeof", "case", "in", "of", "await", "throw", "new", "delete", "void", "yield", "do", "else", "from", "import", "export", "extends", "as", "satisfies"]);
function opensString(src, at) {
  let j = at - 1;
  while (j >= 0 && (src[j] === " " || src[j] === "\t")) j--;
  const prev = j < 0 ? undefined : src[j];
  if (OPENERS.has(prev)) return true;
  if (prev === undefined) return true;
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
  let tplDepth = 0;
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

function matchShape(line) {
  for (const s of SHAPES) {
    if (!s.re.test(line)) continue;
    if (s.reject && s.reject.test(line)) continue;
    if (s.require && !s.require.test(line)) continue;
    return s;
  }
  return null;
}

/* ── SELF-TEST ───────────────────────────────────────────────────────────────
   Six checkers in this repo have reported a plausible WRONG number from a
   pattern that could not match — one of them had a startup self-test that only
   exercised the form it was written against, which is a self-test that passes
   for the same reason the bug exists. So mustMiss below is as long as mustHit,
   and it is drawn from lines that ACTUALLY EXIST in this tree and must not be
   reported. A checker that cannot detect the thing it is named after must SAY
   SO, not print zero and exit 0. */
{
  const failures = [];
  const mustHit = [
    ["if (company_id === 1) return x;", "company-id-literal"],
    ["const a = co.companyId !== 2 ? x : y;", "company-id-literal"],
    ["const caseEntity = companyCode === \"2990\" ? \"2990\" : \"houzs\";", "company-code-literal"],
    ["const isHouzs = branding.companyCode === HOUZS_COMPANY_CODE;", "company-code-constant"],
    ["if (!isHouzs) return '2990 Sofa';", "company-named-identifier"],
    ["if (!docNo || !isMirroredDocNo(docNo)) return false;", "company-doc-prefix"],
    ["const DOC_PREFIX_BY_COMPANY = { HOUZS: 'HC-' };", "company-doc-prefix"],
  ];
  for (const [probe, id] of mustHit) {
    const got = matchShape(norm(stripComments(probe)));
    if (!got) failures.push(`no shape fired on: ${probe}`);
    else if (got.id !== id) failures.push(`expected ${id}, got ${got.id}, on: ${probe}`);
  }
  const mustMiss = [
    // Ordinary company SCOPING is the system working. Never a finding.
    "const scoped = scopeToCompany(base, c);",
    "let q = sb.from('warehouses').select('id').eq('company_id', companyId);",
    "if (companyId != null) q = q.eq('company_id', companyId);",
    "export function requireActiveCompanyId(c: CompanyScopeCtx): RequiredCompany {",
    // A TYPE test, not a company branch. Three of these live in the tree.
    "companyCode: typeof j.companyCode === 'string' ? j.companyCode : null,",
    "if (key === 'companyCode') return typeof opts.companyCode === 'string' ? opts.companyCode : undefined;",
    // An import path that happens to contain a company name.
    "import { fmtDate } from '@2990s/shared';",
    "import { buildVariantSummary } from \"@2990s/shared\";",
    // A column named company_id being written, not compared.
    "const o = { company_id: cid };",
  ];
  for (const probe of mustMiss) {
    const got = matchShape(norm(stripComments(probe)));
    if (got) failures.push(`shape ${got.id} FALSE-POSITIVED on: ${probe}`);
  }
  // The stripper must drop a comment and KEEP a string that looks like one.
  if (norm(stripComments("// isHouzs ? a : b\nconst u = \"http://a//b\";")) !== 'const u = "http://a//b";') {
    failures.push("stripComments mangled a URL or failed to drop a line comment");
  }
  if (/isHouzs/.test(stripComments("/* isHouzs decides the logo */ const a = 1;"))) {
    failures.push("stripComments left a block comment in place");
  }
  if (!/2990/.test(stripComments("const a = `brand ${is2990}`;"))) {
    failures.push("stripComments ate a template literal's text");
  }
  if (failures.length > 0) {
    warn("check-company-divergence: internal SELF-TEST FAILED — not reporting a number.");
    for (const f of failures) warn("  - " + f);
    process.exit(2);
  }
}

/* ── Allowlist ───────────────────────────────────────────────────────────── */
let allowRaw;
try {
  allowRaw = JSON.parse(fs.readFileSync(ALLOWLIST_PATH, "utf8"));
} catch (err) {
  warn(`check-company-divergence: cannot read ${path.relative(repoRoot, ALLOWLIST_PATH)} — ${err.message}`);
  process.exit(2);
}
const allowEntries = Array.isArray(allowRaw.reviewed) ? allowRaw.reviewed : [];
/* A `why` of real words, and a `whoSetIt`. The second field is the one that
   matters for this particular gate: the owner's position is that a per-company
   difference is legitimate only when HE stated it, so an entry has to say whose
   decision it was. "Historical" and "legacy" are not people. */
const badEntries = allowEntries.filter(
  (e) => !e || typeof e.file !== "string" || typeof e.text !== "string"
    || typeof e.why !== "string" || norm(e.why).length < 12
    || typeof e.whoSetIt !== "string" || norm(e.whoSetIt).length < 4,
);
if (badEntries.length > 0) {
  warn("check-company-divergence: allowlist entries need {file, text, why, whoSetIt}, a why of real words and a named decider:");
  for (const e of badEntries) warn("  - " + JSON.stringify(e));
  process.exit(2);
}
const allowKey = (file, text) => `${file} ${norm(text)}`;
const allowed = new Map(allowEntries.map((e) => [allowKey(e.file, e.text), e]));

/* ── Scan ────────────────────────────────────────────────────────────────── */
const files = ROOTS.flatMap((r) => walk(r));
if (files.length < 500) {
  warn(`check-company-divergence: only ${files.length} source files found — the walk is broken, not the tree.`);
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
    const shape = matchShape(text);
    if (!shape) continue;
    hits.push({ file: rel, line: i + 1, shape: shape.id, text });
  }
}

const usedKeys = new Set();
for (const h of hits) {
  const k = allowKey(h.file, h.text);
  const e = allowed.get(k);
  if (e) { h.allowed = true; h.why = e.why; h.whoSetIt = e.whoSetIt; usedKeys.add(k); }
}
const reviewedHits = hits.filter((h) => h.allowed);
const unreviewed = hits.filter((h) => !h.allowed);
const stale = allowEntries.filter((e) => !usedKeys.has(allowKey(e.file, e.text)));

if (jsonOut) {
  say(JSON.stringify({ scanned: files.length, hits, unreviewed, stale }, null, 2));
  process.exit(strict && unreviewed.length > 0 ? 1 : 0);
}

say(`check-company-divergence — ${files.length} source files scanned, ${SHAPES.length} company-keyed shapes.`);
say(`  ${hits.length} company-keyed line(s): ${reviewedHits.length} reviewed, ${unreviewed.length} NOT reviewed.\n`);

if (reviewedHits.length > 0) {
  const byFile = new Map();
  for (const h of reviewedHits) {
    if (!byFile.has(h.file)) byFile.set(h.file, []);
    byFile.get(h.file).push(h);
  }
  say("REVIEWED — a stated per-company difference, with whose decision it was:");
  for (const [file, rows] of [...byFile.entries()].sort()) {
    say(`  ${file}  (${rows.length})`);
    say(`      why: ${rows[0].why}`);
    say(`      set by: ${rows[0].whoSetIt}`);
  }
  say("");
}

if (stale.length > 0) {
  /* PRINTED, NEVER FAILED. A stale entry means somebody REMOVED a per-company
     branch, which is the direction this gate wants. A gate that punishes the
     fix is a gate that stops fixes. Still noise, so it is loud. */
  say(`STALE allowlist entries — ${stale.length} listed branch(es) no longer in the tree. Delete them:`);
  for (const e of stale) say(`  ${e.file}  ${e.text.slice(0, 120)}`);
  say("");
}

if (unreviewed.length === 0) {
  say("No unreviewed per-company branches.");
  say("This is NOT proof the two organisations see the same system — it is proof every");
  say("company-NAMING line has been looked at by a person. A missing config row, a");
  say("column one importer never writes, and a status list that only ever matches one");
  say("company's rows are all invisible here. See WHAT THIS GATE CANNOT SEE in the header.");
  process.exit(0);
}

say(`NOT REVIEWED — ${unreviewed.length} per-company branch(es) with no decision recorded:\n`);
for (const h of unreviewed) {
  say(`  ${h.file}:${h.line}  [${h.shape}]`);
  say(`      ${h.text.slice(0, 240)}`);
}
say(`
ONE SYSTEM, TWO ORGANISATIONS (owner 2026-08-18). A company may have its own
DATA — its documents, its numbering prefix, its branding — and a small number of
RULES THE OWNER STATED HIMSELF. It may not have different CAPABILITIES by
accident.

Either REMOVE the difference (preferred — a per-company switch is a second home
for a rule, and two homes is how the transfer button ended up with three
different definitions of "shipped"), or add it to
backend/scripts/data/company-divergence-allowlist.json with a one-line reason
AND the name of whoever decided it. Run with --suggest for paste-ready entries.`);

if (suggest) {
  say("\nPaste-ready (fill in every `why` and `whoSetIt` — placeholders are rejected):\n");
  const seen = new Set();
  const out = [];
  for (const h of unreviewed) {
    const k = allowKey(h.file, h.text);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({
      file: h.file,
      text: h.text,
      why: "TODO explain why this per-company difference is deliberate",
      whoSetIt: "TODO name who decided it",
    });
  }
  say(JSON.stringify(out, null, 2));
}

process.exit(strict ? 1 : 0);
