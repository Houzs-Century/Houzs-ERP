import { Hono, type Context } from "hono";
import type { Env } from "../types";


export const BADGE_COUNT_PATHS = {
  "amendment-approvals": "/api/scm/so-amendments/pending-count",
  "po-amendment-approvals": "/api/scm/po-amendments/pending-count",
  "payment-backdate-approvals": "/api/scm/payment-backdate-requests/pending-count",
  "payment-requests-waiting": "/api/scm/payment-requests/waiting-count",
  "it-support-replies": "/api/it-support/unread-count",
  "fair-links-to-settle": "/api/scm/mfg-sales-orders/fair-pending/count",
  "product-request-approvals": "/api/scm/product-requests/pending-count",
  "stock-take-approvals": "/api/scm/stock-takes/pending-count",
  "finance-todo": "/api/scm/accounting/todo/count",
  "mail-waiting": "/api/mail-center/waiting-count",
  "meetings-unread": "/api/meetings/unread-count",
} as const;

export type BadgeSource = keyof typeof BADGE_COUNT_PATHS;

/** Runs one internal GET through the whole app. */
export type BadgeDispatch = (c: Context<{ Bindings: Env }>, req: Request) => Promise<Response>;

function isBadgeSource(s: string): s is BadgeSource {
  return Object.prototype.hasOwnProperty.call(BADGE_COUNT_PATHS, s);
}

/** Known names only, de-duplicated, in the order asked. */
export function parseBadgeSources(raw: string | undefined): BadgeSource[] {
  const out: BadgeSource[] = [];
  for (const part of (raw ?? "").split(",")) {
    const s = part.trim();
    if (isBadgeSource(s) && !out.includes(s)) out.push(s);
  }
  return out;
}

const NOT_FORWARDED = new Set([
  "if-none-match",
  "if-modified-since",
  "idempotency-key",
  "content-length",
  "content-type",
]);

export function forwardedHeaders(from: Headers): Headers {
  const out = new Headers();
  from.forEach((value, key) => {
    if (!NOT_FORWARDED.has(key.toLowerCase())) out.set(key, value);
  });
  return out;
}

/** A 200 `{ count: n }` -> n; anything else -> null (no badge). */
export async function readBadgeCount(res: Response): Promise<number | null> {
  if (res.status !== 200) return null;
  try {
    const body = (await res.json()) as { count?: unknown };
    const n = Number(body?.count);
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

export function badgeCountsHandler(dispatch: BadgeDispatch) {
  return async (c: Context<{ Bindings: Env }>) => {
    const sources = parseBadgeSources(c.req.query("sources"));
    const headers = forwardedHeaders(c.req.raw.headers);
    const origin = new URL(c.req.url).origin;
    const pairs = await Promise.all(
      sources.map(async (source): Promise<[BadgeSource, number | null]> => {
        try {
          const res = await dispatch(
            c,
            new Request(`${origin}${BADGE_COUNT_PATHS[source]}`, { method: "GET", headers }),
          );
          return [source, await readBadgeCount(res)];
        } catch {
          return [source, null];
        }
      }),
    );
    c.header("Cache-Control", "private, no-store");
    return c.json({ counts: Object.fromEntries(pairs) as Partial<Record<BadgeSource, number | null>> });
  };
}

/** A router over any dispatcher (tests pass a fake one). */
export function badgeCountsRouter(dispatch: BadgeDispatch) {
  const router = new Hono<{ Bindings: Env }>();
  router.get("/", badgeCountsHandler(dispatch));
  return router;
}

let appDispatch: BadgeDispatch | null = null;
export function setBadgeDispatch(dispatch: BadgeDispatch): void {
  appDispatch = dispatch;
}
const badgeCounts = new Hono<{ Bindings: Env }>();
badgeCounts.get(
  "/",
  badgeCountsHandler((c, req) => {
    if (!appDispatch) return Promise.reject(new Error("badge dispatch not wired"));
    return appDispatch(c, req);
  }),
);
export default badgeCounts;
