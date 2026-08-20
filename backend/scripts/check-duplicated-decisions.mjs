#!/usr/bin/env node
// ----------------------------------------------------------------------------
// check-duplicated-decisions.mjs — A BUSINESS RULE MAY HAVE ONE HOME, OR IT MAY
// HAVE TWO WITH A REFEREE. IT MAY NOT HAVE TWO WITH NOBODY WATCHING.
//
// THE OWNER'S ASK (2026-08-18): "同一条规则两个家 —— 又是今天那个形状 … 那这一个要
// 统一一下吧。然后系统也是要查看这些类型的问题，要统一掉." Unify the instances, and
// make the SYSTEM look for this class.
//
// THE DEFECT SHAPE. One business question, answered independently in more than
// one place. Nobody is careless: the second copy gets written because the first
// was in the wrong layer to reach, or because a new path was added by somebody
// who did not know the rule existed. Then it drifts, and the failure is always
// the same — the rule is enforced at N-1 of N places and the missing one is
// invisible, because nothing errors. Every one of these was found here in the
// last three days:
//
//   · the both-dates-or-neither rule, hand-written in FIVE files; the CO header
//     PATCH had no copy at all (scm/shared/so-processing-date.ts:133+);
//   · the unlinked-line money guard, on the INSERT path of five chains and the
//     EDIT path of none (PR #2374);
//   · the typographic-quote normaliser, added to the pricing engine and never
//     to the allowed-options gate — 30.3% of live bedframe combinations refused
//     on prod because an inch mark was curly (PR #2379);
//   · the stock-readiness label, built twice, so one screen printed a retired
//     label as a group header over rows whose own cells used the corrected one.
//
// SO THE TARGET IS NOT "DUPLICATION". Duplicated utility code is cheap and
// usually fine. The target is a DUPLICATED DECISION: two pieces of code
// independently deciding the same business question.
//
// ── THE THREE DETECTORS ────────────────────────────────────────────────────
//
//   D1  SAME-VALUED STRING SET UNDER DIFFERENT NAMES. Every array of string
//       literals (this covers `new Set([...])`, `as const` tuples and inline
//       PostgREST `.in('status', [...])` filters) and every NAMED constant
//       object whose keys are an enum vocabulary, canonicalised to a
//       fingerprint (uppercase, trim, dedupe, sort, join). A fingerprint
//       carried by two or more FILES is a hit. This is the class
//       check-shared-mirrors.mjs declares itself blind to at its own lines
//       32-35 — "a rule re-implemented under a DIFFERENT filename".
//
//   D2  NEAR-MISS SETS — the one that matters most. Every pair of D1
//       fingerprints with Jaccard >= 0.75 that is NOT identical, reported with
//       the exact differing members. This is what sees a rule enforced at N-1
//       of N. It fires today on the three live spellings of "which SO statuses
//       are done" — FOUR at routes/inventory.ts, FIVE at routes/inventory.ts,
//       SIX at shared/so-terminal-states.ts — two of them same-named constants
//       with different contents inside ONE file.
//
//   D3  A GUARD SYMBOL MISSING FROM A SIBLING HANDLER. Config-driven. For each
//       route registration matching a pattern, take the BALANCED-BRACE slice of
//       that handler and assert the guard appears INSIDE it. This is the only
//       detector of the three that catches an ABSENCE rather than a
//       duplication, and the balanced slice is the whole point: a file-level
//       grep passes when the guard is present in a NEIGHBOURING handler, which
//       is exactly the INSERT-guarded / EDIT-unguarded shape behind PR #2374.
//
// ── WHAT THIS GATE CANNOT CATCH ────────────────────────────────────────────
// Stated here so a green run is not over-read. A gate believed to cover more
// than it does is worse than no gate, and this repo has been burned by exactly
// that twice this week.
//
//   1. A SEMANTIC DUPLICATE WHOSE COPIES SHARE NO LITERAL. The total-height
//      arithmetic (divan + leg + gap) is duplicated across fifteen surfaces —
//      SoLineCard.tsx, PurchaseOrderNew.tsx, GrnNew.tsx, StockAdjustmentNew.tsx
//      and more. All of them share the same arithmetic and the same regex; the
//      divergence lives in CONTROL FLOW (`if (!computedTotalHeight) return;`
//      versus an unconditional assignment). D1 and D2 would call those copies
//      identical. Only a test feeding both implementations one corpus catches
//      it — which is why the twin-agreement tests are a separate mechanism and
//      never a fallback for this script.
//   2. A RULE EXPRESSED ONCE IN TYPESCRIPT AND ONCE IN SQL. The venue map and
//      its migration triggers are invisible here.
//   3. WHETHER A FLAGGED PAIR IS EVEN THE SAME QUESTION. routes/pos.ts
//      deliberately omits DRAFT from its status filter because it is drawing a
//      pipeline card and not a commission figure; it will collide with the SO
//      threshold family. That judgement is exactly what the allowlist `why`
//      field exists to record.
//   4. ANYTHING ASSEMBLED AT RUNTIME from fragments, and anything below the
//      three-member floor. THE FLOOR IS LOAD-BEARING AND IT HAS A KNOWN COST:
//      the PO receivable threshold is a TWO-member set
//      (`['SUBMITTED','PARTIALLY_RECEIVED']`) written out at four homes —
//      routes/grns.ts, routes/inventory.ts, routes/mfg-purchase-orders.ts and
//      services/agents/procurement-learning.ts — and this script CANNOT SEE IT.
//      Dropping the floor to two was measured: it adds 115 hits that are almost
//      entirely camelCase-to-snake_case column aliases (`['debtorCode',
//      'debtor_code']`), which fold together only because the fingerprint
//      uppercases. That family is pinned by a test instead
//      (tests/duplicatedDecisionPins.test.ts).
//   5. TEST FILES ARE NOT SCANNED, deliberately. A test that pins a set's exact
//      membership is the REMEDY for this class; flagging the remedy is how a
//      gate gets switched off. The cost is honest and real: a divergent copy
//      living only in a test is invisible here.
//
// ── HOW IT PASSES OR FAILS ──────────────────────────────────────────────────
// A REVIEWED ALLOWLIST, not a meaning detector — the same mechanism as
// check-empty-state-claims.mjs. Every hit on main today is listed in
// data/duplicated-decision-allowlist.json with a `why` that a person wrote. A
// NEW hit fails until somebody decides about it. That converts a silent
// disagreement into a visible, dated decision; it does NOT prove the listed
// ones are harmless.
//
// IT BLAMES THE ACTOR. Pre-existing hits pass. Only a hit nobody has listed
// fails, so nobody is failed for a duplicate they did not write. And an entry
// whose target is GONE prints as STALE and never fails: a gate that punishes
// somebody for fixing something is a gate that gets disabled.
//
// KEYED BY CONTENT, NOT BY LINE. Line numbers shift on every merge. A D1 key is
// (fingerprint + the set of files carrying it), a D2 key is the two
// fingerprints, a D3 key is (file + guard + handler). So MOVING a literal keeps
// its review, EDITING one re-opens it, and a NEW home appearing re-opens it
// while a home DISAPPEARING does not.
//
// Usage:
//   node backend/scripts/check-duplicated-decisions.mjs            # inventory
//   node backend/scripts/check-duplicated-decisions.mjs --strict   # exit 1 on a NEW hit
//   node backend/scripts/check-duplicated-decisions.mjs --suggest  # paste-ready entries
//   node backend/scripts/check-duplicated-decisions.mjs --json
//
// NO DEPENDENCIES (node:fs / node:path only) so it runs in a worktree before
// any npm install.
// ----------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const strict = process.argv.includes("--strict");
const jsonOut = process.argv.includes("--json");
const suggest = process.argv.includes("--suggest");

