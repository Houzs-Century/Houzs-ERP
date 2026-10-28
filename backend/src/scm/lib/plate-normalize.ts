// ---------------------------------------------------------------------------
// plate-normalize.ts — the ONE definition of what a lorry plate looks like.
//
// WHY. Owner, 2026-08-01, reading Fleet Health: `AKF 8100` and `AKF8100` are two
// rows for one lorry. `scm.lorries.plate` is `NOT NULL UNIQUE` (mig 0053), but
// the uniqueness is over the RAW string — so a space, a hyphen or a lowercase
// letter buys you a second row for a vehicle that already exists, and the two
// then accumulate separate compliance, service history and trips.
//
// The rule is deliberately blunt because Malaysian plates are: strip every
// character that is not a letter or a digit, uppercase the rest. `AKF 8100`,
// `akf-8100` and `AKF8100` all become `AKF8100`. That is the CANONICAL form, and
// it is what gets stored — display re-spacing is a presentation question nobody
// has asked for, and storing the pretty form is exactly what caused this.
//
// Used by BOTH the write path (scm/routes/lorries.ts POST + PATCH, so no new
// duplicate can form) and the repair script (scripts/repair-lorry-plates.mjs,
// which cleans up the ones already there). One rule, two callers — the whole
// point of putting it here rather than inline in each.
//
// It writes nothing and reads nothing.
// ---------------------------------------------------------------------------

/**
 * PURE. The canonical form of a plate: letters and digits only, uppercased.
 * Returns '' for input that has no alphanumerics at all, which the caller must
 * treat as "no plate" — never as a valid canonical value.
 */
export function normalizePlate(raw: string | null | undefined): string {
  if (raw == null) return '';
  return String(raw).replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

/** A lorry as the duplicate finder needs to see it. */
export interface PlateRow {
  id: string;
  plate: string;
  /** Referenced-row counts across every table pointing at this lorry. */
  refs?: number;
  active?: boolean;
  createdAt?: string | null;
}

/** One canonical plate that more than one row claims. */
export interface DuplicateGroup {
  canonical: string;
  /** The row the others should merge INTO. See pickSurvivor for the rule. */
  survivor: PlateRow;
  losers: PlateRow[];
}

/**
 * PURE. Which row of a duplicate group should survive a merge.
 *
 * Most-referenced wins, because re-pointing the FEWEST rows is the smallest
 * possible change to production. Ties break on active-over-inactive, then on the
 * oldest createdAt (the original row, not the accidental re-entry), then on id
 * so the answer is deterministic and a dry run predicts exactly what an apply
 * will do.
 */
export function pickSurvivor(rows: readonly PlateRow[]): PlateRow {
  return [...rows].sort((a, b) => {
    const refs = (b.refs ?? 0) - (a.refs ?? 0);
    if (refs !== 0) return refs;
    const act = Number(b.active !== false) - Number(a.active !== false);
    if (act !== 0) return act;
    const ca = a.createdAt ?? '';
    const cb = b.createdAt ?? '';
    if (ca !== cb) return ca < cb ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  })[0];
}

/**
 * PURE. Group rows whose plates collide once canonicalised.
 *
 * A row whose plate is ALREADY canonical and unique appears nowhere in the
 * result — this returns work to do, not an inventory. Rows with an empty
 * canonical form (a plate of punctuation only) are skipped rather than grouped
 * together under '', which would propose merging unrelated junk rows.
 */
export function findDuplicateGroups(rows: readonly PlateRow[]): DuplicateGroup[] {
  const byCanonical = new Map<string, PlateRow[]>();
  for (const r of rows) {
    const c = normalizePlate(r.plate);
    if (!c) continue;
    const list = byCanonical.get(c) ?? [];
    list.push(r);
    byCanonical.set(c, list);
  }

  const groups: DuplicateGroup[] = [];
  for (const [canonical, list] of byCanonical) {
    if (list.length < 2) continue;
    const survivor = pickSurvivor(list);
    groups.push({ canonical, survivor, losers: list.filter((r) => r.id !== survivor.id) });
  }
  return groups.sort((a, b) => (a.canonical < b.canonical ? -1 : 1));
}

/**
 * PURE. Rows whose stored plate is not its canonical form AND whose canonical
 * form nothing else claims — a pure rename, no merge involved.
 *
 * Kept separate from findDuplicateGroups on purpose: a rename is safe and
 * reversible, a merge re-points foreign keys and deletes a row. They should be
 * reviewable, and appliable, independently.
 */
export function findRenames(rows: readonly PlateRow[]): Array<{ id: string; from: string; to: string }> {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const c = normalizePlate(r.plate);
    if (c) counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  const out: Array<{ id: string; from: string; to: string }> = [];
  for (const r of rows) {
    const c = normalizePlate(r.plate);
    if (!c || c === r.plate) continue;
    if ((counts.get(c) ?? 0) > 1) continue;   // that is a merge, not a rename
    out.push({ id: r.id, from: r.plate, to: c });
  }
  return out.sort((a, b) => (a.to < b.to ? -1 : 1));
}
