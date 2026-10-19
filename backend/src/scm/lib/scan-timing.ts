// scan-timing — per-stage scan timings (HC-0006 slice 1), so "a scan takes one
// to three minutes" can be split into upload / model / parse / save before any
// speed-up is attempted. One JSON log line (Workers Logs) plus one Analytics
// Engine point on the existing ERP_METRICS dataset, guarded the same way
// middleware/requestLog.ts guards its own point.
//
// AE layout (fixed; a reader must match it): blob1='scan', blob2=kind,
// blob3=outcome, blob4=id; double1=total_ms, double2..6 = STAGES in order,
// double7..10 = SAVE_PARTS in order (appended later; older points read 0 there).

type Metrics = { ERP_METRICS?: { writeDataPoint(p: AnalyticsEngineDataPoint): void } };

const STAGES = ['upload', 'model', 'parse', 'save', 'prep'] as const;
type Stage = (typeof STAGES)[number];
// Where the SO job's "save" time goes (HC-0006 speed). A part is charged on top of
// its stage, so save_ms keeps its meaning and stays comparable with older points.
const SAVE_PARTS = ['sample', 'dup', 'create', 'tail'] as const;
type SavePart = (typeof SAVE_PARTS)[number];

export function scanTimer(kind: string) {
  const t0 = Date.now();
  let last = t0;
  const ms: Record<Stage, number> = { upload: 0, model: 0, parse: 0, save: 0, prep: 0 };
  const parts: Record<SavePart, number> = { sample: 0, dup: 0, create: 0, tail: 0 };
  return {
    /** The time since the previous mark (or start) is charged to `stage` (and `part`, if given). */
    mark(stage: Stage, part?: SavePart): void {
      const now = Date.now();
      ms[stage] += now - last;
      if (part) parts[part] += now - last;
      last = now;
    },
    /** `id` joins lines of one scan (e.g. the SO job id); null when there is none. */
    done(env: Metrics, id: string | null, outcome: 'ok' | 'error'): void {
      const total = Date.now() - t0;
      const line: Record<string, unknown> = { event: 'scan_timing', kind, id: id ?? '', outcome, total_ms: total };
      for (const s of STAGES) line[`${s}_ms`] = ms[s];
      for (const p of SAVE_PARTS) line[`save_${p}_ms`] = parts[p];
      console.log(JSON.stringify(line));
      try {
        env.ERP_METRICS?.writeDataPoint({
          indexes: [`scan|${kind}`],
          blobs: ['scan', kind, outcome, id ?? ''],
          doubles: [total, ...STAGES.map((s) => ms[s]), ...SAVE_PARTS.map((p) => parts[p])],
        });
      } catch {
        /* never let observability break a scan */
      }
    },
  };
}
