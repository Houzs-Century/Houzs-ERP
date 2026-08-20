#!/usr/bin/env node
// ----------------------------------------------------------------------------
// check-date-formatting.mjs — ONE DATE FORMAT, ONE PLACE THAT WRITES IT.
//
// THE RULE (owner, 2026-08-18: "全套系统的 date format 没有统一"). Every date a
// user reads is DD/MM/YYYY, numeric, day-first; every timestamp is
// DD/MM/YYYY HH:mm. It is produced by `fmtDate` / `fmtDateTime` in
// frontend/src/vendor/shared/format.ts (mirrored in backend/src/scm/shared/
// format.ts) and NOWHERE ELSE.
//
// WHY A GATE AND NOT A HABIT. The rule was already written down TWICE — once in
// frontend/src/lib/utils.ts ("House style is numeric DD/MM/YYYY … no 'Jun'/'Jul'
// month names anywhere on the desktop app") and once in shared/format.ts
// ("System-wide canonical display format (Commander 2026-06-18)") — and was then
// re-derived by hand about thirty more times in four other spellings:
// `2026/08/16` on all eleven V2 list pages, `16/08/2026` via a copied regex on
// their eight detail pages, `16 Aug 2026` in the print routes, raw
// `2026-08-16` in Fleet, and the OS locale in 175 native `<input type="date">`.
// A list and the detail page one click from it spelled the same date two ways.
// That is the shape this repo keeps producing: a rule expressed at N sites and
// present at N-1 of them. Writing it down a third time would have been the same
// move that failed twice.
//
// WHAT THIS IS, STATED SO A GREEN RUN IS NOT OVER-READ. A regex over source
// cannot understand meaning. It cannot tell a date from a fraction, it cannot
// see a format assembled at runtime, and it cannot tell whether a string it
// found is ever shown to anybody. So it is NOT a date-format detector — it is a
// REVIEWED ALLOWLIST over a fixed list of date-formatting SHAPES. Every
// occurrence in the tree is either routed through the one formatter or listed
// in data/date-format-allowlist.json with a one-line reason. A NEW one fails the
// build until somebody puts it on the list deliberately. It converts silence
// into a decision; it does not prove the entries that passed are right.
//
// WHAT IT CANNOT SEE:
//   · a format built at runtime from fragments, or via a helper it cannot
//     follow;
//   · whether a hit is user-facing at all — a doc-comment quoting a bad shape
//     is a hit, and the allowlist is where that is recorded;
//   · a date rendered by a LIBRARY (a chart axis, a third-party picker);
//   · whether `fmtDate` itself is correct. That is
//     frontend/src/vendor/shared/format.date.canonical.test.ts's job, and it is
//     the file that proves the timezone and null behaviour.
//
// KEYED BY TEXT, NOT BY LINE, for the same reason as
// check-empty-state-claims.mjs: line numbers shift on every merge, so the key is
// (file, normalized matched line). EDITING a listed line re-opens the review;
// MOVING it does not.
//
// Usage:
//   node backend/scripts/check-date-formatting.mjs            # full inventory
//   node backend/scripts/check-date-formatting.mjs --strict   # exit 1 on a new hit
//   node backend/scripts/check-date-formatting.mjs --suggest  # paste-ready entries
//   node backend/scripts/check-date-formatting.mjs --json
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

const ALLOWLIST_PATH = path.join(repoRoot, "backend", "scripts", "data", "date-format-allowlist.json");

/* ── Output ──────────────────────────────────────────────────────────────────
   Buffered and flushed from an `exit` handler, exactly as
   check-empty-state-claims.mjs does and for the reason recorded there:
   console.log to a PIPE is asynchronous and `process.exit()` discards what has
   not drained, so a captured run printed a correct exit code beside a report
   that stopped mid-sentence. CI captures. */
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

/* ── The date-formatting shapes ──────────────────────────────────────────────
   Each one is a way this tree has ACTUALLY spelled a date by hand. Every
   pattern below was written from source that shipped; none is hypothetical.

   Deliberately NOT included, because each fires on hundreds of honest lines and
   a gate that cries wolf gets deleted — which is how the previous generation of
   checks here died:
     · `new Date(` — the app is full of legitimate date ARITHMETIC.
     · `.slice(0, 10)` — the ISO-value idiom, correct at every input site.
     · `padStart(2, '0')` on its own — document numbers (`HC-SO-2608-001`) are
       built that way and must never change. */
