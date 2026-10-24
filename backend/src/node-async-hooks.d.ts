// The one Node built-in the Worker uses (lib/step-timing.ts). The runtime has
// it under the `nodejs_compat` flag in wrangler.toml; the project carries no
// @types/node, so only the surface step-timing calls is declared here.
declare module "node:async_hooks" {
  export class AsyncLocalStorage<T> {
    run<R>(store: T, fn: () => R): R;
    getStore(): T | undefined;
  }
}
