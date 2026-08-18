import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";

// ---------------------------------------------------------------------------
// THE CLASS GATE for deploy churn: no <Suspense> anywhere in this tree may sit
// without a SCOPED crash boundary above it, in its own file.
//
// Why this file exists instead of another per-file assertion
// ----------------------------------------------------------
// The previous pass fixed the three lazy slots inside MobileApp.tsx and gated
// them with `readFileSync("src/mobile/MobileApp.tsx")` + not.toContain("<Suspense").
// That gate reported GREEN while AuthGate.tsx mounted the ENTIRE mobile product
// — `<Suspense fallback={null}><MobileApp /></Suspense>` — with no boundary at
// all. A gate that reads one hardcoded path proves something about that path
// and nothing about the class. This one parses every .tsx under src/ and is
// blind to no file, so a bare <Suspense> added tomorrow in a file nobody has
// thought of fails the suite instead of shipping.
//
// WHAT "SCOPED" MEANS, and what this does NOT prove
// ------------------------------------------------
// Scoped = the nearest boundary above the slot is keyed, so a caught error
// clears when the operator moves. A `resetKey` attribute on the element proves
// it directly; a component qualifies transitively when its own body wraps
// {children} in something already known to be scoped (that is how
// RouteCrashBoundary gets in — it renders <ChunkReloadBoundary
// resetKey={location.pathname}>). main.tsx's top-level <ChunkReloadBoundary>
// takes no resetKey and therefore counts for nothing here, which is the whole
// point: it is the boundary that eats the entire app.
//
// It does NOT prove the key actually changes at runtime — a slot could pass by
// keying on a constant. Two of them deliberately do (AuthGate's mobile shell,
// main.tsx's public surfaces) because there is no navigation above those to
// clear a crash with; both say so at the call site. What this gate does prove
// is that the failure is contained where it happens rather than replacing the
// whole tree, and that no NEW slot is added with no boundary at all.
// ---------------------------------------------------------------------------

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

/** Every JSX element in a subtree, plus whether that subtree renders {children}. */
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
    /* setParentNodes */ true,
    ts.ScriptKind.TSX,
  ),
}));

/** Component declarations (uppercase-named functions) with their bodies. */
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

/** Fixpoint: a component is a scoped boundary when it wraps {children} in an
 *  element that is itself scoped (a resetKey attribute, or another such
 *  component). Seeded by nothing — every member has to earn it. */
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
      // Stop AT the SourceFile: its own `parent` is undefined at runtime even
      // though the type says otherwise, so this is the termination condition,
      // not a truthiness guard the linter would rightly call redundant.
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
    // A verdict computed over zero files reads exactly like a pass. All three
    // of these must be real numbers or the assertion below means nothing.
    expect(files.length).toBeGreaterThan(300);
    expect(sites.length).toBeGreaterThan(0);
    // The slots themselves, so "no bare <Suspense>" cannot be true merely
    // because the walk found no JSX: every lazy mount in the tree is one of
    // these three wrappers, and there are dozens.
    const mounts = parsed.flatMap(({ source }) =>
      jsxElements(source).filter((el) => {
        const tag = tagOf(el);
        return tag === "LazySlot" || tag === "MobileCrashBoundary" || tag === "RouteCrashBoundary";
      }),
    );
    expect(mounts.length).toBeGreaterThan(15);
  });

  it("resolved the boundary components rather than hardcoding their names", () => {
    // Earned through the fixpoint above, not listed: RouteCrashBoundary gets in
    // because it renders <ChunkReloadBoundary resetKey={location.pathname}>.
    expect([...SCOPED].sort()).toEqual(
      expect.arrayContaining(["LazySlot", "MobileCrashBoundary", "RouteCrashBoundary"]),
    );
    const fallback = readFileSync(join(SRC, "components/RouteFallback.tsx"), "utf8");
    expect(fallback).toContain("<ChunkReloadBoundary resetKey={location.pathname}>");
  });

  it("has no <Suspense> whose nearest boundary is the unkeyed top-level one", () => {
    const bare = sites.filter((s) => !s.covered).map((s) => s.where);
    // AuthGate.tsx:120 was on this list until 2026-08-18 — the mobile shell,
    // i.e. the half of the product that is actually carried around a factory.
    expect(bare).toEqual([]);
  });
});
