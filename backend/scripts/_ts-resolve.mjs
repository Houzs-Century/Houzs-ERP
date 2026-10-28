// ESM resolve hook: lets a plain .mjs script import the app's REAL TypeScript
// modules (Node 24 strips the types itself; it just won't resolve TS-style
// extensionless relative specifiers like `./permissions` -> `./permissions.ts`).
//
// WHY this exists: scripts/seed-user-management.mjs hand-copied hashPassword out
// of src/services/auth.ts. A copied hasher silently drifts from the real one and
// mints logins nobody can use. Importing the real module keeps one hasher.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export async function resolve(spec, ctx, next) {
  if (spec.startsWith(".") && !/\.(m?[tj]s|json)$/.test(spec)) {
    try {
      const base = new URL(spec, ctx.parentURL).href;
      for (const ext of [".ts", "/index.ts"]) {
        if (existsSync(fileURLToPath(base + ext))) return next(spec + ext, ctx);
      }
    } catch {
      // Unresolvable as a file URL -- fall through to Node's own resolver.
    }
  }
  return next(spec, ctx);
}
