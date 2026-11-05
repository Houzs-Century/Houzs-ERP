/* PCB / MTD, the monthly income-tax deduction (HC-0125 phase 4), ported from
 * Hookka's src/lib/pcb.ts: LHDN's computerised calculation for normal
 * remuneration, resident bands for YA 2023-2026, non-resident flat 30%.
 *
 * The rule Hookka learned the hard way: a missing tax profile is NOT RM0.00.
 * UNKNOWN prints "--" and says net pay withholds nothing; RM0.00 appears only
 * when the tax is computed as nil (COMPUTED) or is nil under every possible
 * profile (ZERO_PROVEN).
 *
 * Not implemented (as in Hookka): additional remuneration (bonus), TP1
 * reliefs, zakat, CP38.
 *
 * ONE home. backend/src/scm/shared/hr-pcb.ts is the original and
 * frontend/src/vendor/shared/hr-pcb.ts its byte-identical copy
 * (check-shared-mirrors.mjs).
 */

export type PcbCategory = "SINGLE" | "MARRIED_SPOUSE_NOT_WORKING" | "MARRIED_SPOUSE_WORKING";
export type PcbStatus = "DISABLED" | "COMPUTED" | "ZERO_PROVEN" | "UNKNOWN";
export type PcbMissingInput = "taxResidency" | "taxCategory" | "taxChildRelief" | "taxSchedule";
export type PcbOutcome = { status: PcbStatus; pcbSen: number; missing: PcbMissingInput[]; note: string };

export const RESIDENT_SCHEDULE_FIRST_YA = 2023;
export const RESIDENT_SCHEDULE_LAST_YA = 2026;
export const RESIDENT_TAX_BANDS: ReadonlyArray<{ fromSen: number; ratePct: number }> = [
  { fromSen: 0, ratePct: 0 },
  { fromSen: 500_000, ratePct: 1 },
  { fromSen: 2_000_000, ratePct: 3 },
  { fromSen: 3_500_000, ratePct: 6 },
  { fromSen: 5_000_000, ratePct: 11 },
  { fromSen: 7_000_000, ratePct: 19 },
  { fromSen: 10_000_000, ratePct: 25 },
  { fromSen: 40_000_000, ratePct: 26 },
  { fromSen: 60_000_000, ratePct: 28 },
  { fromSen: 200_000_000, ratePct: 30 },
];
export const NON_RESIDENT_FLAT_RATE_PCT = 30;
export const INDIVIDUAL_RELIEF_SEN = 900_000;
export const SPOUSE_RELIEF_SEN = 400_000;
export const EPF_RELIEF_CAP_SEN = 400_000;
export const REBATE_SEN = 40_000;
export const REBATE_CEILING_SEN = 3_500_000;

export function residentTaxSen(chargeableSen: number): number {
  const p = Math.max(0, Math.floor(chargeableSen));
  let tax = 0;
  for (let i = 0; i < RESIDENT_TAX_BANDS.length; i++) {
    const lo = RESIDENT_TAX_BANDS[i].fromSen;
    if (p <= lo) break;
    const hi = i + 1 < RESIDENT_TAX_BANDS.length ? RESIDENT_TAX_BANDS[i + 1].fromSen : Number.POSITIVE_INFINITY;
    tax += ((Math.min(p, hi) - lo) * RESIDENT_TAX_BANDS[i].ratePct) / 100;
  }
  return Math.round(tax);
}

export function residentRebateSen(chargeableSen: number, category: PcbCategory): number {
  if (chargeableSen > REBATE_CEILING_SEN) return 0;
  return category === "MARRIED_SPOUSE_NOT_WORKING" ? REBATE_SEN * 2 : REBATE_SEN;
}

export const roundUpTo5Sen = (sen: number): number => Math.ceil(sen / 5) * 5;

type ResidentInput = {
  monthIndex: number;
  currentRemunerationSen: number;
  currentEpfSen: number;
  ytdRemunerationSen: number;
  ytdEpfSen: number;
  ytdPcbSen: number;
  category: PcbCategory;
  childReliefSen: number;
};

