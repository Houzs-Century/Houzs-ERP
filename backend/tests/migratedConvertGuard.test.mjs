// EVERY door into an invoice refuses a document carried over from AutoCount.
//
// RUN IT WITH (from backend/):
//   node --test tests/migratedConvertGuard.node.mjs
// It is wired into `npm run test:scale-contract`, which is `pretest`, so it runs
// on every CI backend job.
//
// NO DEPENDENCIES: node:test / node:assert only, reading the route sources as
// text. The route handlers themselves cannot be driven in the vitest suite — it
// runs in the Cloudflare Workers pool, where vi.mock does not intercept and a
// Hono handler cannot be pointed at a fake Supabase client. The behavioural
// rules therefore live in src/scm/lib/migrated-chain.ts and are tested directly
// (migrated-chain.test.ts, 26 assertions). What THIS file adds is the one thing
// that unit test cannot see: whether each route actually calls them.
//
// WHY IT IS WORTH A FILE. The refusal was first written on three paths —
// /from-grn, /from-grn-items, /from-dos — and there are SEVEN. A migrated
// receipt or delivery reached the other four through a line id
// (`grnItemId` / `doItemId`) or a delivery id, and each of those is a fence
// with an open gate beside it: the invoice would be numbered PI-YYMM-NNNN
// instead of HC-<AutoCount's number>, it would post a journal entry for money
// AutoCount already booked, and it would enqueue an AutoCount write-back that
// duplicates the invoice in the owner's live account book. Nothing about that
// is visible afterwards — it is the "plausible wrong value, silent forever"
// class. A guard on some of the doors is the failure this test exists to stop
// from coming back.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from 'vitest';
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(here, "..", p), "utf8");

const PI_SRC = "src/scm/routes/purchase-invoices.ts";
const SI_SRC = "src/scm/routes/sales-invoices.ts";

/**
 * Slice a router file into { route -> handler body }, where a handler body runs
 * from its own registration to the next one. Registrations are written flush to
 * column 0 in both files (`purchaseInvoices.post('/from-grn', async (c) => {`),
 * which is what makes this reliable rather than a regex over the whole file: a
 * guard present SOMEWHERE in a 3,300-line router proves nothing about the
 * handler that needs it.
 */
function handlers(src, routerVar) {
  const text = read(src);
  const lines = text.split(/\r?\n/);
  const re = new RegExp(`^${routerVar}\\.(get|post|patch|put|delete)\\(\\s*'([^']+)'(.*)$`);
  const found = [];
  lines.forEach((line, i) => {
    const m = re.exec(line);
    if (m) found.push({ key: `${m[1].toUpperCase()} ${m[2]}`, start: i, rest: m[3] });
  });
  const out = new Map();
  found.forEach((h, idx) => {
    const end = idx + 1 < found.length ? found[idx + 1].start : lines.length;
    let body = lines.slice(h.start, end).join("\n");
    /* A registration may point at a NAMED function instead of inlining the
       handler — `post('/from-grn', createPurchaseInvoiceFromGrnHandler);`. Both
       of these were inline when this test was written and were extracted on
       main; slicing to the next registration then returns one line that
       contains no guard, and every such route reads as unguarded while the
       guard sits untouched in the function above. Follow the reference. */
    const named = /^\s*,\s*([A-Za-z_$][\w$]*)\s*\)\s*;?\s*$/.exec(h.rest);
    if (named) {
      const fn = namedFunctionBody(lines, named[1]);
      if (fn) body += "\n" + fn;
    }
    out.set(h.key, body);
  });
  return out;
}

/**
 * The source of a top-level `const NAME = async (c) => {` / `async function NAME`,
 * from its declaration to the next top-level declaration. Returns null when the
 * name is not declared in this file, which the caller treats as "nothing extra
 * to read" rather than as a pass.
 */
function namedFunctionBody(lines, name) {
  const decl = new RegExp(`^(?:export\\s+)?(?:const\\s+${name}\\s*[:=]|async\\s+function\\s+${name}\\b|function\\s+${name}\\b)`);
  const start = lines.findIndex((l) => decl.test(l));
  if (start === -1) return null;
  const nextTop = lines.findIndex((l, i) => i > start && /^(?:export\s+)?(?:const|async\s+function|function|class)\s/.test(l));
  return lines.slice(start, nextTop === -1 ? lines.length : nextTop).join("\n");
}

/* The seven write paths that can attach a migrated goods receipt or a migrated
   delivery to an invoice, and the guard each one must call. The two that take a
   whole document call refuseMigratedSources directly; the five that arrive
   holding a line id or a delivery id go through the resolver, because the
   source document has to be looked up before the rule can be applied. */
