#!/usr/bin/env node
// ----------------------------------------------------------------------------
// check-no-cjk-ui.mjs — the interface is English only.
//
// WHY. The owner, 2026-11-18: "Clean the whole system of Chinese words —
// everything must be English." A Financial Snapshot badge read 入账 beside an
// English cost name. Text like that came in one string at a time, so it can
// only be kept out by something that reads every string.
//
// WHAT IT READS. Every string literal, template-literal piece and JSX text in
// frontend/src, parsed with the TypeScript compiler, so comments are never
// counted (they quote the owner and stay). Test files are skipped: their
// fixtures carry customer data, which can be Chinese.
//
// WHAT IS ALLOWED. Strings that must stay Chinese on purpose (a parser that
// recognises Chinese input, an AI prompt that names Chinese words) are listed in
// scripts/cjk-ui-allowlist.json: file, the exact literal text, and a reason.
// An entry that no longer matches anything fails too, so the list cannot rot.
//
// Usage:
//   node scripts/check-no-cjk-ui.mjs           # fail on any unlisted CJK string
//   node scripts/check-no-cjk-ui.mjs --list    # print every CJK string (inventory)
// Needs `typescript` from frontend/node_modules (run after npm ci).
// ----------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(frontendRoot, 'src');
const ALLOWLIST = path.join(frontendRoot, 'scripts', 'cjk-ui-allowlist.json');

export const CJK = /[㐀-䶿一-鿿　-〿＀-￯]/;

export function isSkippedFile(rel) {
  const p = rel.split(path.sep).join('/');
  return (
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(p) ||
    /(^|\/)(__tests__|__mocks__|test|tests)\//.test(p) ||
    /\.d\.ts$/.test(p)
  );
}

/** Every CJK-bearing literal in one source text: [{ line, text }]. */
export function findCjkLiterals(fileName, source) {
  const kind = fileName.endsWith('x') ? ts.ScriptKind.TSX : fileName.endsWith('.js') || fileName.endsWith('.mjs') ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const out = [];
  const visit = (node) => {
    let text = null;
    switch (node.kind) {
      case ts.SyntaxKind.StringLiteral:
      case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
      case ts.SyntaxKind.TemplateHead:
      case ts.SyntaxKind.TemplateMiddle:
      case ts.SyntaxKind.TemplateTail:
      case ts.SyntaxKind.RegularExpressionLiteral:
        text = node.text;
        break;
      case ts.SyntaxKind.JsxText:
        text = node.text;
        break;
      default:
        break;
    }
    if (text !== null && CJK.test(text)) {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      out.push({ line: line + 1, text: text.trim() });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function walk(dir, acc) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules') continue;
      walk(full, acc);
    } else if (/\.(tsx?|jsx?|mjs)$/.test(ent.name)) {
      acc.push(full);
    }
  }
  return acc;
}

export function loadAllowlist(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const e of raw.entries) {
    if (!e.file || typeof e.text !== 'string' || !e.reason || e.reason.trim().length < 10) {
      throw new Error(`allowlist entry needs file, text and a reason: ${JSON.stringify(e)}`);
    }
  }
  return raw.entries;
}

function main() {
  const listOnly = process.argv.includes('--list');
  const files = walk(SRC, []);
  const findings = [];
  for (const full of files) {
    const rel = path.relative(frontendRoot, full).split(path.sep).join('/');
    if (isSkippedFile(path.relative(SRC, full))) continue;
    const src = fs.readFileSync(full, 'utf8');
    if (!CJK.test(src)) continue;
    for (const f of findCjkLiterals(full, src)) findings.push({ file: rel, ...f });
  }
  if (listOnly) {
    for (const f of findings) console.log(`${f.file}:${f.line}\t${JSON.stringify(f.text)}`);
    console.log(`\n${findings.length} CJK literal(s)`);
    return;
  }
  const allow = fs.existsSync(ALLOWLIST) ? loadAllowlist(ALLOWLIST) : [];
  const used = new Set();
  const bad = [];
  for (const f of findings) {
    const i = allow.findIndex((e) => e.file === f.file && e.text === f.text);
    if (i === -1) bad.push(f);
    else used.add(i);
  }
  const stale = allow.filter((_, i) => !used.has(i));
  for (const f of bad) console.error(`CJK in UI string  ${f.file}:${f.line}  ${JSON.stringify(f.text)}`);
  for (const e of stale) console.error(`stale allowlist entry (matches nothing)  ${e.file}  ${JSON.stringify(e.text)}`);
  console.log(`check-no-cjk-ui: ${findings.length} CJK literal(s), ${findings.length - bad.length} allowlisted, ${bad.length} not allowed, ${stale.length} stale allowlist entr(ies)`);
  if (bad.length || stale.length) {
    console.error('\nThe interface is English only (owner, 2026-11-18). Translate the string, or, if it must stay Chinese (it matches Chinese input, for example), add it to frontend/scripts/cjk-ui-allowlist.json with the reason.');
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
