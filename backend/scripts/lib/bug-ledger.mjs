/**
 * The bug ledger, read from ONE FILE PER ENTRY.
 *
 * NO SHEBANG — this is imported by tests (see CLAUDE.md, "Anything a TEST
 * imports lives in a lib/ and carries NO shebang": on Windows vitest inlines the
 * module and a `#!` that is no longer at byte 0 is a load-time SyntaxError).
 *
 * WHY THE LEDGER IS A DIRECTORY. Until 2026-08-20 every entry was prepended to
 * the same first line of `BUG-HISTORY.md`, and the working agreement makes that
 * append MANDATORY for every code PR. `.gitattributes` carried
 * `BUG-HISTORY.md merge=union` so OUR git resolved it silently — but GitHub's
 * git does not read this repository's `.gitattributes`, and `main` now runs a
 * MERGE QUEUE, which stacks entry 2 on entry 1's result using GitHub's git.
 *
 * Measured on the live queue, 2026-08-20 afternoon:
 *
 *     1  AWAITING_CHECKS  #2553   <- only position 1 ever builds
 *     2  UNMERGEABLE      #2554
 *     3  UNMERGEABLE      #2557
 *     4  UNMERGEABLE      #2549
 *     5  UNMERGEABLE      #2551
 *     6  UNMERGEABLE      #2555
 *     7  UNMERGEABLE      #2556
 *
 * All six non-leading entries UNMERGEABLE, and all seven touched
 * `BUG-HISTORY.md`. The queue was serialised to one PR at a time — about eight
 * minutes each — by the repo's own mandatory rule.
 *
 * One file per entry removes the shared line: two PRs adding entries write two
 * different paths, so there is nothing for any git to call a conflict.
 *
 * The combined newest-first view is GENERATED on demand
 * (`npm --prefix backend run gen:bug-history`) and is NOT tracked, which is the
 * shape `docs/generated/bug-index.md` already set on 2026-08-18: a generated
 * file that stays in git conflicts exactly as hard as the file it replaced.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Where the entries live, relative to the repo root. */
export const BUG_DIR = "docs/bugs";

/** The combined view, regenerated on demand and gitignored. */
export const LEDGER_OUT = "docs/generated/bug-history.md";

/**
 * An entry file. The four-digit prefix is the ORDER — higher is newer — and it
 * is what makes the combined view reproducible without storing a manifest that
 * every PR would then conflict on.
 *
 * `docs/bugs/README.md` is deliberately NOT of this shape, so the directory can
 * carry its own explanation without the explanation becoming an entry.
 */
export const ENTRY_FILE_RX = /^(\d{4,})-([a-z0-9][a-z0-9-]*)\.md$/;

/** The heading that opens an entry: `## Title [severity]`. */
export const ENTRY_HEADING_RX = /^##\s+(.*?)\s*(?:\[(\w+)\])?\s*$/;

/**
 * Split one entry file into title / severity / body.
 *
 * The heading must be the FIRST line. That is the invariant that keeps one file
 * = one entry, and `gen-bug-history.mjs --check` fails on a file that breaks it
 * rather than silently rendering a second entry nobody indexed.
 */
