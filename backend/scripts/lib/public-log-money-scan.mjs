// Pure scanner behind check-public-log-money.mjs. No filesystem, no network.
//
// Two findings, because the runtime guard (public-log-guard.mjs) can only
// redact money it can RECOGNISE in the text:
//
//   needs-guard  the file formats money (RM/MYR next to a value, sen/100 to two
//                decimals, an MYR currency formatter, a money identifier printed).
//                Satisfied by the script importing ./lib/public-log-guard.mjs.
//   unlabelled   a raw money identifier is interpolated into an output line with
//                nothing the guard can key on: no money-named `key=` / `key:`
//                before it, no `RM` before it, no ` sen` after it. The guard
//                cannot tell "9000" from a quantity, so the line itself must
//                change. Not satisfied by the import.

import { blankComments } from "./jsonb-bind-scan.mjs";
import { isMoneyKey } from "./public-log-redact.mjs";

export const GUARD_IMPORT = /^\s*import\s+["'](?:\.\/|\.\.\/scripts\/|\.\/scripts\/)?lib\/public-log-guard\.mjs["']\s*;?\s*$/m;

const FORMAT_PATTERNS = [
  ["RM next to an interpolated value", /\b(?:RM|MYR)\s?\$\{/],
  ["RM concatenated to a value", /["'`](?:RM|MYR)\s?["'`]\s*\+/],
  ["sen divided by 100 to two decimals", /\/\s*100(?:\.0+)?\s*\)*\s*\.toFixed\(\s*2\s*\)/],
  ["MYR currency formatter", /currency\s*:\s*["']MYR["']/],
];

const MONEY_IDENT = /\b[A-Za-z_$][\w$]*(?:_sen|Sen|SEN)\b|\b(?:unit_cost|total_cost|unitCost|totalCost|amount|price)\b/;

function outputNames(src) {
  const names = new Set();
  const def = /(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)\s*(?:=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>|\()/g;
  let m;
  while ((m = def.exec(src))) {
    const body = src.slice(m.index, m.index + 240);
    if (/console\.(?:log|error|warn|info)|process\.std(?:out|err)\.write/.test(body)) names.add(m[1]);
  }
  return names;
}

function outputLine(line, names) {
  if (/console\.(?:log|error|warn|info|table|dir)\s*\(|process\.std(?:out|err)\.write\s*\(/.test(line)) return true;
  for (const n of names) if (new RegExp(String.raw`(?:^|[^\w$.])${n.replace(/\$/g, "\\$")}\s*\(`).test(line)) return true;
  return false;
}

// Interpolations `${...}` in a line with the literal text around each one.
function interpolations(line) {
  const out = [];
  let i = 0;
  while ((i = line.indexOf("${", i)) !== -1) {
    const j = skipHole(line, i + 2);
    out.push({ expr: line.slice(i + 2, j - 1), before: line.slice(0, i), after: line.slice(j) });
    i = j;
  }
  return out;
}

function labelled({ expr, before, after }) {
  if (/^\s?(?:sen|RM|MYR)\b/.test(after)) return true;
  if (/(?:RM|MYR)\s?$/.test(before)) return true;
  const key = before.match(/([A-Za-z_][A-Za-z0-9_]*)(?:"?\s*[=:]\s*"?|[ \t]+)$/);
  if (key && isMoneyKey(key[1])) return true;
  // A call wrapping the identifier is a formatter; FORMAT_PATTERNS makes the
  // file require the guard, which redacts RM and two-decimal output.
  if (/^\s*[A-Za-z_$][\w$.]*\s*\([\s\S]*\)\s*$/.test(expr) && !/^\s*(?:String|Number|Math\.\w+)\s*\(/.test(expr)) return true;
  return false;
}

function stripStrings(expr) {
  return expr.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, '""');
}

// Index just past the template literal that opens at s[i] (a backtick),
// stepping over ${...} holes, which may hold strings and templates of their own.
function skipTemplate(s, i) {
  let j = i + 1;
  while (j < s.length) {
    const c = s[j];
    if (c === "\\") { j += 2; continue; }
    if (c === "`") return j + 1;
    if (c === "$" && s[j + 1] === "{") { j = skipHole(s, j + 2); continue; }
    j++;
  }
  return s.length;
}
function skipHole(s, j) {
  let depth = 1;
  while (j < s.length && depth > 0) {
    const c = s[j];
    if (c === "`") { j = skipTemplate(s, j); continue; }
    if (c === "'" || c === '"') {
      let k = j + 1;
      while (k < s.length && s[k] !== c) k += s[k] === "\\" ? 2 : 1;
      j = k + 1;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") depth--;
    j++;
  }
  return j;
}

// Nested template literals inside an interpolation, e.g. the `...` in
// ${a ? `x ${b}` : ""}: their bodies, and the expression with each replaced by "".
function nestedTemplates(expr) {
  const bodies = [];
  let rest = "";
  let from = 0;
  let i = 0;
  while ((i = expr.indexOf("`", i)) !== -1) {
    const end = skipTemplate(expr, i);
    bodies.push(expr.slice(i + 1, end - 1));
    rest += expr.slice(from, i) + '""';
    i = end;
    from = end;
  }
  return { bodies, rest: rest + expr.slice(from) };
}

function topLevelSplit(expr) {
  let depth = 0;
  let q = -1;
  for (let k = 0; k < expr.length; k++) {
    const c = expr[k];
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (depth === 0 && c === "?" && expr[k + 1] !== "?" && expr[k - 1] !== "?" && expr[k + 1] !== ".") { q = k; break; }
  }
  if (q === -1) return null;
  depth = 0;
  for (let k = q + 1; k < expr.length; k++) {
    const c = expr[k];
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (depth === 0 && c === ":") return [expr.slice(q + 1, k), expr.slice(k + 1)];
  }
  return null;
}

function judge(ip, depth = 0) {
  if (depth > 4) return [];
  const out = [];
  const nested = nestedTemplates(ip.expr);
  for (const body of nested.bodies) {
    for (const inner of interpolations(body)) out.push(...judge(inner, depth + 1));
  }
  const e = stripStrings(nested.rest);
  const branches = topLevelSplit(e);
  const parts = branches ?? [e];
  for (const part of parts) {
    if (/^\s*""\s*$/.test(part)) continue;
    if (/\.(?:length|size)\s*$/.test(part.trim())) continue;
    if (!MONEY_IDENT.test(part)) continue;
    const view = { expr: part, before: ip.before, after: ip.after };
    out.push(labelled(view) ? "needs-guard" : `unlabelled:${part.trim()}`);
  }
  return out;
}

export function scanSource(src) {
  const code = blankComments(src);
  const names = outputNames(code);
  const findings = [];
  const lines = code.split("\n");
  lines.forEach((line, idx) => {
    for (const [label, re] of FORMAT_PATTERNS) {
      if (re.test(line)) findings.push({ kind: "needs-guard", line: idx + 1, why: label });
    }
    if (!outputLine(line, names)) return;
    for (const ip of interpolations(line)) {
      for (const verdict of judge(ip)) {
        if (verdict === "needs-guard") findings.push({ kind: "needs-guard", line: idx + 1, why: "money identifier printed" });
        else findings.push({ kind: "unlabelled", line: idx + 1, why: `raw money value \${${verdict.slice(11)}} with no RM / sen / money-named key the guard can redact` });
      }
    }
  });
  return findings;
}

export function importsGuard(src) {
  return GUARD_IMPORT.test(src);
}

// Relative imports of a module, resolved by the caller.
export function localImports(src) {
  const out = [];
  const re = /(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s*["'](\.[^"']+)["']|(?:^|\n)\s*import\s*["'](\.[^"']+)["']/g;
  let m;
  while ((m = re.exec(src))) out.push(m[1] ?? m[2]);
  return out;
}
