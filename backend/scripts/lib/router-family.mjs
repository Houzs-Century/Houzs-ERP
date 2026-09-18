// ----------------------------------------------------------------------------
// router-family.mjs — the source a router is written across.
//
// A router file can hand its router to `register<Topic>Routes(router)` or
// `mount<Name>Route(router, ...)` declared in another file. Anything that reads
// "the router's source" to prove a guard is present — or absent — has to read
// those files too; otherwise moving a handler out of the router file quietly
// takes it out of every such check, and an absence assertion keeps passing over
// code it can no longer see.
//
// expandRouterFamily(entry, readSource) returns the entry file's source with
// the file behind each such call inlined directly after the call, so the text
// keeps REGISTRATION ORDER (a static path registered before `/:docNo` stays
// before it), the list of files read, and where each line of the result came
// from (so a failure can name the real file:line). Each file is inlined once, at its
// first call; calls inside an inlined file are followed the same way. A call
// that cannot be resolved THROWS: a family that silently stopped at the router
// file is the exact failure this exists to prevent.
//
// Keys are POSIX paths (relative is fine, `../` included) and `readSource(key)`
// returns the text or null. No node: imports, so the same code serves a node
// script (fs), the light test project and the workerd pool (`?raw` globs).
// ----------------------------------------------------------------------------

const REGISTER_CALL = /^[ \t]*(register[A-Z][\w$]*Routes|mount[A-Z][\w$]*Routes?)[ \t]*\(/;

/** Comments blanked to spaces, newlines kept, strings respected - so line N of
 *  the result is line N of the source and a `//` inside a string survives. */
export function blankComments(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      while (i < n && src[i] !== "\n") { out += " "; i += 1; }
      continue;
    }
    if (c === "/" && d === "*") {
      out += "  "; i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        out += src[i] === "\n" ? "\n" : " "; i += 1;
      }
      out += "  "; i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += c; i += 1;
      while (i < n) {
        if (src[i] === "\\") { out += src[i] + (src[i + 1] ?? ""); i += 2; continue; }
        out += src[i];
        if (src[i] === quote) { i += 1; break; }
        i += 1;
      }
      continue;
    }
    out += c; i += 1;
  }
  return out;
}

/** POSIX normalise that keeps leading `..` segments (glob keys start with them). */
function normalize(p) {
  const out = [];
  for (const part of p.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === ".." && out.length && out[out.length - 1] !== "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

const dirname = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : ".");

/** Value imports: local name -> module specifier. */
export function importSpecifiers(code) {
  const map = new Map();
  for (const m of code.matchAll(/\bimport\s+(?!type\s)([^;'"`]*?)\s*\bfrom\s*['"]([^'"]+)['"]/g)) {
    let clause = m[1].trim();
    const def = /^([A-Za-z_$][\w$]*)\s*(?:,|$)/.exec(clause);
    if (def) {
      map.set(def[1], m[2]);
      clause = clause.slice(def[0].length);
    }
    const named = /\{([\s\S]*)\}/.exec(clause);
    if (!named) continue;
    for (const part of named[1].split(",")) {
      const pm = /^\s*(?:type\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/.exec(part);
      if (pm) map.set(pm[2] ?? pm[1], m[2]);
    }
  }
  return map;
}

function declaresLocally(code, name) {
  return new RegExp(`(?:^|\\n)[ \\t]*(?:export\\s+)?(?:(?:async\\s+)?function\\s+|const\\s+)${name}\\b`).test(code);
}

/**
 * @param {string} entry POSIX key of the router file
 * @param {(key: string) => string | null} readSource
 * @returns {{ source: string, files: string[], origins: Array<{ file: string, line: number }> }}
 */
export function expandRouterFamily(entry, readSource) {
  const files = [];
  const lines = [];
  const origins = [];
  const expand = (key, depth) => {
    if (depth > 8) throw new Error(`router family: register calls nest deeper than 8 at ${key}`);
    const source = readSource(key);
    if (source === null || source === undefined) throw new Error(`router family: cannot read ${key}`);
    files.push(key);
    const code = blankComments(source);
    const imports = importSpecifiers(code);
    const sourceLines = source.split("\n");
    const codeLines = code.split("\n");
    sourceLines.forEach((line, i) => {
      lines.push(line);
      origins.push({ file: key, line: i + 1 });
      const call = REGISTER_CALL.exec(codeLines[i] ?? "");
      if (!call || declaresLocally(code, call[1])) return;
      const specifier = imports.get(call[1]);
      if (!specifier || !specifier.startsWith(".")) {
        throw new Error(`router family: ${call[1]}(...) at ${key}:${i + 1} is neither declared in the file nor a relative import`);
      }
      const base = normalize(`${dirname(key)}/${specifier.replace(/\.js$/, "")}`);
      const target = [`${base}.ts`, `${base}/index.ts`, base].find((candidate) => candidate.endsWith(".ts") && readSource(candidate) != null);
      if (!target) {
        throw new Error(`router family: ${call[1]} is imported from '${specifier}' (${key}:${i + 1}), which is not a readable .ts file here`);
      }
      if (!files.includes(target)) expand(target, depth + 1);
    });
  };
  expand(normalize(entry), 0);
  return { source: lines.join("\n"), files, origins };
}
