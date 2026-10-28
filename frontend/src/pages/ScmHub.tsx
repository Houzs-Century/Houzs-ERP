import { useNavigate } from "react-router-dom";
import { Info } from "lucide-react";
import { NAV_TABS, type NavTab } from "../components/Sidebar";
import { useAuth } from "../auth/AuthContext";
import { PageHeader } from "../components/Layout";
import { cn } from "../lib/utils";
import { prefetchRoute } from "../lib/prefetch-routes";

/**
 * Supply Chain Hub — a section landing page for /scm.
 *
 * Fixes the old 3-level nesting (Supply Chain → Sales Order → Sales Orders)
 * by surfacing every SCM module one click deep. It is driven entirely by the
 * existing NAV_TABS "Supply Chain" subtree (single source of truth shared with
 * the Sidebar), so adding a module to the nav automatically lists it here —
 * and the SAME permission filter (perm / anyPerm / anyAccess / pageAccess)
 * applies, so a position only sees the areas it's granted.
 */
export function ScmHub() {
  const navigate = useNavigate();
  const { can, pageAccess } = useAuth();

  // Mirror Sidebar.filterTab so the Hub and the nav never drift on visibility.
  const visible = (t: NavTab): boolean => {
    if (t.perm && !can(t.perm)) return false;
    if (t.anyPerm || t.anyAccess) {
      const permOk = t.anyPerm ? t.anyPerm.some((p) => can(p)) : false;
      const accessOk = t.anyAccess ? t.anyAccess.some((k) => pageAccess(k) !== "none") : false;
      if (!permOk && !accessOk) return false;
    }
    if (t.hidePerm && can(t.hidePerm)) return false;
    if (t.pageAccess && pageAccess(t.pageAccess) === "none") return false;
    if (t.pageAccessFull && pageAccess(t.pageAccessFull) !== "full") return false;
    return true;
  };

  const scm = NAV_TABS.find((t) => t.groupId === "scm");
  const groups = (scm?.children ?? [])
    .map((g) => ({ group: g, kids: (g.children ?? []).filter(visible) }))
    .filter(({ group, kids }) => visible(group) && kids.length > 0);

  return (
    <div>
      <PageHeader
        eyebrow="Operations · Supply Chain"
        title="Supply Chain"
        description="All supply-chain modules in one place — sales, consignment, procurement, warehouse and finance."
      />

      {/* Why-this-changed note — keeps the amber "intentional warning slot". */}
      <div className="mb-5 flex items-start gap-2 rounded-lg border border-warning-text/20 bg-warning-bg px-3.5 py-2.5 text-[12px] text-warning-text">
        <Info size={14} className="mt-0.5 shrink-0" />
        <span>
          Navigation is flattened — every module is one click away here, no more drilling through levels. Each sub-page keeps a path back.
        </span>
      </div>

      {groups.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface p-8 text-center text-[12px] text-ink-muted shadow-stone">
          You don't have access to any supply-chain modules yet.
        </div>
      ) : (
        <div className="space-y-6">
          {groups.map(({ group, kids }) => {
            const GIcon = group.icon;
            return (
              <section key={group.groupId || group.label}>
                {/* Group header — mono uppercase label + icon + hairline rule. */}
                <div className="mb-2.5 flex items-center gap-2">
                  <GIcon size={14} className="shrink-0 text-ink-muted" />
                  <h2 className="font-mono text-[10px] font-bold uppercase tracking-brand text-ink-muted">
                    {group.label}
                  </h2>
                  <span className="h-px flex-1 bg-border-subtle" />
                  <span className="font-mono text-[10px] text-ink-muted">{kids.length} modules</span>
                </div>

                {/* Module cards — 4-col grid; hover lifts + petrol border. */}
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  {kids.map((k) => {
                    const KIcon = k.icon;
                    return (
                      <button
                        key={k.to}
                        onClick={() => k.to && navigate(k.to)}
                        onMouseEnter={() => k.to && prefetchRoute(k.to)}
                        className={cn(
                          "group flex flex-col gap-2.5 rounded-xl border border-border bg-surface p-4 text-left shadow-stone transition-all duration-150",
                          "hover:-translate-y-px hover:border-primary hover:shadow-slab",
                        )}
                      >
                        <span className="grid h-9 w-9 place-items-center rounded-lg bg-surface-2 text-ink-secondary transition-colors group-hover:bg-primary-soft group-hover:text-primary">
                          <KIcon size={17} />
                        </span>
                        <span className="text-[13px] font-bold leading-snug text-ink">
                          {k.label}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
