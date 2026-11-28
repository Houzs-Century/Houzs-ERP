import type { LogisticsLorrySpend } from '../../vendor/scm/lib/logistics-queries';
import type { LorryKmDaily } from '../../vendor/scm/lib/lorries-queries';

/** Placeholder until the owner picks one (HC-0050): petrol, toll & parking RM per GPS km above this is flagged. */
export const PETROL_RM_PER_KM_LIMIT = 0.8;

export type PetrolKmCell = { petrolSen: number; km: number | null; gpsDays: number; days: number; rmPerKm: number | null; high: boolean };
export type PetrolKmRow = { plate: string; cells: Record<string, PetrolKmCell> };

export const plateKey = (plate: string): string => plate.replace(/[^A-Za-z0-9]/g, '').toUpperCase();

/** Each of our lorries' booked petrol (Actual) against its GPS km, per month. km null = no GPS fix that month. */
export function petrolPerKm(lorries: readonly LogisticsLorrySpend[], kmByMonth: Readonly<Record<string, LorryKmDaily | undefined>>, months: readonly string[], limit: number): PetrolKmRow[] {
  return lorries.filter((e) => e.plate != null && e.ours).map((e) => {
    const plate = e.plate!;
    const cells: Record<string, PetrolKmCell> = {};
    for (const m of months) {
      const petrolSen = e.lines.filter((l) => l.kind === 'petrol' && l.day.slice(0, 7) === m).reduce((t, l) => t + l.amountSen, 0);
      const month = kmByMonth[m];
      const daily = month?.lorries.find((x) => plateKey(x.plate) === plateKey(plate))?.km ?? [];
      const seen = daily.filter((k): k is number => k != null);
      const km = seen.length > 0 ? seen.reduce((t, k) => t + k, 0) : null;
      const rmPerKm = km != null && km > 0 ? petrolSen / 100 / km : null;
      cells[m] = { petrolSen, km, gpsDays: seen.length, days: month?.days.length ?? 0, rmPerKm, high: rmPerKm != null && rmPerKm > limit };
    }
    return { plate, cells };
  });
}
