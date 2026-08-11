import { describe, expect, test } from 'vitest';
// @ts-expect-error - plain .mjs, shared by the cutover importers and sweeps
import { buildFabricColourIndex } from '../scripts/lib/fabric-colour-match.mjs';

/* HC-PO-000162 carries "[DAYBED/COL:J9833-2]". The fabric library holds no
 * J9833 series at all — it holds J9883, and the same supplier's own documents
 * spell it correctly elsewhere (PO-000254: "COL: J9883-1-1 PAMA"). So J9833-2
 * is a transposition of J9883-2 CHIC, and the fix is an alias onto the row that
 * exists rather than a new fabric minted for a typo.
 *
 * The matcher cannot do this unaided by design: its digit guard refuses to
 * treat a different digit RUN as the same colour, because that is how a real
 * BO315-2 becomes a wrong BO315-21. The alias table is the place where a
 * human-evidenced exception is allowed to live. */

const LIBRARY = [
  { fabric_id: 'J9883', colour_id: 'J9883-1-1', label: 'J9883-1-1 PAMA' },
  { fabric_id: 'J9883', colour_id: 'J9883-2', label: 'J9883-2 CHIC' },
  { fabric_id: 'BO315', colour_id: 'BO315-2', label: 'BO315-2 FEATHER' },
  { fabric_id: 'BO315', colour_id: 'BO315-21', label: 'BO315-21' },
];

describe('J9833-2 resolves to the J9883-2 row rather than minting a fabric', () => {
  const { findColour } = buildFabricColourIndex(LIBRARY) as {
    findColour: (s: string) => { fabric_id: string; colour_id: string } | null;
  };

  test('the misspelling from PO-000162 resolves', () => {
    expect(findColour('J9833-2')).toMatchObject({ fabric_id: 'J9883', colour_id: 'J9883-2' });
  });

  test('the correct spelling still resolves to the same row', () => {
    expect(findColour('J9883-2')).toMatchObject({ fabric_id: 'J9883', colour_id: 'J9883-2' });
  });

  test('the alias does not loosen the digit guard for anything else', () => {
    // BO315-2 and BO315-21 are two REAL colours one digit apart. An alias that
    // relaxed the guard generally would collapse them, which is the exact
    // failure the guard exists to prevent.
    expect(findColour('BO315-2')).toMatchObject({ colour_id: 'BO315-2' });
    expect(findColour('BO315-21')).toMatchObject({ colour_id: 'BO315-21' });
  });

  test('an alias whose target is absent from the library is dropped, not invented', () => {
    const only = buildFabricColourIndex([LIBRARY[2]]) as { findColour: (s: string) => unknown };
    expect(only.findColour('J9833-2')).toBeNull();
  });
});
