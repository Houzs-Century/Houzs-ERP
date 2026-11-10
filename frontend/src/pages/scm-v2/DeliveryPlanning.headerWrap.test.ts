import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/* B36: the Send Message / New DP Order / Manage regions group is a single
   item inside PageHeader's wrapping action rail, so unless the group itself
   wraps, the rail's flex-wrap cannot help and the buttons run off a narrow
   desktop window. */
describe('Delivery Planning header buttons', () => {
  it('the primaryAction group wraps and is capped to the header width', () => {
    const src = readFileSync(join(__dirname, 'DeliveryPlanning.tsx'), 'utf8');
    const m = /primaryAction=\{[\s\S]*?<span style=\{\{([^}]*)\}\}>/.exec(src);
    expect(m).not.toBeNull();
    expect(m![1]).toMatch(/flexWrap:\s*'wrap'/);
    expect(m![1]).toMatch(/maxWidth:\s*'100%'/);
  });
});
