import { eq, lt, sql } from "drizzle-orm";
import type { Env } from "../types";
import { getDb, type DB } from "../db/client";
import { job_runs } from "../db/schema";

/**
 * One tracker per scheduled() invocation. `track(name, run)` records the run in
 * public.job_runs and returns exactly what `run` returns or throws, so the
 * caller's own .then/.catch logging is unchanged.
 *
 * Recording must never break or delay a job: the start insert runs alongside
 * the job instead of before it, and every recording failure is logged and
 * swallowed.
 */
export function jobTracker(env: Env) {
  let db: DB | null = null;
  try {
    db = getDb(env);
  } catch (e) {
    console.error("[job-runs] no database, runs are not recorded", e);
  }

  return async function track<T>(job: string, run: () => Promise<T>): Promise<T> {
    if (!db) return run();
    const id = crypto.randomUUID();
    const started = Date.now();
    const inserted = db
      .insert(job_runs)
      .values({ id, job, started_at: new Date(started), status: "running" })
      .then(() => true, (e) => {
        console.error(`[job-runs] start ${job}`, e);
        return false;
      });
    const finish = async (status: "ok" | "error", error: string | null) => {
      if (!(await inserted)) return;
      try {
        await db!
          .update(job_runs)
          .set({ status, error, finished_at: new Date(), duration_ms: Date.now() - started })
          .where(eq(job_runs.id, id));
      } catch (e) {
        console.error(`[job-runs] finish ${job}`, e);
      }
    };
    try {
      const out = await run();
      await finish("ok", null);
      return out;
    } catch (e) {
      await finish("error", (e instanceof Error ? e.message : String(e)).slice(0, 2000));
      throw e;
    }
  };
}

/** Deletes runs older than 14 days. Returns the count removed. */
export async function purgeOldJobRuns(env: Env): Promise<number> {
  const r = await getDb(env)
    .delete(job_runs)
    .where(lt(job_runs.started_at, sql`now() - interval '14 days'`));
  return r.count;
}
