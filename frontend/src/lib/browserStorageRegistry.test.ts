import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import ts from "typescript";
import {
  BROWSER_STORAGE_KEY_REGISTRY,
  classifyBrowserStorageKey,
  PRODUCTION_STORAGE_CALLERS,
  type BrowserStorageClassification,
  type BrowserStorageKind,
} from "./browserStorageRegistry";

const SRC = resolve(process.cwd(), "src");
type StorageCall = { storage: BrowserStorageKind; method: string; literalKey?: string };
type StorageTarget = { storage: BrowserStorageKind; method: string };

function storageCallsFromSource(source: string, path = "inline.ts"): StorageCall[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const calls: StorageCall[] = [];
  const storageAliases = new Map<string, BrowserStorageKind>();
  const methodAliases = new Map<string, StorageTarget>();
  const constantStrings = new Map<string, string>();

  const propertyName = (node: ts.Expression | ts.BindingName): string | undefined => {
    if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    return undefined;
  };
  const staticString = (node: ts.Expression | undefined): string | undefined => {
    if (!node) return undefined;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isIdentifier(node)) return constantStrings.get(node.text);
    if (ts.isParenthesizedExpression(node)) return staticString(node.expression);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = staticString(node.left);
      const right = staticString(node.right);
      return left !== undefined && right !== undefined ? left + right : undefined;
    }
    return undefined;
  };
  const directStorage = (node: ts.Expression): BrowserStorageKind | undefined => {
    if (ts.isIdentifier(node)) {
      if (node.text === "localStorage" || node.text === "sessionStorage") return node.text;
      return storageAliases.get(node.text);
    }
    if (ts.isPropertyAccessExpression(node)) {
      const owner = node.expression;
      if (
        ts.isIdentifier(owner) && ["window", "globalThis"].includes(owner.text) &&
        (node.name.text === "localStorage" || node.name.text === "sessionStorage")
      ) return node.name.text;
    }
    if (ts.isElementAccessExpression(node)) {
      const owner = node.expression;
      const name = node.argumentExpression && propertyName(node.argumentExpression);
      if (
        ts.isIdentifier(owner) && ["window", "globalThis"].includes(owner.text) &&
        (name === "localStorage" || name === "sessionStorage")
      ) return name;
    }
    return undefined;
  };
  const callTarget = (node: ts.Expression): StorageTarget | undefined => {
    if (ts.isIdentifier(node)) {
      return methodAliases.get(node.text);
    }
    if (ts.isPropertyAccessExpression(node)) {
      const storage = directStorage(node.expression);
      return storage ? { storage, method: node.name.text } : undefined;
    }
    if (ts.isElementAccessExpression(node)) {
      const storage = directStorage(node.expression);
      const method = node.argumentExpression && propertyName(node.argumentExpression);
      return storage && method ? { storage, method } : undefined;
    }
    return undefined;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (ts.isIdentifier(node.name)) {
        const value = staticString(node.initializer);
        if (value !== undefined) constantStrings.set(node.name.text, value);
      }
      const storage = directStorage(node.initializer);
      if (storage && ts.isIdentifier(node.name)) storageAliases.set(node.name.text, storage);
      if (storage && ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          const property = element.propertyName;
          const method = property && ts.isComputedPropertyName(property)
            ? propertyName(property.expression)
            : propertyName(property ?? element.name);
          if (method && ts.isIdentifier(element.name)) methodAliases.set(element.name.text, { storage, method });
        }
      }
    }
    if (ts.isCallExpression(node)) {
      const target = callTarget(node.expression);
      if (target && ["getItem", "setItem", "removeItem", "clear"].includes(target.method)) {
        const arg = node.arguments[0];
        const literalKey = staticString(arg);
        calls.push({ storage: target.storage, method: target.method, literalKey });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return calls;
}

function storageCalls(path: string): StorageCall[] {
  return storageCallsFromSource(readFileSync(path, "utf8"), path);
}

function hasDirectStorageReference(path: string): boolean {
  const source = readFileSync(path, "utf8");
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && (node.text === "localStorage" || node.text === "sessionStorage")) found = true;
    if (!found) ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

function productionSources(dir = SRC): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = resolve(dir, name);
    if (statSync(path).isDirectory()) return productionSources(path);
    if (!/\.(?:ts|tsx)$/.test(name) || /\.test\.|\.d\.ts$/.test(name)) return [];
    return [path];
  });
}

