// The vendored shared kit's bare names, for vitest (which reads neither
// tsconfig "paths" nor wrangler [alias]). Same map as wrangler.toml [alias] and
// tsconfig.json "paths"; the exact-match regexes keep "@2990s/shared" from
// swallowing its subpaths.
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const fe = (p) => path.resolve(here, "../../../frontend/src", p);

export const PDF_SHARED_ALIASES = [
  { find: /^@2990s\/shared\/phone$/, replacement: fe("vendor/shared/phone.ts") },
  { find: /^@2990s\/shared\/mfg-pricing$/, replacement: fe("vendor/shared/mfg-pricing.ts") },
  { find: /^@2990s\/shared\/payment-methods$/, replacement: fe("vendor/scm/lib/payment-methods.ts") },
  { find: /^@2990s\/shared\/so-variant-rule$/, replacement: fe("vendor/shared/so-variant-rule.ts") },
  { find: /^@2990s\/shared\/so-line-display$/, replacement: fe("vendor/shared/so-line-display.ts") },
  { find: /^@2990s\/shared$/, replacement: fe("vendor/shared/index.ts") },
];

/* Every frontend file the Worker bundles through src/lib/shared-pdf.ts lives
   under one of these. .github/workflows/ci.yml (changes) and deploy.yml (the
   backend filter) list the same paths, so a change to the shared layout code
   tests and redeploys the Worker too. tests/pdfSharedBoundary.test.ts holds all
   three to this list. Directory entries end in "/". */
export const PDF_SHARED_FRONTEND_PATHS = [
  "frontend/src/vendor/scm/lib/",
  "frontend/src/vendor/shared/",
  "frontend/src/lib/branding-text.ts",
  "frontend/src/lib/customer-ref.ts",
  "frontend/src/lib/thumb-key.ts",
];
