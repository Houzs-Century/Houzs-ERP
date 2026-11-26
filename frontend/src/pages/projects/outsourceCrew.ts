import type { CrewMember } from "./logisticsParts";

export type FleetDriverRow = { id: string; name: string | null; phone: string | null; in_house: boolean | null };
export type FleetHelperRow = { id: string; name: string | null; contact: string | null; in_house: boolean | null };

export type CrewKind = "driver" | "helper";

export function driverToCrew(d: FleetDriverRow): CrewMember {
  return { id: `drv:${d.id}`, name: (d.name ?? "").trim(), phone: d.phone ?? null, user_type: "driver", role_name: "Driver" };
}

export function helperToCrew(h: FleetHelperRow): CrewMember {
  return { id: `hlp:${h.id}`, name: (h.name ?? "").trim(), phone: h.contact ?? null, user_type: "helper", role_name: "Helper" };
}

export function outsourceOnly<T extends { in_house: boolean | null }>(rows: T[]): T[] {
  return rows.filter((r) => r.in_house === false);
}

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

export function validateOutsourceCrew(kind: CrewKind, name: string, phone: string): string | null {
  if (!name.trim()) return "Enter a name.";
  if (kind === "driver" && !phone.trim()) return "A driver needs a phone number.";
  return null;
}
