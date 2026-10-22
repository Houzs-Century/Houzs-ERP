import type { Env } from "../types";

// ---------------------------------------------------------------------------
// Error tracking — Sentry-protocol reporter, INERT until SENTRY_DSN is set.
//
// WHY THIS EXISTS. Until now the only record of a backend failure was
// `console.error` in the Worker log, which nobody reads and which nothing
// alerts on. docs/supavisor-pooler-outage-coe.md §7 states the gap in one
// line: "Nothing watches production between deploys." Production answered 503
// for 18h15m and the only continuous record was an unrelated hourly workflow.
// A grouped, alertable error stream is the missing detector.
//
// WHY NO SDK. `@sentry/cloudflare` cannot be added: CI runs `npm ci`, which
// aborts when package.json and package-lock.json disagree, and this repo does
// not run `npm install` (same constraint that produced the dependency-free
// react-virtual shim in the frontend). More importantly, hand-building the
// payload is what makes the privacy promise ENFORCEABLE — the SDK's default is
// to attach request data and let you subtract from it; here nothing is
// attached unless this file adds it, and a test asserts what the wire carries.
//
// WHY IT IS DSN-GATED, NOT FEATURE-FLAGGED. A missing DSN is the default state
// on every environment (prod, staging, local, CI) until the owner pastes one
// secret. In that state this module must be indistinguishable from not
// existing: no fetch, no throw, no console line, no added latency. See
// `isErrorTrackingEnabled` — every entry point returns before touching
// anything.
//
// PROTOCOL, NOT VENDOR. The wire format is Sentry's "envelope" endpoint, which
// GlitchTip (open source, self-hostable) also speaks. Pointing SENTRY_DSN at a
// self-hosted GlitchTip keeps every byte in-house and needs no code change —
// which is how this squares with the standing "no Sentry" ruling recorded in
// routes/clientErrors.ts. The owner picks who holds the data by choosing a DSN.
//
// WHAT LEAVES THE BUILDING — the exhaustive list. Anything not named here is
// not sent, because this file never reads it:
//   • error type + message, redacted (see `redactText`)
//   • stack frames: file, function, line, column — query strings stripped
//   • the Hono ROUTE PATTERN ("/api/scm/sales-orders/:id"), never the real URL
//   • HTTP method and status
//   • our own request id (correlates back to the Worker log)
//   • the acting user's numeric staff id, and the numeric company id
//   • environment name, build id, timestamp
// Never sent: request bodies, query strings, headers of any kind, cookies,
// session tokens, Authorization values, customer names, phone numbers,
// addresses, prices, or the end user's IP address (browser events are relayed
// BY THE WORKER, so the ingest server only ever sees Cloudflare's address).
// ---------------------------------------------------------------------------

/** Parsed DSN. `https://<publicKey>@<host>/<projectId>` (the secret-key form is
 *  legacy and its secret half is ignored — modern ingest does not use it). */
interface Dsn {
  publicKey: string;
  /** Fully-qualified envelope endpoint, ready to POST. */
  envelopeUrl: string;
}

/** Storm brake. Each Worker isolate may send this many events per window; past
 *  that it drops silently. The point is the ALERT, not the archive: during the
 *  18-hour outage every request failed identically, and ten events a minute is
 *  already far more than any alert rule needs to fire. Cloudflare runs several
 *  isolates concurrently, so the true ceiling is a small multiple of this — it
 *  is a brake, not an accountant. Without it one bad afternoon would spend a
 *  whole month of free quota (Sentry's free plan is 5,000 errors/month; the
 *  arithmetic is worked through in docs/error-tracking-options.md). */
const MAX_EVENTS_PER_WINDOW = 10;
const WINDOW_MS = 60_000;

/** Messages are the one field an upstream library can stuff PII into (Postgres
 *  unique-violation details quote the offending VALUE). Cap then redact. */
const MAX_MESSAGE = 1000;
const MAX_FRAMES = 30;
/** Envelope hard cap. A runaway stack must not turn one crash into a megabyte
 *  upload from the request path. */