/** The year's chargeable income projected from this month: P = Y + K + (Y1 - K1) + (Y1 - K1) n - D - S - Q C, rounded down to the ringgit. */
export function projectedChargeableIncomeSen(a: Omit<ResidentInput, "ytdPcbSen">): number {
  const n = Math.max(0, 12 - a.monthIndex);
  const remuneration = a.ytdRemunerationSen + a.currentRemunerationSen * (1 + n);
  const epfRelief = Math.min(a.ytdEpfSen + a.currentEpfSen * (1 + n), EPF_RELIEF_CAP_SEN);
  const spouse = a.category === "MARRIED_SPOUSE_NOT_WORKING" ? SPOUSE_RELIEF_SEN : 0;
  const chargeable = remuneration - epfRelief - INDIVIDUAL_RELIEF_SEN - spouse - Math.max(0, a.childReliefSen);
  return Math.max(0, Math.floor(chargeable / 100) * 100);
}

export function residentPcbSen(a: ResidentInput): number {
  const n = Math.max(0, 12 - a.monthIndex);
  const p = projectedChargeableIncomeSen(a);
  const remaining = residentTaxSen(p) - residentRebateSen(p, a.category) - a.ytdPcbSen;
  return remaining <= 0 ? 0 : roundUpTo5Sen(remaining / (n + 1));
}

export const nonResidentPcbSen = (remunerationSen: number): number => roundUpTo5Sen((Math.max(0, remunerationSen) * NON_RESIDENT_FLAT_RATE_PCT) / 100);

const MISSING_NOTE: Record<PcbMissingInput, string> = {
  taxResidency: "tax residency (resident / non-resident) has not been recorded for this employee",
  taxCategory: "marital category has not been recorded",
  taxChildRelief: "child relief has not been declared",
  taxSchedule: "no tax schedule is loaded for this year of assessment",
};

const unknown = (missing: PcbMissingInput[]): PcbOutcome => ({
  status: "UNKNOWN",
  pcbSen: 0,
  missing,
  note: `PCB not computed: ${missing.map((m) => MISSING_NOTE[m]).join("; ")}. Net pay does NOT include any tax withholding.`,
});

export function resolvePcb(input: {
  pcbEnabled: boolean;
  year: number;
  monthIndex: number;
  residency: "RESIDENT" | "NON_RESIDENT" | null;
  category: PcbCategory | null;
  childReliefSen: number | null;
  currentRemunerationSen: number;
  currentEpfSen: number;
  ytdRemunerationSen: number;
  ytdEpfSen: number;
  ytdPcbSen: number;
}): PcbOutcome {
  if (!input.pcbEnabled) return { status: "DISABLED", pcbSen: 0, missing: [], note: "Not registered for PCB: no tax is withheld for this employee." };
  if (!Number.isInteger(input.year) || input.year < RESIDENT_SCHEDULE_FIRST_YA || input.year > RESIDENT_SCHEDULE_LAST_YA) return unknown(["taxSchedule"]);
  if (input.residency !== "RESIDENT" && input.residency !== "NON_RESIDENT") return unknown(["taxResidency"]);
  if (input.residency === "NON_RESIDENT") {
    return { status: "COMPUTED", pcbSen: nonResidentPcbSen(input.currentRemunerationSen), missing: [], note: `Non-resident: flat ${NON_RESIDENT_FLAT_RATE_PCT}% of gross, no reliefs.` };
  }
  const base = {
    monthIndex: input.monthIndex,
    currentRemunerationSen: input.currentRemunerationSen,
    currentEpfSen: input.currentEpfSen,
    ytdRemunerationSen: input.ytdRemunerationSen,
    ytdEpfSen: input.ytdEpfSen,
    ytdPcbSen: input.ytdPcbSen,
  };
  const childKnown = input.childReliefSen != null && Number.isFinite(input.childReliefSen) && input.childReliefSen >= 0;
  if (input.category && childKnown) {
    return {
      status: "COMPUTED",
      pcbSen: residentPcbSen({ ...base, category: input.category, childReliefSen: input.childReliefSen ?? 0 }),
      missing: [],
      note: "Resident: LHDN computerised calculation on this month's normal remuneration.",
    };
  }
  /* The most tax any resident profile could owe is SINGLE with no child
     relief; if even that is nil, the missing declaration cannot matter. */
  if (residentPcbSen({ ...base, category: "SINGLE", childReliefSen: 0 }) === 0) {
    return { status: "ZERO_PROVEN", pcbSen: 0, missing: [], note: "No PCB is due at this pay level under any tax profile." };
  }
  const missing: PcbMissingInput[] = [];
  if (!input.category) missing.push("taxCategory");
  if (!childKnown) missing.push("taxChildRelief");
  return unknown(missing);
}

/** Does this status carry a figure (as opposed to "not computed")? */
export const pcbHasFigure = (status: PcbStatus): boolean => status === "COMPUTED" || status === "ZERO_PROVEN";
