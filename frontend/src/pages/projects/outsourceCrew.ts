// Outsource crew for the Project "Setup & Dismantle — crew per lorry" pickers.
//
// The Driver / Helper dropdowns there list in-house staff from /api/fleet/staff
// (the users master). An OUTSOURCE driver/helper that is not a member of staff
// belongs in the Fleet roster (SCM > Maintenance > Fleet: scm.drivers /
// scm.helpers, flagged in_house = false), per externalPosition.ts. These helpers
// (1) fold the outsource Fleet roster into the pickers' options and (2) shape a
// manually-typed name for POST /api/scm/drivers | /api/scm/helpers so it lands
// in that roster and is reusable next time.
//
// Pure only — the api calls live in the component. Tested in outsourceCrew.test.ts.
import type { CrewMember } from "./logisticsParts";

// The subset of GET /api/scm/drivers | /api/scm/helpers rows the pickers read.
export type FleetDriverRow = { id: string; name: string | null; phone: string | null; in_house: boolean | null };
export type FleetHelperRow = { id: string; name: string | null; contact: string | null; in_house: boolean | null };

export type CrewKind = "driver" | "helper";

// A Fleet driver as a picker option. The id is prefixed so a Fleet uuid never
// collides with a numeric users id, and so the row's source stays recognisable.
export function driverToCrew(d: FleetDriverRow): CrewMember {
  return { id: `drv:${d.id}`, name: (d.name ?? "").trim(), phone: d.phone ?? null, user_type: "driver", role_name: "Driver" };
}

// A Fleet helper as a picker option. Helpers keep the phone in `contact`.
export function helperToCrew(h: FleetHelperRow): CrewMember {
  return { id: `hlp:${h.id}`, name: (h.name ?? "").trim(), phone: h.contact ?? null, user_type: "helper", role_name: "Helper" };
}

// Keep only outsourced rows (in_house === false). In-house Fleet crew already
// come from /api/fleet/staff, so re-adding them here would double every name; a
// null flag is the historical in-house default and is dropped too.
export function outsourceOnly<T extends { in_house: boolean | null }>(rows: T[]): T[] {
  return rows.filter((r) => r.in_house === false);
}

// Append `extra` to `base`, skipping blank names and any name already present
// (case-insensitive). In-house staff keep their order; outsource crew follow.
export function mergeCrewOptions(base: CrewMember[], extra: CrewMember[]): CrewMember[] {
  const seen = new Set(base.map((m) => m.name.trim().toLowerCase()).filter(Boolean));
  const out = [...base];
  for (const m of extra) {
    const key = m.name.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(m);
  }
  return out;
}

// Validate a manually-typed outsource member before creating it in the Fleet
// roster. A driver REQUIRES a phone (POST /api/scm/drivers rejects a blank one);
// a helper's contact is optional. Returns a message to show, or null when good.
export function validateOutsourceCrew(kind: CrewKind, name: string, phone: string): string | null {
  if (!name.trim()) return "Enter a name.";
  if (kind === "driver" && !phone.trim()) return "A driver needs a phone number.";
  return null;
}
