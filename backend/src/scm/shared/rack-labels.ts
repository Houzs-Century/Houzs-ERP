// rack-labels — the labels a rack SEED run creates.
//
// ONE home, mirrored verbatim into frontend/src/vendor/shared/ so the Seed
// Racks modal's preview cannot promise a shape the server will not write. The
// pair is refereed by rack-labels.canonical.test.ts (byte comparison) — edit
// both copies or neither.
//
// Owner 2026-09-09, on KL WAREHOUSE: rack numbers run "L1.1, L1.2 … L21.1,
// L21.2" and "R1.1, R1.2 … R17.1, R17.2" — a SERIES letter, an aisle number,
// and a level within the aisle. The seed endpoint only ever produced the flat
// "<prefix> <n>" shape, so a 76-rack warehouse had to be typed in by hand one
// label at a time.

export type SeedRackSpec = {
  /** Leading word every label carries. The endpoint defaults it to "Rack". */
  prefix?: string | null;
  /** Series letter placed before the number: "L" -> "Rack L3.1". */
  series?: string | null;
  /** How many aisles — or plain racks, when `levels` is 1. */
  count: number;
  /** Levels within each aisle. 1 (the default) keeps the flat shape. */
  levels?: number | null;
};

/** Hard ceiling on ONE seed call. Mirrored so the modal states the number the
 *  server actually enforces, rather than a second guess at it. */
export const MAX_SEED_RACKS = 200;

/**
 * The labels a seed run would create, in order, capped at MAX_SEED_RACKS.
 *
 * `levels === 1` reproduces the historic flat shape exactly ("Rack 1" …
 * "Rack N") — that is the back-compat contract, not an accident: every seed
 * run made before 2026-09-09 must still be reproducible from the same inputs.
 */
export function buildSeedRackLabels(spec: SeedRackSpec): string[] {
  const prefix = String(spec.prefix ?? '').trim();
  const series = String(spec.series ?? '').trim();
  const count = Math.floor(Number(spec.count));
  const rawLevels = Math.floor(Number(spec.levels ?? 1));
  const levels = Number.isFinite(rawLevels) && rawLevels > 0 ? rawLevels : 1;
  if (!Number.isFinite(count) || count < 1) return [];

  const head = prefix ? `${prefix} ` : '';
  const out: string[] = [];
  for (let aisle = 1; aisle <= count; aisle++) {
    for (let level = 1; level <= levels; level++) {
      out.push(levels === 1 ? `${head}${series}${aisle}` : `${head}${series}${aisle}.${level}`);
      if (out.length >= MAX_SEED_RACKS) return out;
    }
  }
  return out;
}
