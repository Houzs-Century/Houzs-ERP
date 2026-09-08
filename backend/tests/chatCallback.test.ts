import { describe, expect, test } from "vitest";

/* /api/chat-callback — Houzs Chat (Connect) → ERP delivery callback.
 *
 * WHY THESE ARE SOURCE TESTS AND NOT ROUTE TESTS. The handler talks to
 * Supabase/Postgres (`getSupabaseService(c.env)` → the `scm` schema), and this
 * suite's isolated environment binds D1 only — a request 500s on missing
 * Supabase config long before reaching an assertion worth making. Same call,
 * and same reasoning, as tests/adminResetLink.test.ts: rather than leave the
 * invariants unpinned, or refactor a live intake path onto env.DB purely to
 * make it testable, they are pinned against the handler's SOURCE.
 *
 * Every invariant below would read as perfectly reasonable code if it were
 * quietly reverted — "apply the date the customer picked" looks like finishing
 * the feature, and dropping a `.eq('company_id', …)` looks like simplification
 * — which is exactly why they need a red test rather than a comment.
 *
 * import.meta.glob with `?raw` rather than readFileSync: this suite runs in
 * workerd, where fs throws "not yet implemented in Workers". The glob is
 * expanded by Vite at TRANSFORM time, in Node, so the contents are baked into
 * the bundle. The emptiness assertions make a glob that stops resolving fail
 * LOUD instead of silently passing on an empty string.
 */

