// The vendored shared kit's bare names, for vitest (which reads neither
// tsconfig "paths" nor wrangler [alias]). Same map as wrangler.toml [alias] and
// tsconfig.json "paths"; the exact-match regexes keep "@2990s/shared" from
// swallowing its subpaths.
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const fe = (p) => path.resolve(here, "../../../shared/src", p);

export const PDF_SHARED_ALIASES = [
  { find: /^@2990s\/shared\/phone$/, replacement: fe("vendor/shared/phone.ts") },
  { find: /^@2990s\/shared\/mfg-pricing$/, replacement: fe("vendor/shared/mfg-pricing.ts") },
  { find: /^@2990s\/shared\/so-variant-rule$/, replacement: fe("vendor/shared/so-variant-rule.ts") },
  { find: /^@2990s\/shared\/so-line-display$/, replacement: fe("vendor/shared/so-line-display.ts") },
  { find: /^@2990s\/shared$/, replacement: fe("vendor/shared/index.ts") },
];

/* Every file the Worker bundles through src/lib/shared-pdf.ts lives under
   these (the root shared/ module, bundled by the frontend too). ci.yml
   (changes) runs both halves for them and deploy.yml lists them in both
   filters, so a change to the shared layout tests and redeploys both apps.
   tests/pdfSharedBoundary.test.ts holds the graph and the workflows to this
   list. Directory entries end in "/". */
export const PDF_SHARED_FRONTEND_PATHS = [
  "shared/",
];
