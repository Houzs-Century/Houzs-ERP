import { describe, it, expect } from 'vitest';
import { canTeachAgents, canUseAssistant } from './assistant-scope';

// Owner decision 2026-07-26: teaching agents is open to every staff member who may
// use the Assistant. canTeachAgents is the SEAM to narrow that later; these tests
// pin v1 (= canUseAssistant) so a future narrowing is a deliberate, visible change.

const wildcard = { permissions: ['*'] };
const opsManager = { permissions: [], position_name: 'Operation Manager' }; // known ops position
const driver = { permissions: [], position_name: 'Driver' }; // denied (field crew)
const salesExec = { permissions: [], position_name: 'Sales Executive' }; // denied (sales)
const unknownTitle = { permissions: [], position_name: 'Vibes Officer' }; // fail closed
const noPosition = { permissions: [], position_name: '' };

describe('canTeachAgents (v1 = every Assistant user)', () => {
  it('lets the owner and ordinary operations staff teach', () => {
    expect(canTeachAgents(wildcard)).toBe(true);
    expect(canTeachAgents(opsManager)).toBe(true);
    expect(canTeachAgents(noPosition)).toBe(true);
  });

  it('does not let field crew, Sales, or an unrecognised position teach', () => {
    expect(canTeachAgents(driver)).toBe(false);
    expect(canTeachAgents(salesExec)).toBe(false);
    expect(canTeachAgents(unknownTitle)).toBe(false); // fail closed on unknown
  });

  it('tracks canUseAssistant exactly (the seam is a pure alias in v1)', () => {
    for (const u of [wildcard, opsManager, driver, salesExec, unknownTitle, noPosition]) {
      expect(canTeachAgents(u)).toBe(canUseAssistant(u));
    }
  });
});
