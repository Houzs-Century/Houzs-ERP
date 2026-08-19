/**
 * The four MANDATORY owner rules in CLAUDE.md, expressed as code.
 *
 * NO SHEBANG in this file — it is imported by scripts/lib/working-agreement.test.mjs
 * (see CLAUDE.md, "Anything a TEST imports lives in scripts/lib/ and carries NO
 * shebang": on Windows vitest inlines the module and a `#!` that is no longer at
 * byte 0 is a load-time SyntaxError).
 *
 * Everything here is PURE: it takes an already-gathered description of a pull
 * request and returns findings. All I/O — gh, git, the event payload — lives in
 * the runnable ../check-working-agreement.mjs.
 */

/** Paths whose change is "code that reaches production" for rule 1. */
const CODE_PREFIXES = [
  "backend/src/",
  "frontend/src/",
  // Scripts are here deliberately. PR #2118 was a fix for a bug in
  // backend/scripts/repair-array-shaped-variants.mjs — a script that WRITES to
  // the production database. Scoping rule 1 to src/ alone would have let the
  // exact PR this gate was built from sail through.
  "backend/scripts/",
  "frontend/scripts/",
  "scripts/",
];

/** Paths that can carry a module SURFACE (rule 2). Scripts cannot. */
const SURFACE_PREFIXES = ["backend/src/", "frontend/src/"];

/** Nor can a test, a fixture or a type-only declaration file. */
const NOT_SURFACE_RX = /(^|\/)(__tests__|__fixtures__|e2e)\/|\.(test|spec)\.[cm]?[jt]sx?$|\.d\.[cm]?ts$/;

/**
 * A comment cannot change a surface. Skipping comment-only lines is not
 * cosmetic: this repo comments HEAVILY (PR #2112 added an eight-line block
 * explaining why a gate asks for the warehouse "not for the State"), and every
 * one of those lines otherwise reads as a status declaration.
 */
const COMMENT_ONLY_RX = /^\s*(\/\/|\/\*|\*\/|\*(?!\/)|--|#(?!!))/;

const MIGRATIONS_PG = "backend/src/db/migrations-pg/";

export const BUG_HISTORY_PATH = "BUG-HISTORY.md";
export const MODULE_GUIDE_DIR = "docs/modules/";

export const LABEL_NO_BUG_HISTORY = "no-bug-history-needed";
export const LABEL_NO_GUIDE = "no-guide-change";

/**
 * Words that make a PR read as a fix. Straight from the task the owner set:
 * fix/, bug, broken, wrong, incorrect, regression, 500, crash.
 *
 * Word boundaries matter more than they look: `\bbug\b` must not fire on
 * "debug"/"debugging" (~50 hits in this repo's scripts), and `\b500\b` must not
 * fire on "500ms" or "1500".
 */
const FIX_WORDS =
  /\bfix(e[sd]|ing|up|es)?\b|\bbugs?\b|\bbroke(n)?\b|\bwrong(ly)?\b|\bincorrect(ly)?\b|\bregressions?\b|\b500\b|\bcrash(e[sd]|ing)?\b/i;

// ---------------------------------------------------------------------------
// Unified diff
// ---------------------------------------------------------------------------

/**
 * Parse a unified diff into per-file added/removed lines, keeping git's hunk
 * SECTION HEADING (the text after `@@ ... @@`, which git fills with the
 * enclosing declaration). The section is what lets a bare `'CANCELLED',` added
 * inside `export const DO_STATUSES = [` be recognised as a new status value
 * without parsing TypeScript.
 */
export function parseUnifiedDiff(patch) {
  const files = [];
  let file = null;
  let section = "";
  for (const raw of String(patch || "").split("\n")) {
    if (raw.startsWith("diff --git ")) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(raw);
      file = {
        path: m ? m[2] : raw.slice(11),
        oldPath: m ? m[1] : null,
        added: [],
        removed: [],
      };
      files.push(file);
      section = "";
      continue;
    }
    if (!file) continue;
    if (raw.startsWith("+++ b/")) {
      const p = raw.slice(6);
      if (p !== "/dev/null") file.path = p;
      continue;
    }
    if (raw.startsWith("--- a/")) continue;
    if (raw.startsWith("@@")) {
      const m = /^@@[^@]*@@ ?(.*)$/.exec(raw);
      section = m ? m[1] : "";
      continue;
    }
    if (raw.startsWith("+")) file.added.push({ text: raw.slice(1), section });
    else if (raw.startsWith("-")) file.removed.push({ text: raw.slice(1), section });
  }
  return files;
}

const startsWithAny = (path, prefixes) => prefixes.some((p) => path.startsWith(p));
export const isCodePath = (path) => startsWithAny(path, CODE_PREFIXES);
export const isSurfacePath = (path) =>
  startsWithAny(path, SURFACE_PREFIXES) && !NOT_SURFACE_RX.test(path);
export const isMigrationPath = (path) => path.startsWith(MIGRATIONS_PG);

// ---------------------------------------------------------------------------
// Rule 1 — does this PR read as a fix?
// ---------------------------------------------------------------------------

/**
 * Drop lines the PR TEMPLATE itself contributes before reading the body.
 *
 * Measured, not assumed: `.github/pull_request_template.md` contains the
 * headings "## Regression proof" and the line "BUG-HISTORY.md links the
 * regression evidence for a bug fix." Scanning a template-filled body without
 * this step reports EVERY pull request as a fix — the template's own words are
 * the match. Comparing against the live template file (rather than a hardcoded
 * list) means editing the template cannot silently re-break this.
 */
