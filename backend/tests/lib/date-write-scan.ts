/* Finds every place a REQUEST-SUPPLIED value is written into a DATE column
 * without passing through the blank-date coercion.
 *
 * This is the gate for the whole class, and it is deliberately NOT a vocabulary
 * test: asserting that a regex knows the word "date" passes green on a
 * completely unfixed tree, which is how the first version of this branch shipped
 * five missed sites. This one answers the only question that matters — does the
 * code that writes a date column actually coerce what the browser sent? — and it
 * is red on unpatched main.
 *
 * How a site is judged. All of it is syntax (ts.createSourceFile, no
 * type-checker), so the whole backend scans in about a second.
 *
 *  1. REQUEST-DERIVED NAMES. Seeded per file from anything bound to
 *     `await c.req.json()`, `c.req.query()/param()/valid()`, a zod
 *     `.parse()/.safeParse()`, or a binding/parameter named `body`/`payload`/
 *     `patch`/`input`. Grown to a fixed point along VALUE edges only — `const p
 *     = body.rows[0]`, `for (const it of body.items)`, `const x = a ?? body.b`.
 *     It deliberately does NOT flow through an opaque call, so
 *     `const { data } = await sb.from(t).eq('id', body.id)` leaves `data` a
 *     database row, not request input.
 *
 *  2. SITES THAT REACH THE DATABASE. Only object literals and variables that
 *     are arguments to `.insert()/.update()/.upsert()/.rpc()` count — directly,
 *     inside an array, inside a `.map()` callback, through a coercer wrapper, or
 *     as the initializer of a variable used that way. Response-shaping objects
 *     (reports.ts, search.ts) are not writes and are not scanned.
 *
 *  3. NAMED DATE WRITES. `voucher_date: X` inside such a literal, or
 *     `updates.voucher_date = X` / `updates['voucher_date'] = X` on such a
 *     variable, where `isDateColumn()` recognises the column. It is a FINDING
 *     when X is request-derived and not `""`-safe. `""`-safe means: a coercer
 *     (`dateOrNull`, `coerceEmptyDates`, a local `emptyDate`/`toDateOrNull`/
 *     `trimOrNull`), or a truthy guard `""` cannot survive (`x || null`,
 *     `x ? … : null`, `x && …`, `Boolean(x)`, `new Date(x).toISOString()`).
 *     `x ?? null` and `x ?? todayMyt()` are NULLISH and are exactly the bug.
 *
 *  4. FIELD-MAP LOOPS. `for (const [from, to] of MAP) updates[to] = body[from]`
 *     writes a column whose name is nowhere in the source, so there is nothing
 *     to name-match. For those the PAYLOAD is tracked instead: a variable a
 *     loop fills from request data must pass through `coerceEmptyDates(...)`
 *     before it is sent — wrapped at the call or mutated in place earlier in the
 *     same function. Unwrapped is a finding; that is the shape the production
 *     500 arrived in.
 *
 * There is no allowlist. A finding is fixed by coercing the write.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

import { isDateColumn } from '../../src/scm/lib/date-coerce';

export type Finding = {
  file: string;
  line: number;
  column: string;
  text: string;
  kind: 'write' | 'payload';
};

/** Calls whose result can never be `""`. */
const COERCERS = new Set([
  'dateOrNull', 'coerceEmptyDates', 'emptyDate', 'toDateOrNull',
  'blankDateToNull', 'trimOrNull', 'nullIfBlank', 'dateOnlyOrNull',
]);
/** Calls that turn a blank into something Postgres accepts (or into not-a-string). */
const SAFE_CALLS = new Set([
  'Boolean', 'Number', 'toISOString', 'todayMyt', 'nowMyt', 'nowIso',
]);
/** Method names a value can flow THROUGH without leaving the caller's data. */
const PASSTHROUGH_METHODS = new Set([
  'map', 'filter', 'slice', 'find', 'at', 'flat', 'flatMap', 'concat', 'sort',
  'reverse', 'trim', 'toUpperCase', 'toLowerCase', 'split', 'join',
]);

