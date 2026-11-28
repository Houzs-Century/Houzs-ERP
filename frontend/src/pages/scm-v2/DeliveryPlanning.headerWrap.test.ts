import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Delivery Planning header buttons', () => {
  it('the primaryAction group wraps and is capped to the header width', () => {
    const src = readFileSync(join(__dirname, 'DeliveryPlanning.tsx'), 'utf8');
    const m = /primaryAction=\{[\s\S]*?<span style=\{\{([^}]*)\}\}>/.exec(src);
    expect(m).not.toBeNull();
    expect(m![1]).toMatch(/flexWrap:\s*'wrap'/);
    expect(m![1]).toMatch(/maxWidth:\s*'100%'/);
  });
});