const ALLOWLIST_PATH = path.join(repoRoot, "backend", "scripts", "data", "duplicated-decision-allowlist.json");

/* ── Output ──────────────────────────────────────────────────────────────────
   fs.writeSync, NOT console.log, and that is not a style choice. console.log to
   a PIPE is asynchronous and `process.exit()` discards whatever has not
   drained — check-empty-state-claims.mjs's first version printed a correct exit
   code next to a report that stopped mid-sentence at 9,146 bytes the moment its
   output was captured instead of shown on a terminal. CI captures. The one
   place a gate must not be economical with the truth is the list of what it
   found.

   BUFFERED and flushed once from an `exit` handler. A per-line writeSync on a
   non-blocking pipe spins on EAGAIN until the reader drains. Node runs `exit`
   listeners synchronously even for `process.exit()`, so one write at the end is
   both the fast answer and the complete one. */
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

/* ── Where the rules live ────────────────────────────────────────────────────
   Both trees, EXCLUDING *.test.ts / *.test.tsx — see limit 5 in the header. */
const ROOTS = [
  path.join(repoRoot, "backend", "src"),
  path.join(repoRoot, "frontend", "src"),
  /* An EXTRA root, used by tests/duplicatedDecisionGate.test.mjs to plant a
     violation OUTSIDE the source tree and watch this exit 1. A gate nobody has
     seen fail is not a gate, and proving it by hand once proves it for one
     afternoon. Unset in every real invocation. */
  ...(process.env.DUPLICATED_DECISIONS_EXTRA_ROOT ? [process.env.DUPLICATED_DECISIONS_EXTRA_ROOT] : []),
];
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", ".vite"]);
const isScanned = (name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !/\.d\.ts$/.test(name);

function walk(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, acc);
    else if (isScanned(e.name)) acc.push(full);
  }
  return acc;
}

/* ── Comment stripping ───────────────────────────────────────────────────────
   Lifted from check-empty-state-claims.mjs, whose version is the one that
   survived contact with this tree. Comments here are long and several of them
   QUOTE the sets they explain; scanning them would report the explanation as a
   second home. A char-level scanner rather than a regex, because `"http://x"`
   and a template literal both defeat the regex version — and a stripper that
   ate a string literal would HIDE hits, which is the failure this repo has now
   produced five times: a checker whose number is too small.

   Newlines are preserved so line numbers survive. */
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
const lineAt = (text, idx) => text.slice(0, idx).split("\n").length;