const REQUEST_SEED_NAMES = new Set(['body', 'payload', 'rawBody', 'reqBody', 'patch', 'input']);
const WRITE_METHODS = new Set(['insert', 'update', 'upsert', 'rpc']);
const COLUMN_RE = /^[a-z][a-z0-9_]*$/;

/* ── small AST helpers ─────────────────────────────────────────────────────── */

function unwrap(node: ts.Node): ts.Node {
  let n: ts.Node = node;
  for (;;) {
    if (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isSatisfiesExpression(n) || ts.isNonNullExpression(n)) {
      n = n.expression; continue;
    }
    if (ts.isTypeAssertionExpression(n)) { n = n.expression; continue; }
    return n;
  }
}

function callName(call: ts.CallExpression): string {
  const callee = unwrap(call.expression);
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return '';
}

function enclosingFunction(node: ts.Node): ts.Node | undefined {
  let n: ts.Node | undefined = node.parent;
  while (n) {
    if (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n)) return n;
    n = n.parent;
  }
  return undefined;
}

function isAncestor(maybe: ts.Node, node: ts.Node): boolean {
  let n: ts.Node | undefined = node;
  while (n) { if (n === maybe) return true; n = n.parent; }
  return false;
}

/**
 * The identifiers a value can actually come FROM — following ??/||/?:/member
 * access and the passthrough methods, and stopping dead at any other call.
 */
function valueRoots(node: ts.Node, out: Set<string> = new Set()): Set<string> {
  const n = unwrap(node);
  if (ts.isIdentifier(n)) { out.add(n.text); return out; }
  if (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) return valueRoots(n.expression, out);
  if (ts.isAwaitExpression(n)) return valueRoots(n.expression, out);
  if (ts.isBinaryExpression(n)) {
    const k = n.operatorToken.kind;
    if (k === ts.SyntaxKind.QuestionQuestionToken || k === ts.SyntaxKind.BarBarToken || k === ts.SyntaxKind.AmpersandAmpersandToken) {
      valueRoots(n.left, out); valueRoots(n.right, out);
    }
    return out;
  }
  if (ts.isConditionalExpression(n)) { valueRoots(n.whenTrue, out); valueRoots(n.whenFalse, out); return out; }
  if (ts.isCallExpression(n)) {
    const callee = unwrap(n.expression);
    if (ts.isPropertyAccessExpression(callee) && PASSTHROUGH_METHODS.has(callee.name.text)) {
      return valueRoots(callee.expression, out);
    }
    if (ts.isIdentifier(callee) && (callee.text === 'String' || callee.text === 'Object')) {
      for (const a of n.arguments) valueRoots(a, out);
    }
    return out;
  }
  return out;
}

/* ── 1. which names carry request data ─────────────────────────────────────── */

