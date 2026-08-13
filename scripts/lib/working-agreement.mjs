/**
 * The three MANDATORY owner rules in CLAUDE.md, expressed as code.
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
          `${m.path} changes this module's SURFACE, and its guide was not updated.`,
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