const GUARDED = [
  { src: PI_SRC, router: "purchaseInvoices", route: "POST /from-grn", guard: "refuseMigratedSources(" },
  { src: PI_SRC, router: "purchaseInvoices", route: "POST /from-grn-items", guard: "refuseMigratedSources(" },
  { src: PI_SRC, router: "purchaseInvoices", route: "POST /", guard: "migratedRefusalForGrnItems(" },
  { src: PI_SRC, router: "purchaseInvoices", route: "POST /:id/items", guard: "migratedRefusalForGrnItems(" },
  { src: SI_SRC, router: "salesInvoices", route: "POST /from-dos", guard: "migratedRefusalForDeliveries(" },
  { src: SI_SRC, router: "salesInvoices", route: "POST /", guard: "migratedRefusalForDeliveries(" },
  { src: SI_SRC, router: "salesInvoices", route: "POST /:id/items", guard: "migratedRefusalForDeliveries(" },
  { src: SI_SRC, router: "salesInvoices", route: "POST /:id/items/from-do/:doId", guard: "migratedRefusalForDeliveries(" },
];

const bodies = new Map([
  [PI_SRC, handlers(PI_SRC, "purchaseInvoices")],
  [SI_SRC, handlers(SI_SRC, "salesInvoices")],
]);

test("every convert path into an invoice refuses a migrated source document", () => {
  const unguarded = [];
  for (const g of GUARDED) {
    const body = bodies.get(g.src).get(g.route);
    assert.ok(body, `${g.route} no longer exists in ${g.src} — update this list rather than deleting the check`);
    if (!body.includes(g.guard)) unguarded.push(`${g.route} (${g.src}) does not call ${g.guard}`);
  }
  assert.deepEqual(unguarded, [], `unguarded convert paths:\n  ${unguarded.join("\n  ")}`);
});

test("the guard refuses rather than proceeds when the source lookup FAILS", () => {
  /* A guard that fails open is not a guard. Both resolvers answer
     `{ ok: false }` on a load error, and every call site must turn that into a
     500 instead of reading it as "nothing migrated here". Checked as a pair —
     the ok:false branch has to be handled at the SAME place the refusal is. */
  for (const g of GUARDED) {
    if (!g.guard.startsWith("migratedRefusal")) continue;
    const body = bodies.get(g.src).get(g.route);
    /* The ANSWER is asserted, not the spelling of the call. A refusal may be
       returned through `c.json(...)` or through `refuseWithoutWriting(c, ...)`
       — the second one additionally releases the request's idempotency claim,
       which is what lets an operator correct the payload and try again
       (lib/no-write-refusal.ts). Both are refusals and both are 500 here; a
       gate that pinned one spelling would have blocked that fix while the rule
       it guards was never in question. What stays pinned: it must RETURN, it
       must be a 500, and `mig.reason` must ride the body so the failure is
       findable. */
    assert.match(
      body,
      /if \(!mig\.ok\) return (?:c\.json\(|refuseWithoutWriting\(c, )[^;]*mig\.reason[^;]*, 500\);/,
      `${g.route} calls ${g.guard} but does not refuse when the lookup fails`,
    );
    assert.match(
      body,
      /if \(mig\.refusal\) return (?:c\.json\(|refuseWithoutWriting\(c, )mig\.refusal, 409\);/,
      `${g.route} calls ${g.guard} but does not return its refusal`,
    );
  }
});

test("the AutoCount write-back is never enqueued from a migrated conversion", () => {
  /* enqueueConvert has none of the "already in AutoCount" protection its
     enqueueSoCreate / enqueuePoCreate siblings have, so the only thing standing
     between a migrated conversion and a duplicate invoice in the live account
     book is the handler refusing BEFORE it reaches the enqueue. Assert the
     order, not merely the presence: a refusal after the enqueue is no refusal
     at all. */
  const cases = [
    { src: PI_SRC, router: "purchaseInvoices", route: "POST /from-grn", guard: "refuseMigratedSources(" },
    { src: SI_SRC, router: "salesInvoices", route: "POST /from-dos", guard: "migratedRefusalForDeliveries(" },
  ];
  for (const c of cases) {
    const body = bodies.get(c.src).get(c.route);
    const guardAt = body.indexOf(c.guard);
    const enqueueAt = body.indexOf("enqueueConvert(");
    assert.ok(guardAt >= 0, `${c.route} lost its migrated guard`);
    assert.ok(enqueueAt >= 0, `${c.route} no longer enqueues an AutoCount transfer — update this check`);
    assert.ok(
      guardAt < enqueueAt,
      `${c.route} enqueues the AutoCount write-back at ${enqueueAt} BEFORE it refuses a migrated source at ${guardAt}`,
    );
  }
});

test("a migrated invoice posts no journal entry, guarded inside the poster not at its call sites", () => {
  /* postPiAccounting and postSiRevenue each re-read their own header and bail on
     migrated_no_stock. Guarding in the function rather than at the call sites is
     what makes "every caller" true by construction — the SI auto-posts on create
     AND on convert, and a fifth caller added tomorrow inherits the rule. */
  const pi = read("src/scm/routes/accounting.ts");
  const si = read("src/scm/lib/post-si-revenue.ts");
  for (const [name, text] of [["postPiAccounting", pi], ["postSiRevenue", si]]) {
    assert.match(text, /migrated_no_stock/, `${name} does not read migrated_no_stock`);
    assert.match(
      text,
      /migrated_no_stock\?: boolean \| null \}\)\.migrated_no_stock === true\) \{\s*\n?\s*return \{ ok: true, status: 'migrated_source' \};/,
      `${name} does not return migrated_source before posting`,
    );
  }
});
