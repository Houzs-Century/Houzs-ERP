// ─────────────────────────────────────────────────────────────────────────
// sales-report-evidence.ts — which fair the evening sales reports say an
// order belongs to (owner 2026-10-20).
//
// Every evening the floor's report is pasted into the project's chat, one bill
// per line, by booklet number (the order's Ref No.). That report is the floor's
// own word for where a bill was written, so it settles what a slip's place or
// a scan's guess cannot:
//
//   confirmed  the report of the fair the order is linked to lists it — the
//              link is right, whatever the slip's place says ("Venue differs"
//              is then not shown: 「对的上就不要显示 venue differs」).
//   elsewhere  exactly one OTHER fair's report lists it — that is where it
//              belongs, and a person may transfer it there (by hand, never
//              automatically: 「做成 manual bulk transfer」).
//   conflict   two or more other fairs' reports list it — a person decides.
//   none       no report lists it.
//
// Read from the chat on every call, like the report itself
// (sales-report-bills.ts): a voided message stops counting at once.
// ─────────────────────────────────────────────────────────────────────────
import { collectReport, type NoteRow } from "./sales-report-bills";
import { extractRefTokens } from "../../scm/shared/sales-report-parse";

/** One report line naming a booklet number. */
export type ReportSighting = {
  projectId: number;
  reportDate: string | null;
  amountSen: number;
  salesperson: string | null;
};

/** Booklet token → every fair whose report lists it. */
export type ReportEvidence = Map<string, ReportSighting[]>;

export type ReportVerdict =
  | { kind: "none" }
  | { kind: "confirmed"; sighting: ReportSighting }
  | { kind: "elsewhere"; sighting: ReportSighting }
  | { kind: "conflict"; projectIds: number[] };

/** The booklet numbers an order carries: Ref No. as typed, or the AutoCount ref. */
export function orderBookletTokens(o: { customer_so_no?: string | null; ref?: string | null }): string[] {
  return [...new Set([...extractRefTokens(o.customer_so_no), ...extractRefTokens(o.ref)])];
}

/** Every report line naming one of the order's booklet numbers. */
export function sightingsOf(
  o: { customer_so_no?: string | null; ref?: string | null },
  evidence: ReportEvidence,
): ReportSighting[] {
  return orderBookletTokens(o).flatMap((t) => evidence.get(t) ?? []);
}

/** What the reports say about one order, against the fair it is linked to. */
export function reportVerdict(
  o: { project_id?: number | string | null; customer_so_no?: string | null; ref?: string | null },
  evidence: ReportEvidence,
): ReportVerdict {
  const seen = sightingsOf(o, evidence);
  if (seen.length === 0) return { kind: "none" };
  const linked = o.project_id == null ? null : Number(o.project_id);
  const own = seen.find((s) => s.projectId === linked);
  if (own) return { kind: "confirmed", sighting: own };
  const others = [...new Set(seen.map((s) => s.projectId))];
  if (others.length > 1) return { kind: "conflict", projectIds: others.sort((a, b) => a - b) };
  return { kind: "elsewhere", sighting: seen[0]! };
}

/** The evidence from each fair's chat messages. Pure. */
export function buildReportEvidence(
  notesByProject: ReadonlyMap<number, readonly NoteRow[]>,
  startDateOf: ReadonlyMap<number, string | null>,
): ReportEvidence {
  const out: ReportEvidence = new Map();
  for (const [projectId, notes] of notesByProject) {
    const report = collectReport(notes, startDateOf.get(projectId) ?? null);
    for (const b of report.bills) {
      const list = out.get(b.ref_token) ?? [];
      list.push({ projectId, reportDate: b.report_date, amountSen: b.amount_sen, salesperson: b.salesperson_name });
      out.set(b.ref_token, list);
    }
  }
  return out;
}

type Db = {
  prepare(sql: string): { bind(...vals: unknown[]): { all<T>(): Promise<{ results?: T[] }> } };
};

const text = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));

/**
 * Read the chat of this company's fairs and parse their reports.
 *
 * @param companySql the active-company predicate on `p.company_id`
 *                   (activeCompanySql(c, 'p.company_id')).
 * @param scope      `since`: fairs starting on or after that day; `projectIds`:
 *                   those fairs only. Throws on a failed read.
 */
export async function loadReportEvidence(
  db: Db,
  companySql: string,
  scope: { since: string } | { projectIds: readonly number[] },
): Promise<ReportEvidence> {
  let where: string;
  let binds: unknown[];
  if ("projectIds" in scope) {
    const ids = [...new Set(scope.projectIds.filter((n) => Number.isInteger(n)))];
    if (ids.length === 0) return new Map();
    where = `p.id IN (${ids.map(() => "?").join(", ")})`;
    binds = ids;
  } else {
    where = "p.start_date >= ?";
    binds = [scope.since];
  }
  /* company-scope: ${companySql} is the caller's activeCompanySql(c, 'p.company_id')
     fragment on the fair (projects p) each message belongs to. */
  const res = await db
    .prepare(
      `SELECT a.id AS id, a.project_id AS project_id, a.note AS note, a.created_at AS created_at,
              p.start_date AS start_date, u.email AS author_email, ps.name AS author_position
         FROM project_activity a
         JOIN projects p ON p.id = a.project_id
         LEFT JOIN users u ON u.id = a.user_id
         LEFT JOIN positions ps ON ps.id = u.position_id
        WHERE a.action = 'note' AND a.archived_at IS NULL AND ${where}${companySql}`,
    )
    .bind(...binds)
    .all<Record<string, unknown>>();
  const notesByProject = new Map<number, NoteRow[]>();
  const startDateOf = new Map<number, string | null>();
  for (const r of (res.results ?? []) as Array<Record<string, unknown>>) {
    const pid = Number(r.project_id);
    if (!Number.isInteger(pid)) continue;
    startDateOf.set(pid, text(r.start_date)?.slice(0, 10) ?? null);
    const list = notesByProject.get(pid) ?? [];
    list.push({
      id: Number(r.id),
      note: text(r.note),
      created_at: text(r.created_at),
      author_email: text(r.author_email),
      author_position: text(r.author_position),
    });
    notesByProject.set(pid, list);
  }
  return buildReportEvidence(notesByProject, startDateOf);
}