const PRODUCTION_STORAGE_INVENTORY = productionSources()
  .filter((path) => hasDirectStorageReference(path))
  .map((path) => ({ path, calls: storageCalls(path) }));

describe("browser storage registry", () => {
  test("represents every required ownership class", () => {
    const expected: BrowserStorageClassification[] = [
      "AUTH", "IDENTITY_PREF", "DEVICE_PREF", "CACHE", "TRANSIENT", "DRAFT_UI",
    ];
    expect(new Set(BROWSER_STORAGE_KEY_REGISTRY.map((entry) => entry.classification)))
      .toEqual(new Set(expected));
  });

  test.each([
    ["auth:token", "localStorage", "AUTH"],
    ["houzs-rq-snapshot:build:session:7", "localStorage", "CACHE"],
    ["houzs-mail-local:v2:u1:c7", "localStorage", "DRAFT_UI"],
    ["houzs:scm-handoff:v1:grnNewDraft", "sessionStorage", "TRANSIENT"],
    ["houzs:scm-handoff:v1:soPaymentRetry:u1:c7:SO-1", "localStorage", "DRAFT_UI"],
    ["projects:view:u1:c7", "localStorage", "IDENTITY_PREF"],
    ["dg-product-models", "localStorage", "DEVICE_PREF"],
  ] as const)("classifies %s", (key, storage, classification) => {
    expect(classifyBrowserStorageKey(key, storage)?.classification).toBe(classification);
  });

  test("does not classify an unapproved identity-shaped key", () => {
    expect(classifyBrowserStorageKey("unknown-feature:u1:c7", "localStorage")).toBeUndefined();
    expect(classifyBrowserStorageKey("customer-payment-grid", "localStorage")).toBeUndefined();
    expect(classifyBrowserStorageKey("customer-payment.layout.v9", "localStorage")).toBeUndefined();
    expect(classifyBrowserStorageKey("houzs:scm-handoff:v1:unknownHandoff", "sessionStorage")).toBeUndefined();
  });

  test("each representative key has one owner only", () => {
    const keys = [
      "auth:token",
      "houzs-mail-local:v2:u1:c7",
      "projects:view:u1:c7",
      "houzs:scan-draft-acked:u1:c7",
      "dt:columns:orders",
    ];
    for (const key of keys) {
      expect(BROWSER_STORAGE_KEY_REGISTRY.filter((entry) => entry.matches(key))).toHaveLength(1);
    }
  });

  test("inventory sees clear, aliases, destructuring, globalThis and bracket notation", () => {
    const calls = storageCallsFromSource(`
      const store = globalThis["localStorage"];
      const VIEW_KEY = "projects:" + "view:u1:c7";
      store["setItem"](VIEW_KEY, "list");
      const { getItem: read } = window.sessionStorage;
      read("chunk-recovered-at");
      window["localStorage"].clear();
      sessionStorage.removeItem(dynamicKey);
    `);
    expect(calls).toEqual([
      { storage: "localStorage", method: "setItem", literalKey: "projects:view:u1:c7" },
      { storage: "sessionStorage", method: "getItem", literalKey: "chunk-recovered-at" },
      { storage: "localStorage", method: "clear", literalKey: undefined },
      { storage: "sessionStorage", method: "removeItem", literalKey: undefined },
    ]);
  });

  test("requires review when production code adds a direct storage caller", () => {
    const actual = PRODUCTION_STORAGE_INVENTORY
      .map(({ path }) => relative(SRC, path).replaceAll("\\", "/"))
      .sort();
    expect(actual).toEqual([...PRODUCTION_STORAGE_CALLERS].sort());
  });

  test("classifies every direct literal storage key", () => {
    const unknown: string[] = [];
    for (const { path, calls } of PRODUCTION_STORAGE_INVENTORY) {
      for (const { storage, literalKey: key } of calls) {
        if (!key) continue;
        if (!classifyBrowserStorageKey(key, storage)) {
          unknown.push(`${relative(SRC, path).replaceAll("\\", "/")}: ${storage}[${key}]`);
        }
      }
    }
    expect(unknown).toEqual([]);
  });

  test("forbids whole-store clear in production code", () => {
    const clears = PRODUCTION_STORAGE_INVENTORY.flatMap(({ path, calls }) =>
      calls
        .filter((call) => call.method === "clear")
        .map((call) => `${relative(SRC, path).replaceAll("\\", "/")}: ${call.storage}.clear()`),
    );
    expect(clears).toEqual([]);
  });
});
