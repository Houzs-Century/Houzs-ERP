// Coverage & Fleet, drivers and helpers (owner 2026-11-07): the pure rules behind the crew
// list and drawer. A driver and a helper are one shape here; the screen only renders.
//
// The edit patch carries only what changed. inHouse in particular stays out unless the
// employer actually moved, so renaming a 3PL-linked driver never trips the backend's
// linked-to-carrier 409 (scm/lib/threepl-link.ts resolveCarrierLink).
import { fmtDate } from "../../../vendor/shared/format";
import type { DriverRow } from "../../../vendor/scm/lib/drivers-queries";
import type { HelperRow } from "../../../vendor/scm/lib/helpers-queries";
import type { DriverLeaveRow } from "../../../vendor/scm/lib/delivery-zones-queries";
import type { LorryRow } from "../../../vendor/scm/lib/lorries-queries";

export type CrewKind = "driver" | "helper";

export type CrewPerson = {
  id: string; code: string; name: string; phone: string; ic: string; vehicle: string;
  inHouse: boolean; carrierId: string | null; warehouseId: string | null; active: boolean;
};

export const driverAsCrew = (d: DriverRow): CrewPerson => ({
  id: d.id, code: d.driver_code, name: d.name, phone: d.phone, ic: d.ic_number ?? "", vehicle: d.vehicle ?? "",
  inHouse: (d.inHouse ?? d.in_house) !== false, carrierId: d.threepl_company_id ?? null, warehouseId: d.warehouse_id ?? null, active: d.active,
});

export const helperAsCrew = (h: HelperRow): CrewPerson => ({
  id: h.id, code: h.helper_code, name: h.name, phone: h.contact ?? "", ic: h.ic_number ?? "", vehicle: "",
  inHouse: (h.inHouse ?? h.in_house) !== false, carrierId: h.threepl_company_id ?? null, warehouseId: h.warehouse_id ?? null, active: h.active,
});

/** Who employs them, as the one select shows it: in-house, outsource with no company, or a 3PL company id. */
export type Employer = "in" | "out" | string;
export const employerOf = (p: Pick<CrewPerson, "inHouse" | "carrierId">): Employer => p.carrierId ?? (p.inHouse ? "in" : "out");

export function employerLabel(p: Pick<CrewPerson, "inHouse" | "carrierId">, carrierName: (id: string) => string | null): string {
  if (p.carrierId) return `Outsource · ${carrierName(p.carrierId) ?? "3PL company"}`;
  return p.inHouse ? "In-house" : "Outsource";
}

export type CrewForm = { name: string; phone: string; ic: string; vehicle: string; employer: Employer; warehouseId: string };

export const crewFormOf = (p: CrewPerson | null): CrewForm => p
  ? { name: p.name, phone: p.phone, ic: p.ic, vehicle: p.vehicle, employer: employerOf(p), warehouseId: p.warehouseId ?? "" }
  : { name: "", phone: "", ic: "", vehicle: "", employer: "in", warehouseId: "" };

export type CrewPatch = {
  name?: string; phone?: string; contact?: string; icNumber?: string; vehicle?: string;
  inHouse?: boolean; threeplCompanyId?: string | null; warehouseId?: string | null;
};

/** The employer part of a write: attaching a company forces outsource server-side;
 *  leaving a company sends an explicit detach plus the flag picked. */
function employerPatch(before: Employer | null, next: Employer): Pick<CrewPatch, "inHouse" | "threeplCompanyId"> {
  if (before === next) return {};
  if (next !== "in" && next !== "out") return { threeplCompanyId: next };
  if (before !== null && before !== "in" && before !== "out") return { threeplCompanyId: null, inHouse: next === "in" };
  return { inHouse: next === "in" };
}

/** What a save sends: only the fields that changed (a new person: every field filled in). */
export function crewPatch(kind: CrewKind, before: CrewPerson | null, f: CrewForm): CrewPatch {
  const b = crewFormOf(before);
  const out: CrewPatch = {};
  const name = f.name.trim(), phone = f.phone.trim(), ic = f.ic.trim(), vehicle = f.vehicle.trim();
  if (!before || name !== b.name) out.name = name;
  if (!before ? phone !== "" : phone !== b.phone) out[kind === "driver" ? "phone" : "contact"] = phone;
  if (!before ? ic !== "" : ic !== b.ic) out.icNumber = ic;
  if (kind === "driver" && (!before ? vehicle !== "" : vehicle !== b.vehicle)) out.vehicle = vehicle;
  if (!before || f.warehouseId !== b.warehouseId) out.warehouseId = f.warehouseId || null;
  return { ...out, ...(before ? employerPatch(employerOf(before), f.employer) : employerPatch(null, f.employer)) };
}

/** The first thing wrong with the form, or null. A driver needs a phone, a helper does not. */
export function crewFormProblem(kind: CrewKind, f: CrewForm): string | null {
  if (!f.name.trim()) return "Enter the name.";
  if (kind === "driver" && !f.phone.trim()) return "Enter the phone number.";
  return null;
}

export const initials = (name: string): string =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";

/** The lorries this person usually crews, from the lorry master. */
export const lorriesOf = (lorries: readonly LorryRow[], kind: CrewKind, id: string): LorryRow[] =>
  lorries.filter((l) => (kind === "driver" ? l.usual_driver_id : l.usual_helper_id) === id);

/** A search hit on name, code, phone, IC, vehicle, warehouse or a lorry plate. */
export function crewMatches(p: CrewPerson, q: string, extra: readonly string[]): boolean {
  const s = q.trim().toLowerCase();
  return !s || [p.name, p.code, p.phone, p.ic, p.vehicle, ...extra].join(" ").toLowerCase().includes(s);
}

export type LeaveState = "past" | "now" | "upcoming";
export const leaveState = (start: string, end: string, today: string): LeaveState =>
  end < today ? "past" : start <= today ? "now" : "upcoming";

export const leaveDays = (start: string, end: string): number =>
  Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1;

export const leaveRange = (start: string, end: string): string =>
  start === end ? fmtDate(start) : `${fmtDate(start)} to ${fmtDate(end)}`;

/** This person's leave rows, newest first. */
export const leaveOf = (rows: readonly DriverLeaveRow[], kind: CrewKind, id: string): DriverLeaveRow[] =>
  rows.filter((r) => (kind === "driver" ? r.driverId : r.helperId) === id).sort((a, b) => b.startDate.localeCompare(a.startDate));

/** The line the list shows: on leave now, or the next leave booked, or nothing. */
export function leaveSummary(rows: readonly DriverLeaveRow[], today: string): { text: string; now: boolean } | null {
  const now = rows.find((r) => leaveState(r.startDate, r.endDate, today) === "now");
  if (now) return { text: `On leave until ${fmtDate(now.endDate)}`, now: true };
  const next = rows.filter((r) => r.startDate > today).sort((a, b) => a.startDate.localeCompare(b.startDate)).at(0);
  return next ? { text: `Leave from ${fmtDate(next.startDate)}`, now: false } : null;
}
