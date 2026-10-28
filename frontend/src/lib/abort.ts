/** Combine a caller-owned cancellation signal with an internal deadline. */
export function combineAbortSignals(
  callerSignal: AbortSignal | null | undefined,
  deadlineSignal: AbortSignal | null | undefined,
): AbortSignal | undefined {
  if (!callerSignal) return deadlineSignal ?? undefined;
  if (!deadlineSignal) return callerSignal;
  try {
    return AbortSignal.any([callerSignal, deadlineSignal]);
  } catch {
    const controller = new AbortController();
    const abort = (signal: AbortSignal) => {
      if (!controller.signal.aborted) controller.abort(signal.reason);
    };
    if (callerSignal.aborted) abort(callerSignal);
    else callerSignal.addEventListener("abort", () => abort(callerSignal), { once: true });
    if (deadlineSignal.aborted) abort(deadlineSignal);
    else deadlineSignal.addEventListener("abort", () => abort(deadlineSignal), { once: true });
    return controller.signal;
  }
}

export function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Aborted", "AbortError");
}

/** A retry backoff that ends immediately when its request is superseded. */
export function abortableDelay(ms: number, signal?: AbortSignal | null): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(abortReason(signal!));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
