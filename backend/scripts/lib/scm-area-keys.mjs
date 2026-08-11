// The set of L2 area keys a write-freeze exception may name — read from
// src/scm/index.ts at run time so the scripts can never disagree with the
// routers they are describing.
//
// WHY PARSE THE SOURCE rather than hardcode a list here. These scripts run from
// a repo checkout (GitHub Actions checks the tree out before invoking them), and
// index.ts is the authority for which areas exist: src/scm/lib/scm-areas.ts is
// itself a mirror of it, pinned by tests/writeFreezeAreas.test.ts. Reading the
// same file keeps a THIRD copy from appearing in scripts/, which is exactly how
// a validator ends up rejecting a module that shipped last week.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const INDEX_TS = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "src",
  "scm",
  "index.ts",
);

/** Every area key mounted behind an scmAreaGuard, as a Set. */
export function readScmAreaKeys(file = INDEX_TS) {
  /* Whole-line `//` comments are dropped so the doc example in the L2 block is
     not read as a mount. Block comments are NOT stripped: several mount paths
     contain the `/*` sequence (e.g. "/products/*") and a naive strip eats the
     file. Requiring the area to start with `scm.` excludes the placeholder. */
  const code = readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");
  const re = /scm\.use\(\s*["'][^"']+["']\s*,\s*scmAreaGuard\(\s*["'](scm\.[^"']+)["']/g;
  const out = new Set();
  let m;
  while ((m = re.exec(code))) out.add(m[1]);
  if (out.size === 0) throw new Error(`no scmAreaGuard mounts found in ${file} — the parser is broken, not the tree`);
  return out;
}

/**
 * Validate a write-freeze value the way the middleware parses it.
 * Returns { ok, value, scope, open, problems[] }. `ok` is false for anything
 * the middleware would treat as malformed OR that names an area that does not
 * exist — the point being to reject at the door, so fail-closed stays a
 * backstop rather than the thing that catches a routine typo.
 */
export function validateFreezeValue(raw, areaKeys = readScmAreaKeys()) {
  const v = String(raw ?? "").trim().toLowerCase();
  const problems = [];
  if (["", "off", "0", "false"].includes(v)) {
    return { ok: true, value: v || "off", scope: "off", open: [], problems };
  }

  const dash = v.indexOf("-");
  const head = (dash === -1 ? v : v.slice(0, dash)).trim();
  const tail = dash === -1 ? "" : v.slice(dash + 1).trim();
  const split = (s) => s.split(",").map((t) => t.trim()).filter(Boolean);

  let scope;
  if (["all", "true"].includes(head)) {
    scope = "all";
  } else {
    const tokens = split(head);
    const ids = tokens.filter((t) => /^\d+$/.test(t));
    if (tokens.length > 0 && ids.length === tokens.length) {
      scope = [...new Set(ids.map(Number))];
    } else {
      scope = "all";
      problems.push(
        `company scope ${JSON.stringify(head)} is not 'all' or a comma-separated list of company ids`,
      );
    }
  }

  const open = [];
  for (const token of split(tail)) {
    const key = token.startsWith("scm.") ? token : `scm.${token}`;
    if (areaKeys.has(key)) { if (!open.includes(key)) open.push(key); }
    else problems.push(`area ${JSON.stringify(token)} does not exist (nearest keys: ${nearest(key, areaKeys).join(", ")})`);
  }

  return { ok: problems.length === 0, value: v, scope, open, problems };
}

/** Cheap "did you mean" — shared prefix length, best three. */
function nearest(key, areaKeys) {
  const score = (a) => {
    let i = 0;
    while (i < a.length && i < key.length && a[i] === key[i]) i += 1;
    return i;
  };
  return [...areaKeys].sort((a, b) => score(b) - score(a)).slice(0, 3);
}

/** One line describing what a validated value will DO. */
export function describeFreezeValue({ scope, open }) {
  if (scope === "off") return "OPEN for every company";
  const who = scope === "all" ? "EVERY company" : `company ${scope.join(", ")} only (others trade normally)`;
  return open.length
    ? `FROZEN for ${who}, EXCEPT ${open.join(", ")} which can save`
    : `FROZEN for ${who}, every area`;
}
