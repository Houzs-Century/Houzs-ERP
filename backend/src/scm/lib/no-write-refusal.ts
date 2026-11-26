import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { clearIdempotencyNoWrite, markIdempotencyNoWrite } from '../../middleware/idempotency';
import type { MiddlewareHandler } from 'hono';

export function refuseWithoutWriting(
  c: Context,
  body: object,
  status: ContentfulStatusCode,
): Response {
  markIdempotencyNoWrite(c);
  return c.json(body as Record<string, unknown>, status);
}

export const noWriteUntilMarked: MiddlewareHandler = async (c, next) => {
  markIdempotencyNoWrite(c);
  await next();
};

export function writesFromHere(c: Context): void {
  clearIdempotencyNoWrite(c);
}