const SHAPES = [
  {
    id: "toLocaleDateString",
    // The OS-locale renderer. This is the literal "有时候 MMDDYYYY" bug: the
    // same value reads DD/MM/YYYY on one machine and MM/DD/YYYY on another.
    re: /\.toLocaleDateString\s*\(/,
  },
  {
    id: "toLocaleTimeString",
    re: /\.toLocaleTimeString\s*\(/,
  },
  {
    id: "toLocaleString-bare",
    /* `d.toLocaleString()` with no locale and no options — three of these
       shipped (Announcements, MailCenter Inbox and Thread) and each rendered
       whatever the viewer's machine felt like.

       THE HONEST LIMIT, and the self-test below pins it: an argument-less
       `.toLocaleString()` is a DATE renderer on a Date and a THOUSANDS
       SEPARATOR on a number, and this repo has ~40 of the number kind
       (`{r.count.toLocaleString()}`). No regex can tell them apart, so this
       fires only when the receiver is visibly a date — `new Date(x)` or an
       identifier that reads like one. A date held in a variable named
       something else is INVISIBLE HERE. That is a real hole, stated rather
       than papered over; the alternative was ~40 false positives, and a gate
       that cries wolf is a gate somebody deletes. */
    re: /(?:new\s+Date\s*\([^)]*\)|\b(?:d|dt|date|when|ts|iso|stamp|createdAt|updatedAt|\w*(?:Date|At|Time))\b)\.toLocaleString\s*\(\s*\)/,
  },
  {
    id: "month-name-array",
    // A hand-rolled month vocabulary. Three of these existed; the owner's own
    // rule in lib/utils.ts forbids month names on the desktop app.
    re: /["']Jan["']\s*,\s*["']Feb["']|["']January["']\s*,\s*["']February["']/,
  },
  {
    id: "raw-date-input",
    // A native date input renders in the OPERATING SYSTEM's locale. DateField
    // exists to fix exactly this and is the only legitimate holder of one.
    re: /<input\b[^>]*\btype\s*=\s*["']date["']|\btype\s*=\s*["']date["']/,
  },
  {
    id: "iso-to-slashes",
    // `iso.replace(/-/g, '/')` — the YYYY/MM/DD spelling that all eleven V2
    // list pages carried while their detail pages carried DD/MM/YYYY.
    re: /\.replace\s*\(\s*\/-\/g\s*,\s*["']\/["']\s*\)/,
  },
  {
    id: "dmy-regex-reorder",
    // `${m[3]}/${m[2]}/${m[1]}` — the copied day-first reorder, eight times.
    re: /\$\{\s*\w+\[3\]\s*\}\s*\/\s*\$\{\s*\w+\[2\]\s*\}\s*\/\s*\$\{\s*\w+\[1\]\s*\}/,
  },
  {
    id: "hand-rolled-dmy",
    // A date assembled from parts: `${dd}/${mm}/${yyyy}`, `${d}/${m}/${y}`.
    // Anchored on day/month/year-ish identifiers so a fraction or a path does
    // not match.
    re: /\$\{\s*(?:dd?|day)\w*\s*\}\s*\/\s*\$\{\s*(?:mm?|mon|month)\w*\s*\}\s*\/\s*\$\{\s*(?:y{2,4}|year)\w*\s*\}/i,
  },
  {
    id: "hand-rolled-ymd-display",
    // `${yyyy}-${mm}-${dd}` / `${yyyy}/${mm}/${dd}` — the STORAGE shape built
    // by hand. Legitimate as a VALUE producer (and several are, on the
    // allowlist); it reached a screen in FleetHealth and the ASSR print stamp.
    re: /\$\{\s*(?:y{2,4}|year)\w*\s*\}\s*[-/]\s*\$\{\s*(?:mm?|mon|month)\w*\s*\}\s*[-/]\s*\$\{\s*(?:dd?|day)\w*\s*\}/i,
  },
  {
    id: "intl-datetimeformat",
    // `new Intl.DateTimeFormat(...)` — the memoised formatters in lib/utils.ts
    // and the en-MY ones in my-time.ts were all this shape.
    re: /new\s+Intl\.DateTimeFormat\s*\(/,
  },
];

/* ── Where dates are formatted ───────────────────────────────────────────────
   Both trees, both extensions, INCLUDING tests — a test is exactly where the
   last rule in this repo was declared correct while being wrong. */
const ROOTS = [
  path.join(repoRoot, "frontend", "src"),
  path.join(repoRoot, "backend", "src"),
  /* An EXTRA root, used by tests/dateFormatGate.test.ts to plant a violation
     OUTSIDE the source tree and watch this exit 1. A gate nobody has seen fail
     is not a gate, and proving it by hand once proves it for one afternoon.
     Unset in every real invocation. */
  ...(process.env.DATE_FORMAT_EXTRA_ROOT ? [process.env.DATE_FORMAT_EXTRA_ROOT] : []),
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
   Comments in this repo are long and several of them QUOTE the bad shapes on
   purpose — DateField.tsx's header names `<input type="date">` in order to
   explain why it exists, and format.ts quotes the old `toLocaleDateString` body
   it replaced. Scanning comments would flag the explanation as the offence.

   Line-based and deliberately crude: a full char-level tokenizer is what
   check-empty-state-claims.mjs needs because it matches ENGLISH SENTENCES that
   live inside string literals. Every shape here is CODE, so blanking a line
   comment tail and the block-comment spans is enough, and the cases where a `//` appears inside a
   string ('http://…', a regex literal) are handled by not blanking when the
   `//` is preceded by a quote or a colon. Getting this wrong in the direction
   of keeping too much costs an allowlist entry; the other direction hides a
   hit, so the doubtful case keeps the text. */
function stripComments(src) {
  const lines = src.split("\n");
  let inBlock = false;
  return lines
    .map((line) => {
      let out = "";
      let i = 0;
      while (i < line.length) {
        if (inBlock) {
          const end = line.indexOf("*/", i);
          if (end === -1) { i = line.length; break; }
          inBlock = false; i = end + 2; continue;
        }
        const bs = line.indexOf("/*", i);
        const ls = line.indexOf("//", i);
        // A `//` that is part of a URL or a regex is not a comment opener.
        const lineComment =
          ls !== -1 && !/[:"'`\\/]$/.test(line.slice(Math.max(0, ls - 1), ls));
        if (bs !== -1 && (ls === -1 || bs < ls)) {
          out += line.slice(i, bs); i = bs + 2; inBlock = true; continue;
        }
        if (ls !== -1 && lineComment) { out += line.slice(i, ls); i = line.length; break; }
        out += line.slice(i); i = line.length;
      }
      return out;
    })
    .join("\n");
}

const norm = (s) => s.trim().replace(/\s+/g, " ");

/* ── SELF-TEST ───────────────────────────────────────────────────────────────
   Five checkers in this repo have reported a plausible WRONG number from a
   pattern that could not match — one of them (check-shared-mirrors.mjs) shipped
   a dead pattern precisely because it had no self-test. Assert the machinery on
   known inputs before trusting a single count out of it. The MISS list matters
   as much as the HIT list: `fmtSen` is `toLocaleString('en-MY', {...})` and a
   gate that fires on money is a gate somebody switches off. */
{
  const failures = [];
  const mustHit = [
    ['const s = d.toLocaleDateString("en-GB", { day: "2-digit" });', "toLocaleDateString"],
    ["const t = d.toLocaleTimeString('en-GB', { hour: '2-digit' });", "toLocaleTimeString"],
    ["return new Date(t).toLocaleString();", "toLocaleString-bare"],
    ['const M = ["Jan","Feb","Mar"];', "month-name-array"],
    ['<input type="date" value={x} />', "raw-date-input"],
    "const s = iso.replace(/T.*$/, '').replace(/-/g, '/');",
    "return `${m[3]}/${m[2]}/${m[1]}`;",
    "return `${dd}/${mm}/${yyyy}`;",
    "return `${yyyy}-${mm}-${dd} ${hh}:${min}`;",
    'const f = new Intl.DateTimeFormat("en-GB", { timeZone: TZ });',
  ];
  for (const probe of mustHit) {
    const [text, id] = Array.isArray(probe) ? probe : [probe, null];
    const line = stripComments(text);
    const hit = SHAPES.find((c) => c.re.test(line));
    if (!hit) failures.push(`no shape fired on: ${text}`);
    else if (id && hit.id !== id) failures.push(`expected shape ${id}, got ${hit.id}, on: ${text}`);
  }
  const mustMiss = [
    // MONEY. fmtSen/fmtMoneySen/fmtQty are all toLocaleString with options.
    "return `RM ${(n / 100).toLocaleString('en-MY', { minimumFractionDigits: 2 })}`;",
    'value={total.toLocaleString("en-MY")}',
    "{r.count.toLocaleString()}",
    // DOCUMENT NUMBERS. `HC-SO-2608-001` is built exactly like this and a gate
    // that touched it would corrupt every numbering sequence in the ERP.
    "const yymm = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}`;",
    // ISO VALUE PRODUCERS — the correct idiom at every input and payload site.
    "const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);",
    "value={draft.lineDeliveryDate ?? ''}",
    // The one formatter's own callers.
    "<td>{fmtDate(row.po_date)}</td>",
    "const label = fmtDateTime(r.created_at);",
  ];
  for (const probe of mustMiss) {
    const line = stripComments(probe);
    const hit = SHAPES.find((c) => c.re.test(line));
    if (hit) failures.push(`shape ${hit.id} FALSE-POSITIVED on honest code: ${probe}`);
  }
  // The stripper must drop a comment and KEEP code that looks like one.
  if (/toLocaleDateString/.test(stripComments('// d.toLocaleDateString("en-GB")\nconst a = 1;'))) {
    failures.push("stripComments left a line comment in place");
  }
  if (/toLocaleDateString/.test(stripComments('/* d.toLocaleDateString() */ const a = 1;'))) {
    failures.push("stripComments left a block comment in place");
  }
  if (!/http:\/\/a/.test(stripComments("const u = 'http://a';"))) {
    failures.push("stripComments blanked a URL inside a string");
  }
  if (!/toLocaleDateString/.test(stripComments('const s = d.toLocaleDateString("en-GB"); // why'))) {
    failures.push("stripComments ate the code before a trailing comment");
  }
  if (failures.length > 0) {
    warn("check-date-formatting: internal SELF-TEST FAILED — not reporting a number.");
    for (const f of failures) warn("  - " + f);
    process.exit(2);
  }
}

/* ── Allowlist ───────────────────────────────────────────────────────────── */
let allowRaw;
try {
  allowRaw = JSON.parse(fs.readFileSync(ALLOWLIST_PATH, "utf8"));
} catch (err) {
  warn(`check-date-formatting: cannot read ${path.relative(repoRoot, ALLOWLIST_PATH)} — ${err.message}`);
  process.exit(2);
}
const allowEntries = Array.isArray(allowRaw.reviewed) ? allowRaw.reviewed : [];
const badEntries = allowEntries.filter(
  (e) => !e || typeof e.file !== "string" || typeof e.text !== "string" || typeof e.why !== "string" || norm(e.why).length < 12,
);
if (badEntries.length > 0) {
  warn("check-date-formatting: allowlist entries need {file, text, why} and a why of real words:");
  for (const e of badEntries) warn("  - " + JSON.stringify(e));
  process.exit(2);
}
const allowKey = (file, text) => `${file} ${norm(text)}`;
const allowed = new Map(allowEntries.map((e) => [allowKey(e.file, e.text), e]));

/* Whole FILES that are the rule itself or its proof. Deliberately tiny, and
   deliberately not a directory prefix: `vendor/shared` as a whole would have
   exempted every future date helper somebody drops beside format.ts. */
const RULE_FILES = new Set([
  "frontend/src/vendor/shared/format.ts",
  "backend/src/scm/shared/format.ts",
  "frontend/src/vendor/shared/format.date.canonical.test.ts",
  "frontend/src/vendor/scm/components/DateField.tsx",
]);

/* ── Scan ────────────────────────────────────────────────────────────────── */
const files = ROOTS.flatMap((r) => walk(r));
if (files.length < 500 && !process.env.DATE_FORMAT_EXTRA_ROOT) {
  warn(`check-date-formatting: only ${files.length} source files found — the walk is broken, not the tree.`);
  process.exit(2);
}

const hits = [];
for (const abs of files) {
  const rel = path.relative(repoRoot, abs).split(path.sep).join("/");
  if (RULE_FILES.has(rel)) continue;
  const stripped = stripComments(fs.readFileSync(abs, "utf8"));
  const lines = stripped.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const text = norm(lines[i]);
    if (!text) continue;
    const shape = SHAPES.find((c) => c.re.test(text));
    if (!shape) continue;
    hits.push({ file: rel, line: i + 1, shape: shape.id, text });
  }
}

const usedKeys = new Set();
for (const h of hits) {
  const k = allowKey(h.file, h.text);
  const e = allowed.get(k);
  if (e) { h.allowed = true; h.why = e.why; usedKeys.add(k); }
}
const reviewedHits = hits.filter((h) => h.allowed);
const unreviewed = hits.filter((h) => !h.allowed);
const stale = allowEntries.filter((e) => !usedKeys.has(allowKey(e.file, e.text)));

if (jsonOut) {
  say(JSON.stringify({ scanned: files.length, hits, unreviewed, stale }, null, 2));
  process.exit(strict && unreviewed.length > 0 ? 1 : 0);
}

say(`check-date-formatting — ${files.length} source files scanned, ${SHAPES.length} date-format shapes.`);
say(`  ${hits.length} hand-rolled date-format line(s): ${reviewedHits.length} reviewed, ${unreviewed.length} NOT reviewed.\n`);

if (reviewedHits.length > 0) {
  const byFile = new Map();
  for (const h of reviewedHits) {
    if (!byFile.has(h.file)) byFile.set(h.file, []);
    byFile.get(h.file).push(h);
  }
  say(`REVIEWED — on the allowlist with a reason (${byFile.size} files):`);
  for (const [file, hs] of byFile) {
    say(`  ${file}`);
    for (const h of hs) {
      say(`      :${h.line} [${h.shape}] ${h.text.slice(0, 150)}`);
      say(`         why: ${h.why}`);
    }
  }
  say("");
}

if (stale.length > 0) {
  /* PRINTED, NEVER FAILED — same reasoning as the empty-state gate. A stale
     entry means somebody FIXED a line, and a gate that punishes the fix is a
     gate that stops fixes. Still noise, so it is loud. */
  say(`STALE allowlist entries — ${stale.length} listed line(s) no longer in the tree. Delete them:`);
  for (const e of stale) say(`  ${e.file}  ${e.text.slice(0, 120)}`);
  say("");
}

if (unreviewed.length === 0) {
  say("No unreviewed date formatting.");
  say("This is NOT proof every date on screen is right — it is proof every line in");
  say("the tree that SPELLS a date by hand has been looked at by a person. The");
  say("format itself is proven by format.date.canonical.test.ts. See the header.");
  process.exit(0);
}

say(`NOT REVIEWED — ${unreviewed.length} hand-rolled date format(s) with no decision recorded:\n`);
for (const h of unreviewed) {
  say(`  ${h.file}:${h.line}  [${h.shape}]`);
  say(`      ${h.text.slice(0, 240)}`);
}
say(`
There is ONE date format and ONE place that writes it:

    import { fmtDate, fmtDateTime } from '@2990s/shared';   // frontend
    import { fmtDate, fmtDateTime } from '../shared/format'; // backend

    fmtDate(iso)      -> "16/08/2026"
    fmtDateTime(iso)  -> "16/08/2026 14:30"

Both are null-safe ("—"), invalid-safe, idempotent, and do NOT shift a date-only
value across a timezone. For a date INPUT use <DateField> — a native
<input type="date"> renders in the viewer's OS locale, which is the bug this
whole rule exists for. For a CSV cell the grids already emit ISO via
isoForExport; do not hand-format there.

Storage, API payloads and AutoCount stay ISO YYYY-MM-DD and are none of this
gate's business — if that is what your line is doing, add it to
backend/scripts/data/date-format-allowlist.json with a one-line reason.
Run with --suggest for paste-ready entries.`);

if (suggest) {
  say("\nPaste-ready (fill in every `why` — a placeholder is rejected):\n");
  const seen = new Set();
  const out = [];
  for (const h of unreviewed) {
    const k = allowKey(h.file, h.text);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ file: h.file, text: h.text, why: "TODO explain why this is not a second date format" });
  }
  say(JSON.stringify(out, null, 2));
}

process.exit(strict ? 1 : 0);
