import type { Context, MiddlewareHandler } from "hono";
import type { Env } from "../types";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const MAX_KEY_LENGTH = 200;
const MAX_IDEMPOTENCY_BODY_BYTES = 1024 * 1024;
const BODYLESS_STATUS = new Set([204, 205, 304]);
const IDEMPOTENCY_OUTCOME_HEADER = "Idempotency-Outcome";
const NO_WRITE_OUTCOME = "no-write";
export const IDEMPOTENCY_PHASE_ONE_WORKER_MARKER =
  "rollout.idempotency_phase1_worker_live";

type IdempotencyRow = {
  status_code: number | null;
  response_body: string | null;
  request_hash: string;
};
type AppContext = Context<{ Bindings: Env }>;

class IdempotencyPayloadTooLargeError extends Error {}

/**
 * Mark a response only after the route has proved that this intent performed
 * no business write. The middleware then releases the claim so the same user
 * intent can correct its payload and retry with the same stable key.
 *
 * This must never be inferred from an HTTP status: legacy routes can return a
 * 4xx/5xx after one or more non-transactional writes.
 */
export function markIdempotencyNoWrite(c: {
  header(name: string, value: string): void;
}): void {
  c.header(IDEMPOTENCY_OUTCOME_HEADER, NO_WRITE_OUTCOME);
}

export function isUniqueViolation(error: unknown): boolean {
  if ((error as { code?: unknown } | null)?.code === "23505") return true;
  const message = String((error as Error)?.message ?? error ?? "");
  return /duplicate key value violates unique constraint|UNIQUE constraint failed/i.test(message);
}

async function markPhaseOneWorkerLive(db: Env["DB"]): Promise<void> {
  try {
    // First successful claim wins. Phase 2 uses this row's immutable
    // updated_at as the start of its mixed-Worker soak window.
    await db
      .prepare(
        `INSERT INTO app_settings (key, value, updated_at)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO NOTHING`,
      )
      .bind(
        IDEMPOTENCY_PHASE_ONE_WORKER_MARKER,
        JSON.stringify({ phase: 1, source: "worker" }),
      )
      .run();
  } catch (error) {
    // The claim itself is already durable and must continue normally. A
    // missing marker only keeps the destructive Phase-2 migration blocked.
    console.warn(
      `[idempotency] phase-one rollout marker failed: ${String((error as Error)?.message ?? error).slice(0, 120)}`,
    );
  }
}

function idempotencyScope(request: Request): string {
  const url = new URL(request.url);
  return `${request.method} ${url.pathname}`;
}

function tenantScope(c: AppContext): string {
  const companyId = Number(c.get("companyId"));
  if (Number.isInteger(companyId) && companyId > 0) return `company:${companyId}`;

  // During a company-master cold start there may be no resolved companyId yet.
  // Keep an explicit company pick or hostname in the namespace so a retry made
  // through another company door cannot replay the first door's response.
  const requestedCompany = (
    c.req.header("X-Company-Id") ?? c.req.query("companyId") ?? ""
  )
    .trim()
    .toLowerCase();
  if (requestedCompany) return `company-request:${requestedCompany.slice(0, 80)}`;

  const host = (c.req.header("host") ?? new URL(c.req.url).host).trim().toLowerCase();
  return host ? `host:${host.slice(0, 160)}` : "global";
}