const MAX_ENVELOPE_BYTES = 100 * 1024;

let windowStartedAt = 0;
let sentInWindow = 0;

/**
 * Redact the value classes that routinely ride inside an error message.
 *
 * Deliberately narrow: over-redaction makes the tool useless, and the fields
 * we control (route, tags, user) are already ids rather than names. These three
 * patterns cover what actually leaks from this stack — a Postgres constraint
 * violation quoting a customer's phone, an email address in a validation
 * message, and any long digit run (phone, IC, bank account, card).
 *
 * Exported for the test that proves it.
 */
export function redactText(input: string): string {
  return (
    input
      // Postgres: `Key (phone)=(0123456789) already exists.` — the column name
      // is diagnostic and stays; the value is the customer's data and goes.
      .replace(/Key \(([^)]*)\)=\(([^)]*)\)/g, "Key ($1)=([redacted])")
      .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]")
      // 8+ digits, optionally separated by spaces/dashes: phone, IC, account,
      // card. Short numbers (ids, line numbers, quantities, years) survive
      // because they are what makes an error readable.
      .replace(/\d[\d\s-]{6,}\d/g, "[number]")
  );
}

/**
 * The cause of a failure, as one Worker-log string. `console.error(err)` logs
 * the stack alone, and a postgres.js error's stack has no message line, so
 * every database error reached the log as bare frames ("at ErrorResponse ...")
 * naming neither the constraint nor the table. Redacted like the reported
 * message: a Postgres message can quote a value.
 */
export function describeErrorForLog(err: unknown): string {
  if (!(err instanceof Error)) return redactText(String(err)).slice(0, MAX_MESSAGE);
  const pg = err as Error & Record<string, unknown>;
  const where = [
    ["code", pg.code],
    ["table", pg.table_name],
    ["column", pg.column_name],
    ["constraint", pg.constraint_name],
  ]
    .filter(([, v]) => typeof v === "string" && v !== "")
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  return redactText(`${err.name}${where ? ` (${where})` : ""}: ${err.message}`).slice(0, MAX_MESSAGE);
}

/**
 * Parse SENTRY_DSN. Returns null for absent, blank, or malformed input —
 * malformed is treated exactly like absent (stay inert) rather than throwing,
 * because a typo in a secret must never take production down.
 */
export function parseDsn(raw: string | undefined | null): Dsn | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    const publicKey = url.username;
    if (!publicKey) return null;
    // Path is `/<projectId>` on hosted Sentry, `/<path>/<projectId>` on a
    // self-hosted GlitchTip mounted under a prefix. The project id is the last
    // segment; whatever precedes it is the base path.
    const segments = url.pathname.split("/").filter(Boolean);
    const projectId = segments.pop();
    if (!projectId) return null;
    const basePath = segments.length ? `/${segments.join("/")}` : "";
    return {
      publicKey,
      envelopeUrl: `${url.protocol}//${url.host}${basePath}/api/${projectId}/envelope/`,
    };
  } catch {
    return null;
  }
}

/** The single gate. Everything public in this module returns early on false. */
export function isErrorTrackingEnabled(env: Pick<Env, "SENTRY_DSN">): boolean {
  return parseDsn(env?.SENTRY_DSN) !== null;
}

