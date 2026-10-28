import { Link, useLocation, useNavigate } from "react-router-dom";
import { ShieldOff, ArrowLeft, Home } from "lucide-react";
import { Button } from "../components/Button";

/**
 * Generic access-denied / error page. Renders inline (URL unchanged)
 * when a route's PageGuard rejects the user, or when a handler wants
 * to surface a hard "no" without sending them home silently.
 *
 * Three modes via props:
 *   - default                 → "Access denied"
 *   - kind="forbidden"        → 403-flavoured copy
 *   - kind="not-found"        → 404-flavoured copy (use from generic
 *                                error boundaries / catch-all routes)
 */
export function Forbidden({
  kind = "forbidden",
  page,
  reason,
}: {
  kind?: "forbidden" | "not-found";
  /** Page key the guard rejected (e.g. "projects.finances"). Rendered
   *  as muted detail so admins can debug a misconfigured role from a
   *  screenshot. */
  page?: string;
  /** Optional override for the body copy. */
  reason?: string;
}) {
  const navigate = useNavigate();
  const location = useLocation();

  const isForbidden = kind === "forbidden";
  const code = isForbidden ? "403" : "404";
  const headline = isForbidden ? "Access denied" : "Page not found";
  const body =
    reason ??
    (isForbidden
      ? "Your role doesn't have access to this page. If you think this is a mistake, contact an administrator to update your role."
      : "We couldn't find what you were looking for. Check the link or head back to the dashboard.");

  return (
    <div className="flex min-h-[70vh] items-center justify-center px-4 py-12">
      <div className="w-full max-w-md text-center">
        <div className="mx-auto mb-5 inline-flex h-14 w-14 items-center justify-center rounded-full border border-border bg-surface text-ink-muted">
          <ShieldOff size={26} strokeWidth={1.5} />
        </div>
        <div className="mb-1 font-mono text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
          Error {code}
        </div>
        <h1 className="font-display text-[24px] font-extrabold tracking-tight text-ink">
          {headline}
        </h1>
        <p className="mt-2 text-[13px] leading-relaxed text-ink-secondary">
          {body}
        </p>
        {page && (
          <div className="mt-4 inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1 font-mono text-[10.5px] text-ink-muted">
            <span className="text-ink-muted/70">page:</span>
            <span className="text-ink">{page}</span>
          </div>
        )}
        <div className="mt-6 flex items-center justify-center gap-2">
          <Button
            variant="secondary"
            icon={<ArrowLeft size={14} />}
            onClick={() => {
              // If we have history, go back; otherwise fall through to /
              if (window.history.length > 1) navigate(-1);
              else navigate("/", { replace: true });
            }}
          >
            Go back
          </Button>
          <Link to="/">
            <Button variant="primary" icon={<Home size={14} />}>
              Dashboard
            </Button>
          </Link>
        </div>
        <p className="mt-8 font-mono text-[10px] text-ink-muted/70">
          {location.pathname}
        </p>
      </div>
    </div>
  );
}