export function stripTemplateLines(body, templateBody) {
  const norm = (s) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const boiler = new Set(
    String(templateBody || "")
      .split("\n")
      .map(norm)
      .filter((l) => l.length > 0),
  );
  return String(body || "")
    .split("\n")
    .filter((l) => !boiler.has(norm(l)))
    .join("\n");
}

const headingLines = (text) =>
  String(text || "")
    .split("\n")
    .filter((l) => /^\s{0,3}#{1,6}\s/.test(l));

/**
 * Fix intent comes from the TITLE, the BRANCH NAME, and the body's own
 * HEADINGS — never from body prose.
 *
 * Measured over the 80 most recent merged PRs (2022-2132, 74 of them touching
 * code): title|branch flags 51; adding de-templated headings adds 4; adding
 * free body prose adds 16 more, and those 16 are features, read-only probes and
 * docs PRs whose narrative happens to contain the word "fix". Prose is where the
 * signal stops being a signal.
 */
export function detectFixIntent({ title, branch, body, templateBody }) {
  const signals = [];
  const hit = (where, text) => {
    const m = FIX_WORDS.exec(String(text || ""));
    if (m) signals.push({ where, match: m[0], text: String(text).trim().slice(0, 160) });
  };
  hit("title", title);
  hit("branch", branch);
  for (const line of headingLines(stripTemplateLines(body, templateBody))) hit("body heading", line);
  return { isFix: signals.length > 0, signals };
}

/**
 * A NEW entry, not merely a touched file. `BUG-HISTORY.md` is 10,000+ lines;
 * a typo fix in it is not a bug log. An entry is a new `## ` heading.
 */
export function addsBugHistoryEntry(files) {
  const f = files.find((x) => x.path === BUG_HISTORY_PATH);
  if (!f) return { touched: false, entry: false, heading: null };
  const heading = f.added.map((a) => a.text).find((t) => /^\s{0,3}##\s+\S/.test(t));
  return { touched: true, entry: Boolean(heading), heading: heading ? heading.trim() : null };
}

// ---------------------------------------------------------------------------
// Rule 2 — module surface
// ---------------------------------------------------------------------------

const ROUTE_RX =
  /(?:^|[^\w.])([A-Za-z_$][\w$]*)\s*\.\s*(get|post|put|patch|delete|all)\s*\(\s*(['"`])(\/[^'"`]*)\3/;
const MOUNT_RX = /\.route\s*\(\s*(['"`])(\/[^'"`]*)\1/;
const PERM_RX =
  /\b(?:requirePermission|requireAnyPermission|requireAllPermissions|hasPermission|can)\s*\(\s*\[?\s*(['"])([a-z0-9_]+(?:\.[a-z0-9_]+)+)\1/g;
const PERM_CATALOGUE_RX = /\bkey:\s*(['"])([a-z0-9_]+(?:\.[a-z0-9_]+)+|\*)\1/g;
// CASE-SENSITIVE, and that is the whole point: an `/i` flag here turns
// `const state = String(facts.customerState ?? '')` — an ordinary local in
// so-location-gate.ts — into "a status declaration changed". A status list is
// `DO_STATUSES` or `DoStatus`; a local is `state`.
const STATUS_DECL_TS_RX =
  /\btype\s+\w*(?:Status|State)\w*\s*=|\b(?:const|enum)\s+\w*(?:Status|State|STATUS|STATE)\w*\b[^=]*=/;
const STATUS_DECL_SQL_RX = /\bALTER\s+TYPE\b.*\bADD\s+VALUE\b|\bCHECK\s*\([^)]*\bIN\s*\(/i;
const STATUS_SECTION_RX = /Status|State|STATUS|STATE/;
const SCREAMING_RX = /(['"])([A-Z][A-Z0-9_]{2,})\1/g;
const SQL_REQUIRED_RX =
  /\bSET\s+NOT\s+NULL\b|\bDROP\s+NOT\s+NULL\b|\bADD\s+COLUMN\b[^;]*\bNOT\s+NULL\b/i;
const LOCK_RX =
  /\bFOR\s+UPDATE\b|\bFOR\s+NO\s+KEY\s+UPDATE\b|\bpg_advisory(?:_xact)?_lock\b|\bLOCK\s+TABLE\b|\b(?:acquire|with|take)[A-Za-z]*Lock\s*\(/i;
const PROP_RX = /^\s*(?:readonly\s+)?["']?([A-Za-z_$][\w$]*)["']?\s*(\??)\s*:/;

const collect = (rx, text) => {
  const out = [];
  const re = new RegExp(rx.source, rx.flags.includes("g") ? rx.flags : rx.flags + "g");
  let m;
  while ((m = re.exec(text))) out.push(m[m.length - 1]);
  return out;
};

const optionalityByProp = (lines) => {
  const map = new Map();
  for (const { text } of lines) {
    const m = PROP_RX.exec(text);
    if (!m) continue;
    const optional = m[2] === "?" || /\.optional\s*\(|\.nullish\s*\(/.test(text);
    map.set(m[1], optional);
  }
  return map;
};

/**
 * "SURFACE" as CLAUDE.md enumerates it, and nothing beyond it: a new route
 * registration, a new permission string, a new status value, a field becoming
 * or ceasing to be required, a new lock.
 */
export function detectSurfaceChanges(file) {
  const found = [];
  const code = (lines) => lines.filter((l) => !COMMENT_ONLY_RX.test(l.text));
  const added = code(file.added);
  const removed = code(file.removed);
  const removedBlob = removed.map((r) => r.text).join("\n");
  const push = (kind, detail, line) =>
    found.push({ kind, detail, line: String(line).trim().slice(0, 140) });

  const sql = file.path.endsWith(".sql");
  const ts = /\.(ts|tsx|mts)$/.test(file.path);

  for (const { text, section } of added) {
    if (ts) {
      const r = ROUTE_RX.exec(text);
      // `router.get("/x")` moved within a file appears as both + and -; only a
      // path absent from the removals is genuinely new.
      if (r && !removedBlob.includes(r[4])) push("route", `${r[2].toUpperCase()} ${r[4]}`, text);
      const mo = MOUNT_RX.exec(text);
      if (mo && !removedBlob.includes(mo[2])) push("route", `mount ${mo[2]}`, text);
    }

    for (const rx of [PERM_RX, PERM_CATALOGUE_RX]) {
      for (const perm of collect(rx, text)) {
        if (!removedBlob.includes(perm)) push("permission", perm, text);
      }
    }

    if ((ts && STATUS_DECL_TS_RX.test(text)) || (sql && STATUS_DECL_SQL_RX.test(text))) {
      push("status", "status/state declaration changed", text);
    } else if (STATUS_SECTION_RX.test(section)) {
      for (const v of collect(SCREAMING_RX, text)) {
        if (!removedBlob.includes(v)) push("status", `${v} (in \`${section.trim()}\`)`, text);
      }
    }

    if (sql && SQL_REQUIRED_RX.test(text)) push("required-field", "NOT NULL changed", text);
    if (LOCK_RX.test(text)) push("lock", "lock acquired", text);
  }

  // A field becoming or ceasing to be required, in TypeScript / zod: the same
  // property name present on both sides of the diff with different optionality.
  if (ts) {
    const before = optionalityByProp(removed);
    const after = optionalityByProp(added);
    for (const [prop, opt] of after) {
      if (before.has(prop) && before.get(prop) !== opt) {
        push(
          "required-field",
          `${prop} became ${opt ? "OPTIONAL" : "REQUIRED"}`,
          added.find((a) => PROP_RX.exec(a.text)?.[1] === prop)?.text || prop,
        );
      }
    }
  }

  // One finding per kind per file: the reviewer needs to know THAT the surface
  // moved, not every line that moved it.
  const seen = new Set();
  return found.filter((f) => {
    const k = `${f.kind}:${f.detail}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const PATH_IN_GUIDE_RX = /`([A-Za-z0-9_@./-]+\.(?:ts|tsx|mts|mjs|js|jsx|sql))`/g;

const normaliseStem = (stem) =>
  stem
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/(^|-)(mfg|mobile|new|edit|v2|v3)(-|$)/g, "$1$3")
    .replace(/-(list|detail|page|form|modal|card|tab|drawer|dialog|v2|v3)$/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .replace(/ies$/, "y")
    .replace(/([^s])s$/, "$1");

/**
 * Build `source path -> module guide` from the GUIDES THEMSELVES. Every guide
 * already quotes the files it documents in backticks, so the index updates
 * itself the moment a guide names a new file — nothing to keep in sync by hand.
 *
 * Secondary: normalised filename stem to guide name (mfg-sales-orders-list-v2 ->
 * sales-order), which catches the sibling files a guide has not got around to
 * quoting.
 */
/**
 * Does this file's diff change CODE, as opposed to only comments, blank lines
 * and import bookkeeping?
 *
 * Deliberately crude, and biased towards "no". A false NO costs one PR its
 * guide update; a false YES makes the gate fire on a typo fix in a comment,
 * and a gate that cries wolf is deleted within the week. The kinds of line
 * discounted here are the ones that genuinely cannot change behaviour.
 */
export function changesLogic(file) {
  const substantive = (t) => {
    const line = String(t).trim();
    if (line === "") return false;
    if (line.startsWith("//") || line.startsWith("/*") || line.startsWith("*") || line.startsWith("*/")) return false;
    if (/^import\s/.test(line) || /^export\s+\{[^}]*\}\s+from\s/.test(line)) return false;
    return true;
  };
  return file.added.some((l) => substantive(l.text)) || file.removed.some((l) => substantive(l.text));
}

export function buildModuleIndex(guides) {
  const byPath = new Map();
  const byStem = new Map();
  let mentions = 0;
  for (const g of guides) {
    const name = g.name.replace(/\.md$/, "");
    let m;
    const re = new RegExp(PATH_IN_GUIDE_RX.source, "g");
    while ((m = re.exec(g.text))) {
      const p = m[1];
      if (!/^(backend|frontend)\//.test(p)) continue;
      mentions++;
      if (!byPath.has(p)) byPath.set(p, new Set());
      byPath.get(p).add(name);
    }
    const stem = normaliseStem(name);
    if (!byStem.has(stem)) byStem.set(stem, new Set());
    byStem.get(stem).add(name);
  }
  return { byPath, byStem, mentions, guideCount: guides.length };
}

export function mapPathToGuides(path, index) {
  if (index.byPath.has(path)) {
    return { guides: [...index.byPath.get(path)], reason: "the guide quotes this file" };
  }
  const raw = path.split("/").pop().replace(/\.[^.]+$/, "");
  // `0287_scm_so_force_unlock_audit` is a migration NUMBER, not a module. Stem
  // matching it would have the check demanding `docs/modules/0287_....md`.
  if (/^\d{3,}[_-]/.test(raw)) return { guides: [], reason: null, stem: null };
  const stem = normaliseStem(raw);
  if (stem && index.byStem.has(stem)) {
    return {
      guides: [...index.byStem.get(stem)],
      reason: `filename stem "${stem}" matches the guide name`,
    };
  }
  return { guides: [], reason: null, stem };
}

/** `ALTER TABLE scm.mfg_sales_orders` -> `scm.mfg_sales_orders`, for saying WHICH module a migration is about. */
export function tablesTouched(file) {
  const rx = /\b(?:ALTER|CREATE)\s+TABLE\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?([A-Za-z_][\w.]*)/gi;
  const out = new Set();
  for (const { text } of file.added) {
    let m;
    while ((m = rx.exec(text))) out.add(m[1]);
  }
  return [...out];
}

// ---------------------------------------------------------------------------
// Rule 3 — migrations
// ---------------------------------------------------------------------------

const REVERSAL_RX = /^\s*(?:[-*]\s*)?(?:\*\*)?(reversal|reverse|rollback|revert(?:ed)?|down migration)(?:\*\*)?\s*:(.*)$/i;
const VERIFIED_RX =
  /^\s*(?:[-*]\s*)?(?:\*\*)?(verified against|verified on|verified with|verification|proved against|proven against)(?:\*\*)?\s*:(.*)$/i;
const PLACEHOLDER_RX = /^\s*(?:<[^>]*>|tbd|todo|n\/?a|none|-{1,3}|\.{3})?\s*$/i;

const findStatement = (body, rx) => {
  for (const line of String(body || "").split("\n")) {
    const m = rx.exec(line);
    if (!m) continue;
    const value = m[2].trim();
    if (PLACEHOLDER_RX.test(value)) continue;
    // Twelve characters is roughly "drop column x" — short enough to allow a
    // real terse answer, long enough that "yes" and "ok" are not answers.
    if (value.length < 12) continue;
    return { label: m[1], value };
  }
  return null;
};

// ---------------------------------------------------------------------------
// Rule 4 — a REMEDY CLAIM needs the run that proved it
//
// The three rules above gate CODE. Nothing gated a CLAIM ABOUT AN OPERATION —
// a sentence telling a future reader that running some thing will repair some
// other thing. That sentence is not code, so no test covers it; it is not a
// population, so `completeness-claim` does not see it; it is not a migration,
// so `Reversal:` does not apply. It goes straight into a PR body or a module
// guide and is believed.
//
// 2026-08-19 is the worked example, and it cost the owner a day of a
// salesperson's work. A PR shipped `?mode=all` on the AutoCount pull and
// described it as "the clean way to collect a backlog". That sentence was
// written from READING `services/pull.ts:29` — `getAll()` is called and the
// checkpoint is not touched, both true — and the operation was never once
// executed. Dispatched against production afterwards: 39 seconds, then HTTP 503
// `Worker exceeded resource limits`. ~13,000 orders cannot be fetched and
// upserted inside one Cloudflare Worker request. The remedy that shipped was
// `?since=YYYY-MM-DD` windows.
//
// Note what would NOT have caught it. The code was correct — `mode=all` does
// exactly what the source says. Types, lint, tests and review all passed,
// because none of them was wrong. The only wrong artifact was the CLAIM, and
// this repo had nothing that reads claims about operations.
//
// WHAT THIS GATE CAN AND CANNOT DO — stated plainly, because overselling a
// check is the same failure in a different costume.
//
//   It CANNOT verify the pasted output is real. Unlike `completeness-claim`,
//   which re-runs the enumeration, a production dispatch cannot be reproduced
//   in CI. A determined author can forge an `Observed:` line.
//
//   It CAN catch the claim written from reading, which is the failure that
//   actually happens here — the author is not lying, they simply never ran it
//   and had no moment that asked. That author has NOTHING to paste. They must
//   either go and run it, or write UNTESTED, and UNTESTED is the word that
//   stops a reader from relying on the sentence.
//
// Forgetting and forging are different acts. This gate is aimed at the first.
// ---------------------------------------------------------------------------

export const LABEL_REMEDY_UNTESTED = "remedy-untested";

/**
 * PRESCRIBING an operation — telling the reader to perform one. Not merely
 * mentioning that one exists.
 *
 * The distinction is the whole gate, and the first draft got it wrong in both
 * directions when run against the real files. A bare `\brun\b` fired on "the
 * job kept reporting a normal-looking run", which prescribes nothing; and
 * requiring the outcome on the SAME line missed the actual defect, because
 * "Run the pull in 'all' mode" and "the clean way to collect a backlog" are
 * four console.log lines apart. So: an imperative must sit at a sentence
 * boundary (capitalised, as imperatives are), or carry a modal, or be a gerund
 * subject — and the outcome is looked for in a small WINDOW after it.
 */
/* CASE MATTERS for the bare imperative, and nowhere else. "Run the pull" is an
   instruction; "a normal-looking run" is narration, and the capital is what
   tells them apart without parsing English. The boundary set includes a quote
   and an open paren because the sentences this gate exists for live inside
   console.log("..."), and leaving those out made the detector silent on the
   exact line it was built from. */
const IMPERATIVE_RX =
  /(?:^|[.:;!?]\s+|^\s*[-*>]\s+|["'`(\[]\s*)(?:Re-?run|Run|Dispatch|Trigger|Execute|Invoke|Kick off)\b/;

/* Everything else is case-insensitive: "Just re-run it" and "just re-run it"
   prescribe equally, and only the first was matched while this was one regex. */
const PRESCRIPTION_RX = new RegExp(
  [
    String.raw`\b(?:can|could|should|shall|will|must|just|simply|to|then|please)\s+(?:re-?)?(?:run|dispatch|trigger|execute|invoke)\b`,
    String.raw`\bre-?running\b`,
    String.raw`\bthe (?:clean(?:est)?|right|correct|proper|only|simplest?|safe(?:st)?) way\b`,
  ].join("|"),
  "i",
);

/* ---------------------------------------------------------------------------
   CHINESE. The owner writes in Chinese, and the first version of this rule was
   English-only — so the gate was blind to the half of this repo's PR bodies
   most likely to carry an unproved promise. Measured before writing this:
   「跑这个就能补回来」, 「重跑一次 sync 就会好了」, 「执行 mode=all 就可以把历史补
   齐」, 「dispatch 一次这个 workflow 就能修复」 and 「跑 all 模式是补历史的干净做
   法」 — five real claim shapes, all five silently missed.

   Chinese has no word boundaries, so `\b` does nothing and a single common
   character carries far too much. Every pattern below is therefore a
   MULTI-CHARACTER phrase: bare 跑 would fire on 「一直在跑」 (narration) and bare
   好 on 「好像」. The one exception is 跑 followed by a LATIN token — 「跑 all
   模式」, 「跑 mode=all」 — which is a command being named, and cannot collide
   with 跑了 / 跑得 / 跑步 because those continue in CJK.
   --------------------------------------------------------------------------- */
const CN_PRESCRIPTION =
  /(重新?跑|再跑一?次?|跑一次|跑这个|跑那个|去跑|手动跑|执行|触发|派发|dispatch\s*[一-鿿]|跑\s*[A-Za-z0-9`'"-])/;

const CN_OUTCOME =
  /(修好|修复|补回|补齐|补上|补完|补起来|恢复|救回|解决掉|解决了|就会好|就能好|就没事|干净做法|正确做法|唯一办法|最好的做法)/;

/* Negation, checked in the FOUR characters against the promise rather than
   across the sentence — the same narrowing the English side needed. 「补不回来」
   never matches CN_OUTCOME at all (不 sits inside the phrase), which is the
   cheapest possible way to get 「跑了 all 模式，但是补不回来」 right. */
const CN_NEGATED = /[不没无未别]/;

const prescribesCn = (line) => CN_PRESCRIPTION.test(line);

const prescribes = (line) =>
  IMPERATIVE_RX.test(line) || PRESCRIPTION_RX.test(line) || prescribesCn(line);

/**
 * The first promise in `text` that is not denied right where it stands.
 *
 * Negation is checked in the `lookback` characters immediately BEFORE the
 * promise, never across the whole window, and that narrowing was bought by
 * testing against the real file. The stale verdict in
 * backend/scripts/check-autocount-pull-health.mjs reads:
 *
 *   "...uses /getAll and does NOT touch the checkpoint, so it is the clean
 *    way to collect a backlog..."
 *
 * A window-wide negation check sees "does NOT" and lets the exact sentence this
 * gate was built from walk straight through. That "not" denies a side effect; it
 * does not deny the remedy.
 */
function matchPromise(text, outcomeRx, negatedRx, lookback) {
  const m = outcomeRx.exec(text);
  if (!m) return null;
  const around = text.slice(Math.max(0, m.index - lookback), m.index + m[0].length);
  return negatedRx.test(around) ? null : m;
}

/** How far after the prescription the promise may sit. Four console.log lines. */
const CLAIM_WINDOW = 3;

/** Claiming that the operation REPAIRS something. */
const OUTCOME_RX =
  /\b(?:fix(?:es|ed|ing)?|repairs?|recover(?:s|ed|ing|y)?|restores?|collects?|unblocks?|unfreezes?|resolves?|catch(?:es)? up|clean way|the way to|will bring|brings? (?:it|them|these|those|the \w+) in)\b/i;

/**
 * A sentence that DENIES a remedy is the opposite of the failure — it is the
 * correction. `all` DOES NOT WORK on this book" must not trip the gate that
 * exists because "`all` is the clean way" did.
 */
const NEGATED_RX =
  /\b(?:does ?n[o']t|do ?n[o']t|did ?n[o']t|cannot|can ?n[o']t|will ?n[o']t|wo ?n[o']t|is ?n[o']t|are ?n[o']t|never|no longer|fails? to|failed to|impossible|instead of|rather than|without|not)\b/i;

/** A question asks; it does not assert. */
const QUESTION_RX = /\?\s*$/;

/**
 * Evidence. `Observed:` and its synonyms, and the value has to look like
 * something a person LOOKED AT — a number, a URL, or an outcome word. Twelve
 * characters of prose is the same bar rule 3 sets; the outcome token is the
 * extra one, because "Observed: it works" is a restatement of the claim.
 */
const OBSERVED_RX =
  /^\s*(?:[-*]\s*)?(?:\*\*)?(observed|ran it|i ran|actual result|output was|result was|proved by running|dispatched|measured)(?:\*\*)?\s*:(.*)$/i;
const OUTCOME_TOKEN_RX =
  /\d|https?:\/\/|\b(?:returned|exit|status|rows?|error|failed|succeeded|took|empty|none|zero|ok|200|503)\b/i;

/** The author's own admission, per claim, in the one spelling nobody types by accident. */
const UNTESTED_RX = /\bUNTESTED\b/;

/**
 * Find prescriptive sentences: a line that PRESCRIBES an operation, with a
 * claim that it repairs something in the same line or the next few.
 *
 * Fenced blocks are skipped throughout. A fence holds a transcript or a
 * command — the evidence, or the thing itself — not a promise about one, and
 * failing a PR for pasting the very output the gate asked for would be absurd.
 */
export function findRemedyClaims(text) {
  const claims = [];
  const raw = String(text || "").split("\n");
  const open = raw.map(() => false);
  let inFence = false;
  for (let i = 0; i < raw.length; i++) {
    if (/^\s*```/.test(raw[i])) {
      inFence = !inFence;
      open[i] = true; // the fence line itself is never prose
      continue;
    }
    open[i] = inFence;
  }

  for (let i = 0; i < raw.length; i++) {
    if (open[i]) continue;
    const line = raw[i].trim();
    if (!line || QUESTION_RX.test(line)) continue;
    if (!prescribes(line)) continue;

    // The window: this line plus the next few PROSE lines, joined. A promise
    // may trail the instruction by a sentence or two.
    const window = [line];
    for (let j = i + 1; j <= i + CLAIM_WINDOW && j < raw.length; j++) {
      if (open[j]) break;
      window.push(raw[j].trim());
    }
    const joined = window.join(" ");

    /* Two languages, each with its own promise vocabulary AND its own lookback
       distance. 34 characters is about a clause of English; Chinese says the
       same thing in a fraction of that, so a 34-character Chinese lookback
       would reach back into an unrelated sentence and suppress real claims.
       A line may satisfy either side — mixed-language bodies are the norm here
       ("dispatch 一次这个 workflow 就能修复"). */
    const promise =
      matchPromise(joined, OUTCOME_RX, NEGATED_RX, 34) ?? matchPromise(joined, CN_OUTCOME, CN_NEGATED, 4);
    if (!promise) continue;

    claims.push({
      text: joined.length > 200 ? `${joined.slice(0, 197)}...` : joined,
      line: i + 1,
      untested: UNTESTED_RX.test(joined),
    });
    i += window.length - 1; // one finding per claim, not one per window line
  }
  return claims;
}

/** Did the author paste something they actually looked at? */
export function findObservation(body) {
  for (const line of String(body || "").split("\n")) {
    const m = OBSERVED_RX.exec(line);
    if (!m) continue;
    const value = m[2].trim();
    if (PLACEHOLDER_RX.test(value)) continue;
    if (value.length < 12) continue;
    if (!OUTCOME_TOKEN_RX.test(value)) continue;
    return { label: m[1], value };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rendering order
// ---------------------------------------------------------------------------

/** The rules this repo has, in the order they read best. */
export const RULE_ORDER = ["bug-history", "module-guide", "migration-notes", "remedy-claim"];

/**
 * Every rule present in `findings`, known ones first in RULE_ORDER, unknown
 * ones appended in first-seen order.
 *
 * This lives here, tested, because the runner's inline version was WRONG and
 * wrong in the silent direction. Adding rule 4 while the runner still iterated
 * a hardcoded three-element list produced a gate that counted "1 violation(s)",
 * exited 1, and said nothing about what the violation was. The replacement —
 *
 *     ...findings.map((f) => f.rule).filter((r) => !seen.has(r) && !seen.add(r))
 *
 * — reads as a de-dup idiom and appends NOTHING, ever: `Set.prototype.add`
 * returns the Set, which is truthy, so `!seen.add(r)` is always false. It was
 * shipped with a commit message asserting it "appends any rule the list has not
 * heard of", written from reading it and never run. Same failure as the
 * `mode=all` claim this PR exists for, inside the fix for that claim.
 *
 * Hence: a pure function, in the file the tests import.
 */
export function renderOrder(findings) {
  const order = [...RULE_ORDER];
  for (const f of findings || []) {
    if (f && f.rule && !order.includes(f.rule)) order.push(f.rule);
  }
  return order;
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/**
 * @returns {{ok: boolean, findings: Array, summary: object}}
 */
export function evaluate({ title, branch, body, labels, templateBody, files, guides }) {
  const findings = [];
  const labelSet = new Set((labels || []).map((l) => String(l).toLowerCase()));
  const add = (level, rule, message, detail) => findings.push({ level, rule, message, detail });

  const index = buildModuleIndex(guides);

  // --- rule 1 -------------------------------------------------------------
  const fix = detectFixIntent({ title, branch, body, templateBody });
  const codeFiles = files.filter((f) => isCodePath(f.path));
  const bh = addsBugHistoryEntry(files);

  if (fix.isFix && codeFiles.length > 0) {
    const why = fix.signals.map((s) => `${s.where}: "${s.match}"`).join(", ");
    if (labelSet.has(LABEL_NO_BUG_HISTORY)) {
      add(
        "escape",
        "bug-history",
        `SKIPPED by label \`${LABEL_NO_BUG_HISTORY}\` — this PR reads as a fix (${why}) and touches ${codeFiles.length} code file(s), and is shipping with NO BUG-HISTORY.md entry.`,
      );
    } else if (bh.entry) {
      add("pass", "bug-history", `New BUG-HISTORY.md entry: ${bh.heading}`);
    } else if (bh.touched) {
      add(
        "fail",
        "bug-history",
        `BUG-HISTORY.md was touched but no new entry was added (no new "## " heading).`,
        `Fix signals — ${why}. CLAUDE.md: one entry, Symptom -> Root cause -> Fix -> Ref, newest first, in the SAME PR.`,
      );
    } else {
      add(
        "fail",
        "bug-history",
        `This PR reads as a fix and changes code, but BUG-HISTORY.md is untouched.`,
        [
          `Fix signals — ${why}`,
          `Code files — ${codeFiles.slice(0, 6).map((f) => f.path).join(", ")}${codeFiles.length > 6 ? ` (+${codeFiles.length - 6} more)` : ""}`,
          `CLAUDE.md marks this MANDATORY. Add the entry, or apply the \`${LABEL_NO_BUG_HISTORY}\` label so the exception is on the record.`,
        ].join("\n    "),
      );
    }
  } else if (fix.isFix) {
    add("info", "bug-history", "Reads as a fix, but touches no backend/frontend code. Not required.");
  } else {
    add("info", "bug-history", "Does not read as a fix. Not required.");
  }

  // --- rule 2 -------------------------------------------------------------
  const touchedGuides = new Set(
    files
      .filter((f) => f.path.startsWith(MODULE_GUIDE_DIR) && f.path.endsWith(".md"))
      .map((f) => f.path.slice(MODULE_GUIDE_DIR.length).replace(/\.md$/, "")),
  );
  const guideNames = new Set(guides.map((g) => g.name.replace(/\.md$/, "")));

  const surfaces = [];
  for (const f of files) {
    if (!isSurfacePath(f.path)) continue;
    const changes = detectSurfaceChanges(f);
    if (changes.length) surfaces.push({ path: f.path, changes, file: f });
  }

  /* LOGIC, not only surface (owner 2026-08-18: 「backend 逻辑更改 你要更新的啊」).
     detectSurfaceChanges only fires on five shapes — a new route, permission,
     status value, required-field flip or lock — so a change to a RULE sailed
     past saying nothing. Measured on this repo the same day: of the last 30
     merges, 19 touched a file some guide quotes and 8 of those never opened the
     guide. One of the 8 is the commit that created the shared Branding rule.

     Scope is deliberately the files a guide QUOTES BY PATH — 343 of 1454, the
     ones somebody chose to document — and not mapPathToGuides' filename-stem
     fallback, which is a guess. A guess that fails a PR is a gate people learn
     to route around. So: if the guide claims to describe this file and the file's
     logic moved, the guide is stale until proven otherwise. */
  const surfacePaths = new Set(surfaces.map((s) => s.path));
  for (const f of files) {
    if (surfacePaths.has(f.path)) continue;
    if (!index.byPath.has(f.path)) continue;
    if (!changesLogic(f)) continue;
    surfaces.push({
      path: f.path,
      changes: [{ kind: "logic", detail: "code changed in a file a module guide documents" }],
      file: f,
    });
  }

  if (surfaces.length === 0) {
    add("info", "module-guide", "No module surface change detected (no new route, permission, status, required-field flip or lock).");
  } else {
    const unmapped = [];
    const missing = [];
    for (const s of surfaces) {
      const { guides: owners, reason, stem } = mapPathToGuides(s.path, index);
      const what = s.changes.map((c) => `${c.kind}: ${c.detail}`).join("; ");
      if (owners.length === 0) {
        unmapped.push({ ...s, what, stem, tables: s.path.endsWith(".sql") ? tablesTouched(s.file) : [] });
        continue;
      }
      if (owners.some((g) => touchedGuides.has(g))) continue;
      missing.push({ ...s, what, owners, reason });
    }

    if (missing.length && labelSet.has(LABEL_NO_GUIDE)) {
      add(
        "escape",
        "module-guide",
        `SKIPPED by label \`${LABEL_NO_GUIDE}\` — ${missing.length} module surface change(s) are shipping without a guide update: ` +
          missing.map((m) => `${m.path} (${m.what}) -> ${MODULE_GUIDE_DIR}${m.owners[0]}.md`).join(" | "),
      );
    } else {
      for (const m of missing) {
        add(
          "fail",
          "module-guide",
          m.changes.every((c) => c.kind === "logic")
            ? `${m.path} changed, and the guide that documents it was not updated.`
            : `${m.path} changes this module's SURFACE, and its guide was not updated.`,
          [
            `Surface — ${m.what}`,
            `Guide — ${m.owners.map((g) => `${MODULE_GUIDE_DIR}${g}.md`).join(" or ")} (${m.reason})`,
            `CLAUDE.md: "If your change alters that module's SURFACE ... update the guide in the same PR." Or apply \`${LABEL_NO_GUIDE}\`.`,
          ].join("\n    "),
        );
      }
    }

    // A gap in the guide set is NOT this PR's fault, and failing it would get
    // the gate deleted by Friday. It is still said out loud, with the module
    // named, because CLAUDE.md calls a missing guide "the gap to close".
    for (const u of unmapped) {
      add(
        "warn",
        "module-guide",
        `${u.path} changes a surface (${u.what}) and NO module guide covers it.`,
        u.stem
          ? `Nothing in ${MODULE_GUIDE_DIR} quotes this file, and no guide is named "${u.stem}". CLAUDE.md: "If a module has no guide yet, that is the gap to close" — write ${MODULE_GUIDE_DIR}${u.stem}.md following docs/modules/sales-order.md.`
          : `Nothing in ${MODULE_GUIDE_DIR} quotes this file${u.tables.length ? `, which alters ${u.tables.join(", ")}` : ""}. Name the module that owns it and say this there — a numbered migration is not itself a module.`,
      );
    }

    if (!missing.length && !unmapped.length) {
      add("pass", "module-guide", `Surface changed in ${surfaces.length} file(s); the owning guide(s) were updated.`);
    }
  }

  for (const g of touchedGuides) {
    if (!guideNames.has(g)) {
      add("info", "module-guide", `New module guide added: ${MODULE_GUIDE_DIR}${g}.md`);
    }
  }

  // --- rule 3 -------------------------------------------------------------
  const migrations = files.filter((f) => isMigrationPath(f.path));
  if (migrations.length === 0) {
    add("info", "migration-notes", "No migrations-pg change.");
  } else {
    const reversal = findStatement(body, REVERSAL_RX);
    const verified = findStatement(body, VERIFIED_RX);
    const names = migrations.map((m) => m.path.split("/").pop()).join(", ");
    if (reversal && verified) {
      add("pass", "migration-notes", `${names}: reversal and verification are both stated in the body.`);
    } else {
      add(
        "fail",
        "migration-notes",
        `${names}: the PR body must state how this migration is REVERSED and what it was VERIFIED AGAINST.`,
        [
          reversal ? `Reversal: ${reversal.value}` : "Missing: a line reading `Reversal: <how it is undone, or why it cannot be>`",
          verified ? `Verified against: ${verified.value}` : "Missing: a line reading `Verified against: <the database/catalog it was proved on>`",
          `The 0284 rename was proved only on a replica and nobody had read the live catalog. pg-migrate tracks by FULL FILENAME — renaming an applied file runs its SQL a second time.`,
        ].join("\n    "),
      );
    }
  }

  // --- rule 4 -------------------------------------------------------------
  /* The DE-TEMPLATED body, for the reason rule 1 uses it: the PR template is
     contributed to every body, so a single prescriptive sentence in the
     template would fail every pull request in the repo — the same way the
     template's own word "fix" once reported every PR as a fix. The observation
     is read from the RAW body, because an `Observed:` line the author typed
     into a template field is still the author's evidence. */
  const prose = stripTemplateLines(body, templateBody);
  const bodyClaims = findRemedyClaims(prose);
  const observation = findObservation(body);

  if (bodyClaims.length === 0) {
    add("info", "remedy-claim", "No remedy claim in the body (no line prescribing an operation as a repair).");
  } else if (observation) {
    add(
      "pass",
      "remedy-claim",
      `${bodyClaims.length} remedy claim(s), and the run that proved them is in the body: ${observation.label}: ${observation.value.slice(0, 120)}`,
    );
  } else if (bodyClaims.every((c) => c.untested)) {
    add(
      "escape",
      "remedy-claim",
      `Every remedy claim is marked UNTESTED by the author: ${bodyClaims.map((c) => `"${c.text}"`).join(" | ")}`,
    );
  } else if (labelSet.has(LABEL_REMEDY_UNTESTED)) {
    add(
      "escape",
      "remedy-claim",
      `SKIPPED by label \`${LABEL_REMEDY_UNTESTED}\` — ${bodyClaims.length} remedy claim(s) are shipping with no evidence anyone ran the operation: ` +
        bodyClaims.map((c) => `"${c.text}"`).join(" | "),
    );
  } else {
    add(
      "fail",
      "remedy-claim",
      `This PR tells a reader that running something will repair something, and shows no sign the operation was ever run.`,
      [
        ...bodyClaims.filter((c) => !c.untested).map((c) => `Claim — "${c.text}"`),
        `Add a line reading \`Observed: <what actually happened when you ran it>\` — a status, a count, a duration, an error, a run URL.`,
        `If you have not run it, write UNTESTED in the sentence itself, or apply \`${LABEL_REMEDY_UNTESTED}\`. Both are honest; silence is not.`,
        `CLAUDE.md, rule 3 of "Do not guess": \`mode=all\` was written from reading pull.ts:29 and never executed. 39s -> HTTP 503 Worker exceeded resource limits.`,
      ].join("\n    "),
    );
  }

  /* The same sentence in a GUIDE or a check script's verdict is aimed at a
     reader who is not in this conversation and cannot ask. It is warned, not
     failed, for the reason the unmapped-guide finding above is warned: a gate
     that fails on prose gets routed around, and rule 2 already brings the guide
     author to this output. That this is not hypothetical: the `mode=all`
     correction landed in docs/modules/system-health.md and MISSED the identical
     claim in the check script's own VERDICT text, where it is still printing
     today. One correction, two homes, one of them forgotten. */
  for (const f of files) {
    const prescriptive =
      (f.path.startsWith(MODULE_GUIDE_DIR) && f.path.endsWith(".md")) || /(^|\/)scripts\/check-[^/]+\.mjs$/.test(f.path);
    if (!prescriptive) continue;
    const claims = findRemedyClaims(f.added.map((a) => a.text).join("\n")).filter((c) => !c.untested);
    if (!claims.length) continue;
    add(
      "warn",
      "remedy-claim",
      `${f.path} adds ${claims.length} line(s) telling a future reader that an operation will repair something.`,
      [
        ...claims.map((c) => `Claim — "${c.text}"`),
        `A reader of this file cannot ask you whether you ran it. Say what you observed, or write UNTESTED.`,
      ].join("\n    "),
    );
  }

  const ok = !findings.some((f) => f.level === "fail");
  return {
    ok,
    findings,
    summary: {
      fix,
      codeFiles: codeFiles.length,
      files: files.length,
      surfaces,
      guideCount: index.guideCount,
      guideMentions: index.mentions,
      mappedPaths: index.byPath.size,
      migrations: migrations.length,
      escapes: findings.filter((f) => f.level === "escape").length,
    },
  };
}
