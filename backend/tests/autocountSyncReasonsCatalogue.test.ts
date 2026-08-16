// docs/autocount-sync-reasons.md is the AutoCount Sync page's DICTIONARY, and a
// dictionary with a missing word is worse than no dictionary: the UI looks a
// code up, finds nothing, and shows the owner a bare hyphenated key on a screen
// whose whole requirement is that no code jargon appears on it.
//
// So the file is pinned against the code that produces the codes. Both
// directions are checked, because they fail differently:
//
//   code -> doc   a reason the system can produce that nobody documented. The
//                 UI has no sentence for it and the operator has no remedy.
//   doc -> code   a reason the doc still describes after the code stopped
//                 producing it. Harmless on screen, and exactly how a document
//                 comes to describe a system that no longer exists — which is
//                 the failure CLAUDE.md's whole docs layer is built around.
//
// It lives in tests/ rather than beside the module because it reads a file, and
// backend/tsconfig.json types src/ with @cloudflare/workers-types only — there
// is no `node:fs` in there, by design. tests/ is outside `include`.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { AC_REQUEUE_MEANING } from '../src/scm/lib/autocount-requeue';
import { AC_SKIP_KINDS, AC_SKIP_UNRECOGNISED } from '../src/scm/lib/autocount-outbox-status';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CATALOGUE = path.join(repoRoot, 'docs/autocount-sync-reasons.md');
const doc = readFileSync(CATALOGUE, 'utf8');

/** Every `backticked` token in the file, which is how it names a code. */
const ticked = new Set([...doc.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]));

describe('the reason catalogue documents every code the system can produce', () => {
  it('every re-queue outcome has a row', () => {
    for (const code of Object.keys(AC_REQUEUE_MEANING)) {
      expect(ticked.has(code), `${code} is not in ${path.basename(CATALOGUE)}`).toBe(true);
    }
  });

  it('every skip kind has a row', () => {
    for (const { kind } of AC_SKIP_KINDS) {
      expect(ticked.has(kind), `${kind} is not in ${path.basename(CATALOGUE)}`).toBe(true);
    }
  });

  it('the catch-all kind is documented too, as a finding rather than a category', () => {
    expect(ticked.has(AC_SKIP_UNRECOGNISED)).toBe(true);
  });

  it('the catalogue describes no re-queue outcome the code cannot return', () => {
    /* Scoped to the outcome table's own column, so an ordinary hyphenated word
       elsewhere in the prose is not mistaken for a code. Every outcome row
       begins `| \`code\` | yes|no |`. */
    const rows = [...doc.matchAll(/^\| `([a-z-]+)` \| (?:\*\*yes\*\*|no) \|/gm)].map((m) => m[1]);
    expect(rows.length, 'the outcome table was not found — has its shape changed?')
      .toBeGreaterThan(5);
    for (const code of rows) {
      expect(AC_REQUEUE_MEANING, `${code} is documented but no longer exists`).toHaveProperty(code);
    }
  });

  it('the two live examples the owner asked about are both in it', () => {
    /* Named rather than counted: these are the two the page must get right, and
       a catalogue that quietly lost either one would still pass every check
       above. */
    expect(doc).toContain('Invalid transfer item.');
    expect(doc).toContain('no-source-document');
  });

  it('does NOT tell anyone to simply retry the transfer-item failure', () => {
    /* That row has already spent all six attempts. The remedy is to rebuild and
       redeploy the AutoCount service first — a re-send before that produces the
       same exception, faster. */
    const section = doc.slice(doc.indexOf('### `Invalid transfer item.`'));
    expect(section).toContain('rebuild');
    expect(section).toContain('autocount-service-deploy.md');
  });
});