function requestDerivedNames(src: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const edges: Array<{ name: string; from: ts.Node }> = [];

  const isRequestSource = (e: ts.Node): boolean => {
    const t = e.getText(src);
    return /\bc\.req\.(json|query|param|parseBody|valid)\b/.test(t)
      /* a zod result is still the caller's data — the schema decides only
         WHETHER a blank got through, which isBlankSafe reads separately */
      || /(?<!JSON)\.(safeParse|parse)\(/.test(t)
      || /\bparseJsonBody\(/.test(t);
  };

  const bind = (name: string, init: ts.Node) => {
    if (isRequestSource(init)) names.add(name);
    edges.push({ name, from: init });
  };

  const visit = (node: ts.Node): void => {
    /* `let body: Record<string, unknown>;` then `body = await c.req.json()` in a
       try/catch is the house shape for a 400-on-bad-JSON handler — there is no
       initializer to read, so the seed names count on sight. */
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && REQUEST_SEED_NAMES.has(node.name.text)) {
      names.add(node.name.text);
    }
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (ts.isIdentifier(node.name)) {
        bind(node.name.text, node.initializer);
      } else {
        for (const el of node.name.elements) {
          if (ts.isBindingElement(el) && ts.isIdentifier(el.name)) bind(el.name.text, node.initializer);
        }
      }
    }
    if (ts.isParameter(node) && ts.isIdentifier(node.name) && REQUEST_SEED_NAMES.has(node.name.text)) {
      names.add(node.name.text);
    }
    if (ts.isForOfStatement(node) && ts.isVariableDeclarationList(node.initializer)) {
      for (const d of node.initializer.declarations) {
        if (ts.isIdentifier(d.name)) bind(d.name.text, node.expression);
        else for (const el of d.name.elements) {
          if (ts.isBindingElement(el) && ts.isIdentifier(el.name)) bind(el.name.text, node.expression);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(src);

  for (let pass = 0; pass < 10; pass++) {
    let grew = false;
    for (const e of edges) {
      if (names.has(e.name)) continue;
      for (const r of valueRoots(e.from)) {
        if (names.has(r)) { names.add(e.name); grew = true; break; }
      }
    }
    if (!grew) break;
  }
  return names;
}

function isRequestDerived(expr: ts.Node, names: Set<string>): boolean {
  let hit = false;
  const walk = (n: ts.Node): void => {
    if (hit) return;
    if (ts.isIdentifier(n) && names.has(n.text)) {
      const p = n.parent;
      // a PROPERTY called `body` is not the body
      if (p && ts.isPropertyAccessExpression(p) && p.name === n) return;
      if (p && (ts.isPropertyAssignment(p) || ts.isBindingElement(p)) && p.name === n) return;
      hit = true; return;
    }
    ts.forEachChild(n, walk);
  };
  walk(expr);
  return hit;
}

/* ── 2. is the value `""`-safe? ────────────────────────────────────────────── */

/**
 * The expressions a condition proves TRUTHY. `if (body.poDate) x = body.poDate`
 * and `typeof body.at === 'string' && body.at ? body.at : now` are both perfectly
 * safe — `""` is falsy, so the write never happens with a blank — and neither
 * guard is visible from the assigned expression alone.
 */
function truthyAsserted(cond: ts.Node, out: Set<string> = new Set()): Set<string> {
  const c = unwrap(cond);
  if (ts.isBinaryExpression(c)) {
    if (c.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      truthyAsserted(c.left, out); truthyAsserted(c.right, out);
    }
    return out; // a comparison proves nothing about blankness
  }
  if (ts.isPrefixUnaryExpression(c) || ts.isCallExpression(c)) return out;
  out.add(c.getText().replace(/\s+/g, ''));
  return out;
}

function guardedByEnclosingIf(site: ts.Node, value: ts.Node): boolean {
  const wanted = unwrap(value).getText().replace(/\s+/g, '');
  let child: ts.Node = site;
  let n: ts.Node | undefined = site.parent;
  while (n) {
    if (ts.isIfStatement(n) && isAncestor(n.thenStatement, child)) {
      if (truthyAsserted(n.expression).has(wanted)) return true;
    }
    if (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n)) break;
    child = n; n = n.parent;
  }
  return false;
}

/**
 * `if (!X) return 400` / `if (!ISO_DATE.test(X)) return 400` — the handler has
 * already refused a blank before it reaches the write. Collected once per
 * function; only guards that sit BEFORE the site count.
 */
function earlyReturnGuards(fn: ts.Node, src: ts.SourceFile): Array<{ text: string; pos: number }> {
  const out: Array<{ text: string; pos: number }> = [];
  const fromCondition = (cond: ts.Node, pos: number): void => {
    const c = unwrap(cond);
    if (ts.isBinaryExpression(c) && c.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
      fromCondition(c.left, pos); fromCondition(c.right, pos); return;
    }
    if (!ts.isPrefixUnaryExpression(c) || c.operator !== ts.SyntaxKind.ExclamationToken) return;
    const inner = unwrap(c.operand);
    /* `!RE.test(x)` — a format regex for a date is anchored and demands digits,
       so passing it excludes "". */
    if (ts.isCallExpression(inner) && callName(inner) === 'test' && inner.arguments.length === 1) {
      out.push({ text: unwrap(inner.arguments[0]!).getText().replace(/\s+/g, ''), pos });
      return;
    }
    out.push({ text: inner.getText().replace(/\s+/g, ''), pos });
  };
  const walk = (n: ts.Node): void => {
    if (ts.isIfStatement(n) && !n.elseStatement) {
      const then = n.thenStatement;
      const returns = ts.isReturnStatement(then)
        || (ts.isBlock(then) && then.statements.some((s) => ts.isReturnStatement(s)));
      if (returns) fromCondition(n.expression, n.getEnd());
    }
    ts.forEachChild(n, walk);
  };
  walk(fn);
  return out;
}

type SafeCtx = {
  resolve: (id: ts.Identifier) => ts.Expression | undefined;
  /** locally declared helpers that explicitly handle the empty string */
  localCoercers: Set<string>;
  /** zod keys the file validates in a way `""` cannot pass */
  zodGuardedKeys: Set<string>;
};

function isBlankSafe(expr: ts.Node, ctx: SafeCtx, depth = 0): boolean {
  if (depth > 6) return false;
  const e = unwrap(expr);

  if (e.kind === ts.SyntaxKind.NullKeyword || e.kind === ts.SyntaxKind.TrueKeyword || e.kind === ts.SyntaxKind.FalseKeyword) return true;
  if (ts.isStringLiteral(e) || ts.isNumericLiteral(e) || ts.isTemplateExpression(e) || ts.isNoSubstitutionTemplateLiteral(e)) return true;
  if (ts.isNewExpression(e)) return true;

  if (ts.isCallExpression(e)) {
    const name = callName(e);
    if (COERCERS.has(name) || SAFE_CALLS.has(name) || ctx.localCoercers.has(name)) return true;
  }

  if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken) return true;

  if (ts.isBinaryExpression(e)) {
    const k = e.operatorToken.kind;
    // "" is falsy: `x || null` and `x && y` cannot pass "" through.
    if (k === ts.SyntaxKind.BarBarToken || k === ts.SyntaxKind.AmpersandAmpersandToken) return true;
    // `a ?? b` is NULLISH — safe only when the left side is itself safe.
    if (k === ts.SyntaxKind.QuestionQuestionToken) return isBlankSafe(e.left, ctx, depth + 1);
    return true; // comparisons etc. are not strings
  }

  // `x ? a : b` — "" takes the else branch, so both branches must be safe,
  // unless the condition itself already proves the taken branch is non-blank.
  if (ts.isConditionalExpression(e)) {
    const asserted = truthyAsserted(e.condition);
    const notBlank = blankExcluded(e.condition);
    const key = (n: ts.Node) => unwrap(n).getText().replace(/\s+/g, '');
    const trueOk = isBlankSafe(e.whenTrue, ctx, depth + 1) || asserted.has(key(e.whenTrue));
    const falseOk = isBlankSafe(e.whenFalse, ctx, depth + 1) || notBlank.has(key(e.whenFalse));
    return trueOk && falseOk;
  }

  if (ts.isPropertyAccessExpression(e)) {
    /* `d.value` where `d = dateField(body.serviceDate)` — the helper is the
       coercion, and this is how the fleet/lorry routes already do it. */
    const obj = unwrap(e.expression);
    if (ts.isIdentifier(obj)) {
      const init = obj && ctx.resolve(obj);
      if (init) {
        const c = unwrap(init);
        if (ts.isCallExpression(c) && (ctx.localCoercers.has(callName(c)) || COERCERS.has(callName(c)))) return true;
      }
    }
    /* a zod key the schema refuses to accept blank (`z.string().min(1)`,
       `.regex(ISO_DATE)`) — the 400 happens before this line runs */
    if (ctx.zodGuardedKeys.has(e.name.text)) return true;
  }

  // follow a local: `const paidAt = (body.paymentDate as string) ?? todayMyt()`
  if (ts.isIdentifier(e)) {
    const init = ctx.resolve(e);
    if (init) return isBlankSafe(init, ctx, depth + 1);
  }
  return false;
}

/** Expressions a condition proves are NOT `""` when it is FALSE (`x === ''`). */
function blankExcluded(cond: ts.Node, out: Set<string> = new Set()): Set<string> {
  const c = unwrap(cond);
  if (!ts.isBinaryExpression(c)) return out;
  const k = c.operatorToken.kind;
  if (k !== ts.SyntaxKind.EqualsEqualsEqualsToken && k !== ts.SyntaxKind.EqualsEqualsToken) return out;
  const lit = (n: ts.Node) => ts.isStringLiteral(unwrap(n)) && (unwrap(n) as ts.StringLiteral).text === '';
  if (lit(c.right)) out.add(unwrap(c.left).getText().replace(/\s+/g, ''));
  if (lit(c.left)) out.add(unwrap(c.right).getText().replace(/\s+/g, ''));
  return out;
}

/* ── zod schemas and local blank-handling helpers ──────────────────────────── */

const ZOD_BLANK_PROOF = /\.(min\(\s*[1-9]|nonempty\(|regex\(|datetime\(|uuid\(|email\(|length\(\s*[1-9]|enum\(|date\(\))/;

/** Keys every zod object in this file declares in a way `""` cannot satisfy. */
function zodGuardedKeys(src: ts.SourceFile): Set<string> {
  const guarded = new Set<string>();
  const loose = new Set<string>();
  const visit = (n: ts.Node): void => {
    if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name)) {
      const t = n.initializer.getText(src);
      if (/^z\./.test(t)) (ZOD_BLANK_PROOF.test(t) ? guarded : loose).add(n.name.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(src);
  for (const k of loose) guarded.delete(k); // one loose declaration spoils the key
  return guarded;
}

/**
 * Helpers this file declares that explicitly answer the empty string — the
 * `dateField(v)` / `trimOrNull(v)` shape. They ARE the coercion; the gate would
 * otherwise ask a file to coerce twice.
 */
function localCoercerNames(src: ts.SourceFile): Set<string> {
  const out = new Set<string>();
  const handlesBlank = (body: ts.Node) => /===\s*''|===\s*""|!==\s*''|\.trim\(\)\s*===|!\s*[A-Za-z_$][\w$]*\.trim\(\)/.test(body.getText(src));
  const visit = (n: ts.Node): void => {
    if (ts.isFunctionDeclaration(n) && n.name && n.body && handlesBlank(n.body)) out.add(n.name.text);
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      const init = unwrap(n.initializer);
      if ((ts.isArrowFunction(init) || ts.isFunctionExpression(init)) && handlesBlank(init.body)) out.add(n.name.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(src);
  return out;
}

/* ── 3. the scan ───────────────────────────────────────────────────────────── */

/* Parsing 480 files with setParentNodes costs ~1.8s single-threaded, and this
   suite runs alongside 340 others competing for the same cores — long enough to
   flake against a 5s timeout, which is precisely the bug this branch is about.
   A file that names no write method AND no date-shaped column cannot produce a
   finding, and that is decidable from the raw text before any parsing. */
const WRITE_CALL_RE = /\.(insert|update|upsert|rpc)\s*\(/;
const DATE_TOKEN_RE = /_at\b|_date|_expiry|_birthday|Date\b/;

export function scanFile(file: string, rel: string): Finding[] {
  const text = readFileSync(file, 'utf8');
  if (!WRITE_CALL_RE.test(text) || !DATE_TOKEN_RE.test(text)) return [];
  const src = ts.createSourceFile(rel, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const reqNames = requestDerivedNames(src);
  const findings: Finding[] = [];
  const at = (n: ts.Node) => src.getLineAndCharacterOfPosition(n.getStart(src)).line + 1;
  const textOf = (n: ts.Node) => n.getText(src).replace(/\s+/g, ' ').slice(0, 150);

  /* declarations, so an identifier can be followed back to its initializer and
     two different `updates` in one file are not confused for each other */
  const decls: Array<{ name: string; node: ts.VariableDeclaration; scope: ts.Node | undefined; pos: number }> = [];
  const collectDecls = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      decls.push({ name: node.name.text, node, scope: enclosingFunction(node), pos: node.getStart(src) });
    }
    ts.forEachChild(node, collectDecls);
  };
  collectDecls(src);

  const resolveDecl = (id: ts.Identifier): ts.VariableDeclaration | undefined => {
    const use = id.getStart(src);
    let best: { d: ts.VariableDeclaration; pos: number } | undefined;
    for (const d of decls) {
      if (d.name !== id.text) continue;
      if (d.scope && !isAncestor(d.scope, id)) continue;
      if (d.pos > use) continue;
      if (!best || d.pos > best.pos) best = { d: d.node, pos: d.pos };
    }
    return best?.d;
  };
  const ctx: SafeCtx = {
    resolve: (id) => resolveDecl(id)?.initializer,
    localCoercers: localCoercerNames(src),
    zodGuardedKeys: zodGuardedKeys(src),
  };

  /** cached per enclosing function — `if (!ISO.test(date)) return 400` */
  const guardCache = new Map<ts.Node, Array<{ text: string; pos: number }>>();
  const guardedByEarlyReturn = (site: ts.Node, value: ts.Node): boolean => {
    const fn = enclosingFunction(site);
    if (!fn) return false;
    let g = guardCache.get(fn);
    if (!g) { g = earlyReturnGuards(fn, src); guardCache.set(fn, g); }
    const wanted = unwrap(value).getText().replace(/\s+/g, '');
    const here = site.getStart(src);
    return g.some((x) => x.text === wanted && x.pos < here);
  };

  /* (2) everything that reaches an insert/update/upsert/rpc */
  const payloadLiterals = new Set<ts.ObjectLiteralExpression>();
  /** decl node → the identifier uses that send it */
  const sentVars: Array<{ decl: ts.VariableDeclaration; id: ts.Identifier; wrapped: boolean }> = [];

  const takePayload = (argIn: ts.Node, wrapped: boolean): void => {
    const arg = unwrap(argIn);
    if (ts.isObjectLiteralExpression(arg)) {
      if (payloadLiterals.has(arg)) return;
      payloadLiterals.add(arg);
      /* `.insert({ grn_number, ...grnPayload })` — the spread source is the row
         just as much as the literal is, and that is where the columns live. */
      for (const p of arg.properties) if (ts.isSpreadAssignment(p)) takePayload(p.expression, wrapped);
      return;
    }
    if (ts.isArrayLiteralExpression(arg)) { for (const el of arg.elements) takePayload(el, wrapped); return; }
    if (ts.isIdentifier(arg)) {
      const d = resolveDecl(arg);
      if (d) {
        sentVars.push({ decl: d, id: arg, wrapped });
        if (d.initializer && ts.isObjectLiteralExpression(unwrap(d.initializer))) {
          payloadLiterals.add(unwrap(d.initializer) as ts.ObjectLiteralExpression);
        }
      }
      return;
    }
    if (ts.isCallExpression(arg)) {
      const name = callName(arg);
      if (COERCERS.has(name)) { for (const a of arg.arguments) takePayload(a, true); return; }
      const callee = unwrap(arg.expression);
      if (ts.isPropertyAccessExpression(callee) && (callee.name.text === 'map' || callee.name.text === 'flatMap')) {
        for (const a of arg.arguments) {
          const cb = unwrap(a);
          if (ts.isArrowFunction(cb) && !ts.isBlock(cb.body)) takePayload(cb.body, wrapped);
        }
      }
    }
  };

  const collectSends = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      if (ts.isPropertyAccessExpression(callee) && WRITE_METHODS.has(callee.name.text)) {
        const args = callee.name.text === 'rpc' ? node.arguments.slice(1) : node.arguments;
        for (const a of args) takePayload(a, false);
      }
    }
    ts.forEachChild(node, collectSends);
  };
  collectSends(src);

  const sentDecls = new Set(sentVars.map((s) => s.decl));

  /* (4) payload variables a loop fills from request data, and where they are coerced */
  const dynamicallyFilled = new Set<ts.VariableDeclaration>();
  /** decl node → source positions of `coerceEmptyDates(thatVar)` */
  const coercedAt = new Map<ts.VariableDeclaration, number[]>();

  /* (3) named date-column writes */
  const checkWrite = (site: ts.Node, column: string, value: ts.Node, inPayload: boolean) => {
    if (!inPayload) return;
    if (!COLUMN_RE.test(column) || !isDateColumn(column)) return;
    if (!isRequestDerived(value, reqNames)) return;
    if (isBlankSafe(value, ctx)) return;
    if (guardedByEnclosingIf(site, value)) return;
    if (guardedByEarlyReturn(site, value)) return;
    findings.push({ file: rel, line: at(site), column, text: textOf(site), kind: 'write' });
  };

  /**
   * `for (const [from, to] of MAP) updates[to] = body[from]` — does that MAP
   * carry a date column at all? A loop that only moves `item_code` and `notes`
   * has nothing to coerce, and demanding a call there would be noise.
   * Unresolvable map ⇒ assume yes, because the unknown case is the dangerous one.
   */
  const loopTouchesADate = (assignment: ts.Node): boolean => {
    let n: ts.Node | undefined = assignment;
    while (n && !ts.isForOfStatement(n)) {
      if (ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n)) return true;
      n = n.parent;
    }
    if (!n) return true;
    let list: ts.Node = unwrap((n as ts.ForOfStatement).expression);
    if (ts.isIdentifier(list)) {
      const init = resolveDecl(list)?.initializer;
      if (!init) return true;
      list = unwrap(init);
    }
    if (!ts.isArrayLiteralExpression(list)) return true;
    let sawPair = false;
    for (const el of list.elements) {
      const pair = unwrap(el);
      if (!ts.isArrayLiteralExpression(pair) || pair.elements.length < 2) continue;
      const col = unwrap(pair.elements[1]!);
      if (!ts.isStringLiteral(col)) return true;
      sawPair = true;
      if (isDateColumn(col.text)) return true;
    }
    return !sawPair;
  };

  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && ts.isObjectLiteralExpression(node.parent)) {
      const nameNode = node.name;
      const column = ts.isIdentifier(nameNode) ? nameNode.text : ts.isStringLiteral(nameNode) ? nameNode.text : '';
      if (column) checkWrite(node, column, node.initializer, payloadLiterals.has(node.parent));
    }

    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const lhs = unwrap(node.left);
      if (ts.isPropertyAccessExpression(lhs) || ts.isElementAccessExpression(lhs)) {
        const target = unwrap(lhs.expression);
        const decl = ts.isIdentifier(target) ? resolveDecl(target) : undefined;
        const isPayloadVar = !!decl && sentDecls.has(decl);
        const key = ts.isPropertyAccessExpression(lhs) ? lhs.name.text
          : ts.isStringLiteral(unwrap(lhs.argumentExpression)) ? (unwrap(lhs.argumentExpression) as ts.StringLiteral).text
          : null;
        if (key !== null) {
          checkWrite(node, key, node.right, isPayloadVar);
        } else if (decl && isRequestDerived(node.right, reqNames)
          && !isBlankSafe(node.right, ctx) && loopTouchesADate(node)) {
          dynamicallyFilled.add(decl); // `updates[to] = body[from]`
        }
      }
    }

    if (ts.isCallExpression(node) && COERCERS.has(callName(node))) {
      for (const a of node.arguments) {
        const arg = unwrap(a);
        if (!ts.isIdentifier(arg)) continue;
        const d = resolveDecl(arg);
        if (!d) continue;
        const list = coercedAt.get(d) ?? [];
        list.push(node.getStart(src));
        coercedAt.set(d, list);
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(src);

  for (const s of sentVars) {
    if (!dynamicallyFilled.has(s.decl)) continue;
    if (s.wrapped) continue;
    const marks = coercedAt.get(s.decl) ?? [];
    const sendPos = s.id.getStart(src);
    if (marks.some((m) => m < sendPos)) continue;
    findings.push({ file: rel, line: at(s.id), column: s.id.text, text: textOf(s.id.parent), kind: 'payload' });
  }

  return findings.sort((a, b) => a.line - b.line);
}

export function listSourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry === 'node_modules' || entry === 'migrations' || entry === 'migrations-pg') continue;
        walk(full); continue;
      }
      if (!entry.endsWith('.ts') || entry.includes('.test.') || entry.endsWith('.d.ts')) continue;
      out.push(full);
    }
  };
  walk(root);
  return out.sort();
}

export function scanTree(root: string): Finding[] {
  return listSourceFiles(root).flatMap((f) => scanFile(f, path.relative(root, f)));
}
