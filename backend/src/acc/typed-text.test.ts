/* Finance's typed words in UPPER CASE (owner 2026-11-09: 可以默认…自动大写吗？…主要是
   finance 模块). Pinned: a typed value upper-cased, null kept; a party's name keys case-
   blind, so a party typed "Ah Meng" before and "AH MENG" after is one party on the aging. */

import { describe, expect, test } from 'vitest';
import { partyNameKey, upperTyped } from './typed-text';
import { lineParty } from './aging-load';

describe('typed text', () => {
  test('a typed value in upper case; null stays null; Chinese is left as it is', () => {
    expect(upperTyped("Salary - Jun'26")).toBe("SALARY - JUN'26");
    expect(upperTyped('运输 transport')).toBe('运输 TRANSPORT');
    expect(upperTyped(null)).toBeNull();
  });

  test('a party name as a key: trimmed, upper case, blank as none', () => {
    expect(partyNameKey('  Ah Meng ')).toBe('AH MENG');
    expect(partyNameKey('')).toBeNull();
    expect(partyNameKey(null)).toBeNull();
  });

  test('the aging keys a party with no code by its name, case-blind; a code still wins', () => {
    const line = (party_code: string | null, party_name: string | null) => ({ party_code, party_name }) as Parameters<typeof lineParty>[0];
    expect(lineParty(line(null, 'Ah Meng')).key).toBe(lineParty(line(null, 'AH MENG')).key);
    expect(lineParty(line(null, 'Ah Meng')).name).toBe('Ah Meng');
    expect(lineParty(line('300-A001', 'Ah Meng')).key).toBe('300-A001');
  });
});
