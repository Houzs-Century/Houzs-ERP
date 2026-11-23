/* Project Overview keeps a copy of its answer (serveSwr family "projov": fresh
   for 5 minutes, kept up to 2 hours). A change made on a project - its Forecast,
   a cost line, its rental, its dates - must show on the overview at once (owner
   2026-11-19: 我里面edit过了 外面没有跟着换), so every successful write under the
   project routes drops the company's copies; the next read recomputes. */
import type { MiddlewareHandler } from 'hono';
import { activeCompanyId } from '../../scm/lib/companyScope';
import { bustSwrPrefix } from '../../scm/lib/kv-swr';

export const projectOverviewPrefix = (companyId: number): string => `swr:projov:v1:${companyId}:`;

/** True for a request that changed something and succeeded. */
export const isSuccessfulWrite = (method: string, status: number): boolean =>
  method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS' && status < 400;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mounted on several routers; only env, executionCtx and the company var are read
export const bustProjectOverviewOnWrite: MiddlewareHandler<any> = async (c, next) => {
  await next();
  if (!isSuccessfulWrite(c.req.method, c.res.status)) return;
  const companyId = activeCompanyId(c);
  if (companyId == null) return;
  const kv = (c.env as { SESSION_CACHE?: KVNamespace }).SESSION_CACHE;
  const job = bustSwrPrefix(kv, projectOverviewPrefix(companyId)).catch((e: unknown) => {
    console.error('project overview cache bust failed', e instanceof Error ? e.message : String(e));
  });
  try { c.executionCtx.waitUntil(job); } catch { await job; }
};