/** Balanced slice starting at `openIdx`, for the bracket pair at that index. */
function balanced(text, openIdx) {
  const open = text[openIdx];
  const close = open === "{" ? "}" : open === "[" ? "]" : ")";
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === open) depth++;
    else if (text[i] === close) { depth--; if (depth === 0) return text.slice(openIdx, i + 1); }
  }
  return null;
}

/* ── D1 extraction ───────────────────────────────────────────────────────────
   Two shapes, and the second is narrower than the first on purpose.

   ARRAYS: any `[...]` whose entire content is string literals. Unconstrained by
   context, because the sites that matter include INLINE ones — the PO
   receivable filter at services/agents/procurement-learning.ts is an inline
   `.in('po.status', [...])` with no name at all, and a name requirement would
   have hidden it.

   OBJECT KEYS: only the initialiser of a NAMED const, and only when the keys
   read as an enum vocabulary rather than a field list. Measured: without the
   named-const requirement this arm reports 64 multi-file groups, of which
   roughly half are PostgREST update payloads (`{ status, updated_at }`) — a
   column list, not a decision. With it: 31, nearly all of them stage / status /
   method vocabularies, including the ASSR stage-label maps that live in five
   files under five different names. A gate that cries wolf is a gate somebody
   deletes, and that is how the previous generation of checks in this repo
   died. */
/* A SCANNER, not a regex, and the difference is not cosmetic. The regex version
   of this — `(?:[^'"\\\n]|\\.)*` for the body of a literal — cannot express
   "the OTHER quote character is ordinary text in here", so `["12'", "ab"]` did
   not match it at all and the array was dropped from the scan. A dropped array
   is a duplicate this gate then swears does not exist. Returns the member
   values, or null when the slice is not a pure array of string literals. */
function parseStringArray(slice) {
  if (slice[0] !== "[" || slice[slice.length - 1] !== "]") return null;
  const members = [];
  let i = 1;
  const end = slice.length - 1;
  const skipWs = () => { while (i < end && /\s/.test(slice[i])) i++; };
  for (;;) {
    skipWs();
    if (i >= end) return members;
    const q = slice[i];
    if (q !== "'" && q !== '"') return null;
    i++;
    let val = "";
    for (;;) {
      if (i >= end) return null;             // unterminated
      const ch = slice[i];
      if (ch === "\\") { val += ch + (slice[i + 1] ?? ""); i += 2; continue; }
      if (ch === q) { i++; break; }
      if (ch === "\n") return null;          // not a single-line literal
      val += ch; i++;
    }
    members.push(val);
    skipWs();
    if (i >= end) return members;
    if (slice[i] !== ",") return null;       // an `as const`, a spread, an expression
    i++;
  }
}
const SCREAMING = /^[A-Z][A-Z0-9_]*$/;
const MEMBER_FLOOR = 3;
const MAX_ARRAY_CHARS = 4000;
const MAX_OBJECT_CHARS = 20000;
/** `const NAME =` / `const NAME: T =` / `= Object.freeze(` immediately before. */
const NAMED_CONST_TAIL = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]*)?=\s*(?:Object\.freeze\(\s*)?$/;

/** Top-level keys of an object literal, or null when it is not a plain map. */
function objectKeys(slice) {
  const inner = slice.slice(1, -1);
  const els = [];
  let depth = 0, start = 0, st = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (st === 0) {
      if (ch === "'") { st = 1; continue; }
      if (ch === '"') { st = 2; continue; }
      if (ch === "`") { st = 3; continue; }
      if ("([{".includes(ch)) depth++;
      else if (")]}".includes(ch)) depth--;
      else if (ch === "," && depth === 0) { els.push(inner.slice(start, i)); start = i + 1; }
    } else {
      if (ch === "\\") { i++; continue; }
      if ((st === 1 && ch === "'") || (st === 2 && ch === '"') || (st === 3 && ch === "`")) st = 0;
    }
  }
  els.push(inner.slice(start));
  const keys = [];
  for (const e of els) {
    const t = e.trim();
    if (!t) continue;
    const m = t.match(/^(?:'([^']*)'|"([^"]*)"|([A-Za-z_$][\w$]*))\s*:/);
    if (!m) return null; // a spread, a method, a shorthand — not a plain map
    keys.push(m[1] ?? m[2] ?? m[3]);
  }
  return keys;
}

/* A member is compared by its VALUE, not by its source spelling. `'12\''` and
   `"12'"` are the same string; leaving the backslash in would split one set
   into two fingerprints and hide the duplicate — the checker-reports-a-number-
   that-is-too-small failure again. The self-test asserts both spellings fold
   together, because this was wrong on the first run of this script and the
   probe is the only reason anyone noticed. */
const ESCAPES = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", 0: "\0" };
const unescapeMember = (s) =>
  s.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (_, e) => {
    if (e[0] === "u" || e[0] === "x") {
      const hex = e.replace(/^u\{|\}$|^u|^x/g, "");
      const cp = Number.parseInt(hex, 16);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : e;
    }
    return ESCAPES[e] ?? e;
  });

