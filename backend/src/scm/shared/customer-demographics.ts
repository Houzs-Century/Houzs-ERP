
import { todayMyt } from '../lib/my-time';

export const RACE_OPTIONS = ['Malay', 'Chinese', 'Indian', 'Others'] as const;
export type Race = (typeof RACE_OPTIONS)[number];

const RACE_SET = new Set<string>(RACE_OPTIONS);

export function isValidRace(v: unknown): v is Race {
  return typeof v === 'string' && RACE_SET.has(v);
}

export const GENDER_OPTIONS = ['Male', 'Female', 'Others'] as const;
export type Gender = (typeof GENDER_OPTIONS)[number];
const GENDER_SET = new Set<string>(GENDER_OPTIONS);

export function isValidGender(v: unknown): v is Gender {
  return typeof v === 'string' && GENDER_SET.has(v);
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;


/** Exact integer age from an ISO birthday as of `asOf` (default today). Returns
 *  null for malformed or impossible calendar input. Calendar comparison (no
 *  rounding) — age ticks up only on/after the birthday. */
export function ageFromBirthday(birthday: string | null | undefined, asOf?: string): number | null {
  if (typeof birthday !== 'string' || !ISO_DATE_RE.test(birthday)) return null;
  const ref = asOf && ISO_DATE_RE.test(asOf) ? asOf : todayMyt();
  const [by, bm, bd] = birthday.split('-').map(Number) as [number, number, number];
  const [ry, rm, rd] = ref.split('-').map(Number) as [number, number, number];
  const d = new Date(Date.UTC(by, bm - 1, bd));
  if (d.getUTCFullYear() !== by || d.getUTCMonth() !== bm - 1 || d.getUTCDate() !== bd) return null;
  let age = ry - by;
  if (rm < bm || (rm === bm && rd < bd)) age -= 1;
  return age;
}

/** True when `v` is a valid ISO birthday: a real calendar date, not in the
 *  future, and a plausible human age (0..120) as of `asOf`. */
export function isValidBirthday(v: unknown, asOf?: string): v is string {
  if (typeof v !== 'string' || !ISO_DATE_RE.test(v)) return false;
  const age = ageFromBirthday(v, asOf);
  return age !== null && age >= 0 && age <= 120;
}
