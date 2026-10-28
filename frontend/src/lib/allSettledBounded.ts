/** Run promise factories with a fixed concurrency ceiling, preserving order. */
export async function allSettledBounded<T>(
  tasks: readonly (() => Promise<T>)[],
  concurrency = 6,
): Promise<PromiseSettledResult<T>[]> {
  if (tasks.length === 0) return [];

  const workerCount = Math.min(
    tasks.length,
    Number.isFinite(concurrency) ? Math.max(1, Math.floor(concurrency)) : 1,
  );
  const results = new Array<PromiseSettledResult<T>>(tasks.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < tasks.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = { status: "fulfilled", value: await tasks[index]() };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}
