import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";


const SRC = join(process.cwd(), "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx$/.test(entry) && !/\.test\.tsx$/.test(entry)) out.push(full);
  }
  return out;
}

function tagOf(node: ts.Node): string | null {
  if (ts.isJsxElement(node)) return node.openingElement.tagName.getText();
  if (ts.isJsxSelfClosingElement(node)) return node.tagName.getText();
  return null;
}

function attrsOf(node: ts.JsxElement | ts.JsxSelfClosingElement): ts.JsxAttributes {
  return ts.isJsxElement(node) ? node.openingElement.attributes : node.attributes;
}

function hasResetKey(node: ts.Node): boolean {
  if (!ts.isJsxElement(node) && !ts.isJsxSelfClosingElement(node)) return false;
  return attrsOf(node).properties.some(
    (p) => ts.isJsxAttribute(p) && p.name.getText() === "resetKey",
  );
}

function jsxElements(root: ts.Node): ts.Node[] {
  const found: ts.Node[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) found.push(n);
    ts.forEachChild(n, visit);
  };
  visit(root);
  return found;
}

function rendersChildren(root: ts.Node): boolean {
  let yes = false;
  const visit = (n: ts.Node) => {
    if (ts.isJsxExpression(n) && n.expression && n.expression.getText() === "children") yes = true;
    ts.forEachChild(n, visit);
  };
  visit(root);
  return yes;
}

interface Parsed {
  file: string;
  source: ts.SourceFile;
}

const files = walk(SRC).sort();
const parsed: Parsed[] = files.map((file) => ({
  file,
  source: ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.ESNext,
 true,
    ts.ScriptKind.TSX,
  ),
}));

function componentDecls(source: ts.SourceFile): { name: string; body: ts.Node }[] {
  const out: { name: string; body: ts.Node }[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isFunctionDeclaration(n) && n.name && /^[A-Z]/.test(n.name.text) && n.body) {
      out.push({ name: n.name.text, body: n.body });
    }
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && /^[A-Z]/.test(n.name.text) && n.initializer) {
      out.push({ name: n.name.text, body: n.initializer });
    }
    ts.forEachChild(n, visit);
  };
  visit(source);
  return out;
}

function scopedComponents(): Set<string> {
  const scoped = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const { source } of parsed) {
      for (const { name, body } of componentDecls(source)) {
        if (scoped.has(name)) continue;
        const wraps = jsxElements(body).some((el) => {
          const tag = tagOf(el);
          const isScoped = hasResetKey(el) || (tag !== null && scoped.has(tag));
          return isScoped && rendersChildren(el);
        });
        if (wraps) {
          scoped.add(name);
          changed = true;
        }
      }
    }
  }
  return scoped;
}

const SCOPED = scopedComponents();

function isScopedElement(node: ts.Node): boolean {
  if (hasResetKey(node)) return true;
  const tag = tagOf(node);
  return tag !== null && SCOPED.has(tag);
}

interface Site {
  where: string;
  covered: boolean;
}

function suspenseSites(): Site[] {
  const out: Site[] = [];
  for (const { file, source } of parsed) {
    for (const el of jsxElements(source)) {
      const tag = tagOf(el);
      if (tag !== "Suspense" && tag !== "React.Suspense") continue;
      let covered = false;
      for (let p = el.parent; !ts.isSourceFile(p); p = p.parent) {
        if (isScopedElement(p)) {
          covered = true;
          break;
        }
      }
      const line = source.getLineAndCharacterOfPosition(el.getStart(source)).line + 1;
      out.push({ where: `${relative(process.cwd(), file)}:${line}`, covered });
    }
  }
  return out;
}

describe("every lazy slot in the tree sits inside a scoped crash boundary", () => {
  const sites = suspenseSites();

  it("measured something — the population is not empty", () => {
    expect(files.length).toBeGreaterThan(300);
    expect(sites.length).toBeGreaterThan(0);
    const mounts = parsed.flatMap(({ source }) =>
      jsxElements(source).filter((el) => {
        const tag = tagOf(el);
        return tag === "LazySlot" || tag === "MobileCrashBoundary" || tag === "RouteCrashBoundary";
      }),
    );
    expect(mounts.length).toBeGreaterThan(15);
  });

  it("resolved the boundary components rather than hardcoding their names", () => {
    expect([...SCOPED].sort()).toEqual(
      expect.arrayContaining(["LazySlot", "MobileCrashBoundary", "RouteCrashBoundary"]),
    );
    const fallback = readFileSync(join(SRC, "components/RouteFallback.tsx"), "utf8");
    expect(fallback).toContain("<ChunkReloadBoundary resetKey={location.pathname}>");
  });

  it("has no <Suspense> whose nearest boundary is the unkeyed top-level one", () => {
    const bare = sites.filter((s) => !s.covered).map((s) => s.where);
    expect(bare).toEqual([]);
  });
});