export function parseEntry(text) {
  const lines = String(text).split(/\r?\n/);
  const m = ENTRY_HEADING_RX.exec(lines[0] ?? "");
  if (!m) return null;
  return {
    title: m[1],
    severity: m[2] ?? "unspecified",
    heading: lines[0],
    body: lines.slice(1).join("\n"),
    /** Every `## ` line in the file — more than one means the file holds two entries. */
    headingCount: lines.filter((l) => /^##\s+\S/.test(l)).length,
  };
}

const AREA_TAG = /<!--\s*area:\s*([^>]+?)\s*-->/i;

/**
 * Read every entry, NEWEST FIRST.
 *
 * Line endings are normalised to LF on read. `core.autocrlf=true` is the norm on
 * the Windows machine this repo is developed on, so without this the combined
 * view would differ byte-for-byte between platforms and every round-trip check
 * would be a coin flip.
 */
export function readEntries(repoRoot) {
  const dir = path.join(repoRoot, BUG_DIR);
  if (!fs.existsSync(dir)) return { dir, entries: [], skipped: [] };

  const entries = [];
  const skipped = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith(".md")) continue;
    const m = ENTRY_FILE_RX.exec(name);
    if (!m) {
      skipped.push(name);
      continue;
    }
    const raw = fs.readFileSync(path.join(dir, name), "utf8").replace(/\r\n/g, "\n");
    const parsed = parseEntry(raw);
    entries.push({
      name,
      file: `${BUG_DIR}/${name}`,
      ordinal: Number(m[1]),
      slug: m[2],
      text: raw,
      parsed,
      area: parsed ? AREA_TAG.exec(parsed.body)?.[1] ?? null : null,
      ref: parsed ? (/\*\*Ref\*\*[.:]?\s*[-—]?\s*(.+)/.exec(parsed.body)?.[1] ?? "").replace(/`/g, "").trim() : "",
    });
  }

  // Newest first: descending ordinal. Ties fall to the LATER filename so the
  // order is total — two branches can pick the same ordinal without a conflict,
  // and a deterministic tiebreak is what stops that showing up as churn.
  entries.sort((a, b) => b.ordinal - a.ordinal || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  for (const e of entries) {
    const d = /(\d{4}-\d{2}-\d{2})/.exec(e.ref);
    e.date = d ? d[1] : "";
  }
  return { dir, entries, skipped };
}

/**
 * The combined newest-first ledger, exactly as `BUG-HISTORY.md` used to read:
 * every entry verbatim, one blank line between them, LF throughout.
 */
export function renderLedger(entries) {
  return entries.map((e) => `${e.text.replace(/\s+$/, "")}\n`).join("\n");
}

/** The next free ordinal. Not a lock — see `scripts/new-bug.mjs`. */
export function nextOrdinal(entries) {
  return entries.reduce((n, e) => Math.max(n, e.ordinal), 0) + 1;
}

/** `Some title` -> `some-title`, the slug half of an entry filename. */
export function slugify(title) {
  return (
    String(title)
      .replace(/\s*\[[^\]]*\]\s*$/, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
      .replace(/-+$/, "") || "entry"
  );
}

// ---------------------------------------------------------------------------
// Whose fault is it?
// ---------------------------------------------------------------------------

/**
 * The entry directory as it stands at the merge base with `origin/main`.
 *
 * WHY EVERY GATE OVER THIS DIRECTORY NEEDS IT. `audit:bug-index` and
 * `audit:bug-history` both run inside `backend-typecheck`, which IS a required
 * status check, and this directory is the one place the working agreement makes
 * every code PR write to. So a gate that refuses unconditionally turns one bad
 * file on `main` into a repo-wide CI blackout: on 2026-08-17 commit 6c9f8cbd
 * landed an unparseable `<!-- area: -->` tag at 04:00:21Z and until #2351
 * repaired it at 04:59:53Z, five of five PR-branch CI runs were red — three of
 * those branches had nothing to do with it, and because the generator exited
 * before writing, nobody could regenerate their way out either.
 *
 * REPORT in full, CHARGE only the change in front of you. Same rule
 * check-file-size.mjs uses for an inherited ceiling violation.
 *
 * @returns {{resolved: boolean, names: Set<string>, read: (name: string) => string|null}}
 *          `resolved:false` means "cannot tell whose fault it is" — a shallow
 *          clone, or no origin/main — and the caller must then charge
 *          everything, because a gate that cannot tell must not let things pass.
 */
export function mergeBaseLedger(repoRoot) {
  const git = (args) =>
    execFileSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });

  let base = null;
  try {
    git(["rev-parse", "--verify", "--quiet", "origin/main"]);
    base = git(["merge-base", "HEAD", "origin/main"]).trim();
  } catch {
    base = null;
  }
  if (!base) return { resolved: false, names: new Set(), read: () => null };

  let names = new Set();
  try {
    names = new Set(
      git(["ls-tree", "-r", "--name-only", base, "--", BUG_DIR])
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((p) => p.slice(BUG_DIR.length + 1)),
    );
  } catch {
    return { resolved: false, names: new Set(), read: () => null };
  }

  return {
    resolved: true,
    names,
    /* Read ON DEMAND, not the whole directory up front: the callers only ever ask about the
       handful of files they already found a problem in, and `git show` per entry
       across the whole directory would put ~460 process spawns in a required
       check. */
    read(name) {
      if (!names.has(name)) return null;
      try {
        return git(["show", `${base}:${BUG_DIR}/${name}`]).replace(/\r\n/g, "\n");
      } catch {
        return null;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// The OLD path, and why it needs a guard of its own
// ---------------------------------------------------------------------------

/**
 * The signpost left behind at the ledger's old path.
 *
 * WHY THIS IS GUARDED AT ALL. On 2026-08-20 #2567 split the ledger into
 * `docs/bugs/` and left ~40 lines of signpost here. On 2026-08-21 the whole
 * 24,000-line ledger was BACK at this path on `main`, and no check went red.
 *
 * The mechanism, reproduced rather than guessed at. A branch that forked BEFORE
 * #2567 still carries `BUG-HISTORY.md merge=union` in its own `.gitattributes`,
 * and a merge applies the attributes of the tree the merge is running IN. So
 * `git merge origin/main` on such a branch hits the one hunk where the branch
 * appended an entry and `main` replaced the file, resolves it by KEEPING BOTH
 * SIDES, prints `Auto-merging BUG-HISTORY.md`, and EXITS 0. The result is the
 * branch's entry, then every line #2567 deleted, then the signpost at the
 * bottom. It is a plausible-looking file produced by a successful command, which
 * is why review did not catch it either: #2568 merged it into `main`, and its
 * own entry then existed ONLY in the resurrected file.
 *
 * Removing the attribute from `main` — which #2567 already did — cannot fix
 * this, because the attribute that applies lives in the OTHER branch's tree.
 * Nothing on `main` can reach into a branch that forked a day ago. What `main`
 * CAN do is refuse to accept the result, which is what this is.
 */
export const SIGNPOST_PATH = "BUG-HISTORY.md";

/**
 * Judge the content of `BUG-HISTORY.md`. Pure: no I/O, so the CLI can self-test
 * it against synthetic samples before trusting it against the tree.
 *
 * @param {string} text          the signpost file's content
 * @param {Iterable<string>} entryTitles  every entry's heading line, from docs/bugs/
 * @returns {{kind: string, line: number, text: string}[]} empty means clean
 *
 * THREE RULES, and each one is an exact identity rather than a threshold. A
 * line-count ceiling was the obvious guard and is the wrong one: it is a number
 * somebody has to maintain, and the first time the signpost legitimately grows
 * the fix on offer is to raise it — which is how a ratchet stops ratcheting.
 *
 *   entry-heading        a line opening `## `, which is what EVERY reader in
 *                        this repo treats as the start of an entry
 *                        (ENTRY_HEADING_RX, gen-bug-history, the round-trip
 *                        test, the working-agreement gate). If a `## ` line is
 *                        here, ledger content is here.
 *   known-entry-title    a line that IS one of the ledger's own titles, with any
 *                        heading level or none. Catches a resurrection whose
 *                        heading level got mangled on the way in, which `## `
 *                        alone would miss.
 *   not-a-signpost       the file no longer names `docs/bugs`. Without this the
 *                        cheapest way to pass the two rules above is to empty
 *                        the file, and an empty file breaks the ~60 comments in
 *                        `backend/`, `frontend/` and `docs/` that cite this path
 *                        by name — the entire reason #2567 kept it.
 *
 * The cost, stated: a `## ` sub-heading can no longer be used INSIDE the
 * signpost. Use `###` or bold. That is a real restriction on ~40 lines of prose,
 * accepted because `## ` at line start is the one shape this repo has already
 * given a meaning to.
 */
export function signpostViolations(text, entryTitles) {
  const body = String(text).replace(/\r\n/g, "\n");
  const titles = new Set();
  for (const t of entryTitles) {
    const norm = String(t).replace(/^#+\s*/, "").trim();
    if (norm) titles.add(norm);
  }

  const out = [];
  const lines = body.split("\n");
  for (const [i, line] of lines.entries()) {
    if (/^##\s+\S/.test(line)) {
      out.push({ kind: "entry-heading", line: i + 1, text: line });
      continue;
    }
    const norm = line.replace(/^#+\s*/, "").trim();
    if (norm && titles.has(norm)) out.push({ kind: "known-entry-title", line: i + 1, text: line });
  }

  if (!body.includes(BUG_DIR)) {
    out.push({ kind: "not-a-signpost", line: 0, text: `the file never names ${BUG_DIR}` });
  }
  return out;
}