function eventId(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** Token bucket, module-scoped (per isolate). Returns false once spent. */
function allowByRate(now: number): boolean {
  if (now - windowStartedAt > WINDOW_MS) {
    windowStartedAt = now;
    sentInWindow = 0;
  }
  if (sentInWindow >= MAX_EVENTS_PER_WINDOW) return false;
  sentInWindow++;
  return true;
}

/** Test seam: the brake is module state, so a test that sends events would
 *  otherwise poison the next test in the same isolate (singleWorker: true). */
export function __resetRateLimitForTest(): void {
  windowStartedAt = 0;
  sentInWindow = 0;
}

function sampleRate(env: Pick<Env, "SENTRY_SAMPLE_RATE">): number {
  // A blank var is "unset", not "zero". Number("") is 0, which would silently
  // report nothing at all — the failure mode hardest to notice, since silence
  // is also what correct-and-unconfigured looks like.
  const raw = (env?.SENTRY_SAMPLE_RATE ?? "").trim();
  if (!raw) return 1;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 1;
}

export interface StackFrame {
  filename: string;
  function?: string;
  lineno?: number;
  colno?: number;
  in_app: boolean;
}

const FRAME_RE = /^\s*at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/;

/**
 * Parse a V8 stack string into Sentry frames.
 *
 * Sentry expects frames OLDEST FIRST, the reverse of how V8 prints them, and
 * groups issues by the frame list — so getting the order wrong does not fail
 * loudly, it just groups badly. Query strings are stripped from filenames: a
 * frame URL can carry one, and a query string is exactly the place tokens and
 * filter values live (same boundary routes/clientErrors.ts enforces).
 *
 * Exported for the test that proves the order and the stripping.
 */
export function parseStackFrames(stack: string | undefined): StackFrame[] {
  if (!stack) return [];
  const frames: StackFrame[] = [];
  for (const line of stack.split("\n")) {
    const m = FRAME_RE.exec(line);
    if (!m) continue;
    const filename = m[2].split("?")[0].split("#")[0];
    frames.push({
      filename,
      function: m[1] || undefined,
      lineno: Number(m[3]) || undefined,
      colno: Number(m[4]) || undefined,
      // Anything not from a vendor bundle is ours. Crude but it only affects
      // which frames Sentry highlights, never what is sent.
      in_app: !/node_modules|\/react-vendor|\/lucide|\/leaflet/.test(filename),
    });
    if (frames.length >= MAX_FRAMES) break;
  }
  return frames.reverse();
}

/** Everything a caller may contribute. Every field is an id, a pattern or an
 *  enum — there is deliberately no way to pass free-form user data through. */
export interface CaptureContext {
  /** "worker" for a backend throw, "browser" for a relayed client crash. */
  source: "worker" | "browser";
  /** Hono route PATTERN (/api/x/:id) or a sanitized SPA pathname. Never a URL
   *  with a query string. */
  route?: string;
  method?: string;
  status?: number;
  /** Our X-Request-Id, so an issue links back to the Worker log line. */
  requestId?: string;
  userId?: number | string | null;
  companyId?: number | string | null;
  /** Frontend build id — becomes the Sentry release for browser events. */
  release?: string;
  /** Pre-parsed stack for relayed browser events (we get a string, not an Error). */
  stack?: string;
  /** Exception type when we only have strings (browser relay). */
  type?: string;
}

/**
 * Recover the real exception class from a stack's first line.
 *
 * Browser crashes reach us as plain strings relayed from the SPA, so the
 * Error we reconstruct is always literally `Error` — which would collapse
 * every frontend issue into one useless bucket. The stack still names the
 * original ("TypeError: Cannot read properties of undefined ..."), so read it
 * back. Purely a grouping aid; it never affects what is sent.
 */
function typeFromStack(stack: string | undefined): string | undefined {
  const first = (stack ?? "").split("\n", 1)[0];
  return /^\s*([A-Za-z][A-Za-z0-9_]*Error)\b/.exec(first)?.[1];
}

/** The event body, exported so the test can assert the exact wire shape. */
export function buildEvent(
  env: Pick<Env, "SENTRY_ENVIRONMENT">,
  err: unknown,
  ctx: CaptureContext,
): Record<string, unknown> {
  const asError = err instanceof Error ? err : undefined;
  const rawMessage = asError?.message ?? (typeof err === "string" ? err : String(err ?? "Unknown error"));
  const stack = ctx.stack ?? asError?.stack;
  const named = ctx.type || asError?.name;
  const type = named && named !== "Error" ? named : typeFromStack(stack) || named || "Error";
  const frames = parseStackFrames(stack);

  const tags: Record<string, string> = { source: ctx.source };
  if (ctx.route) tags.route = ctx.route;
  if (ctx.method) tags.method = ctx.method;
  if (ctx.status !== undefined) tags.status = String(ctx.status);
  if (ctx.requestId) tags.request_id = ctx.requestId;
  if (ctx.companyId != null && ctx.companyId !== "") tags.company_id = String(ctx.companyId);

  const event: Record<string, unknown> = {
    event_id: eventId(),
    timestamp: Date.now() / 1000,
    platform: "javascript",
    level: "error",
    logger: ctx.source,
    environment: env?.SENTRY_ENVIRONMENT || "production",
    // The route PATTERN is the transaction name. Using the real path would put
    // customer-identifying ids into the issue title for no diagnostic gain.
    transaction: ctx.route,
    tags,
    exception: {
      values: [
        {
          type: redactText(String(type)).slice(0, 200),
          value: redactText(rawMessage).slice(0, MAX_MESSAGE),
          stacktrace: frames.length ? { frames } : undefined,
        },
      ],
    },
  };
  if (ctx.release) event.release = ctx.release;
  // Identity is a NUMBER and nothing else. No name, no email, no username —
  // and `ip_address: null` explicitly opts out of Sentry inferring one from
  // the connection (which, since the Worker is the client, would be a
  // Cloudflare address anyway).
  if (ctx.userId != null && ctx.userId !== "") {
    event.user = { id: String(ctx.userId), ip_address: null };
  } else {
    event.user = { ip_address: null };
  }
  // `request` carries the pattern and the method ONLY. There is intentionally
  // no `headers`, no `cookies`, no `data`, no `query_string` key — the SDK
  // would populate all four by default, and this is the whole reason we build
  // the payload by hand.
  if (ctx.route) {
    event.request = { method: ctx.method, url: ctx.route };
  }
  return event;
}

function envelope(dsn: string, event: Record<string, unknown>): string {
  const body = JSON.stringify(event);
  const header = JSON.stringify({ event_id: event.event_id, sent_at: new Date().toISOString(), dsn });
  const itemHeader = JSON.stringify({
    type: "event",
    content_type: "application/json",
    length: new TextEncoder().encode(body).length,
  });
  return `${header}\n${itemHeader}\n${body}\n`;
}

/**
 * Report one error. Fire-and-forget, never throws, never awaits on the request
 * path (the caller hands us `waitUntil`).
 *
 * PRIME DIRECTIVE, same as the frontend reporter: reporting must never change
 * behaviour. With no DSN this returns before doing anything at all — that is
 * the state every environment is in until the owner acts, so it is the path
 * that has to be perfect, and errorTracking.test.ts asserts it makes no fetch
 * and writes nothing to the console.
 */
export function captureError(
  env: Env,
  err: unknown,
  ctx: CaptureContext,
  waitUntil?: (p: Promise<unknown>) => void,
): void {
  try {
    const dsn = parseDsn(env?.SENTRY_DSN);
    if (!dsn) return; // INERT. No fetch, no log, no allocation past this line.
    if (Math.random() >= sampleRate(env)) return;
    if (!allowByRate(Date.now())) return;

    const payload = envelope(env.SENTRY_DSN as string, buildEvent(env, err, ctx));
    if (payload.length > MAX_ENVELOPE_BYTES) return;

    const p = fetch(dsn.envelopeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-sentry-envelope",
        // Sentry authenticates the DSN's PUBLIC key in this header. It is not
        // a credential that grants read access — it only permits writes into
        // one project.
        "X-Sentry-Auth": `Sentry sentry_version=7, sentry_client=houzs-erp/1.0, sentry_key=${dsn.publicKey}`,
      },
      body: payload,
    }).catch(() => {
      // Ingest unreachable, rate-limited (429 once the monthly quota is spent),
      // or 4xx: drop. This is telemetry, not business data — a retry loop
      // against a down collector is strictly worse than losing the event.
      return undefined;
    });

    if (waitUntil) waitUntil(p);
    else void p;
  } catch {
    // A bug in the reporter must never surface as a bug in the ERP. Swallowed
    // deliberately, and silently: a console line here would fire once per
    // request during an incident and drown the log we are trying to read.
  }
}
