import { Link } from "react-router-dom";
import { fmtDateTime } from "@2990s/shared";
import {
  deliveryIssueSummary, serviceCaseHref, useDoDeliveryIssues, useSoDeliveryIssues, type DeliveryIssue,
} from "../../vendor/scm/lib/delivery-issue-queries";

/* "Delivered with issue" on the office screens: what the crew reported at POD
   and the Service Case it opened. Renders nothing when there is no issue. The
   mobile twin is MobileDeliveryIssues (mobile/DeliveryIssueForm.tsx); both read
   vendor/scm/lib/delivery-issue-queries.ts. */
export function DeliveryIssuesCard({ issues, showDo = false }: { issues: DeliveryIssue[] | undefined; showDo?: boolean }) {
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
            <div className="mt-0.5 text-[11.5px] text-ink-muted">
              {fmtDateTime(i.reported_at)}
              {showDo && i.do_number ? ` · ${i.do_number}` : ""}
              {i.photo_keys.length ? ` · ${i.photo_keys.length} photo${i.photo_keys.length === 1 ? "" : "s"} on the case` : ""}
              {" · "}
              {href && i.assr_no
                ? <Link to={href} className="font-semibold text-accent underline">Service case {i.assr_no}</Link>
                : <span>Service case not linked</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function DoDeliveryIssuesCard({ doId }: { doId: string | null | undefined }) {
  const q = useDoDeliveryIssues(doId);
  return <DeliveryIssuesCard issues={q.data} />;
}

export function SoDeliveryIssuesCard({ docNo }: { docNo: string | null | undefined }) {
  const q = useSoDeliveryIssues(docNo);
  return <DeliveryIssuesCard issues={q.data} showDo />;
}
