import { describe, expect, test } from 'vitest';
import { pickDisplayCrew } from '../src/scm/lib/crew-display';

/* Regression: a Sales Order can carry several delivery orders and crew is a
   per-DO snapshot, so the driver the planner assigned lived on one DO. The board
   read crew from only the newest DO; when a later, blank DO joined the SO the
   driver "vanished" from the Driver column and had to be re-typed. pickDisplayCrew
   keeps it visible by falling back to the most-recent DO that still names a driver. */

type Crew = { driver_1_name: string | null; lorry_plate?: string | null };
const pick = (dos: string[], byDo: Record<string, Crew>) =>
  pickDisplayCrew(dos, (id) => byDo[id] ?? null, (c) => !!c.driver_1_name);

describe('pickDisplayCrew', () => {
  test('newest DO already names a driver → shows it (unchanged behaviour)', () => {
    const crew = pick(['do1', 'do2'], {
      do1: { driver_1_name: 'Ah Meng' },
      do2: { driver_1_name: 'Siva' },
    });
    expect(crew?.driver_1_name).toBe('Siva'); // do2 is newest (last by id)
  });

  test('newest DO is blank but an earlier DO has the driver → the driver stays visible', () => {
    // The vanish bug: a fresh DO (do2) joined the SO with no crew.
    const crew = pick(['do1', 'do2'], {
      do1: { driver_1_name: 'Ah Meng' },
      // do2 has no crew row at all
    });
    expect(crew?.driver_1_name).toBe('Ah Meng');
  });

  test('newest DO has a crew row without a driver → still falls back to the earlier driver', () => {
    const crew = pick(['do1', 'do2'], {
      do1: { driver_1_name: 'Ah Meng', lorry_plate: 'WXY 1' },
      do2: { driver_1_name: null, lorry_plate: 'WZZ 9' }, // lorry only, no driver
    });
    expect(crew?.driver_1_name).toBe('Ah Meng');
  });

  test('several earlier DOs name drivers → the most recent one wins', () => {
    const crew = pick(['do1', 'do2', 'do3'], {
      do1: { driver_1_name: 'Oldest' },
      do2: { driver_1_name: 'Middle' },
      // do3 blank
    });
    expect(crew?.driver_1_name).toBe('Middle');
  });

  test('no DO names a driver → the newest DO crew (lorry/helpers only), unchanged', () => {
    const crew = pick(['do1', 'do2'], {
      do1: { driver_1_name: null, lorry_plate: 'OLD 1' },
      do2: { driver_1_name: null, lorry_plate: 'NEW 2' },
    });
    expect(crew?.driver_1_name).toBeNull();
    expect(crew?.lorry_plate).toBe('NEW 2'); // coherent with the newest DO, not merged
  });

  test('newest DO has no crew row and no earlier driver → null', () => {
    expect(pick(['do1', 'do2'], { do1: { driver_1_name: null } })).toBeNull();
  });

  test('an order with no delivery order yet → null', () => {
    expect(pick([], {})).toBeNull();
  });
});
