/* Owner 2026-09-18: on a Sales Order, a solo roadshow's mall management /
 * organizer name is for BD, the Owner and weisiang only — "others only show
 * solo". An exhibition keeps its organizer for everybody.
 *
 * The names below are the SHAPES found on the live database that day, not
 * invented ones: a solo name with an organizer column, a solo name whose
 * organizer column is empty while the slot is still filled, an old solo code
 * that carries the organizer slug, and the one name that fits no shape.
 */
import { describe, expect, test } from "vitest";

import {
  isSoloEvent,
  maskSoloOrganizer,
  salesOrderProjectLabel,
  salesOrderProjectName,
} from "./soloOrganizerMask";

const solo = {
  code: "2026-10-SOLO-JOHOR-SUNWAY-KLUANG-MALL-AKEMI",
  name: "JOHOR [AKEMI] KAI HAO (KL, CHEN) @ SUNWAY KLUANG MALL",
  organizer: "KAI HAO (KL, CHEN)",
  venue: "SUNWAY KLUANG MALL",
  event_type_name: "Solo",
};
const exhibition = {
  code: "2026-09-REX-KL-MID-VALLEY-AKEMI",
  name: "Kuala Lumpur [AKEMI] REX @ MID VALLEY",
  organizer: "REX",
  venue: "MID VALLEY",
  event_type_name: "Exhibition",
};

describe("isSoloEvent", () => {
  test("reads the slug first, the name as the fallback, and nothing else as solo", () => {
    expect(isSoloEvent({ event_type_slug: "solo" })).toBe(true);
    expect(isSoloEvent({ event_type_name: "Solo" })).toBe(true);
    expect(isSoloEvent({ event_type_name: "Solo Roadshow" })).toBe(true);
    expect(isSoloEvent({ event_type_name: "Exhibition" })).toBe(false);
    expect(isSoloEvent({})).toBe(false);
  });
});

describe("salesOrderProjectLabel", () => {
  test("a solo roadshow shows SOLO in the organizer slot, and drops the code", () => {
    expect(salesOrderProjectLabel(solo, false)).toBe("JOHOR [AKEMI] SOLO @ SUNWAY KLUANG MALL");
  });

  test("BD / Owner / weisiang still read the organizer and the code", () => {
    expect(salesOrderProjectLabel(solo, true)).toBe(`${solo.code} · ${solo.name}`);
  });

  test("an exhibition keeps its organizer for everybody", () => {
    const full = `${exhibition.code} · ${exhibition.name}`;
    expect(salesOrderProjectLabel(exhibition, false)).toBe(full);
    expect(salesOrderProjectLabel(exhibition, true)).toBe(full);
  });

  test("the masked label carries no trace of the organizer — not in the code either", () => {
    const old = { ...solo, code: "2026-03-IOI-MGMT-SELANGOR-IOI-MALL-AKEMI", name: "SELANGOR [AKEMI] IOI MGMT @ IOI MALL", organizer: "IOI MGMT", venue: "IOI MALL" };
    const label = salesOrderProjectLabel(old, false);
    expect(label).toBe("SELANGOR [AKEMI] SOLO @ IOI MALL");
    expect(label).not.toMatch(/MGMT/i);
  });
});

describe("maskSoloOrganizer", () => {
  test("masks the slot even when the organizer COLUMN is empty (192 of 284 live solo rows)", () => {
    expect(maskSoloOrganizer({ name: "PERAK [ZANOTTI] AEON MALL MGT @ AEON IPOH", organizer: null }))
      .toBe("PERAK [ZANOTTI] SOLO @ AEON IPOH");
  });

  test("a name already reading SOLO is unchanged", () => {
    expect(maskSoloOrganizer({ name: "SELANGOR [AKEMI] SOLO @ IOI MALL" })).toBe("SELANGOR [AKEMI] SOLO @ IOI MALL");
  });

  test("no brand bracket: falls back to replacing the organizer string", () => {
    expect(maskSoloOrganizer({ name: "KAI HAO roadshow Kluang", organizer: "Kai Hao" })).toBe("SOLO roadshow Kluang");
  });

  test("a name of no known shape is REPLACED, never passed through", () => {
    expect(maskSoloOrganizer({ name: "Sunway Mgmt Kluang", organizer: null, venue: "SUNWAY KLUANG MALL" })).toBe("SOLO @ SUNWAY KLUANG MALL");
    expect(maskSoloOrganizer({ name: "Sunway Mgmt Kluang" })).toBe("SOLO");
  });
});

describe("salesOrderProjectName", () => {
  test("the picker's option text follows the same rule", () => {
    expect(salesOrderProjectName(solo, false)).toBe("JOHOR [AKEMI] SOLO @ SUNWAY KLUANG MALL");
    expect(salesOrderProjectName(solo, true)).toBe(solo.name);
    expect(salesOrderProjectName(exhibition, false)).toBe(exhibition.name);
  });
});
