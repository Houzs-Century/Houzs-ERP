// ---------------------------------------------------------------------------
// fleet-crew-fields.ts — the field rules for a driver / helper record.
//
// WHY. Owner, 2026-08-02: "我们填入的资料（司机的电话号码、公司电话号码、IC、名
// 字、email 等等）应该都是 formatted 的". None of it was. The IC field had no
// validation, no uniqueness, not even a placeholder — `ic_number: (body.icNumber
// as string) ?? null`, a raw cast straight into a TEXT column. The name had no
// ceiling at all while the 3PL COMPANY name was capped at 120.
//
// PURE, so the rule is testable and the two crew routes cannot drift.
// ---------------------------------------------------------------------------

/** A crew name's ceiling. The company name has carried max(120) since 0210;
 *  the people had none, which is the wrong way round for the field a human
 *  types under time pressure. */
export const NAME_MAX = 120;

/** An IC / passport number's ceiling. Generous on purpose — see below. */
export const IC_MAX = 20;

/** Returned when the value cannot be stored at all. A distinct sentinel rather
 *  than null, because null is a LEGITIMATE value here (the field is optional)
 *  and a caller must not confuse "left blank" with "rejected". */
export const INVALID_IC = Symbol('invalid_ic');

const onlyDigits = (s: string): string => s.replace(/\D+/g, '');

/**
 * Normalise an IC / passport number.
 *
 * A 12-digit Malaysian NRIC is reformatted to its canonical YYMMDD-PB-###G so
 * that 900101015523, 900101-01-5523 and 900101 01 5523 stop being three
 * different values for one person.
 *
 * EVERYTHING ELSE IS KEPT AS TYPED (upper-cased, trimmed). This is deliberate
 * and it is the reason there is no format check: a large part of this fleet's
 * crew are foreign workers carrying PASSPORT numbers, not NRICs. A strict
 * 12-digit rule would refuse to register the people it exists to record, which
 * is a worse failure than an unvalidated string.
 *
 * Returns null for blank (the field is optional) and INVALID_IC only for a
 * value too long to be any identity document.
 */
export function normalizeIc(raw: unknown): string | null | typeof INVALID_IC {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (s.length > IC_MAX) return INVALID_IC;

  const digits = onlyDigits(s);
  /* Only reformat when the WHOLE value is those 12 digits. A passport that
     happens to contain 12 digits among letters is not an NRIC. */
  if (digits.length === 12 && onlyDigits(s) === s.replace(/[-\s]/g, '')) {
    return `${digits.slice(0, 6)}-${digits.slice(6, 8)}-${digits.slice(8)}`;
  }
  return s.toUpperCase();
}
