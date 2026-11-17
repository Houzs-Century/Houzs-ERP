import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { fmtDateTime } from "@2990s/shared";
import {
  createServiceCaseForIssue, deliveryIssueSummary, invalidateDeliveryIssues, serviceCaseHref,
  useDoDeliveryIssues, useSoDeliveryIssues, SERVICE_CASE_CREATE_PERMS, type DeliveryIssue,
} from "../../vendor/scm/lib/delivery-issue-queries";
import { writeFailed } from "../../vendor/scm/lib/mutation-error";
import { useAuth } from "../../auth/AuthContext";

/* "Delivered with issue" on the office screens: what the crew reported at POD
   and — once the office opens one — the Service Case. The crew no longer opens
   the case (owner 2026-11-16); an unlinked report shows a "Create service case"
   action to a user who may open cases (canCreateCase), which pulls the POD
   photos onto the new case. Renders nothing when there is no issue. The mobile
   twin is MobileDeliveryIssues (mobile/DeliveryIssueForm.tsx); both read
   vendor/scm/lib/delivery-issue-queries.ts. */
export function DeliveryIssuesCard({ issues, canCreateCase, showDo = false }: {
  issues: DeliveryIssue[] | undefined; canCreateCase: boolean; showDo?: boolean;
}) {
  const qc = useQueryClient();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const createCase = useMutation({
    mutationFn: (issueId: string) => createServiceCaseForIssue(issueId),
    onMutate: (issueId: string) => { setPendingId(issueId); },
    onSettled: () => { setPendingId(null); },
    onSuccess: () => { void invalidateDeliveryIssues(qc); },
    onError: writeFailed,
  });
  if (!issues?.length) return null;
  return (
    <div data-testid="delivery-issues-card" className="rounded-lg border border-border border-l-[3px] border-l-err bg-surface p-4 shadow-stone">
      <div className="mb-2 flex items-center gap-2">
        <span className="font-mono text-[10px] font-semibold uppercase tracking-brand text-err">Delivered with issue</span>
        <span className="rounded-full bg-err-bg px-2 py-0.5 text-[10.5px] font-bold text-err">{issues.length}</span>
      </div>
      {issues.map((i) => {
        const href = serviceCaseHref(i);
        return (
          <div key={i.id} className="border-t border-border-subtle py-2 first:border-t-0">
            <div className="text-[13px] font-semibold text-ink">{deliveryIssueSummary(i)}</div>
            {i.note && <div className="whitespace-pre-wrap text-[12.5px] text-ink">{i.note}</div>}
            <div className="mt-0.5 flex flex-wrap items-center gap-x-1 text-[11.5px] text-ink-muted">
              <span>{fmtDateTime(i.reported_at)}</span>
              {showDo && i.do_number ? <span>{`· ${i.do_number}`}</span> : null}
              {i.photo_keys.length ? <span>{`· ${i.photo_keys.length} photo${i.photo_keys.length === 1 ? "" : "s"}`}</span> : null}
              <span>·</span>
              {href && i.assr_no ? (
                <Link to={href} className="font-semibold text-accent underline">Service case {i.assr_no}</Link>
              ) : canCreateCase ? (
                <button
                  type="button"
                  disabled={createCase.isPending}
                  onClick={() => createCase.mutate(i.id)}
                  className="rounded border border-accent px-2 py-0.5 text-[11px] font-semibold text-accent disabled:opacity-50"
                >
                  {pendingId === i.id ? "Creating…" : "Create service case"}
                </button>
              ) : (
                <span>Service case not linked</span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function DoDeliveryIssuesCard({ doId }: { doId: string | null | undefined }) {
  const q = useDoDeliveryIssues(doId);
  const { canAny } = useAuth();
  return <DeliveryIssuesCard issues={q.data} canCreateCase={canAny(SERVICE_CASE_CREATE_PERMS)} />;
}

export function SoDeliveryIssuesCard({ docNo }: { docNo: string | null | undefined }) {
  const q = useSoDeliveryIssues(docNo);
  const { canAny } = useAuth();
  return <DeliveryIssuesCard issues={q.data} showDo canCreateCase={canAny(SERVICE_CASE_CREATE_PERMS)} />;
}