const sources = import.meta.glob(
  [
    "../src/routes/chatCallback.ts",
    "../src/index.ts",
    "../src/scm/routes/delivery-messages.ts",
  ],
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;

function source(suffix: string): string {
  const hit = Object.entries(sources).find(([p]) => p.endsWith(suffix));
  expect(hit, `source not found: ${suffix} — did the file move?`).toBeTruthy();
  const text = hit![1] ?? "";
  expect(text.length, `source empty: ${suffix}`).toBeGreaterThan(200);
  return text;
}

/** Strip comments so the assertions read CODE, not prose. Load-bearing, not
 *  tidiness: this route's header comment explains at length what it must NOT
 *  do, and naming the thing you removed is exactly how a source test starts
 *  reporting a phantom. */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const route = () => stripComments(source("routes/chatCallback.ts"));
const deliveryMessages = () => stripComments(source("routes/delivery-messages.ts"));

// Line number of the first UNCOMMENTED line containing `needle`, or -1.
//
// Deliberately NOT stripComments(index.ts): that helper treats a slash-star as
// a block-comment opener, and index.ts is full of route patterns like
// app.use("/api/*", auth) whose star closes the quote and opens a phantom
// block, swallowing every real mount until the next close marker. Comparing
// line positions and skipping "//" lines gets the same "is it commented out"
// protection without that hazard.
function uncommentedLine(src: string, needle: string): number {
  return src
    .split("\n")
    .findIndex((l) => l.includes(needle) && !l.trimStart().startsWith("//"));
}

describe("chat-callback is reachable at all", () => {
  test("mounted ABOVE the /api/* auth gate", () => {
    const src = source("src/index.ts");
    const mount = uncommentedLine(src, 'app.route("/api/chat-callback"');
    const gate = uncommentedLine(src, 'app.use("/api/*", auth)');
    expect(mount, "route is not mounted in index.ts").toBeGreaterThan(-1);
    expect(gate, "the /api/* auth gate moved — this test needs updating").toBeGreaterThan(-1);
    // Below the gate, every call 401s before the route's own key check runs.
    // That is the exact mistake /api/assr-form-intake documents having made.
    expect(mount).toBeLessThan(gate);
  });
});

describe("the callback records, it does not schedule", () => {
  test("never writes to mfg_sales_orders", () => {
    const src = route();
    // A date a customer tapped is a REQUEST. The board owns delivery dates and
    // MRP pools off them; a write here would let a customer move a date a trip
    // has already been planned around.
    expect(src).not.toMatch(/\.update\s*\(/);
    expect(src).not.toMatch(/mfg_sales_orders[\s\S]{0,200}\.update\s*\(/);
  });

  test("mfg_sales_orders is read-only — select only", () => {
    const src = route();
    const idx = src.indexOf('from("mfg_sales_orders")');
    expect(idx, "the SO existence check disappeared").toBeGreaterThan(-1);
    const stmt = src.slice(idx, idx + 200);
    expect(stmt).toContain(".select(");
  });

  test("the response says applied:false, so no caller can assume otherwise", () => {
    expect(route()).toMatch(/applied:\s*false/);
  });
});

describe("one secret, one company", () => {
  test("the key speaks for HOUZS and the SO lookup is scoped to it", () => {
    const src = route();
    expect(src).toMatch(/CHAT_KEY_COMPANY\s*=\s*"HOUZS"/);
    // company.id null-but-master-readable is a MISCONFIGURATION and must
    // refuse; degrading to "no predicate" re-opens the cross-tenant hole on
    // the day someone renames a company code.
    expect(src).toMatch(/company\.master\s*&&\s*company\.id\s*==\s*null/);
    expect(src).toMatch(/\.eq\("company_id",\s*company\.id\)/);
  });

  test("an unknown ref and another company's ref answer identically", () => {
    const src = route();
    // Distinguishing them would let a Houzs credential probe which doc numbers
    // exist elsewhere.
    const hits = src.match(/unknown_ref/g) ?? [];
    expect(hits.length).toBe(1);
  });
});

describe("the guard is the same shape as the other intake keys", () => {
  test("constant-time compare, rate limit, and a failure delay", () => {
    const src = route();
    expect(src).toMatch(/timingSafeEqualStr\(provided,\s*expected\)/);
    expect(src).toMatch(/checkRateLimit\(/);
    expect(src).toMatch(/setTimeout\(r,\s*250\)/);
  });

  test("an unset secret refuses rather than admits", () => {
    const src = route();
    // `expected &&` before the compare: with CHAT_CALLBACK_KEY unset, an empty
    // provided header must NOT equal an empty expected one and sail through.
    expect(src).toMatch(/if\s*\(expected\s*&&\s*timingSafeEqualStr/);
  });
});

describe("idempotency cannot widen or collide", () => {
  test("callback_id is sanitised before it reaches the LIKE", () => {
    const src = route();
    expect(src).toMatch(/replace\(\/\[\^A-Za-z0-9_-\]\/g,\s*""\)/);
    // The id is interpolated into a LIKE; an unfiltered % or _ would silently
    // match rows it should not.
    expect(src).toMatch(/callback_id":"\$\{callbackId\}/);
  });

  test("the duplicate probe only ever sees this route's own rows", () => {
    const src = route();
    const idx = src.indexOf(".like(");
    expect(idx, "the idempotency probe disappeared").toBeGreaterThan(-1);
    // A delivery-planning send must never be mistaken for a duplicate callback.
    expect(src.slice(Math.max(0, idx - 300), idx)).toMatch(
      /\.eq\("source",\s*"chat-callback"\)/,
    );
  });
});

describe("a lost answer is an error, not a 200", () => {
  test("the insert failure is returned, not swallowed", () => {
    const src = route();
    expect(src).toMatch(/insErr[\s\S]{0,160}log_failed/);
    // The send path logs best-effort because the WhatsApp had already left.
    // Here the row IS the delivery: answering 200 would stop chat retrying and
    // the customer's answer would be gone for good.
    expect(src).toMatch(/log_failed[\s\S]{0,80}500/);
  });
});

describe("callback rows cannot masquerade as send status", () => {
  test("the board's /statuses filters to delivery-planning rows", () => {
    const src = deliveryMessages();
    const idx = src.indexOf("deliveryMessages.post('/statuses'");
    expect(idx, "the /statuses handler moved").toBeGreaterThan(-1);
    const handler = src.slice(idx);
    // Callback rows are NEWER than the send they answer, and the handler takes
    // the first hit per doc — without this predicate every answered message
    // would report itself as freshly sent.
    expect(handler).toMatch(/\.eq\('source',\s*'delivery-planning'\)/);
  });

  test("the callback writes a source the filter excludes", () => {
    expect(route()).toMatch(/source:\s*"chat-callback"/);
  });
});