const fingerprintOf = (members) =>
  [...new Set(members.map((s) => unescapeMember(s).trim().toUpperCase()))].sort();

/** The ~70 chars of code before a literal, so the report can name the symbol. */
function contextOf(text, idx) {
  const before = norm(text.slice(Math.max(0, idx - 90), idx));
  const named = before.match(/([A-Za-z_$][\w$]*)\s*(?::[^=;]*)?=\s*(?:new Set\(\s*)?(?:Object\.freeze\(\s*)?$/);
  if (named) return named[1];
  return before.slice(-46) || "(inline)";
}

/** Every fingerprinted set in one file. */
function extractSets(rel, raw) {
  const text = stripComments(raw);
  const out = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "[") {
      const slice = balanced(text, i);
      if (!slice || slice.length > MAX_ARRAY_CHARS) continue;
      const members = parseStringArray(slice);
      if (members === null || members.length === 0) continue;
      const fp = fingerprintOf(members);
      if (fp.length >= MEMBER_FLOOR) {
        out.push({ file: rel, line: lineAt(text, i), kind: "array", symbol: contextOf(text, i), members: fp });
      }
      i += slice.length - 1;
      continue;
    }
    if (ch === "{") {
      const slice = balanced(text, i);
      if (!slice || slice.length > MAX_OBJECT_CHARS || slice.length < 8) continue;
      const before = text.slice(Math.max(0, i - 220), i);
      const named = before.match(NAMED_CONST_TAIL);
      if (!named) continue;
      const keys = objectKeys(slice);
      if (!keys || keys.length < MEMBER_FLOOR) continue;
      // An enum vocabulary, not a field list: at least two keys carry an
      // underscore or are SCREAMING_SNAKE.
      if (keys.filter((k) => k.includes("_") || SCREAMING.test(k)).length < 2) continue;
      const fp = fingerprintOf(keys);
      if (fp.length >= MEMBER_FLOOR) {
        out.push({ file: rel, line: lineAt(text, i), kind: "record", symbol: named[1], members: fp });
      }
    }
  }
  return out;
}

const jaccard = (a, b) => {
  const B = new Set(b);
  let inter = 0;
  for (const x of a) if (B.has(x)) inter++;
  return inter / (a.length + b.length - inter);
};

/* ── D3 config ───────────────────────────────────────────────────────────────
   {guardSymbol, files[], handlerPattern}. handlerPattern must be a GLOBAL regex
   matching a route registration; the handler slice is the balanced brace block
   after the first `=>` that follows it.

   The seed is the main-mix guard: the server's answer to "does this line
   introduce a SOFA x (bedframe|mattress) mix that did not exist before" — the
   PR #519 create rule, extended to line add and swap. It is applied on BOTH the
   add and the edit path of a sales order, which is what this asserts stays true.

   THE SYMBOL IS `lineMixRefusal`, AND IT USED TO BE `soMainMixIntroduced`.
   That rename is why this paragraph is worth reading. `soMainMixIntroduced` was
   the hand-rolled third form main-mix.ts describes at its own line 47; it was
   replaced by `lineMixRefusal` (main-mix.ts:193) and no implementation of the
   old name is left in src — only comments naming it. This config kept pointing
   at the dead name, so D3 reported BOTH sales-order handlers as unguarded while
   both in fact call `lineMixRefusal` — and, the part that matters, it could no
   longer have caught the guard genuinely going missing, because the symbol it
   watched for was absent everywhere by definition. A guard check pinned to a
   renamed symbol either passes for the wrong reason or fails for the wrong one;
   here it did the second. It is
   applied on NEITHER path of a consignment order, while the consignment FORM
   enforces the rule client-side (ConsignmentOrderNew.tsx imports
   hasSofaMixConflict from the vendored so-variant-rule). That gap is real, it
   is recorded in the allowlist rather than silently fixed here, and the
   allowlist entry is where the owner's ruling will land. */