/** Exported for deterministic race tests; production callers use the middleware. */
export async function idempotencyRequestHash(request: Request): Promise<string> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_IDEMPOTENCY_BODY_BYTES) {
    throw new IdempotencyPayloadTooLargeError();
  }

  // Web Crypto has no streaming digest. Read at most 1 MiB from a cloned body
  // so an authenticated caller cannot make the global middleware buffer an R2
  // upload before the route's own size checks. All current keyed callsites are
  // JSON document/payment mutations and sit comfortably below this ceiling.
  const reader = request.clone().body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_IDEMPOTENCY_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new IdempotencyPayloadTooLargeError();
      }
      chunks.push(value);
    }
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const url = new URL(request.url);
  const contentType = request.headers.get("content-type") ?? "";
  // Query parameters can change a mutation's meaning. Bind them to the hash,
  // while keeping the indexed route scope bounded to METHOD + pathname.
  const prefix = new TextEncoder().encode(
    `${request.method}\n${url.pathname}${url.search}\n${contentType}\n`,
  );
  const bodyDigest = new Uint8Array(await crypto.subtle.digest("SHA-256", body));
  const input = new Uint8Array(prefix.length + bodyDigest.length);
  input.set(prefix);
  input.set(bodyDigest, prefix.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const inFlight = (c: AppContext) => {
  c.header("Retry-After", "1");
  return c.json(
    {
      error: "idempotency_in_flight",
      message:
        "This request is already being processed. Please wait a moment and refresh — do not send it again.",
    },
    409,
  );
};

/* The collision answer has to say WHICH collision it is, because the two have
   opposite remedies and only the server can tell them apart.
 *
 * `completed_status` is the status the EARLIER request under this key already
 * answered with. It is present on every key_reused, and it is the whole point:
 * a client that sees this code knows the handler for THIS request never ran,
 * and knows nothing whatsoever about whether the earlier one wrote. A 201 here
 * means a document exists. Nothing downstream may read this code as "nothing
 * was saved" — the release path for a genuine no-write is
 * markIdempotencyNoWrite, which DELETES the claim, so a proven no-write never
 * reaches this response at all.
 *
 * The copy therefore sends the operator to CHECK, never to resubmit. It used
 * to end "Please submit again", which is the same wrong instruction in the
 * server's own voice. */
const keyReuse = (c: AppContext, completedStatus: number) =>
  c.json(
    {
      error: "idempotency_key_reused",
      completed_status: completedStatus,
      message:
        "An earlier submission under this key already finished with different data. " +
        "Refresh and check what was recorded before sending this again.",
    },
    409,
  );

const keyConflict = (c: AppContext) =>
  c.json(
    {
      error: "idempotency_key_conflict",
      message: "This request key is already owned by another operation. Please try again.",
    },
    409,
  );

const outcomeUnknown = (c: AppContext) =>
  c.json(
    {
      error: "idempotency_outcome_unknown",
      message:
        "We couldn't confirm whether this was recorded. Do not submit it again — refresh and check first.",
    },
    503,
  );

const unavailable = (c: AppContext) => {
  c.header("Retry-After", "1");
  return c.json(
    {
      error: "idempotency_unavailable",
      message: "This write cannot be safely recorded right now. Please wait and try again.",
    },
    503,
  );
};

/**
 * Principal- and company-scoped request idempotency.
 *
 * Activates when a mutating request carries `Idempotency-Key`. The key is
 * owned by the authenticated user and active company, and is bound to the
 * exact request body. A retry can therefore replay only its own matching
 * operation; it cannot replay another user's/company's response or silently
 * substitute an earlier payload.
 *
 * Bookkeeping is fail-closed before the handler. A caller that explicitly asks
 * for idempotency must never be allowed to perform an untracked write when the
 * table is unavailable. Mount AFTER auth and companyContext.
 */
export const idempotency: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const rawKey = c.req.header("Idempotency-Key");
  if (!rawKey || !MUTATING.has(c.req.method)) return next();

  const key = rawKey.trim();
  if (
    key.length === 0 ||
    key.length > MAX_KEY_LENGTH ||
    !/^[\x21-\x7e]+$/.test(key)
  ) {
    return c.json(
      {
        error: "invalid_idempotency_key",
        message: `Idempotency-Key must be 1-${MAX_KEY_LENGTH} printable ASCII characters without spaces.`,
      },
      400,
    );
  }

  const rawUserId = c.get("userId");
  const userId = Number(rawUserId);
  if (rawUserId == null || !Number.isInteger(userId) || userId < 0) {
    console.error("[idempotency] authenticated principal is missing");
    return unavailable(c);
  }

  const scope = idempotencyScope(c.req.raw);
  const tenant = tenantScope(c);
  let requestHash: string;
  try {
    requestHash = await idempotencyRequestHash(c.req.raw);
  } catch (error) {
    if (error instanceof IdempotencyPayloadTooLargeError) {
      return c.json(
        {
          error: "idempotency_payload_too_large",
          message: "Idempotent requests are limited to 1 MiB. Upload the file separately.",
        },
        413,
      );
    }
    console.warn(
      `[idempotency] request hash failed: ${String((error as Error)?.message ?? error).slice(0, 120)}`,
    );
    return unavailable(c);
  }

  const db = c.env.DB;
  const findExisting = () =>
    db
      .prepare(
        `SELECT status_code, response_body, request_hash
           FROM idempotency_keys
          WHERE user_id = ? AND tenant_scope = ? AND key = ? AND scope = ?`,
      )
      .bind(userId, tenant, key, scope)
      .first<IdempotencyRow>();

  const respondToExisting = (existing: IdempotencyRow): Response => {
    /* STATUS FIRST, then the hash. The hash decides whether this request may be
       REPLAYED; the status decides what the caller must be told, and it is the
       stronger fact. Checked the other way round (which it was until
       2026-08-18) a changed payload sent while the first request is still
       RUNNING was answered "you reused the key", never `idempotency_in_flight`
       — so in_flight was only ever reachable for the identical payload, i.e.
       the one case that was already safe, and no caller could distinguish
       "still running" from "already finished" at all. */
    if (existing.status_code == null) return inFlight(c);
    if (existing.request_hash !== requestHash) return keyReuse(c, existing.status_code);
    return new Response(
      BODYLESS_STATUS.has(existing.status_code) ? null : (existing.response_body ?? ""),
      {
        status: existing.status_code,
        headers: { "Content-Type": "application/json", "Idempotent-Replay": "true" },
      },
    );
  };

  try {
    const existing = await findExisting();
    if (existing) return respondToExisting(existing);

    await db
      .prepare(
        `INSERT INTO idempotency_keys
           (key, scope, user_id, tenant_scope, request_hash)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(key, scope, userId, tenant, requestHash)
      .run();
  } catch (error) {
    if (isUniqueViolation(error)) {
      try {
        const winner = await findExisting();
        // Phase-1 rollout deliberately retains the legacy global (key, scope)
        // primary key until every old Worker has drained. A collision owned by
        // another principal/tenant is blocked, never replayed. The follow-up
        // constraint migration will permit the same opaque key across owners.
        return winner ? respondToExisting(winner) : keyConflict(c);
      } catch (lookupError) {
        console.warn(
          `[idempotency] collision lookup failed: ${String((lookupError as Error)?.message ?? lookupError).slice(0, 120)}`,
        );
        // Another request won the unique race, so its business handler may
        // already be running or committed. Never claim that "nothing was sent".
        return outcomeUnknown(c);
      }
    }
    console.warn(
      `[idempotency] claim failed (write blocked): ${String((error as Error)?.message ?? error).slice(0, 120)}`,
    );
    return unavailable(c);
  }

  await markPhaseOneWorkerLive(db);

  try {
    await next();
  } catch (handlerError) {
    // A thrown handler can have completed one or more non-transactional writes
    // before failing. Retain the in-flight claim: allowing the same key to run
    // again could duplicate money, stock or a document number.
    console.warn(
      `[idempotency] handler threw; claim retained as outcome-unknown: ${String((handlerError as Error)?.message ?? handlerError).slice(0, 120)}`,
    );
    throw handlerError;
  }

  try {
    const response = c.res;
    if (response) {
      if (response.headers.get(IDEMPOTENCY_OUTCOME_HEADER) === NO_WRITE_OUTCOME) {
        await db
          .prepare(
            `DELETE FROM idempotency_keys
              WHERE user_id = ? AND tenant_scope = ? AND key = ? AND scope = ?
                AND request_hash = ?`,
          )
          .bind(userId, tenant, key, scope, requestHash)
          .run();
        return;
      }

      // Persist every terminal HTTP response, not only 2xx. Several legacy
      // mutations are not transactional yet; a 4xx/5xx may follow a partial
      // write. Only an explicit route-level no-write proof releases the claim;
      // otherwise replaying the same response is safer than executing again.
      const body = await response.clone().text();
      await db
        .prepare(
            `UPDATE idempotency_keys
              SET status_code = ?, response_body = ?
            WHERE user_id = ? AND tenant_scope = ? AND key = ? AND scope = ?
              AND request_hash = ?`,
        )
        .bind(response.status, body, userId, tenant, key, scope, requestHash)
        .run();
    }
  } catch (error) {
    // Do not fail open after the business handler ran. A retained in-flight
    // claim is safer than allowing a retry to duplicate an unknown write.
    console.warn(
      `[idempotency] response capture failed; claim retained: ${String((error as Error)?.message ?? error).slice(0, 120)}`,
    );
  }
};
