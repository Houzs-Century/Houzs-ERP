import type { Env } from "../types";


interface Dsn {
  publicKey: string;
  envelopeUrl: string;
}

const MAX_EVENTS_PER_WINDOW = 10;
const WINDOW_MS = 60_000;

const MAX_MESSAGE = 1000;
const MAX_FRAMES = 30;
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
      .replace(/Key \(([^)]*)\)=\(([^)]*)\)/g, "Key ($1)=([redacted])")
      .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]")
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
      in_app: !/node_modules|\/react-vendor|\/lucide|\/leaflet/.test(filename),
    });
    if (frames.length >= MAX_FRAMES) break;
  }
  return frames.reverse();
}

/** Everything a caller may contribute. Every field is an id, a pattern or an
 *  enum — there is deliberately no way to pass free-form user data through. */
export interface CaptureContext {
  source: "worker" | "browser";
  route?: string;
  method?: string;
  status?: number;
  requestId?: string;
  userId?: number | string | null;
  companyId?: number | string | null;
  release?: string;
  stack?: string;
  type?: string;
}

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
  if (ctx.userId != null && ctx.userId !== "") {
    event.user = { id: String(ctx.userId), ip_address: null };
  } else {
    event.user = { ip_address: null };
  }
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
    if (!dsn) return;
    if (Math.random() >= sampleRate(env)) return;
    if (!allowByRate(Date.now())) return;

    const payload = envelope(env.SENTRY_DSN as string, buildEvent(env, err, ctx));
    if (payload.length > MAX_ENVELOPE_BYTES) return;

    const p = fetch(dsn.envelopeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-sentry-envelope",
        "X-Sentry-Auth": `Sentry sentry_version=7, sentry_client=houzs-erp/1.0, sentry_key=${dsn.publicKey}`,
      },
      body: payload,
    }).catch(() => {
      return undefined;
    });

    if (waitUntil) waitUntil(p);
    else void p;
  } catch {
  }
}
