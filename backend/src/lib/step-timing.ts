// ---------------------------------------------------------------------------
// step-timing.ts — where a slow request spends its time, step by step.
// Ported from HOOKKA (src/api/lib/step-timing.ts, 2026-10-19).
//
// The access log has one number per request. That says a screen is slow, not
// WHICH read: after the 2026-10-22 batch (#4876) Inventory and Delivery
// Planning stayed at 6-8 s on prod and nothing said which of their reads took
// the time (HC-0002).
//
// `timed(name, fn)` records how long fn took under the current request;
// requestLog runs each request inside `withStepTiming` and adds the steps to a
// Server-Timing header as `s-<name>;dur=<total ms>;desc="<n>x"` (largest first,
// at most STEP_LIMIT). Outside a request — tests, cron — it just runs fn.
// Read-only: nothing a request returns changes.
// ---------------------------------------------------------------------------
import { AsyncLocalStorage } from "node:async_hooks";

export type StepMark = { name: string; ms: number };

const store = new AsyncLocalStorage<StepMark[]>();

/** Run a request's handler with a fresh list of step marks. */
export function withStepTiming<T>(marks: StepMark[], fn: () => Promise<T>): Promise<T> {
  return store.run(marks, fn);
}

/** Time one step of the current request (a plain call outside one). */
export async function timed<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const marks = store.getStore();
  if (!marks) return fn();
  const t0 = Date.now();
  try {
    return await fn();
  } finally {
    marks.push({ name, ms: Date.now() - t0 });
  }
}

/** Record a step measured elsewhere (a no-op outside a request). */
export function recordStep(name: string, ms: number): void {
  store.getStore()?.push({ name, ms });
}

/**
 * Laps for a long handler whose reads are started in many places: each
 * `lap(name)` records the time since the previous lap (or since stepClock was
 * called) as a step. One line after an await, no change to the await itself.
 */
export function stepClock(): (name: string) => void {
  let last = Date.now();
  return (name) => {
    const now = Date.now();
    store.getStore()?.push({ name, ms: now - last });
    last = now;
  };
}

/**
 * stepClock that also LOGS each lap as it happens, with the database steps
 * (`dbStep`, e.g. "db-pg") recorded since the previous lap. A request the
 * browser gave up on never sends its Server-Timing header, and the access-log
 * line is written only once the handler returns — so for a write that times out
 * (HC-0167: approve-so past 30 s at the evening peak) these lines are the only
 * record of where the time went.
 */
export function loggedStepClock(tag: string, dbStep: string): (name: string) => void {
  const start = Date.now();
  let last = start;
  let seen = 0;
  return (name) => {
    const now = Date.now();
    const marks = store.getStore();
    let dbN = 0;
    let dbMs = 0;
    if (marks) {
      marks.push({ name, ms: now - last });
      for (const m of marks.slice(seen)) {
        if (m.name === dbStep) { dbN += 1; dbMs += m.ms; }
      }
      seen = marks.length;
    }
    console.log(`[${tag}] ${name} ${now - last}ms total=${now - start}ms ${dbStep}=${dbN}x/${dbMs}ms`);
    last = now;
  };
}

export const STEP_LIMIT = 12;

/**
 * The request's steps as Server-Timing entries: one per step name (its time
 * added up, how many times it ran), the slowest first. Names are reduced to
 * the token characters the header allows.
 */
export function stepTimingEntries(marks: readonly StepMark[], limit = STEP_LIMIT): string[] {
  const by = new Map<string, { ms: number; n: number }>();
  for (const m of marks) {
    const key = `s-${m.name.replace(/[^A-Za-z0-9_-]/g, "_")}`;
    const cur = by.get(key) ?? { ms: 0, n: 0 };
    cur.ms += m.ms;
    cur.n += 1;
    by.set(key, cur);
  }
  return [...by.entries()]
    .sort((a, b) => b[1].ms - a[1].ms)
    .slice(0, limit)
    .map(([key, v]) => `${key};dur=${v.ms};desc="${v.n}x"`);
}
