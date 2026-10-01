// ----------------------------------------------------------------------------
// projectFinanceLines.ts — one event's finance lines as its detail reads them
// (moved out of getProjectDetail, services/projects.ts, when the books joined
// them — owner 2026-10-01, payment-request item 5):
//   • the typed and auto ledger (project_finance_lines — listLedgerLines);
//   • the books: money Finance posted to the event, in the row its account
//     names, replacing that row's typed / auto lines (scm/lib/event-books.ts);
//   • the sales entries, as virtual income rows.
// Newest first. Every reader of the detail — the PC page, the phone, the
// printed debrief — sums these as they are.
// ----------------------------------------------------------------------------

import type { Env } from "../types";
import { applyEventBooks, readEventBooks } from "../scm/lib/event-books";

export async function eventFinanceLines(
  env: Env,
  projectId: number,
  companyId: number | null,
  ledger: any[],
  costCategories: readonly string[],
) {
  const { lines, books } = applyEventBooks(projectId, ledger, await readEventBooks(env.DB, projectId, companyId), costCategories);

  // Sales entries surface as virtual income rows in the ledger so the
  // Finance section reflects rep-entered sales without double-bookkeeping.
  // sales_entries is the source of truth (managed via the Sales section);
  // these synthetic rows carry source='sales_entry' so the UI suppresses
  // edit/delete controls.
  const salesEntryLines = await env.DB.prepare(
    `SELECT s.id, s.amount, s.occurred_at, s.created_at,
            s.customer_name, s.ref_no, s.notes,
            COALESCE(sp.name, u.name) as created_by_name
       FROM sales_entries s
       LEFT JOIN users u  ON u.id  = s.created_by
       LEFT JOIN users sp ON sp.id = s.sales_person_id
      WHERE s.project_id = ?
        AND s.archived_at IS NULL
        AND s.status != 'void'
      ORDER BY s.occurred_at DESC, s.id DESC`
  )
    .bind(projectId)
    .all<{
      id: number;
      amount: number;
      occurred_at: string;
      created_at: string;
      customer_name: string;
      ref_no: string | null;
      notes: string | null;
      created_by_name: string | null;
    }>();
  // Quick-log rows (rep entered amount + ref_no only at the project)
  // carry the sentinel "(quick log)" in customer_name. Render them
  // with a friendlier "Quick log · {ref}" label in the project finance
  // ledger so the boss isn't squinting at a parenthesised placeholder.
  const QUICK_LOG_SENTINEL = "(quick log)";
  const synthIncome = (salesEntryLines.results ?? []).map((s) => ({
    id: -s.id,
    project_id: projectId,
    kind: "income" as const,
    category: "sales",
    description:
      s.customer_name === QUICK_LOG_SENTINEL
        ? `Quick log · ${s.ref_no ?? "no ref"}`
        : (s.ref_no ? `${s.ref_no} · ` : "") + s.customer_name,
    amount: s.amount,
    occurred_at: s.occurred_at,
    r2_key: null,
    file_name: null,
    mime_type: null,
    notes: s.notes,
    created_by_name: s.created_by_name,
    created_at: s.created_at,
    archived_at: null,
    source: "sales_entry" as const,
    source_id: s.id,
  }));
  const financeLines = [...lines, ...synthIncome].sort((a: any, b: any) => {
    const ao = a.occurred_at ?? "";
    const bo = b.occurred_at ?? "";
    if (ao && bo) return bo.localeCompare(ao);
    if (!ao && bo) return 1;
    if (ao && !bo) return -1;
    return (b.id ?? 0) - (a.id ?? 0);
  });
  return { financeLines, books };
}