const GUARD_CONFIG = [
  {
    id: "so-main-mix",
    guardSymbol: "lineMixRefusal",
    handlerPattern: /\.(post|patch)\(\s*'\/:docNo\/items(?:\/:itemId)?'\s*,/g,
    files: [
      "backend/src/scm/routes/mfg-sales-orders.ts",
      "backend/src/scm/routes/consignment-orders.ts",
    ],
  },
];

/** Every (file, handler) pair a guard config covers, with a present/missing verdict. */
function checkGuards(readFile) {
  const rows = [];
  for (const cfg of GUARD_CONFIG) {
    for (const rel of cfg.files) {
      const raw = readFile(rel);
      if (raw == null) {
        rows.push({ config: cfg.id, guard: cfg.guardSymbol, file: rel, handler: "(file missing)", present: false, unreadable: true });
        continue;
      }
      const text = stripComments(raw);
      cfg.handlerPattern.lastIndex = 0;
      let m;
      let found = 0;
      while ((m = cfg.handlerPattern.exec(text)) !== null) {
        found++;
        const arrow = text.indexOf("=>", m.index + m[0].length);
        const open = arrow === -1 ? -1 : text.indexOf("{", arrow);
        const body = open === -1 ? null : balanced(text, open);
        rows.push({
          config: cfg.id,
          guard: cfg.guardSymbol,
          file: rel,
          handler: norm(m[0]).replace(/,$/, ""),
          line: lineAt(text, m.index),
          present: body != null && body.includes(cfg.guardSymbol),
          unslicable: body == null,
        });
      }
      if (found === 0) {
        /* NO HANDLER MATCHED. Reported as its own row and never silently
           counted as a pass: a config whose pattern matches nothing has not
           checked anything, and "0 missing out of 0" is exactly how a checker
           looks clean while seeing nothing. */
        rows.push({ config: cfg.id, guard: cfg.guardSymbol, file: rel, handler: "(no handler matched the pattern)", present: false, nomatch: true });
      }
    }
  }
  return rows;
}

/* ── SELF-TEST ───────────────────────────────────────────────────────────────
   check-shared-mirrors.mjs shipped a pattern that could only match TYPE-
   ANNOTATED consts, so nine of thirteen pairs compared ZERO functions while it
   printed "every shared function is identical" about an empty set. It had no
   self-test; that is why it shipped. A third dead pattern was found in this
   repo's checkers on the same day.

   So these probes deliberately exercise the forms the extractor is most likely
   to MISS — multi-line `new Set` with a trailing comma, double quotes, an
   escaped apostrophe inside a member, a quoted-key record — and the forms it is
   most likely to WRONGLY CLAIM: a numeric array, an array holding an
   identifier, a camelCase prop bag, an inline (unnamed) object. A self-test
   that only asserts the case you had in mind passes for the same reason the bug
   exists. */
{
  const failures = [];
  const fpOf = (src) => extractSets("probe.ts", src).map((s) => s.members.join(","));

  // ARRAYS — the forms most likely to be missed.
  const mustFind = [
    ["multi-line new Set with a trailing comma",
     "const S = new Set([\n  'DRAFT',\n  'CANCELLED',\n  'ON_HOLD',\n]);", "CANCELLED,DRAFT,ON_HOLD"],
    ["double-quoted `as const` tuple",
     'const T = ["a_one", "b_two", "c_three"] as const;', "A_ONE,B_TWO,C_THREE"],
    ["inline PostgREST filter with no name at all",
     "sb.from('x').in('status', ['SUBMITTED', 'PARTIALLY_RECEIVED', 'DRAFT']);", "DRAFT,PARTIALLY_RECEIVED,SUBMITTED"],
    ["a member carrying an escaped quote",
     "const Q = ['12\\'', 'ab', 'cd'];", "12',AB,CD"],
    ["the SAME member written with the other quote style — the two must fold together",
     'const Q2 = ["12\'", "ab", "cd"];', "12',AB,CD"],
    ["a set whose members repeat — dedupe before the floor is applied",
     "const R = ['A', 'B', 'C', 'A'];", "A,B,C"],
  ];
  for (const [what, src, want] of mustFind) {
    if (!fpOf(src).includes(want)) failures.push(`array extractor MISSED ${what}: ${src.replace(/\n/g, "\\n")}`);
  }

  // RECORDS — the named-const arm, both key spellings.
  const recFind = [
    ["bare snake_case keys",
     'const M = { pending_review: "a", pending_solution: "b", completed: "c" };', "COMPLETED,PENDING_REVIEW,PENDING_SOLUTION"],
    ["quoted keys behind a type annotation",
     'const M: Record<string, number> = { "stage_one": 1, "stage_two": 2, "done": 3 };', "DONE,STAGE_ONE,STAGE_TWO"],
  ];
  for (const [what, src, want] of recFind) {
    if (!fpOf(src).includes(want)) failures.push(`record extractor MISSED ${what}: ${src}`);
  }

  // Things it must NOT claim.
  const mustMiss = [
    ["a numeric array", "const N = [1, 2, 3];"],
    ["an array holding an identifier", "const A = [DRAFT, 'CANCELLED', 'ON_HOLD'];"],
    ["an array of template literals", "const A = [`a`, `b`, `c`];"],
    ["a two-member set — below the floor, see header limit 4", "const P = ['SUBMITTED', 'PARTIALLY_RECEIVED'];"],
    ["a camelCase prop bag", "const P = { itemCode: a, unitPrice: b, qtyOrdered: c };"],
    ["an INLINE object literal with enum-ish keys", "call({ pending_review: 1, pending_solution: 2, completed: 3 });"],
    ["an object holding a spread", "const M = { ...base, pending_review: 1, pending_solution: 2, completed: 3 };"],
  ];
  for (const [what, src] of mustMiss) {
    if (fpOf(src).length > 0) failures.push(`extractor FALSE-POSITIVED on ${what}: ${src} -> ${fpOf(src).join(" | ")}`);
  }

  // Comments must not become a second home, and a string that looks like a
  // comment must survive.
  if (fpOf("// const S = ['A', 'B', 'C'];\nconst u = 1;").length > 0) {
    failures.push("a commented-out set was counted as a live one");
  }
  if (!fpOf("const U = ['http://a//b', 'x_1', 'y_2'];").includes("HTTP://A//B,X_1,Y_2")) {
    failures.push("stripComments blanked the inside of a string literal containing //");
  }
  {
    // The JSX apostrophe: reading it as a string delimiter desynchronises
    // everything after it, which can DELETE a later literal from the scan.
    const jsx = "const A = () => <M>Couldn't load them.</M>;\nconst S = ['A_1', 'B_2', 'C_3'];";
    if (!fpOf(jsx).includes("A_1,B_2,C_3")) failures.push("a JSX apostrophe swallowed a later set");
  }

  // D2 — the near-miss arithmetic itself.
  if (jaccard(["A", "B", "C", "D"], ["A", "B", "C", "D", "E"]) < 0.75) failures.push("jaccard: 4-of-5 near-miss does not clear 0.75");
  if (jaccard(["A", "B", "C"], ["A", "D", "E"]) >= 0.75) failures.push("jaccard: two mostly-different sets cleared 0.75");
  if (jaccard(["A", "B"], ["A", "B"]) !== 1) failures.push("jaccard: identical sets did not score 1");

  /* D3 — THE FORM IT EXISTS TO CATCH. The guard is present in a NEIGHBOURING
     handler in the same file and absent from the target. A file-level
     `includes()` passes here; only the balanced slice fails. If this probe ever
     goes quiet, D3 has silently become a grep. */
  {
    const src =
      "r.post('/:docNo/items', async (c) => {\n  if (await theGuard(sb, d)) return c.json({}, 409);\n  return c.json({});\n});\n" +
      "r.patch('/:docNo/items/:itemId', async (c) => {\n  return c.json({});\n});\n";
    const saved = GUARD_CONFIG.splice(0, GUARD_CONFIG.length);
    GUARD_CONFIG.push({ id: "probe", guardSymbol: "theGuard", handlerPattern: /\.(post|patch)\(\s*'\/:docNo\/items(?:\/:itemId)?'\s*,/g, files: ["probe.ts"] });
    const rows = checkGuards((rel) => (rel === "probe.ts" ? src : null));
    GUARD_CONFIG.splice(0, GUARD_CONFIG.length, ...saved);
    if (rows.length !== 2) failures.push(`D3 self-test: expected 2 handler rows, got ${rows.length}`);
    if (!rows.some((r) => r.handler.includes("/:itemId") && !r.present)) {
      failures.push("D3 self-test: the UNGUARDED sibling handler was reported as guarded — the slice is not balanced and D3 has become a file-level grep");
    }
    if (!rows.some((r) => !r.handler.includes("/:itemId") && r.present)) {
      failures.push("D3 self-test: the GUARDED handler was reported as missing the guard");
    }
    // A pattern that matches nothing must SAY SO, never read as a pass.
    GUARD_CONFIG.splice(0, GUARD_CONFIG.length);
    GUARD_CONFIG.push({ id: "probe2", guardSymbol: "theGuard", handlerPattern: /\.post\(\s*'\/nowhere'\s*,/g, files: ["probe.ts"] });
    const none = checkGuards((rel) => (rel === "probe.ts" ? src : null));
    GUARD_CONFIG.splice(0, GUARD_CONFIG.length, ...saved);
    if (!none.some((r) => r.nomatch)) failures.push("D3 self-test: a handlerPattern matching NOTHING did not report itself");
  }

  if (failures.length > 0) {
    warn("check-duplicated-decisions: internal SELF-TEST FAILED — not reporting a number.");
    for (const f of failures) warn("  - " + f);
    process.exit(2);
  }
}

/* ── Allowlist ───────────────────────────────────────────────────────────── */
let allowRaw;
try {
  allowRaw = JSON.parse(fs.readFileSync(ALLOWLIST_PATH, "utf8"));
} catch (err) {
  warn(`check-duplicated-decisions: cannot read ${path.relative(repoRoot, ALLOWLIST_PATH)} — ${err.message}`);
  process.exit(2);
}
const allowEntries = Array.isArray(allowRaw.reviewed) ? allowRaw.reviewed : [];
const WHY_FLOOR = 24;
const badEntries = allowEntries.filter(
  (e) =>
    !e ||
    !["D1", "D2", "D3"].includes(e.check) ||
    typeof e.key !== "string" ||
    e.key.length === 0 ||
    typeof e.why !== "string" ||
    norm(e.why).length < WHY_FLOOR ||
    /^todo\b/i.test(norm(e.why)),
);
if (badEntries.length > 0) {
  warn(`check-duplicated-decisions: allowlist entries need {check: D1|D2|D3, key, why} and a why of at least ${WHY_FLOOR} real characters (a TODO is rejected):`);
  for (const e of badEntries) warn("  - " + JSON.stringify(e).slice(0, 300));
  process.exit(2);
}
const allowed = new Map(allowEntries.map((e) => [`${e.check}|${e.key}`, e]));
const usedKeys = new Set();

/* ── Scan ────────────────────────────────────────────────────────────────── */
const files = ROOTS.flatMap((r) => walk(r));
if (files.length < 500) {
  warn(`check-duplicated-decisions: only ${files.length} source files found — the walk is broken, not the tree.`);
  process.exit(2);
}

const sets = [];
for (const abs of files) {
  const rel = path.relative(repoRoot, abs).split(path.sep).join("/");
  sets.push(...extractSets(rel, fs.readFileSync(abs, "utf8")));
}

/* D1 — one fingerprint, two or more files. */
const byFingerprint = new Map();
for (const s of sets) {
  const fp = s.members.join(",");
  if (!byFingerprint.has(fp)) byFingerprint.set(fp, []);
  byFingerprint.get(fp).push(s);
}
const d1 = [];
for (const [fp, occ] of byFingerprint) {
  const filesFor = [...new Set(occ.map((o) => o.file))].sort();
  if (filesFor.length < 2) continue;
  d1.push({ fingerprint: fp, members: occ[0].members, files: filesFor, sites: occ });
}
d1.sort((a, b) => b.files.length - a.files.length || a.fingerprint.localeCompare(b.fingerprint));

/* D2 — near misses. Compared over DISTINCT fingerprints, including ones that
   live in a single file: the SO_DONE disagreement is two same-named constants
   inside routes/inventory.ts and would be invisible to a cross-file-only pass. */
const distinctFps = [...byFingerprint.entries()].map(([fp, occ]) => ({ fp, members: occ[0].members, occ }));
const d2 = [];
for (let i = 0; i < distinctFps.length; i++) {
  for (let j = i + 1; j < distinctFps.length; j++) {
    const A = distinctFps[i], B = distinctFps[j];
    const jac = jaccard(A.members, B.members);
    if (jac < 0.75 || jac >= 1) continue;
    const setB = new Set(B.members), setA = new Set(A.members);
    d2.push({
      key: [A.fp, B.fp].sort().join(" ~ "),
      a: A.fp, b: B.fp,
      jaccard: Number(jac.toFixed(3)),
      onlyInA: A.members.filter((m) => !setB.has(m)),
      onlyInB: B.members.filter((m) => !setA.has(m)),
      sitesA: A.occ.map((o) => `${o.file}:${o.line} ${o.symbol}`),
      sitesB: B.occ.map((o) => `${o.file}:${o.line} ${o.symbol}`),
    });
  }
}
d2.sort((a, b) => b.jaccard - a.jaccard || a.key.localeCompare(b.key));

/* D3 — guard presence. */
const readRepoFile = (rel) => {
  const abs = path.join(repoRoot, rel);
  try { return fs.readFileSync(abs, "utf8"); } catch { return null; }
};
const d3rows = checkGuards(readRepoFile);
const d3 = d3rows.filter((r) => !r.present);

/* ── Adjudicate against the allowlist ────────────────────────────────────── */
const d1Key = (h) => `${h.fingerprint}|${h.files.join(" ")}`;
for (const h of d1) {
  const exact = allowed.get(`D1|${d1Key(h)}`);
  if (exact) { h.verdict = "REVIEWED"; h.why = exact.why; usedKeys.add(`D1|${d1Key(h)}`); continue; }
  /* Same fingerprint, different file set. A home DISAPPEARING is somebody
     fixing something and must not fail; a home APPEARING is the whole point of
     this gate and must. */
  const sameFp = allowEntries.find((e) => e.check === "D1" && e.key.split("|")[0] === h.fingerprint);
  if (sameFp) {
    const was = new Set((sameFp.key.split("|")[1] ?? "").split(" ").filter(Boolean));
    const added = h.files.filter((f) => !was.has(f));
    usedKeys.add(`D1|${sameFp.key}`);
    if (added.length === 0) { h.verdict = "REVIEWED"; h.why = sameFp.why; h.note = "a home disappeared — passing, update the key when convenient"; continue; }
    h.verdict = "NEW"; h.why = sameFp.why; h.note = `NEW HOME(S): ${added.join(", ")}`;
    continue;
  }
  h.verdict = "NEW";
}
for (const h of d2) {
  const e = allowed.get(`D2|${h.key}`);
  if (e) { h.verdict = "REVIEWED"; h.why = e.why; usedKeys.add(`D2|${h.key}`); }
  else h.verdict = "NEW";
}
const d3Key = (r) => `${r.file}|${r.guard}|${r.handler}`;
for (const r of d3) {
  const e = allowed.get(`D3|${d3Key(r)}`);
  if (e) { r.verdict = "REVIEWED"; r.why = e.why; usedKeys.add(`D3|${d3Key(r)}`); }
  else r.verdict = "NEW";
}

const newD1 = d1.filter((h) => h.verdict === "NEW");
const newD2 = d2.filter((h) => h.verdict === "NEW");
const newD3 = d3.filter((h) => h.verdict === "NEW");
const newHits = newD1.length + newD2.length + newD3.length;
const stale = allowEntries.filter((e) => !usedKeys.has(`${e.check}|${e.key}`));

if (jsonOut) {
  say(JSON.stringify({ scanned: files.length, sets: sets.length, d1, d2, d3: d3rows, stale, newHits }, null, 2));
  process.exit(strict && newHits > 0 ? 1 : 0);
}

say(`check-duplicated-decisions — ${files.length} source files scanned (tests excluded), ${sets.length} fingerprinted set(s).`);
say(`  D1 same-valued set in >= 2 files : ${d1.length} group(s), ${newD1.length} NOT reviewed`);
say(`  D2 near-miss pairs (Jaccard >=.75): ${d2.length} pair(s), ${newD2.length} NOT reviewed`);
say(`  D3 guard missing from a handler   : ${d3.length} of ${d3rows.length} checked handler(s), ${newD3.length} NOT reviewed`);
say("");

if (stale.length > 0) {
  /* PRINTED, NEVER FAILED. A stale entry usually means somebody FIXED a
     duplicate, and a gate that punishes the fix is a gate that stops fixes. It
     is still noise that has to be cleared, so it is loud. */
  say(`STALE allowlist entries — ${stale.length} listed item(s) no longer in the tree. Delete them:`);
  for (const e of stale) say(`  [${e.check}] ${e.key.slice(0, 150)}`);
  say("");
}

const printD1 = (h) => {
  say(`  ${h.files.length} files  {${h.members.join(", ")}}`);
  for (const s of h.sites) say(`      ${s.file}:${s.line}  ${s.kind}  ${s.symbol}`);
  if (h.note) say(`      note: ${h.note}`);
  if (h.why) say(`      why: ${h.why}`);
};
const printD2 = (h) => {
  say(`  jaccard ${h.jaccard}`);
  say(`      A {${h.a}}`);
  say(`      B {${h.b}}`);
  say(`      only in A: ${h.onlyInA.join(", ") || "(none)"}`);
  say(`      only in B: ${h.onlyInB.join(", ") || "(none)"}`);
  for (const s of h.sitesA) say(`      A @ ${s}`);
  for (const s of h.sitesB) say(`      B @ ${s}`);
  if (h.why) say(`      why: ${h.why}`);
};
const printD3 = (r) => {
  say(`  ${r.file}  ${r.handler}${r.line ? ` (line ${r.line})` : ""}`);
  say(`      guard \`${r.guard}\` does not appear inside this handler's body`);
  if (r.unslicable) say("      NOTE: the handler body could not be sliced — read it by hand");
  if (r.nomatch) say("      NOTE: the configured handlerPattern matched NOTHING in this file — nothing was checked");
  if (r.why) say(`      why: ${r.why}`);
};

if (newD1.length > 0) {
  say(`NOT REVIEWED — D1, one set of values under two or more homes (${newD1.length}):\n`);
  for (const h of newD1) printD1(h);
  say("");
}
if (newD2.length > 0) {
  say(`NOT REVIEWED — D2, NEAR MISS: two sets that almost agree (${newD2.length}).`);
  say("This is the shape where a rule is enforced at N-1 of N places.\n");
  for (const h of newD2) printD2(h);
  say("");
}
if (newD3.length > 0) {
  say(`NOT REVIEWED — D3, a guard missing from a sibling handler (${newD3.length}):\n`);
  for (const r of newD3) printD3(r);
  say("");
}

const reviewedD1 = d1.filter((h) => h.verdict === "REVIEWED");
const reviewedD2 = d2.filter((h) => h.verdict === "REVIEWED");
const reviewedD3 = d3.filter((h) => h.verdict === "REVIEWED");
if (reviewedD1.length + reviewedD2.length + reviewedD3.length > 0) {
  say("REVIEWED — on the allowlist with a reason:\n");
  for (const h of reviewedD1) printD1(h);
  for (const h of reviewedD2) printD2(h);
  for (const r of reviewedD3) printD3(r);
  say("");
}

if (newHits === 0) {
  say("No unreviewed duplicated decisions.");
  say("This is NOT proof every rule in the tree has one home — it is proof every");
  say("same-valued set, near-miss pair and configured guard this script can SEE has");
  say("been looked at by a person. Read the header for the four things it cannot see;");
  say("the total-height family and the PO receivable threshold are both among them.");
  process.exit(0);
}

say(`${newHits} duplicated decision(s) with no recorded decision.

A duplicated DECISION is not duplicated code — it is one business question with
two independent answers, and the cost is paid when they diverge. Either give the
rule ONE home, or, when it must genuinely stay two (a client-side meter that
cannot round-trip, a deliberately different question), pin the pair with a test
that feeds both implementations one corpus — the pattern in
backend/tests/duplicatedDecisionPins.test.ts.

If it is neither, record the decision:
backend/scripts/data/duplicated-decision-allowlist.json, one line of why.
Run with --suggest for paste-ready entries.`);

if (suggest) {
  say("\nPaste-ready (fill in every `why` — a placeholder is rejected):\n");
  const out = [];
  for (const h of newD1) out.push({ check: "D1", key: d1Key(h), why: `TODO ${h.files.length} homes: ${h.files.join(", ")}` });
  for (const h of newD2) out.push({ check: "D2", key: h.key, why: `TODO differs by ${[...h.onlyInA, ...h.onlyInB].join("/")}` });
  for (const r of newD3) out.push({ check: "D3", key: d3Key(r), why: `TODO guard ${r.guard} absent from ${r.handler}` });
  say(JSON.stringify(out, null, 2));
}

process.exit(strict ? 1 : 0);
