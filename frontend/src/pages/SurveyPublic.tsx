import { useEffect, useState } from "react";
import {
  HOUZS_COMPANY_CODE,
  defaultBrandingForCompany,
  hostDefaultCompanyCode,
  shortCompanyName,
} from "../lib/branding";

/** Public page — no auth, no branding fetch. Survey links are minted on the
 *  case company's hostname (publicUrl(companyCode)), so the hostname default
 *  IS the case's company. HOUZS keeps its historic literal. */
function surveyCompanyName(): string {
  return hostDefaultCompanyCode() === HOUZS_COMPANY_CODE
    ? "Houzs Century Sdn. Bhd."
    : defaultBrandingForCompany(hostDefaultCompanyCode()).companyName;
}
import { Star, CheckCircle2 } from "lucide-react";
import { cn, formatDate } from "../lib/utils";
import { humanHttpMessage } from "../api/client";
import {
  consumeCorrelated,
  correlateError,
  correlatedFetch,
  requestIdFromResponse,
} from "../lib/requestCorrelation";

// Public (unauthenticated) customer satisfaction survey. Loaded via
// /survey/:token — dispatcher shares this URL with the customer by
// WhatsApp/SMS/email after the case closes. Customer submits a
// 1-5 rating + optional notes, which lands back on the case.

interface SurveyPayload {
  already_submitted: boolean;
  assr_no: string;
  customer_name: string | null;
  doc_no: string;
  complained_date: string | null;
  existing_rating: number | null;
  existing_notes: string | null;
}

export function SurveyPublic() {
  const token = window.location.pathname.split("/")[2] || "";
  const [data, setData] = useState<SurveyPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rating, setRating] = useState(0);
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const base =
          (import.meta.env.VITE_API_URL as string) ||
          (import.meta.env.PROD ? "" : "https://autocount-sync-api.houzs-erp.workers.dev");
        const res = await correlatedFetch(`${base}/api/survey/${encodeURIComponent(token)}`);
        if (!res.ok) {
          throw correlateError(
            new Error(humanHttpMessage(res.status, await res.text().catch(() => ""))),
            requestIdFromResponse(res),
          );
        }
        const json = await consumeCorrelated(res, () => res.json() as Promise<SurveyPayload>);
        setData(json);
        if (json.already_submitted) {
          setRating(json.existing_rating ?? 0);
          setNotes(json.existing_notes ?? "");
        }
      } catch (e: any) {
        setError(e?.message || "Couldn't load survey");
      } finally {
        setLoading(false);
      }
    })();
  }, [token]);

  async function submit() {
    if (!rating) return;
    setSubmitting(true);
    setError(null);
    try {
      const base = (import.meta.env.VITE_API_URL as string) || "";
      const res = await correlatedFetch(`${base}/api/survey/${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rating, notes: notes.trim() || undefined }),
      });
      if (!res.ok) {
        throw correlateError(
          new Error(humanHttpMessage(res.status, await res.text().catch(() => ""))),
          requestIdFromResponse(res),
        );
      }
      setSubmitted(true);
    } catch (e: any) {
      setError(e?.message || "Submission failed");
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <Frame>
        <div className="py-10 text-center text-ink-muted">Loading…</div>
      </Frame>
    );
  }

  if (error && !data) {
    return (
      <Frame>
        <div className="py-8 text-center">
          <div className="mb-2 font-display text-[15px] font-bold leading-tight tracking-tight text-err">Survey Unavailable</div>
          <div className="text-[12px] leading-relaxed text-ink-secondary">{error}</div>
          <div className="mt-6 text-[12px] text-ink-muted">
            If you believe this is a mistake, please contact our service team.
          </div>
        </div>
      </Frame>
    );
  }

  if (submitted || data?.already_submitted) {
    return (
      <Frame>
        <div className="flex flex-col items-center gap-3 py-10 text-center">
          <CheckCircle2 size={44} className="text-synced" />
          <div className="font-display text-[15px] font-bold leading-tight tracking-tight text-ink">Thank you for your feedback!</div>
          <div className="text-[12px] leading-relaxed text-ink-secondary">
            Your response for case{" "}
            <span className="font-mono font-semibold">{data?.assr_no}</span> has been recorded.
          </div>
          {rating > 0 && (
            <div className="mt-2 flex items-center gap-1">
              {[1, 2, 3, 4, 5].map((n) => (
                <Star
                  key={n}
                  size={20}
                  className={n <= rating ? "fill-amber-400 text-amber-400" : "text-ink-muted/40"}
                />
              ))}
            </div>
          )}
        </div>
      </Frame>
    );
  }

  return (
    <Frame>
      <div className="mb-5">
        <div className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
          Service Case
        </div>
        <div className="mt-1 font-mono text-[15px] font-bold leading-tight tracking-tight text-ink">{data!.assr_no}</div>
        <div className="mt-1 text-[12px] leading-relaxed text-ink-secondary">
          {data!.customer_name || "Valued customer"} · SO {data!.doc_no}
          {data!.complained_date && ` · ${formatDate(data!.complained_date)}`}
        </div>
      </div>

      <div className="border-t border-border pt-5">
        <div className="text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
          How satisfied were you with our service?
        </div>
        <div className="mt-3 flex justify-center gap-2">
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              onClick={() => setRating(n)}
              className="rounded-lg p-2 transition-transform hover:scale-110 active:scale-95"
              aria-label={`${n} stars`}
            >
              <Star
                size={36}
                className={cn(
                  "transition-colors",
                  n <= rating ? "fill-amber-400 text-amber-400" : "text-ink-muted/40"
                )}
              />
            </button>
          ))}
        </div>
        <div className="mt-1 text-center text-[11px] text-ink-muted">
          {rating === 0 && "Tap to rate"}
          {rating === 1 && "Very dissatisfied"}
          {rating === 2 && "Dissatisfied"}
          {rating === 3 && "Neutral"}
          {rating === 4 && "Satisfied"}
          {rating === 5 && "Very satisfied"}
        </div>
      </div>

      <div className="mt-5">
        <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
          Additional comments (optional)
        </div>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={4}
          placeholder="Tell us more about your experience…"
          className="w-full rounded-md border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
          maxLength={1000}
        />
      </div>

      {error && <div className="mt-3 text-[12px] text-err">{error}</div>}

      <button
        onClick={submit}
        disabled={!rating || submitting}
        className="mt-5 w-full rounded-md bg-accent px-4 py-3 text-[12px] font-bold uppercase tracking-wider text-white disabled:opacity-50"
      >
        {submitting ? "Submitting…" : "Submit Feedback"}
      </button>

      <div className="mt-5 text-center text-[10px] text-ink-muted">
        {surveyCompanyName()} — Your feedback helps us improve.
      </div>
    </Frame>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-bg py-10">
      <div className="mx-auto max-w-md rounded-lg border border-border bg-surface p-6 shadow-sm">
        <div className="mb-5 text-center">
          <div className="font-display text-[15px] font-bold leading-tight tracking-tight text-ink">
            {shortCompanyName(surveyCompanyName())}
          </div>
          <div className="text-[10px] font-semibold uppercase tracking-brand text-accent">
            Customer Feedback
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}
