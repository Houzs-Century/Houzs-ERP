// Work to do just before the operator presses a Refresh button that reloads the
// tab (NewVersionBanner). A registry rather than an import so the banner, which
// is on the always-loaded path, does not pull in the modules that register here:
// chunkActionRecovery.ts arrives with the print code and adds its hook then.
// Measured 2026-09-14: importing that module from the banner and main.tsx put
// +0.9 KB gzip on the initial bundle (168.1 -> 169.0 KB, the ceiling).

const hooks = new Set<() => void>();

export function onBeforeManualReload(hook: () => void): () => void {
  hooks.add(hook);
  return () => {
    hooks.delete(hook);
  };
}

/** Never throws: a hook that fails must not stop the reload it runs before. */
export function runBeforeManualReload(): void {
  for (const hook of [...hooks]) {
    try {
      hook();
    } catch {
      // The reload is what the operator asked for; it still happens.
    }
  }
}
