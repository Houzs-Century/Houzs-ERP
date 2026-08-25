import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { Plus, Copy, Trash2, UserX, UserCheck, X, KeyRound, Pencil, Check, RefreshCw, Search, ArrowUp, ArrowDown, ChevronsUpDown, ChevronRight, ChevronDown, Printer, LayoutGrid, List, Phone, Mail, AtSign, ArrowLeft, SlidersHorizontal, Eye, EyeOff, Users, ShieldCheck, Network, Building2, LogIn, type LucideIcon } from "lucide-react";
import { PageHeader } from "../components/Layout";
import { TabStrip, type TabOption } from "../components/TabStrip";
import { Button } from "../components/Button";
import { ColorPicker } from "../components/ColorPicker";
import { Panel, PanelSection } from "../components/Panel";
import { StatusDot } from "../components/StatusDot";
/* The house searchable dropdown (owner 2026-07-27, "全部下拉的 option 都要加上
   搜索功能"), vendored where the long option lists first appeared. Team's people
   pickers are the same problem, so they use the same control. */
import { SearchableSelect } from "../vendor/scm/components/SearchableSelect";
import { ORG_PICKER_CLS, isDescendantOf, managerOptions } from "./team/orgChartPickers";
import { Avatar } from "../components/Avatar";
import { useQuery } from "../hooks/useQuery";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "../hooks/useToast";
import { useDialog } from "../hooks/useDialog";
import { Skeleton, ListSkeleton } from "../components/Skeleton";
import { DataTable, type Column } from "../components/DataTable";
import { FilterPills } from "../components/FilterPills";
import { StatCard } from "../components/StatCard";
import { Badge } from "../components/Badge";
import { EmptyState } from "../components/EmptyState";
import { useStickyFilters } from "../hooks/useStickyFilters";
import { enumPreference, useIdentityPreference } from "../hooks/useIdentityPreference";
import { allSettledBounded } from "../lib/allSettledBounded";
import { api, tokenStore } from "../api/client";
import { prepareImageForUpload } from "../lib/imagePipeline";
import { useAuth } from "../auth/AuthContext";
import { isSalesDirectorUser } from "../auth/salesAccess";
import { relativeTime, cn } from "../lib/utils";
import { inviteExpiry, inviteLink } from "../lib/invitations";
import { formatPhone } from "../vendor/shared/phone";
import type { TeamMember, Invitation, Role, Department, Position } from "../types";
import { MemberOrgPerformance } from "./team/MemberOrgPerformance";
import { TeamDirectory } from "./team/TeamDirectory";
import { TeamOrgChartV2 } from "./team/TeamOrgChartV2";
import { TeamDepartmentsV2 } from "./team/TeamDepartmentsV2";
import { TeamMailboxesV2 } from "./team/TeamMailboxesV2";
import { TeamRolesV2 } from "./team/TeamRolesV2";
import { Forbidden } from "./Forbidden";
import { RolesTab } from "./Roles";
import { PositionsTab } from "./Positions";
import { MailboxesTab } from "./MailboxesTab";
import { PhoneInput } from "../vendor/scm/components/PhoneInput";
import { PrintPreviewModal, usePrintPreview } from "../components/scm-v2/PrintPreviewModal";
import { fmtDate } from "../vendor/shared/format";

type TeamTabValue =
  | "hub"
  /* Redesigned Team screens (design handoff "ERP Team模块重整", 2026-08).
     These four are the strip; the classic tabs below stay URL-reachable
     during the transition so nothing is lost while the redesign is reviewed. */
  | "directory"
  | "orgchart2"
  | "departments2"
  | "mail2"
  | "permissions"
  | "members"
  | "positions"
  | "roles"
  | "orgchart"
  | "departments"
  | "mail";

const TEAM_KEYS = ["tab"] as const;

// Icons for the Team Hub landing cards (keyed by tab value).
const TEAM_HUB_ICON: Partial<Record<TeamTabValue, LucideIcon>> = {
  directory: Users,
  orgchart2: Network,
  departments2: Building2,
  mail2: Mail,
  permissions: ShieldCheck,
  members: Users,
  positions: ShieldCheck,
  orgchart: Network,
  departments: Building2,
  mail: Mail,
};

// One-click member segments (label + key). Shared by the Filters popover
// and the active-filter pill row.
const QUICK_SEGMENTS = [
  ["online", "Online now"],
  ["joined7d", "Joined ≤ 7d"],
  ["no_login", "Never signed in"],
  ["stale", "Inactive 30d+"],
  ["no_dept", "No department"],
  ["no_pos", "No position"],
  ["no_mgr", "No manager"],
  ["no_photo", "No photo"],
] as const;

// yyyy/mm/dd for the date columns — same normalisation as the SO list's
// fmtDate, plus space-separated Postgres timestamps ("2026-07-22 09:14:33").
const fmtDay = fmtDate;

// Full department set for a member (mig 0020) — primary first, falling back to
// the single primary on older backends that don't send department_ids.
function deptIdsOf(u: TeamMember): number[] {
  if (u.department_ids && u.department_ids.length) return u.department_ids;
  return u.department_id != null ? [u.department_id] : [];
}

// Departments a member belongs to BESIDES the primary — drives the "+N" chips.
function extraDeptIdsOf(u: TeamMember): number[] {
  return deptIdsOf(u).filter((d) => d !== u.department_id);
}

// True when the member belongs to `deptId` through any of their departments.
function inDept(u: TeamMember, deptId: number): boolean {
  return deptIdsOf(u).includes(deptId);
}

// Compact "+N" pill for departments a member has beyond the primary; the
// tooltip names them. Renders nothing when there are no extras.
function ExtraDeptCount({
  user,
  deptById,
}: {
  user: TeamMember;
  deptById: Map<number, Department>;
}) {
  const names = extraDeptIdsOf(user)
    .map((id) => deptById.get(id)?.name)
    .filter((n): n is string => !!n);
  if (names.length === 0) return null;
  return (
    <span
      className="shrink-0 rounded-full bg-surface-dim px-1.5 py-px text-[10px] font-semibold text-ink-muted"
      title={`Also in ${names.join(", ")}`}
    >
      +{names.length}
    </span>
  );
}

// ──────────────────────────────────────────────────────────
// Company assignment (Phase 0e) — shared helpers + segmented control
// ──────────────────────────────────────────────────────────

type CompanyOpt = { id: number; code: string; name: string };

/* Showroom parking (owner 2026-07-19) — a Showroom is a scm.warehouses row
   flagged is_showroom, and `venueName` is the venue its parked salespeople's
   orders attribute to. venueName is nullable on purpose: a showroom can be
   flagged before anyone has decided what its venue is called, and until then it
   resolves to NO venue rather than to the warehouse's own name. */
type ShowroomOption = {
  id: string;
  code: string;
  name: string;
  venueName: string | null;
  active: boolean;
};

/* The subset of GET /api/scm/staff this panel reads. `userId` is migration
   0066's link from a Houzs user to their sales profile. */
type ScmStaffRow = {
  id: string;
  userId: number | null;
  showroomWarehouseId: string | null;
};

// Friendly short name for a company code (HOUZS → "Houzs"; else the code).
function companyShortName(code: string): string {
  return code === "HOUZS" ? "Houzs" : code;
}

// One-word label for a member's grant set, for the Company column:
//   all companies granted → "Both"; a single company → its short name;
//   empty (no grant row) → "All" (fail-open — user may act in every company).
function companyLabelFor(ids: number[], companies: CompanyOpt[]): string {
  if (!companies.length) return "—";
  if (ids.length === 0) return "All";
  if (ids.length >= companies.length && companies.every((co) => ids.includes(co.id)))
    return "Both";
  const single = companies.find((co) => co.id === ids[0]);
  return single ? companyShortName(single.code) : "—";
}

// Segmented picker: one button per company plus a "Both" (all companies) when
// there is more than one. Value/onChange work on the raw company-id array so
// the caller sends `company_ids` straight to the backend. Both = every id;
// a single company = [id]. Mirrors the existing option-pill styling.
function CompanySelect({
  companies,
  value,
  onChange,
}: {
  companies: CompanyOpt[];
  value: number[];
  onChange: (ids: number[]) => void;
}) {
  const allIds = companies.map((co) => co.id);
  const isBoth =
    companies.length > 1 &&
    value.length >= companies.length &&
    companies.every((co) => value.includes(co.id));
  const segCls = (on: boolean) =>
    cn(
      "flex-1 rounded-md border px-2.5 py-1.5 text-[12px] font-semibold transition-colors",
      on
        ? "border-accent bg-accent text-white"
        : "border-border bg-surface text-ink-secondary hover:border-accent/40 hover:text-accent",
    );
  return (
    <div className="flex gap-1.5">
      {companies.map((co) => {
        const on = !isBoth && value.length === 1 && value[0] === co.id;
        return (
          <button
            key={co.id}
            type="button"
            onClick={() => onChange([co.id])}
            className={segCls(on)}
            title={co.name}
          >
            {companyShortName(co.code)}
          </button>
        );
      })}
      {companies.length > 1 && (
        <button
          type="button"
          onClick={() => onChange(allIds)}
          className={segCls(isBoth)}
          title="Both companies"
        >
          Both
        </button>
      )}
    </div>
  );
}

/**
 * Unified Team page — two tabs (Members, Roles) sharing a single header.
 * Members lists users + pending invitations and lets admins invite /
 * reset / disable / remove. Roles is a grid of role cards with an editor
 * panel for permissions.
 *
 * The wrapper owns the primary action button for each tab (Invite Member
 * / New Role) so they live consistently in the PageHeader's `actions`
 * slot — not duplicated inside each tab body.
 */
export function Team() {
  const { can, user } = useAuth();
  const [params, setParams] = useStickyFilters("team", TEAM_KEYS);

  const canUsers = can("users.read");
  const canRoles = can("roles.read");
  const canManageUsers = can("users.manage");
  const canManageRoles = can("roles.manage");
  // Mail Center admin — gates the Mailboxes tab (owner via "*").
  const canManageMail = can("mail_center.manage");
  // Sales Director — department-scoped Team admin (owner 2026-07). Gets
  // Members / Org Chart / Departments (own-dept only, backend-scoped) + Invite,
  // but NOT Positions/Mailboxes and NOT permission editing. A full admin
  // (canManageUsers) keeps everything unchanged. `salesDirScoped` is true only
  // when the Sales Director is NOT already a full admin.
  const isSalesDir = isSalesDirectorUser(user);
  const salesDirScoped = isSalesDir && !canManageUsers;
  const canSeeMembers = canUsers || isSalesDir;
  const canInvite = canManageUsers || isSalesDir;

  function setTab(next: TeamTabValue) {
    const p = new URLSearchParams(params);
    p.set("tab", next);
    setParams(p, { replace: true });
  }

  const [inviteOpen, setInviteOpen] = useState(false);
  const [creatingRole, setCreatingRole] = useState(false);
  const [creatingDept, setCreatingDept] = useState(false);

  const tabs: TabOption<TeamTabValue>[] = [
    { value: "directory", label: "Directory", show: canSeeMembers },
    { value: "orgchart2", label: "Org Chart", show: canSeeMembers },
    { value: "departments2", label: "Departments", show: canSeeMembers },
    { value: "mail2", label: "Mailboxes", show: canManageMail },
    { value: "permissions", label: "Roles & Permissions", show: canRoles },
    // Classic tabs (members / orgchart / departments / mail) are out of the
    // strip but still URL-reachable while the redesign is reviewed — see
    // canViewTab below. Cutover removes them.
    // Positions tab removed from the strip (owner: "那個team的矩陣拆掉") — the
    // same treatment the Roles tab got, which is why neither is in the strip.
    // A positioned user's page access is resolved from position defaults
    // (services/positionPolicy.ts, read at login), NOT from the 4-level
    // position_page_access matrix this tab edited — that table is no longer read
    // for them, so removing the tab changes no one's access. Re-add this line to
    // restore the tab in the strip (it is also gated off in canViewTab below).
    // Roles tab removed (owner: "删了role") — Position governs page access; a
    // baseline role is auto-assigned on invite. Re-add this line to restore.
  ];

  // The landing tab, and the fallback when the requested one is not theirs.
  const firstVisible = tabs.find((t) => t.show !== false)?.value ?? null;

  // Whether the user can open a tab's CONTENT — deliberately not the same list
  // as the strip. Entry to /team is granted by the POSITION page matrix
  // (PageGuard) while every tab below is gated by ROLE permissions, and the two
  // come from different sources (position page access from position defaults via
  // resolvePositionPolicy vs roles.permissions — services/auth.ts), so they can
  // disagree and an admitted user may be able
  // to open nothing. `roles` is absent from the strip (owner: "删了role") but
  // the editor is still live and reachable by URL, so it stays viewable for
  // roles.read. `hub` has something to list only if some tab is visible.
  const canViewTab: Record<TeamTabValue, boolean> = {
    hub: firstVisible !== null,
    directory: canSeeMembers,
    orgchart2: canSeeMembers,
    departments2: canSeeMembers,
    mail2: canManageMail,
    permissions: canRoles,
    members: canSeeMembers,
    // Positions is turned off entirely (owner: "整個關掉先") — #740 only pulled
    // it from the nav but left it URL-reachable at /team?tab=positions for a
    // full admin. Forcing this to `false` closes that escape hatch: a requested
    // `positions` tab now fails the canViewTab gate below and falls through to
    // the user's first real tab (or the same Forbidden safe-landing #722 gives
    // any admitted-but-empty user), so `active` can never resolve to "positions"
    // and PositionsTab never mounts — its data query never fires. Enforcement is
    // untouched: a positioned user's access is resolved from position defaults
    // (services/positionPolicy.ts), which this gate does not affect. The former
    // writer PATCH /api/positions/:id/page-access is now DISABLED (it short-
    // circuits without writing); its route and the position_page_access table
    // are kept for a future rework, and the tab's page-access editor is read-only.
    positions: false,
    orgchart: canSeeMembers,
    departments: canSeeMembers,
    roles: canRoles,
    mail: canManageMail,
  };

  const raw = params.get("tab") as TeamTabValue | null;
  const requested = raw && raw in canViewTab ? raw : null;
  // Honour the requested tab only if the user can open it, else land on their
  // first real one. Falling back to a tab they cannot see renders the header
  // over an empty body, which is what `: "roles"` used to do here.
  const active: TeamTabValue | null =
    requested && canViewTab[requested] ? requested : firstVisible;

  // No tab at all — say so instead of rendering a page with nothing under it.
  if (active === null)
    return (
      <Forbidden
        page="team"
        reason="Your position opens the Team page, but your role doesn't include any of its sections. Ask an administrator to update your role."
      />
    );

  const TAB_HEADER: Record<
    TeamTabValue,
    { eyebrow: string; title: string; description: string }
  > = {
    hub: {
      eyebrow: "System · Team",
      title: "Team",
      description: "Members, positions, org chart, departments and mailboxes — pick a section to manage.",
    },
    directory: {
      eyebrow: "Workspace · Team",
      title: "Directory",
      description:
        "Find people fast — department tree on the left, roster on the right, bulk actions on selection.",
    },
    orgchart2: {
      eyebrow: "Workspace · Hierarchy",
      title: "Org Chart",
      description:
        "Companies as lanes, departments as pills — expand a department to see its teams, drag cards to reassign.",
    },
    departments2: {
      eyebrow: "Workspace · Team",
      title: "Departments",
      description:
        "Company-wide headcount at a glance. A department without a lead surfaces in red.",
    },
    mail2: {
      eyebrow: "Workspace · Mail Center",
      title: "Mailboxes",
      description:
        "Personal and department mailboxes — orphaned mailboxes (member disabled, mail still arriving) surface for resolution.",
    },
    permissions: {
      eyebrow: "Workspace · Access Control",
      title: "Roles & Permissions",
      description:
        "What each position may do — load, dispatch, revert, invoice. Toggle a cell to change the grant; menus follow the position policy.",
    },
    members: {
      eyebrow: "Workspace · Members",
      title: "Members",
      description: "Manage who can access this workspace and what they can do.",
    },
    positions: {
      eyebrow: "Workspace · Access by Position",
      title: "Positions",
      description:
        "Set which pages each position can see (none / view / edit / full) — this drives the menu and blocks direct-URL access.",
    },
    orgchart: {
      eyebrow: "Workspace · Hierarchy",
      title: "Org Chart",
      description:
        "Who reports to whom. Reporting lines drive project access — a user sees projects where they or their manager is the PIC (when their role is scoped).",
    },
    departments: {
      eyebrow: "Workspace · Teams",
      title: "Departments",
      description:
        "Groupings for visibility only — colour-codes the org chart and tags members. Access control still runs through roles + reporting lines.",
    },
    roles: {
      eyebrow: "Workspace · Access Control",
      title: "Roles",
      description:
        "Define what each role can access. System roles are locked; create custom roles for fine-grained control.",
    },
    mail: {
      eyebrow: "Workspace · Mail Center",
      title: "Mailboxes",
      description:
        "Assign email addresses to people or departments, grant shared-mailbox access, and set each member's mail visibility.",
    },
  };

  const actions =
    active === "members" || active === "directory" ? (
      canInvite ? (
        <Button
          variant="brass"
          icon={<Plus size={14} />}
          onClick={() => setInviteOpen(true)}
        >
          Invite Member
        </Button>
      ) : null
    ) : active === "departments" || active === "departments2" ? (
      canManageUsers ? (
        <Button
          variant="brass"
          icon={<Plus size={14} />}
          onClick={() => setCreatingDept(true)}
        >
          New Department
        </Button>
      ) : null
    ) : active === "roles" ? (
      canManageRoles ? (
        <Button
          variant="brass"
          icon={<Plus size={14} />}
          onClick={() => setCreatingRole(true)}
        >
          New Role
        </Button>
      ) : null
    ) : null;

  return (
    <div>
      {active !== "hub" && (
        <TabStrip<TeamTabValue>
          value={active}
          onChange={setTab}
          options={tabs}
        />
      )}

      <PageHeader
        eyebrow={TAB_HEADER[active].eyebrow}
        title={TAB_HEADER[active].title}
        description={TAB_HEADER[active].description}
        actions={active === "hub" ? undefined : actions}
      />

      {active === "hub" && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {tabs
            .filter((t) => t.show !== false)
            .map((t) => {
              const Icon = TEAM_HUB_ICON[t.value] ?? Users;
              return (
                <button
                  key={t.value}
                  onClick={() => setTab(t.value)}
                  className="group flex flex-col gap-2.5 rounded-xl border border-border bg-surface p-4 text-left shadow-stone transition-all duration-150 hover:-translate-y-px hover:border-primary hover:shadow-slab"
                >
                  <span className="grid h-9 w-9 place-items-center rounded-lg bg-surface-2 text-ink-secondary transition-colors group-hover:bg-primary-soft group-hover:text-primary">
                    <Icon size={17} />
                  </span>
                  <span className="text-[13px] font-bold text-ink">{t.label}</span>
                  <span className="text-[11px] leading-snug text-ink-muted">
                    {TAB_HEADER[t.value].description}
                  </span>
                </button>
              );
            })}
        </div>
      )}

      {active === "directory" && canSeeMembers && (
        <TeamDirectory
          inviteOpen={inviteOpen}
          onCloseInvite={() => setInviteOpen(false)}
          salesDirScoped={salesDirScoped}
        />
      )}
      {active === "orgchart2" && canSeeMembers && <TeamOrgChartV2 />}
      {active === "departments2" && canSeeMembers && (
        <TeamDepartmentsV2
          creating={creatingDept}
          onCloseCreate={() => setCreatingDept(false)}
        />
      )}
      {active === "mail2" && canManageMail && <TeamMailboxesV2 />}
      {active === "permissions" && canRoles && <TeamRolesV2 />}
      {active === "members" && canSeeMembers && (
        <MembersTab
          inviteOpen={inviteOpen}
          onCloseInvite={() => setInviteOpen(false)}
          salesDirScoped={salesDirScoped}
        />
      )}
      {/* Unreachable by design: canViewTab.positions is false, so `active` can
          never resolve to "positions" and this never mounts. Kept (not deleted)
          so the editor is one line from being restored if the owner turns it
          back on — flip canViewTab.positions to canManageUsers. */}
      {active === "positions" && canManageUsers && <PositionsTab />}
      {active === "orgchart" && canSeeMembers && <OrgChartTab />}
      {active === "departments" && canSeeMembers && (
        <DepartmentsTab
          creating={creatingDept}
          onCloseCreate={() => setCreatingDept(false)}
        />
      )}
      {active === "roles" && canRoles && (
        <RolesTab
          creating={creatingRole}
          onCloseCreate={() => setCreatingRole(false)}
        />
      )}
      {active === "mail" && canManageMail && <MailboxesTab />}
    </div>
  );
}

// ──────────────────────────────────────────────────────────
// Windowed card grid — renders only the rows scrolled into view
// ──────────────────────────────────────────────────────────
// The Members card-grid view (owner 2026-07-24: the DEFAULT is the LIST view;
// the grid stays one toggle away). Rendering EVERY card
// unvirtualized freezes the page once the workspace grows (10× users). This
// windows the grid the same way the desktop DataTable and MobileVirtualList do:
// a CAPTURING window scroll listener (scroll events don't bubble) measures the
// grid against the viewport, and only the visible slice of ROWS is mounted,
// bracketed by two spacer divs that reserve the off-screen height so the page
// scrollbar behaves exactly as before. Card height is measured from a real
// rendered card and the live column count is read from the grid's computed
// `grid-template-columns`, so the responsive `grid-cols-*` breakpoints and the
// card layout are preserved verbatim — nothing about the columns is re-encoded
// here. No-op below `threshold`: a small team renders byte-identically to the
// plain `.map` grid it replaces.
const GRID_VIRTUAL_THRESHOLD = 40;
const GRID_OVERSCAN_ROWS = 3;
const GRID_GAP = 12; // px — matches Tailwind `gap-3` (0.75rem) on the grid
const CARD_HEIGHT_ESTIMATE = 168; // px; corrected at runtime by measuring a real card

// Live column count from the grid's resolved template (e.g. "296px 296px 296px"
// → 3). Follows the responsive breakpoints without re-encoding them.
function gridColumnCount(grid: HTMLElement): number {
  const tpl = getComputedStyle(grid).gridTemplateColumns;
  const n = tpl && tpl !== "none" ? tpl.split(" ").filter(Boolean).length : 1;
  return Math.max(1, n);
}

function VirtualMemberGrid<T>({
  items,
  renderItem,
  gridClassName,
  gap = GRID_GAP,
  threshold = GRID_VIRTUAL_THRESHOLD,
  overscanRows = GRID_OVERSCAN_ROWS,
  estimateHeight = CARD_HEIGHT_ESTIMATE,
}: {
  items: T[];
  /** Must return an element with a stable `key` (the caller owns it). */
  renderItem: (item: T, index: number) => ReactNode;
  /** The exact grid classes (`grid grid-cols-2 gap-3 …`) so the responsive
   *  column count + card layout stay identical to the un-windowed grid. */
  gridClassName: string;
  gap?: number;
  threshold?: number;
  overscanRows?: number;
  estimateHeight?: number;
}) {
  const on = items.length > threshold;
  const containerRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const rowHRef = useRef(estimateHeight + gap);
  const [range, setRange] = useState<{
    start: number;
    end: number;
    topPad: number;
    botPad: number;
  }>({ start: 0, end: Math.min(items.length, threshold * 2), topPad: 0, botPad: 0 });

  useEffect(() => {
    if (!on) return;
    let raf = 0;
    const measure = () => {
      raf = 0;
      const container = containerRef.current;
      const grid = gridRef.current;
      if (!container || !grid) return;
      const cols = gridColumnCount(grid);
      const card = grid.firstElementChild as HTMLElement | null;
      if (card && card.offsetHeight > 0) rowHRef.current = card.offsetHeight + gap;
      const rh = rowHRef.current || estimateHeight + gap;
      const totalRows = Math.ceil(items.length / cols);
      const top = container.getBoundingClientRect().top; // grid top vs viewport
      const firstRow = Math.max(0, Math.floor(-top / rh) - overscanRows);
      const visRows = Math.ceil(window.innerHeight / rh) + overscanRows * 2;
      const lastRow = Math.min(totalRows, firstRow + visRows);
      const start = firstRow * cols;
      const end = Math.min(items.length, lastRow * cols);
      const topPad = firstRow * rh;
      const botPad = (totalRows - lastRow) * rh;
      setRange((p) =>
        p.start === start && p.end === end && p.topPad === topPad && p.botPad === botPad
          ? p
          : { start, end, topPad, botPad },
      );
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener("scroll", onScroll, { capture: true, passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [on, items.length, overscanRows, estimateHeight, gap]);

  // Below the threshold: byte-identical to the plain grid it replaces.
  if (!on) {
    return (
      <div className={gridClassName}>
        {items.map((item, i) => renderItem(item, i))}
      </div>
    );
  }

  const start = range.start;
  const end = Math.min(items.length, range.end);
  return (
    <div ref={containerRef}>
      {start > 0 && <div aria-hidden style={{ height: range.topPad }} />}
      <div ref={gridRef} className={gridClassName}>
        {items.slice(start, end).map((item, i) => renderItem(item, start + i))}
      </div>
      {end < items.length && <div aria-hidden style={{ height: range.botPad }} />}
    </div>
  );
}

// ──────────────────────────────────────────────────────────
// Members tab — active users + pending invitations
// ──────────────────────────────────────────────────────────
function MembersTab({
  inviteOpen,
  onCloseInvite,
  salesDirScoped = false,
}: {
  inviteOpen: boolean;
  onCloseInvite: () => void;
  /** Sales Director (non-admin) — invite is forced into HIS department and the
   *  Position/Role pickers are hidden (backend forces dept + defaults role). */
  salesDirScoped?: boolean;
}) {
  const { user: me, can } = useAuth();
  const toast = useToast();
  const dialog = useDialog();

  // NOTE: unbounded fetch — pulls ALL users in one request; the grid below is
  // DOM-windowed, but fetch pagination is a separate follow-up.
  const members = useQuery<{ users: TeamMember[] }>("/api/users", () => api.get("/api/users"));
  const invites = useQuery<{ invitations: Invitation[] }>("/api/users/invitations", () =>
    api.get("/api/users/invitations")
  );
  // PERF: these were refetchOnMount "always" + staleTime 0, which forced a
  // full-screen load on EVERY Team visit. Freshness is already guaranteed
  // without that: every create/update goes through the MutationCache hook
  // (lib/queryClient.ts) which invalidates same-tab queries and broadcasts
  // to sibling tabs — and invalidation ignores staleTime. A 60s staleTime
  // just lets a plain revisit serve the cached snapshot instantly.
  const freshList = { staleTime: 60_000 };
  const roles = useQuery<{ roles: Role[] }>("/api/roles",
    () => api.get("/api/roles"),
    [],
    freshList,
  );
  const depts = useQuery<{ departments: Department[] }>("/api/departments",
    () => api.get("/api/departments"),
    [],
    freshList,
  );
  const positions = useQuery<{ positions: Position[] }>("/api/positions",
    () => api.get("/api/positions"),
    [],
    freshList,
  );
  // Live presence — who's online right now (active in the last few minutes).
  const presence = useQuery<{ active: { id: number }[] }>("/api/presence", () =>
    api.get("/api/presence")
  );
  // Multi-company (Phase 0e). Gate the per-user Company-access control on there
  // being a real choice (>1 company). Pre-activation this returns 0/1 companies
  // so the control stays hidden — single-company Houzs is unchanged.
  const companiesQ = useQuery<{
    companies: Array<{ id: number; code: string; name: string }>;
  }>("/api/companies", () => api.get("/api/companies"), [], freshList);
  const companyOpts: CompanyOpt[] = companiesQ.data?.companies ?? [];
  const multiCompany = companyOpts.length > 1;
  const onlineIds = useMemo(
    () => new Set((presence.data?.active ?? []).map((a) => a.id)),
    [presence.data],
  );
  // Lookup for resolving a member's extra department ids → name/colour.
  const deptById = useMemo(() => {
    const m = new Map<number, Department>();
    for (const d of depts.data?.departments ?? []) m.set(d.id, d);
    return m;
  }, [depts.data]);

  // Members-list filters (owner ask: filter/sort by department and/or position).
  const [filterDept, setFilterDept] = useState<number | "">("");
  const [filterPos, setFilterPos] = useState<number | "">("");
  const [filterStatus, setFilterStatus] = useState<"" | "active" | "invited" | "disabled">("");
  // One-click segments to surface misconfigured / stale accounts.
  // Multi-select: any number of segments can be active; each adds a
  // constraint (AND), the same way the dropdown filters compose.
  const [quickFilters, setQuickFilters] = useState<Set<string>>(new Set());
  const toggleQuick = (key: string) =>
    setQuickFilters((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  const [filterRole, setFilterRole] = useState<number | "">("");
  const [filterBrand, setFilterBrand] = useState<string>("");
  const [filterCompany, setFilterCompany] = useState<number | "">("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [searchQ, setSearchQ] = useState("");
  // Card grid (reference look) vs. dense table. Grid is the default.
  /* Owner 2026-07-24: Members opens in the LIST view by default ("team member
     - default view是listing"). Identity-scoped preference still wins, so
     anyone who explicitly picked the grid keeps it. */
  const [view, setView] = useIdentityPreference("team:view", "list", enumPreference(["grid", "list"] as const));
  /* Invitations collapse by default: the freeze cap yields row height to any
     content below the members table, so an always-open second table squeezed
     members to the 240px floor (owner 2026-07-28: "member 显示太少了"). */
  const [invitesView, setInvitesView] = useIdentityPreference(
    "team:invites",
    "collapsed",
    enumPreference(["open", "collapsed"] as const),
  );
  const invitesOpen = invitesView === "open";
  // Grid ordering (the table view has its own column sort).
  const [gridSort, setGridSort] = useIdentityPreference(
    "team:gridSort",
    "name",
    enumPreference(["name", "recent", "status"] as const),
  );

  // Per-user brand picker — opens a small modal scoped to one member.
  // Member being edited in the side panel (name/email/phone/org + actions).
  const [editing, setEditing] = useState<TeamMember | null>(null);
  // Member whose full-screen detail is open. Stored by id so it re-reads
  // from the live list after an edit/reload instead of going stale.
  const [viewingId, setViewingId] = useState<number | null>(null);
  // Invitation row whose resend is in flight (spinner + disable).
  const [resendingId, setResendingId] = useState<number | null>(null);

  const canManage = can("users.manage");
  // `salesDirScoped` arrives as a prop (a dept-scoped Sales Director). It gates
  // the member-detail Edit + enable/disable actions (backend enforces the
  // own-dept + no-role/dept/password scope).

  // Staging-only "login as member": the backend probe reports enabled only
  // when the worker runs with IMPERSONATION_ENABLED (staging vars block), so
  // the button never appears on prod even though it's the same bundle.
  const [canImpersonate, setCanImpersonate] = useState(false);
  useEffect(() => {
    if (!canManage) return;
    let alive = true;
    api
      .get<{ enabled: boolean }>("/api/users/impersonation-enabled")
      .then((r) => {
        if (alive) setCanImpersonate(!!r.enabled);
      })
      .catch(() => {
        /* disabled or unreachable — keep the button hidden */
      });
    return () => {
      alive = false;
    };
  }, [canManage]);

  async function loginAs(u: TeamMember) {
    if (
      !(await dialog.confirm(
        `Log in as ${u.name || u.email}?\n\nYour current session will be replaced — to come back, log out and sign in with your own account again.`
      ))
    )
      return;
    try {
      const res = await api.post<{ token: string }>(`/api/users/${u.id}/impersonate`, {});
      tokenStore.set(res.token, true);
      // Full reload so the app re-bootstraps as the target user everywhere.
      window.location.assign("/");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not log in as this member");
    }
  }

  function reload() {
    members.reload();
    invites.reload();
  }

  // Per-field inline editing moved into the Edit Member panel — it sends
  // one PATCH with all changed fields (name/email/phone/department/
  // position/reports-to), keeping the members table read-only and tidy.

  // Sending a reset link does NOT change the account (backend users.ts
  // /:id/reset-password). The old copy promised a logout that the old handler
  // really did perform; both are gone. The link is never shown here — it is a
  // live credential and it belongs only in the member's mailbox.
  async function sendReset(u: TeamMember) {
    if (
      !(await dialog.confirm(
        `Send a password reset link to ${u.email}?\n\nNothing changes until they click it — their current password and any active sessions keep working. The link expires in 1 hour and can be used once.`
      ))
    )
      return;
    try {
      const res = await api.post<{
        ok: boolean;
        expires_at: string;
        email: string;
        email_sent?: boolean;
        email_status?: string;
      }>(`/api/users/${u.id}/reset-password`);
      if (res.email_sent) {
        toast.success(`Reset link emailed to ${u.email} — expires in 1 hour`);
      } else {
        toast.error(
          `Email not sent (${res.email_status || "check Settings, Email"}) — nothing was changed on the account`
        );
      }
    } catch (e: any) {
      toast.error(e?.message || "Failed to send reset");
    }
  }

  // Admin set / clear a member's POS PIN (backend /api/pos/admin-*-pin/:userId,
  // users.manage-gated). The admin TYPES the 6-digit PIN — a login credential is
  // entered into the tool by the person, not stored or defaulted by us. The
  // member can change it themselves afterwards via the POS.
  async function setPosPin(u: TeamMember) {
    const pin = await dialog.prompt({
      title: `Set POS PIN for ${u.name || u.email}`,
      message: "6 digits. They can change it themselves later.",
      placeholder: "6-digit PIN",
      required: true,
      confirmLabel: "Set PIN",
    });
    if (pin == null) return;
    if (!/^\d{6}$/.test(pin.trim())) {
      toast.error("PIN must be exactly 6 digits");
      return;
    }
    try {
      await api.post(`/api/pos/admin-set-pin/${u.id}`, { pin: pin.trim() });
      toast.success(`POS PIN set for ${u.name || u.email}`);
    } catch (e: any) {
      toast.error(e?.message || "Failed to set PIN");
    }
  }

  // Re-send the invite email to a member who hasn't joined yet, keyed by
  // user id (the member row). Reuses the existing invite token — only the
  // email is fired again.
  async function resendInviteForUser(u: TeamMember) {
    try {
      const res = await api.post<{
        ok: boolean;
        invite_url: string;
        email_sent?: boolean;
        email_status?: string;
      }>(`/api/users/${u.id}/resend-invite`);
      if (res.email_sent) {
        toast.success(`Invitation emailed to ${u.email}`);
      } else {
        toast.error(
          `Email not sent (${res.email_status || "check Settings, Email"}) — use Copy Link on the pending invite instead`
        );
      }
    } catch (e: any) {
      toast.error(e?.message || "Failed to resend invitation");
    }
  }

  async function toggleStatus(u: TeamMember) {
    const next = u.status === "active" ? "disabled" : "active";
    const body: Record<string, unknown> = { status: next };
    if (next === "disabled") {
      const reason = await dialog.prompt({
        title: `Disable ${u.name || u.email}?`,
        message: "Optional — note why. Shown on their profile and cleared if re-enabled.",
        placeholder: "e.g. left the company",
        confirmLabel: "Disable",
      });
      if (reason === null) return; // cancelled
      body.status_reason = reason.trim() || null;
    }
    try {
      await api.patch(`/api/users/${u.id}`, body);
      toast.success(`${u.email} ${next === "active" ? "enabled" : "disabled"}`);
      members.reload();
    } catch (e: any) {
      toast.error(e?.message || "Something went wrong. Please try again.");
    }
  }

  async function removeUser(u: TeamMember) {
    // True hard-delete via ?hard=1. Backend errors out with a helpful
    // message if FK references block it; in that case the admin should
    // use the Disable button (soft-delete) instead.
    const confirmed = await dialog.confirm(
      `Permanently delete ${u.email}?\n\n` +
        "This wipes their account, sessions, audit log entries, and engagement history. " +
        "Trips, sales entries, and projects they created may block the delete — " +
        "use Disable instead for users with real activity.",
    );
    if (!confirmed) return;
    try {
      await api.del(`/api/users/${u.id}?hard=1`);
      toast.success(`${u.email} permanently deleted`);
      reload();
    } catch (e: any) {
      toast.error(e?.message || "Something went wrong. Please try again.");
    }
  }

  async function revokeInvite(inv: Invitation) {
    if (!(await dialog.confirm(`Revoke invitation for ${inv.email}?`))) return;
    try {
      await api.del(`/api/users/invitations/${inv.id}`);
      toast.success("Invitation revoked");
      reload();
    } catch (e: any) {
      toast.error(e?.message || "Something went wrong. Please try again.");
    }
  }

  const expiredInvites = (invites.data?.invitations ?? []).filter(
    (inv) => new Date(inv.expires_at).getTime() < Date.now(),
  );

  async function revokeAllExpired() {
    if (expiredInvites.length === 0) return;
    if (
      !(await dialog.confirm(
        `Revoke ${expiredInvites.length} expired invitation${expiredInvites.length === 1 ? "" : "s"}? This can't be undone.`,
      ))
    )
      return;
    try {
      await Promise.all(
        expiredInvites.map((inv) => api.del(`/api/users/invitations/${inv.id}`)),
      );
      toast.success(`Revoked ${expiredInvites.length} expired invitation(s)`);
      invites.reload();
    } catch (e: any) {
      toast.error(e?.message || "Failed to revoke some invitations");
    }
  }

  function copyInviteLink(inv: Invitation) {
    const link = inviteLink(inv);
    navigator.clipboard.writeText(link).then(
      () => toast.success("Invite link copied to clipboard"),
      () => toast.error("Couldn't access clipboard")
    );
  }

  async function resendInvite(inv: Invitation) {
    setResendingId(inv.id);
    try {
      const res = await api.post<{
        ok: boolean;
        email_sent: boolean;
        email_status?: string;
      }>(`/api/users/invitations/${inv.id}/resend`);
      if (res.email_sent) {
        toast.success(`Invitation emailed to ${inv.email}`);
      } else {
        toast.error(
          `Email not sent (${res.email_status || "check Settings, Email"}) — use Copy Link instead`
        );
      }
      invites.reload();
    } catch (e: any) {
      toast.error(e?.message || "Failed to resend invitation");
    } finally {
      setResendingId(null);
    }
  }

  const posNameById = useMemo(() => {
    const m = new Map<number, string>();
    for (const p of positions.data?.positions ?? []) m.set(p.id, p.name);
    return m;
  }, [positions.data]);
  const filteredMembers = useMemo(() => {
    const q = searchQ.trim().toLowerCase();
    const DAY = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const segMatch = (key: string, u: TeamMember) => {
      switch (key) {
        case "no_login":
          return !u.last_login_at;
        case "no_dept":
          return u.department_id == null;
        case "no_pos":
          return u.position_id == null;
        case "no_mgr":
          return u.manager_id == null;
        case "stale":
          return !!u.last_login_at && now - new Date(u.last_login_at).getTime() > 30 * DAY;
        case "online":
          return onlineIds.has(u.id);
        case "joined7d":
          return !!u.joined_at && now - new Date(u.joined_at).getTime() <= 7 * DAY;
        case "no_photo":
          return !u.profile_pic_r2_key;
        default:
          return true;
      }
    };
    const segs = [...quickFilters];
    return (members.data?.users ?? []).filter(
      (u) =>
        (filterDept === "" || inDept(u, filterDept as number)) &&
        (filterPos === "" || u.position_id === filterPos) &&
        (filterStatus === "" || u.status === filterStatus) &&
        (filterRole === "" || u.role_id === filterRole) &&
        (filterBrand === "" || (u.brands ?? []).includes(filterBrand)) &&
        (filterCompany === "" || (u.company_ids ?? []).includes(filterCompany as number)) &&
        segs.every((k) => segMatch(k, u)) &&
        (q === "" ||
          (u.name || "").toLowerCase().includes(q) ||
          (u.email || "").toLowerCase().includes(q) ||
          (u.phone || "").replace(/[\s-]/g, "").includes(q.replace(/[\s-]/g, "")) ||
          (u.role_name || "").toLowerCase().includes(q) ||
          (u.department_name || "").toLowerCase().includes(q) ||
          (u.position_id != null
            ? (posNameById.get(u.position_id) || "").toLowerCase().includes(q)
            : false)),
    );
  }, [
    members.data,
    filterDept,
    filterPos,
    filterStatus,
    filterRole,
    filterBrand,
    filterCompany,
    quickFilters,
    onlineIds,
    searchQ,
    posNameById,
  ]);

  // Distinct brands across members — drives the brand filter dropdown.
  const allBrands = useMemo(() => {
    const s = new Set<string>();
    for (const u of members.data?.users ?? []) for (const b of u.brands ?? []) s.add(b);
    return [...s].sort();
  }, [members.data]);

  // Active-filter bookkeeping for the Filters popover + removable pills.
  const statusLabels: Record<string, string> = {
    active: "Active",
    invited: "Pending",
    disabled: "Disabled",
  };
  const activeFilters: { label: string; clear: () => void }[] = [];
  if (filterStatus)
    activeFilters.push({ label: statusLabels[filterStatus], clear: () => setFilterStatus("") });
  if (filterDept !== "")
    activeFilters.push({
      label: depts.data?.departments.find((d) => d.id === filterDept)?.name ?? "Department",
      clear: () => setFilterDept(""),
    });
  if (filterPos !== "")
    activeFilters.push({
      label: posNameById.get(filterPos as number) ?? "Position",
      clear: () => setFilterPos(""),
    });
  if (filterRole !== "")
    activeFilters.push({
      label: roles.data?.roles.find((r) => r.id === filterRole)?.name ?? "Role",
      clear: () => setFilterRole(""),
    });
  if (filterBrand)
    activeFilters.push({ label: filterBrand, clear: () => setFilterBrand("") });
  if (filterCompany !== "")
    activeFilters.push({
      label: companyOpts.find((co) => co.id === filterCompany)?.name ?? "Company",
      clear: () => setFilterCompany(""),
    });
  for (const key of quickFilters)
    activeFilters.push({
      label: QUICK_SEGMENTS.find(([k]) => k === key)?.[1] ?? "Segment",
      clear: () => toggleQuick(key),
    });

  function clearAllFilters() {
    setFilterStatus("");
    setFilterDept("");
    setFilterPos("");
    setFilterRole("");
    setFilterBrand("");
    setFilterCompany("");
    setQuickFilters(new Set());
  }

  // Grid ordering (table view keeps its own column sort).
  const gridMembers = useMemo(() => {
    const arr = filteredMembers.slice();
    if (gridSort === "name") {
      arr.sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email));
    } else if (gridSort === "recent") {
      arr.sort(
        (a, b) =>
          new Date(b.last_login_at || 0).getTime() - new Date(a.last_login_at || 0).getTime(),
      );
    } else if (gridSort === "status") {
      const rank: Record<string, number> = { active: 0, invited: 1, disabled: 2 };
      arr.sort(
        (a, b) =>
          (rank[a.status] ?? 9) - (rank[b.status] ?? 9) ||
          (a.name || a.email).localeCompare(b.name || b.email),
      );
    }
    return arr;
  }, [filteredMembers, gridSort]);

  // Status tallies for the stat strip (reference layout). Mirrors the
  // member lifecycle: active / invited (pending) / disabled (archived).
  const counts = useMemo(() => {
    const all = members.data?.users ?? [];
    return {
      total: all.length,
      active: all.filter((u) => u.status === "active").length,
      invited: all.filter((u) => u.status === "invited").length,
      disabled: all.filter((u) => u.status === "disabled").length,
    };
  }, [members.data]);

  // Click a stat card to toggle that status filter (like the reference).
  function pickStatus(s: "active" | "invited" | "disabled") {
    setFilterStatus((cur) => (cur === s ? "" : s));
  }

  // Status strip under the section header — same slab as the SO list's
  // status tabs, counts baked into the labels over the FULL member set.
  const statusPillOptions = [
    { value: "all" as const, label: `All · ${counts.total}` },
    { value: "active" as const, label: `Active · ${counts.active}` },
    { value: "invited" as const, label: `Pending · ${counts.invited}` },
    { value: "disabled" as const, label: `Disabled · ${counts.disabled}` },
  ];

  // How many members report to each manager — powers the hidden
  // "Direct Reports" column without a backend round-trip.
  const directReports = useMemo(() => {
    const m = new Map<number, number>();
    for (const u of members.data?.users ?? []) {
      if (u.manager_id != null) m.set(u.manager_id, (m.get(u.manager_id) ?? 0) + 1);
    }
    return m;
  }, [members.data]);

  // Re-read the viewed member from the live list so the detail page stays
  // current after an edit reload (rather than holding a stale snapshot).
  const viewing =
    viewingId != null
      ? (members.data?.users.find((u) => u.id === viewingId) ?? null)
      : null;

  // ── Bulk selection (list view) ─────────────────────────────────
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const bulkBusyRef = useRef(false);
  function beginBulk(): boolean {
    if (bulkBusyRef.current) return false;
    bulkBusyRef.current = true;
    setBulkBusy(true);
    return true;
  }
  function endBulk() {
    bulkBusyRef.current = false;
    setBulkBusy(false);
  }
  function toggleSelect(id: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }
  function clearSelect() {
    setSelectedIds(new Set());
  }
  // Only ever act on rows the admin may modify (manageable + not self).
  const selectableFiltered = filteredMembers.filter(
    (u) => canManage && u.id !== me?.id,
  );
  function selectAllFiltered() {
    setSelectedIds(new Set(selectableFiltered.map((u) => u.id)));
  }
  async function bulkPatch(fields: Record<string, unknown>, label: string) {
    const ids = [...selectedIds];
    if (ids.length === 0 || !beginBulk()) return;
    try {
      const results = await allSettledBounded(
        ids.map((id) => () => api.patch(`/api/users/${id}`, fields)),
      );
      const ok = results.filter((r) => r.status === "fulfilled").length;
      const failed = ids.length - ok;
      if (failed === 0) toast.success(`${label} — ${ok} member${ok === 1 ? "" : "s"}`);
      else toast.error(`${label}: ${ok} done, ${failed} failed`);
      clearSelect();
      members.reload();
    } catch (e: any) {
      toast.error(e?.message || "Bulk action failed");
    } finally {
      endBulk();
    }
  }

  // Two SEPARATE bulk actions, kept distinct on purpose so re-inviting the
  // not-yet-onboarded never touches (and never logs out) active members:
  //   • Resend invites  → only pending (status "invited") rows
  //   • Reset passwords → only active rows (deliberate, confirmed, logs sessions out)
  const selectedInvited = selectableFiltered.filter(
    (u) => selectedIds.has(u.id) && u.status === "invited",
  );
  const selectedActive = selectableFiltered.filter(
    (u) => selectedIds.has(u.id) && u.status === "active",
  );
  async function bulkResendInvites() {
    const targets = selectedInvited;
    if (targets.length === 0 || !beginBulk()) return;
    try {
      const results = await allSettledBounded(
        targets.map((u) => () =>
          api.post<{ email_sent?: boolean }>(`/api/users/${u.id}/resend-invite`),
        ),
      );
      const sent = results.filter(
        (r) => r.status === "fulfilled" && r.value?.email_sent,
      ).length;
      const failed = targets.length - sent;
      if (failed === 0) {
        toast.success(`Resent ${sent} invitation${sent === 1 ? "" : "s"}`);
      } else {
        toast.error(`Resent ${sent}, ${failed} not emailed — use Copy Link on those`);
      }
      clearSelect();
      members.reload();
    } catch (e: any) {
      toast.error(e?.message || "Failed to resend invitations");
    } finally {
      endBulk();
    }
  }
  async function bulkResetPasswords() {
    const targets = selectedActive;
    if (targets.length === 0 || bulkBusyRef.current) return;
    const ok = await dialog.confirm(
      `Send a password-reset link to ${targets.length} active member${targets.length === 1 ? "" : "s"}?\n\n` +
        `Nothing changes for anyone who doesn't click — passwords and active sessions keep working. Each link expires in 1 hour. This does NOT touch pending invites.`,
    );
    if (!ok) return;
    if (!beginBulk()) return;
    try {
      const results = await allSettledBounded(
        targets.map((u) => () =>
          api.post<{ email_sent?: boolean }>(`/api/users/${u.id}/reset-password`),
        ),
      );
      const sent = results.filter(
        (r) => r.status === "fulfilled" && r.value?.email_sent,
      ).length;
      const failed = targets.length - sent;
      if (failed === 0) {
        toast.success(`Sent ${sent} reset link${sent === 1 ? "" : "s"}`);
      } else {
        toast.error(`Sent ${sent}, ${failed} not emailed — use Reset on those individually`);
      }
      clearSelect();
      members.reload();
    } catch (e: any) {
      toast.error(e?.message || "Failed to send reset links");
    } finally {
      endBulk();
    }
  }

  const memberColumns: Column<TeamMember>[] = [
    ...(canManage
      ? [
          {
            key: "select",
            label: "",
            width: "36px",
            alwaysVisible: true,
            disableSort: true,
            renderHeader: () => {
              const all =
                selectableFiltered.length > 0 &&
                selectableFiltered.every((u) => selectedIds.has(u.id));
              const some = selectableFiltered.some((u) => selectedIds.has(u.id));
              return (
                <input
                  type="checkbox"
                  checked={all}
                  disabled={bulkBusy}
                  ref={(el) => {
                    if (el) el.indeterminate = some && !all;
                  }}
                  onChange={() => (all ? clearSelect() : selectAllFiltered())}
                  onClick={(e) => e.stopPropagation()}
                  className="h-3.5 w-3.5 cursor-pointer accent-[#a16a2e]"
                  aria-label="Select all members"
                  title="Select all"
                />
              );
            },
            render: (u: TeamMember) =>
              u.id === me?.id ? (
                <span className="block w-3.5" />
              ) : (
                <input
                  type="checkbox"
                  checked={selectedIds.has(u.id)}
                  disabled={bulkBusy}
                  onChange={() => toggleSelect(u.id)}
                  onClick={(e) => e.stopPropagation()}
                  className="h-3.5 w-3.5 cursor-pointer accent-[#a16a2e]"
                  aria-label={`Select ${u.name || u.email}`}
                />
              ),
          } as Column<TeamMember>,
        ]
      : []),
    {
      key: "name",
      label: "Member",
      getValue: (u) => u.name || u.email || "",
      render: (u) => (
        <div className="flex min-w-0 items-center gap-2.5">
          <Avatar
            userId={u.id}
            hasImage={u.profile_pic_r2_key}
            name={u.name}
            email={u.email}
            size={32}
          />
          <StatusDot
            variant={
              u.status === "active"
                ? "synced"
                : u.status === "disabled"
                ? "error"
                : "neutral"
            }
          />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-[13px] font-semibold text-ink">
                {u.name || u.email}
              </span>
              {u.id === me?.id && (
                <span className="shrink-0 rounded bg-accent-soft px-1.5 py-px font-mono text-[9px] font-semibold uppercase tracking-wider text-accent-ink">
                  You
                </span>
              )}
            </div>
            <div className="truncate text-[11px] text-ink-muted">
              {u.email}
              {u.phone ? ` · ${formatPhone(u.phone)}` : ""}
            </div>
          </div>
        </div>
      ),
    },
    {
      key: "status",
      label: "Status",
      width: "100px",
      getValue: (u) => statusLabels[u.status] ?? u.status,
      render: (u) => (
        <Badge
          tone={
            u.status === "active"
              ? "success"
              : u.status === "disabled"
              ? "error"
              : "warning"
          }
          size="xs"
        >
          {statusLabels[u.status] ?? u.status}
        </Badge>
      ),
    },
    {
      key: "department",
      label: "Department",
      width: "150px",
      getValue: (u) => u.department_name || "",
      render: (u) =>
        u.department_name ? (
          <span className="inline-flex min-w-0 items-center gap-1.5 text-[12px] text-ink-secondary">
            {u.department_color && (
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: `#${u.department_color}` }}
              />
            )}
            <span className="truncate">{u.department_name}</span>
            <ExtraDeptCount user={u} deptById={deptById} />
          </span>
        ) : (
          <span className="text-[12px] text-ink-muted">—</span>
        ),
    },
    {
      key: "position",
      label: "Position",
      width: "160px",
      getValue: (u) =>
        u.position_id != null ? posNameById.get(u.position_id) || "" : "",
      render: (u) => (
        <span className="truncate text-[12px] text-ink-secondary">
          {u.position_id != null ? posNameById.get(u.position_id) || "—" : "—"}
        </span>
      ),
    },
    ...(multiCompany
      ? [
          {
            key: "company",
            label: "Company",
            width: "110px",
            getValue: (u: TeamMember) =>
              companyLabelFor(u.company_ids ?? [], companyOpts),
            render: (u: TeamMember) => {
              const label = companyLabelFor(u.company_ids ?? [], companyOpts);
              return (
                <span
                  className={cn(
                    "inline-flex items-center rounded-full border px-2 py-px text-[11px] font-semibold",
                    label === "Both"
                      ? "border-accent/40 bg-accent-soft text-accent-ink"
                      : "border-border bg-surface-dim text-ink-secondary",
                  )}
                >
                  {label}
                </span>
              );
            },
          } as Column<TeamMember>,
        ]
      : []),
    {
      key: "last_seen",
      label: "Last Seen",
      width: "110px",
      getValue: (u) => u.last_login_at || "",
      render: (u) => (
        <span className="truncate text-[11px] text-ink-muted">
          {u.last_login_at ? relativeTime(u.last_login_at) : "never"}
        </span>
      ),
    },
    {
      key: "manager",
      label: "Reports to",
      width: "160px",
      getValue: (u) => u.manager_name || u.manager_email || "",
      render: (u) => (
        <span className="truncate text-[12px] text-ink-secondary">
          {u.manager_name || u.manager_email || "—"}
        </span>
      ),
    },
    /* Reveal-on-demand columns (SO-list parity) — every field /api/users
       already returns, so the Columns panel decides, not the payload. */
    {
      key: "email",
      label: "Email",
      width: "220px",
      defaultHidden: true,
      getValue: (u) => u.email || "",
      render: (u) => (
        <span className="truncate text-[12px] text-ink-secondary">{u.email}</span>
      ),
    },
    {
      key: "phone",
      label: "Phone",
      width: "140px",
      defaultHidden: true,
      getValue: (u) => u.phone || "",
      render: (u) => (
        <span className="truncate font-mono text-[12px] text-ink-secondary">
          {u.phone ? formatPhone(u.phone) : "—"}
        </span>
      ),
    },
    {
      key: "role",
      label: "Role",
      width: "140px",
      defaultHidden: true,
      getValue: (u) => u.role_name || "",
      render: (u) => (
        <span className="truncate text-[12px] text-ink-secondary">
          {u.role_name || "—"}
        </span>
      ),
    },
    {
      key: "division",
      label: "Division",
      width: "130px",
      defaultHidden: true,
      getValue: (u) => u.division || "",
      render: (u) => (
        <span className="truncate text-[12px] text-ink-secondary">
          {u.division || "—"}
        </span>
      ),
    },
    {
      key: "brands",
      label: "Brands",
      width: "170px",
      defaultHidden: true,
      getValue: (u) => (u.brands ?? []).join(", "),
      render: (u) =>
        (u.brands ?? []).length ? (
          <span className="flex flex-wrap gap-1">
            {(u.brands ?? []).map((b) => (
              <Badge key={b} tone="accent" size="xs" caseless>
                {b}
              </Badge>
            ))}
          </span>
        ) : (
          <span className="text-[12px] text-ink-muted">—</span>
        ),
    },
    {
      key: "email_alias",
      label: "Email Alias",
      width: "190px",
      defaultHidden: true,
      getValue: (u) => u.email_alias || "",
      render: (u) => (
        <span className="truncate text-[12px] text-ink-secondary">
          {u.email_alias || "—"}
        </span>
      ),
    },
    {
      key: "presence",
      label: "Presence",
      width: "100px",
      defaultHidden: true,
      getValue: (u) => (onlineIds.has(u.id) ? "Online" : "Offline"),
      render: (u) => (
        <span className="inline-flex items-center gap-1.5 text-[11px] text-ink-secondary">
          <StatusDot variant={onlineIds.has(u.id) ? "synced" : "neutral"} />
          {onlineIds.has(u.id) ? "Online" : "Offline"}
        </span>
      ),
    },
    {
      key: "direct_reports",
      label: "Direct Reports",
      width: "110px",
      align: "right",
      defaultHidden: true,
      getValue: (u) => directReports.get(u.id) ?? 0,
      render: (u) => {
        const n = directReports.get(u.id) ?? 0;
        return n > 0 ? (
          <span className="font-mono text-[12px] text-ink-secondary">{n}</span>
        ) : (
          <span className="text-[12px] text-ink-muted">—</span>
        );
      },
    },
    {
      key: "invited_at",
      label: "Invited",
      width: "110px",
      defaultHidden: true,
      getValue: (u) => u.invited_at || "",
      render: (u) => (
        <span className="font-mono text-[11px] text-ink-muted">
          {fmtDay(u.invited_at)}
        </span>
      ),
    },
    {
      key: "invited_by",
      label: "Invited By",
      width: "160px",
      defaultHidden: true,
      getValue: (u) => u.invited_by_name || u.invited_by_email || "",
      render: (u) => (
        <span className="truncate text-[12px] text-ink-secondary">
          {u.invited_by_name || u.invited_by_email || "—"}
        </span>
      ),
    },
    {
      key: "joined_at",
      label: "Joined",
      width: "110px",
      defaultHidden: true,
      getValue: (u) => u.joined_at || "",
      render: (u) => (
        <span className="font-mono text-[11px] text-ink-muted">
          {fmtDay(u.joined_at)}
        </span>
      ),
    },
    {
      key: "created_at",
      label: "Created",
      width: "110px",
      defaultHidden: true,
      getValue: (u) => u.created_at || "",
      render: (u) => (
        <span className="font-mono text-[11px] text-ink-muted">
          {fmtDay(u.created_at)}
        </span>
      ),
    },
    {
      key: "status_reason",
      label: "Status Reason",
      width: "180px",
      defaultHidden: true,
      getValue: (u) => u.status_reason || "",
      render: (u) => (
        <span className="truncate text-[12px] text-ink-muted">
          {u.status_reason || "—"}
        </span>
      ),
    },
    {
      key: "actions",
      label: "",
      width: "168px",
      align: "right",
      render: (u) => {
        const manageable = canManage && u.id !== me?.id;
        if (!manageable) return <span className="text-[11px] text-ink-muted">—</span>;
        return (
          <span className="inline-flex items-center gap-1">
            {canImpersonate && u.status === "active" && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  loginAs(u);
                }}
                title="Log in as this member"
                aria-label="Log in as this member"
                className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 text-[11px] font-semibold text-ink-secondary transition-colors hover:border-accent/40 hover:bg-accent-soft/50 hover:text-accent"
              >
                <LogIn size={12} /> Login as
              </button>
            )}
            <button
              onClick={(e) => {
                e.stopPropagation();
                setEditing(u);
              }}
              title="Edit member"
              aria-label="Edit member"
              className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 text-[11px] font-semibold text-ink-secondary transition-colors hover:border-accent/40 hover:bg-accent-soft/50 hover:text-accent"
            >
              <Pencil size={12} /> Edit
            </button>
          </span>
        );
      },
    },
  ];

  // ── Pending invitations table (Theme C DataTable) — expiry buckets and
  //    the copied link come from lib/invitations, shared with the mobile
  //    MobileInvitations card. ──────────────────────────────────────
  /* No getValue carries token/invite_url — the CSV export must never
     contain a live invite credential. Copy Link stays a per-row action. */
  const inviteColumns: Column<Invitation>[] = [
    {
      key: "email",
      label: "Email",
      getValue: (inv) => inv.email || "",
      render: (inv) => (
        <span className="truncate text-[13px] font-semibold text-ink">{inv.email}</span>
      ),
    },
    {
      key: "role",
      label: "Role",
      width: "150px",
      getValue: (inv) => inv.role_name || "",
      render: (inv) =>
        inv.role_name ? (
          <span className="rounded bg-accent-soft px-1.5 py-px font-mono text-[9px] font-semibold uppercase tracking-wider text-accent-ink">
            {inv.role_name}
          </span>
        ) : (
          <span className="text-[12px] text-ink-muted">—</span>
        ),
    },
    {
      key: "status",
      label: "Status",
      width: "120px",
      getValue: (inv) =>
        inviteExpiry(inv) === "expired"
          ? "Expired"
          : inviteExpiry(inv) === "expiring"
          ? "Expiring soon"
          : "Pending",
      render: (inv) => {
        const s = inviteExpiry(inv);
        return s === "expired" ? (
          <Badge tone="error" size="xs">
            Expired
          </Badge>
        ) : s === "expiring" ? (
          <Badge tone="warning" size="xs">
            Expiring soon
          </Badge>
        ) : (
          <Badge tone="neutral" size="xs">
            Pending
          </Badge>
        );
      },
    },
    {
      key: "invited",
      label: "Invited",
      width: "110px",
      getValue: (inv) => inv.created_at || "",
      render: (inv) => (
        <span className="text-[11px] text-ink-muted" title={fmtDay(inv.created_at)}>
          {relativeTime(inv.created_at)}
        </span>
      ),
    },
    {
      key: "expires",
      label: "Expires",
      width: "120px",
      getValue: (inv) => inv.expires_at || "",
      render: (inv) => (
        <span
          className={cn(
            "text-[11px]",
            inviteExpiry(inv) === "expired" ? "font-semibold text-err" : "text-ink-muted",
          )}
          title={fmtDay(inv.expires_at)}
        >
          {relativeTime(inv.expires_at)}
        </span>
      ),
    },
    {
      key: "emailed",
      label: "Emailed",
      width: "120px",
      getValue: (inv) =>
        inv.email_status === "sent"
          ? inv.emailed_at || "sent"
          : inv.email_status
          ? "not sent"
          : "",
      render: (inv) =>
        inv.email_status === "sent" ? (
          <span className="text-[11px] text-ink-muted">
            {inv.emailed_at ? relativeTime(inv.emailed_at) : "sent"}
          </span>
        ) : inv.email_status ? (
          <Badge tone="warning" size="xs">
            Not sent
          </Badge>
        ) : (
          <span className="text-[11px] text-ink-muted">—</span>
        ),
    },
    {
      key: "invited_by",
      label: "Invited By",
      width: "180px",
      defaultHidden: true,
      getValue: (inv) => inv.invited_by_email || "",
      render: (inv) => (
        <span className="truncate text-[12px] text-ink-secondary">
          {inv.invited_by_email || "—"}
        </span>
      ),
    },
    ...(canManage
      ? [
          {
            key: "invite_actions",
            label: "",
            width: "190px",
            align: "right",
            disableSort: true,
            render: (inv: Invitation) => (
              <span className="inline-flex items-center gap-1">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    resendInvite(inv);
                  }}
                  disabled={resendingId === inv.id}
                  className="rounded p-1.5 text-ink-muted transition-colors hover:bg-accent-soft hover:text-accent disabled:opacity-50"
                  aria-label="Resend invitation email"
                  title="Resend invitation email"
                >
                  <RefreshCw
                    size={14}
                    className={resendingId === inv.id ? "animate-spin" : undefined}
                  />
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    copyInviteLink(inv);
                  }}
                  className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-[11px] font-semibold uppercase tracking-wider text-ink-secondary transition-colors hover:border-accent/40 hover:bg-accent-soft/50 hover:text-accent"
                >
                  <Copy size={12} />
                  Copy Link
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    revokeInvite(inv);
                  }}
                  className="rounded p-1.5 text-ink-muted transition-colors hover:bg-err/10 hover:text-err"
                  aria-label="Revoke invitation"
                  title="Revoke invitation"
                >
                  <X size={14} />
                </button>
              </span>
            ),
          } as Column<Invitation>,
        ]
      : []),
  ];

  return (
    <div>
      {viewing ? (
        <MemberDetail
          user={viewing}
          members={members.data?.users ?? []}
          departments={depts.data?.departments ?? []}
          posName={
            viewing.position_id != null ? posNameById.get(viewing.position_id) : undefined
          }
          canManage={canManage && viewing.id !== me?.id}
          canEditScoped={(canManage || salesDirScoped) && viewing.id !== me?.id}
          online={onlineIds.has(viewing.id)}
          onBack={() => setViewingId(null)}
          onOpenMember={(id) => setViewingId(id)}
          onEdit={() => setEditing(viewing)}
          onSendReset={() => sendReset(viewing)}
          onSetPin={() => setPosPin(viewing)}
          onResendInvite={() => resendInviteForUser(viewing)}
          onToggleStatus={async () => {
            await toggleStatus(viewing);
          }}
          onRemove={async () => {
            await removeUser(viewing);
            setViewingId(null);
          }}
        />
      ) : (
      <>
      {/* Status overview — each card filters the list when clicked. */}
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          pending={members.loading && !members.data}
          label="Active Users"
          value={counts.active}
          subtitle="Can sign in"
          tone="success"
          rail="bg-synced"
          onClick={() => pickStatus("active")}
          active={filterStatus === "active"}
        />
        <StatCard
          pending={members.loading && !members.data}
          label="Pending Invites"
          value={counts.invited}
          subtitle="Awaiting first sign-in"
          tone="warning"
          rail="bg-accent"
          onClick={() => pickStatus("invited")}
          active={filterStatus === "invited"}
        />
        <StatCard
          pending={members.loading && !members.data}
          label="Disabled"
          value={counts.disabled}
          subtitle="Access revoked"
          tone="error"
          rail="bg-err"
          onClick={() => pickStatus("disabled")}
          active={filterStatus === "disabled"}
        />
        <StatCard
          pending={members.loading && !members.data}
          label="Total Members"
          value={counts.total}
          subtitle="All accounts"
          rail="bg-primary"
          onClick={() => setFilterStatus("")}
          active={filterStatus === ""}
        />
      </div>

      {/* Members */}
      <div className="mb-6">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="h-px w-5 bg-accent" />
          <h2 className="text-[10px] font-bold uppercase tracking-brand text-accent">
            Members ({filteredMembers.length}/{members.data?.users.length ?? 0})
          </h2>
          <div className="ml-auto flex items-center gap-2">
            {/* List view searches inside the DataTable toolbar; the grid
                keeps its own box since the table chrome isn't mounted. */}
            {view === "grid" && (
              <div className="relative">
                <Search
                  size={12}
                  className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-muted"
                />
                <input
                  value={searchQ}
                  onChange={(e) => setSearchQ(e.target.value)}
                  placeholder="Search name, email, phone, role…"
                  className="h-7 w-48 rounded-md border border-border bg-surface pl-7 pr-2 text-[11px] text-ink outline-none placeholder:text-ink-muted hover:border-accent/50 focus:border-primary focus:ring-2 focus:ring-primary/20"
                />
              </div>
            )}

            {/* Filters — everything tucked into one popover to keep the bar tidy */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setFiltersOpen((o) => !o)}
                className={cn(
                  "inline-flex h-7 items-center gap-1.5 rounded-md border bg-surface px-2.5 text-[11px] font-semibold transition-colors",
                  activeFilters.length > 0
                    ? "border-accent/50 text-accent"
                    : "border-border text-ink-secondary hover:border-accent/40 hover:text-accent",
                )}
              >
                <SlidersHorizontal size={13} /> Filters
                {activeFilters.length > 0 && (
                  <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[9px] font-bold text-white">
                    {activeFilters.length}
                  </span>
                )}
              </button>
              {filtersOpen && (
                <>
                  <div
                    className="fixed inset-0 z-30"
                    onClick={() => setFiltersOpen(false)}
                    aria-hidden
                  />
                  <div className="absolute right-0 z-40 mt-1.5 w-64 rounded-lg border border-border bg-surface p-3 text-left shadow-slab">
                    <div className="space-y-2.5">
                      <div>
                        <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-ink-muted">
                          Department
                        </label>
                        <select
                          value={filterDept}
                          onChange={(e) => {
                            setFilterDept(e.target.value ? Number(e.target.value) : "");
                            setFilterPos("");
                          }}
                          className="h-8 w-full cursor-pointer rounded-md border border-border bg-surface px-2 text-[12px] text-ink outline-none hover:border-accent/50 focus:border-primary"
                        >
                          <option value="">All departments</option>
                          {depts.data?.departments.map((d) => (
                            <option key={d.id} value={d.id}>
                              {d.name}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-ink-muted">
                          Position
                        </label>
                        <select
                          value={filterPos}
                          onChange={(e) =>
                            setFilterPos(e.target.value ? Number(e.target.value) : "")
                          }
                          className="h-8 w-full cursor-pointer rounded-md border border-border bg-surface px-2 text-[12px] text-ink outline-none hover:border-accent/50 focus:border-primary"
                        >
                          <option value="">All positions</option>
                          {(positions.data?.positions ?? [])
                            .filter(
                              (p) =>
                                filterDept === "" ||
                                !p.department_id ||
                                p.department_id === filterDept,
                            )
                            .map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.name}
                              </option>
                            ))}
                        </select>
                      </div>
                      <div>
                        <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-ink-muted">
                          Role
                        </label>
                        <select
                          value={filterRole}
                          onChange={(e) =>
                            setFilterRole(e.target.value ? Number(e.target.value) : "")
                          }
                          className="h-8 w-full cursor-pointer rounded-md border border-border bg-surface px-2 text-[12px] text-ink outline-none hover:border-accent/50 focus:border-primary"
                        >
                          <option value="">All roles</option>
                          {(roles.data?.roles ?? []).map((r) => (
                            <option key={r.id} value={r.id}>
                              {r.name}
                            </option>
                          ))}
                        </select>
                      </div>
                      {allBrands.length > 0 && (
                        <div>
                          <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-ink-muted">
                            Brand
                          </label>
                          <select
                            value={filterBrand}
                            onChange={(e) => setFilterBrand(e.target.value)}
                            className="h-8 w-full cursor-pointer rounded-md border border-border bg-surface px-2 text-[12px] text-ink outline-none hover:border-accent/50 focus:border-primary"
                          >
                            <option value="">All brands</option>
                            {allBrands.map((b) => (
                              <option key={b} value={b}>
                                {b}
                              </option>
                            ))}
                          </select>
                        </div>
                      )}
                      {companyOpts.length > 1 && (
                        <div>
                          <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-ink-muted">
                            Company
                          </label>
                          <select
                            value={filterCompany}
                            onChange={(e) =>
                              setFilterCompany(e.target.value ? Number(e.target.value) : "")
                            }
                            className="h-8 w-full cursor-pointer rounded-md border border-border bg-surface px-2 text-[12px] text-ink outline-none hover:border-accent/50 focus:border-primary"
                          >
                            <option value="">All companies</option>
                            {companyOpts.map((co) => (
                              <option key={co.id} value={co.id}>
                                {co.name}
                              </option>
                            ))}
                          </select>
                        </div>
                      )}
                    </div>

                    <div className="mt-3 border-t border-border-subtle pt-3">
                      <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-ink-muted">
                        Quick segments
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {QUICK_SEGMENTS.map(([key, label]) => {
                          const on = quickFilters.has(key);
                          return (
                            <button
                              key={key}
                              type="button"
                              onClick={() => toggleQuick(key)}
                              className={cn(
                                "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] font-medium transition-colors",
                                on
                                  ? "border-accent/50 bg-accent-soft text-accent"
                                  : "border-border bg-surface text-ink-secondary hover:border-accent/40 hover:text-accent",
                              )}
                            >
                              {on && <Check size={10} className="-ml-0.5" />}
                              {label}
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    {activeFilters.length > 0 && (
                      <button
                        type="button"
                        onClick={clearAllFilters}
                        className="mt-3 w-full rounded-md border border-border px-2 py-1.5 text-[11px] font-semibold text-ink-secondary transition-colors hover:border-err/40 hover:text-err"
                      >
                        Clear all filters
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>

            {view === "grid" && (
              <select
                value={gridSort}
                onChange={(e) => setGridSort(e.target.value as "name" | "recent" | "status")}
                title="Sort cards"
                className="h-7 cursor-pointer rounded-md border border-border bg-surface pl-2 pr-6 text-[11px] text-ink outline-none hover:border-accent/50 focus:border-primary"
              >
                <option value="name">Sort: Name</option>
                <option value="recent">Sort: Recently active</option>
                <option value="status">Sort: Status</option>
              </select>
            )}
            <div className="flex items-center rounded-md border border-border bg-surface p-0.5">
              <button
                type="button"
                onClick={() => setView("grid")}
                title="Card grid"
                aria-label="Card grid view"
                className={cn(
                  "inline-flex h-6 w-7 items-center justify-center rounded",
                  view === "grid" ? "bg-accent-soft text-accent" : "text-ink-muted hover:text-ink",
                )}
              >
                <LayoutGrid size={13} />
              </button>
              <button
                type="button"
                onClick={() => setView("list")}
                title="List"
                aria-label="List view"
                className={cn(
                  "inline-flex h-6 w-7 items-center justify-center rounded",
                  view === "list" ? "bg-accent-soft text-accent" : "text-ink-muted hover:text-ink",
                )}
              >
                <List size={13} />
              </button>
            </div>
          </div>
        </div>

        {/* Status strip — SO-list pattern: one slab, counts in the labels.
            Mirrors the stat cards' filter (both drive filterStatus). */}
        <div className="mb-3">
          <FilterPills
            options={statusPillOptions}
            value={filterStatus === "" ? "all" : filterStatus}
            onChange={(v) => setFilterStatus(v === "all" ? "" : v)}
          />
        </div>

        {/* Active filters — removable pills so applied filters are visible. */}
        {activeFilters.length > 0 && (
          <div className="mb-3 flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] font-medium uppercase tracking-wide text-ink-muted">
              Filtered by
            </span>
            {activeFilters.map((f, i) => (
              <span
                key={i}
                className="inline-flex items-center gap-1 rounded-full border border-border bg-surface py-0.5 pl-2 pr-1 text-[10.5px] font-medium text-ink-secondary shadow-stone"
              >
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                {f.label}
                <button
                  type="button"
                  onClick={f.clear}
                  className="rounded-full p-0.5 text-ink-muted transition-colors hover:bg-err/10 hover:text-err"
                  aria-label={`Remove ${f.label} filter`}
                >
                  <X size={11} />
                </button>
              </span>
            ))}
            <button
              type="button"
              onClick={clearAllFilters}
              className="ml-1 text-[10.5px] text-ink-muted underline-offset-2 transition-colors hover:text-err hover:underline"
            >
              Clear all
            </button>
          </div>
        )}

        {view === "list" ? (
          <DataTable
            tableId="team-members"
            columns={memberColumns}
            rows={members.data ? filteredMembers : null}
            loading={members.loading}
            error={members.error}
            getRowKey={(u) => u.id}
            onRowClick={(u) => setViewingId(u.id)}
            emptyLabel="No members match these filters."
            exportName="team-members"
            search={{
              value: searchQ,
              onChange: setSearchQ,
              placeholder: "Search name, email, phone, role…",
              totalRecords: filteredMembers.length,
            }}
          />
        ) : members.loading && !members.data ? (
          <ListSkeleton rows={6} />
        ) : gridMembers.length === 0 ? (
          <EmptyState compact message="No members match these filters." />
        ) : (
          // Windowed so only the on-screen rows (plus overscan) are in the DOM;
          // the grid classes are handed through verbatim so the responsive
          // column count and card layout are unchanged.
          <VirtualMemberGrid
            items={gridMembers}
            gridClassName="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4"
            renderItem={(u) => (
              <MemberCard
                key={u.id}
                u={u}
                posName={u.position_id != null ? posNameById.get(u.position_id) : undefined}
                isYou={u.id === me?.id}
                online={onlineIds.has(u.id)}
                onOpen={() => setViewingId(u.id)}
              />
            )}
          />
        )}

        {/* Bulk action bar — appears when rows are selected (list view). */}
        {view === "list" && selectedIds.size > 0 && (
          <div className="sticky bottom-3 z-20 mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-accent/40 bg-surface px-3 py-2 shadow-slab">
            <span className="text-[12px] font-semibold text-ink">
              {bulkBusy ? "Working…" : `${selectedIds.size} selected`}
            </span>
            {selectedIds.size < selectableFiltered.length && (
              <button
                type="button"
                onClick={selectAllFiltered}
                disabled={bulkBusy}
                className="text-[11px] font-medium text-accent hover:underline"
              >
                Select all {selectableFiltered.length}
              </button>
            )}
            <span className="mx-1 h-4 w-px bg-border" />
            <button
              type="button"
              onClick={() => bulkPatch({ status: "active" }, "Enabled")}
              disabled={bulkBusy}
              className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 text-[11px] font-semibold text-ink-secondary transition-colors hover:border-accent/40 hover:bg-accent-soft/50 hover:text-accent"
            >
              <UserCheck size={12} /> Enable
            </button>
            <button
              type="button"
              onClick={() => bulkPatch({ status: "disabled" }, "Disabled")}
              disabled={bulkBusy}
              className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 text-[11px] font-semibold text-ink-secondary transition-colors hover:border-accent/40 hover:bg-accent-soft/50 hover:text-accent"
            >
              <UserX size={12} /> Disable
            </button>
            {selectedInvited.length > 0 && (
              <button
                type="button"
                onClick={bulkResendInvites}
                disabled={bulkBusy}
                className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 text-[11px] font-semibold text-ink-secondary transition-colors hover:border-accent/40 hover:bg-accent-soft/50 hover:text-accent"
                title="Re-send the invitation email to the pending (not-yet-onboarded) members in your selection. Does not touch active members."
              >
                <Mail size={12} /> Resend {selectedInvited.length} invite{selectedInvited.length === 1 ? "" : "s"}
              </button>
            )}
            {selectedActive.length > 0 && (
              <button
                type="button"
                onClick={bulkResetPasswords}
                disabled={bulkBusy}
                className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 text-[11px] font-semibold text-ink-secondary transition-colors hover:border-accent/40 hover:bg-accent-soft/50 hover:text-accent"
                title="Send a password-reset link to the active members in your selection. Logs out their sessions; confirms first."
              >
                <KeyRound size={12} /> Reset {selectedActive.length} password{selectedActive.length === 1 ? "" : "s"}
              </button>
            )}
            <select
              defaultValue=""
              disabled={bulkBusy}
              onChange={(e) => {
                if (e.target.value) {
                  bulkPatch({ department_id: Number(e.target.value) }, "Department updated");
                  e.target.value = "";
                }
              }}
              className="h-7 cursor-pointer rounded-md border border-border bg-surface pl-2 pr-6 text-[11px] text-ink outline-none hover:border-accent/50 focus:border-primary"
            >
              <option value="" disabled>
                Set department…
              </option>
              {depts.data?.departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
            <select
              defaultValue=""
              disabled={bulkBusy}
              onChange={(e) => {
                if (e.target.value) {
                  bulkPatch({ position_id: Number(e.target.value) }, "Position updated");
                  e.target.value = "";
                }
              }}
              className="h-7 cursor-pointer rounded-md border border-border bg-surface pl-2 pr-6 text-[11px] text-ink outline-none hover:border-accent/50 focus:border-primary"
            >
              <option value="" disabled>
                Set position…
              </option>
              {(positions.data?.positions ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={clearSelect}
              disabled={bulkBusy}
              className="ml-1 text-[11px] font-medium text-ink-muted transition-colors hover:text-err"
            >
              Clear
            </button>
          </div>
        )}
      </div>

      {/* Pending invitations — collapsed by default so the members table
          keeps the full freeze height (the row cap yields to content below). */}
      <div className="mb-6">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setInvitesView(invitesOpen ? "collapsed" : "open")}
            aria-expanded={invitesOpen}
            className="group inline-flex items-center gap-2"
          >
            <span className="h-px w-5 bg-accent" />
            <h2 className="text-[10px] font-bold uppercase tracking-brand text-accent underline-offset-2 group-hover:underline">
              Pending Invitations ({invites.data?.invitations.length ?? 0})
            </h2>
            {invitesOpen ? (
              <ChevronDown size={12} className="text-accent" />
            ) : (
              <ChevronRight size={12} className="text-accent" />
            )}
          </button>
          {!invitesOpen && expiredInvites.length > 0 && (
            <Badge tone="error" size="xs">
              {expiredInvites.length} expired
            </Badge>
          )}
          {canManage && expiredInvites.length > 0 && (
            <button
              type="button"
              onClick={revokeAllExpired}
              className="ml-auto inline-flex items-center gap-1 rounded-md border border-err/30 bg-surface px-2.5 py-1 text-[10.5px] font-semibold text-err transition-colors hover:bg-err/10"
            >
              <Trash2 size={12} /> Revoke {expiredInvites.length} expired
            </button>
          )}
        </div>
        {invitesOpen && (
          <DataTable
            tableId="team-invitations"
            columns={inviteColumns}
            rows={invites.data ? invites.data.invitations : null}
            loading={invites.loading}
            error={invites.error}
            getRowKey={(inv) => inv.id}
            emptyLabel="No pending invitations."
            exportName="team-invitations"
            getRowClassName={(inv) =>
              inviteExpiry(inv) === "expired" ? "opacity-60" : undefined
            }
          />
        )}
      </div>
      </>
      )}

      <InvitePanel
        open={inviteOpen}
        onClose={onCloseInvite}
        roles={roles.data?.roles ?? []}
        departments={depts.data?.departments ?? []}
        positions={positions.data?.positions ?? []}
        members={members.data?.users ?? []}
        companies={companyOpts}
        multiCompany={multiCompany}
        lockDeptId={salesDirScoped ? me?.department_id ?? null : undefined}
        onInvited={() => {
          onCloseInvite();
          reload();
        }}
      />

      {editing && (
        <EditMemberPanel
          user={editing}
          departments={depts.data?.departments ?? []}
          positions={positions.data?.positions ?? []}
          members={members.data?.users ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            members.reload();
          }}
          onChanged={() => members.reload()}
          onSendReset={(u) => sendReset(u)}
          onResendInvite={(u) => resendInviteForUser(u)}
          onToggleStatus={async (u) => {
            await toggleStatus(u);
            setEditing(null);
          }}
          onRemove={async (u) => {
            await removeUser(u);
            setEditing(null);
          }}
          multiCompany={multiCompany}
          companies={companyOpts}
        />
      )}

    </div>
  );
}

// Bordered column card with a bold header — the right-hand groups on the
// member detail page (reference layout: profile on the left, grouped
// columns on the right).
function DetailCol({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface shadow-stone">
      <div className="border-b border-border px-4 py-2.5 text-[10.5px] font-bold uppercase tracking-wide text-ink-secondary">
        {title}
      </div>
      <div className="space-y-2.5 px-4 py-3.5">{children}</div>
    </div>
  );
}

// "service_cases.cases" → "Service cases · Cases" for the page-access list.
function prettyPageKey(key: string): string {
  return key
    .split(".")
    .map((part) =>
      part
        .replace(/_/g, " ")
        .replace(/\b\w/, (c) => c.toUpperCase()),
    )
    .join(" · ");
}

function DetailKV({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-ink-muted">
        {label}
      </span>
      <span className="min-w-0 truncate text-right text-[12.5px] text-ink">{children}</span>
    </div>
  );
}

/**
 * Full-screen member detail (reference layout, Houzs theme): a profile card
 * on the left, grouped columns on the right — Organisation, Direct reports,
 * Access & Activity. All data comes from the members payload (no extra
 * fetch). Manage actions live on the profile card; clicking a direct report
 * navigates to their detail.
 */
function MemberDetail({
  user,
  members,
  departments,
  posName,
  canManage,
  canEditScoped,
  online,
  onBack,
  onOpenMember,
  onEdit,
  onSendReset,
  onSetPin,
  onResendInvite,
  onToggleStatus,
  onRemove,
}: {
  user: TeamMember;
  members: TeamMember[];
  departments: Department[];
  posName?: string;
  canManage: boolean;
  canEditScoped: boolean;
  online?: boolean;
  onBack: () => void;
  onOpenMember: (id: number) => void;
  onEdit: () => void;
  onSendReset: () => void;
  onSetPin?: () => void;
  onResendInvite: () => void;
  onToggleStatus: () => void | Promise<void>;
  onRemove: () => void | Promise<void>;
}) {
  const reports = members
    .filter((m) => m.manager_id === user.id)
    .slice()
    .sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email));

  // Departments this member belongs to beyond the primary (mig 0020).
  const deptById = new Map(departments.map((d) => [d.id, d]));
  const extraDepts = extraDeptIdsOf(user)
    .map((id) => deptById.get(id))
    .filter((d): d is Department => !!d);

  // Pages this member can reach, via their position's access matrix. The
  // endpoint returns a { page_key: { explicit, level } } MAP (not an array),
  // so flatten it to a sorted list of the pages actually granted.
  const pageAccessQ = useQuery<{
    page_access: Record<string, { explicit?: boolean; level: string }>;
  }>("position-page-access#user",
    () =>
      user.position_id != null
        ? api.get(`/api/positions/${user.position_id}/page-access`)
        : Promise.resolve({ page_access: {} }),
    [user.position_id],
  );
  const grantedPages = Object.entries(pageAccessQ.data?.page_access ?? {})
    .map(([page_key, v]) => ({ page_key, level: v?.level ?? "none" }))
    .filter((p) => p.level && p.level !== "none")
    .sort((a, b) => a.page_key.localeCompare(b.page_key));

  const tone: "success" | "warning" | "error" | "neutral" =
    user.status === "active"
      ? "success"
      : user.status === "invited"
      ? "warning"
      : user.status === "disabled"
      ? "error"
      : "neutral";
  const statusLabel =
    user.status === "active"
      ? "Active"
      : user.status === "invited"
      ? "Pending invite"
      : user.status === "disabled"
      ? "Disabled"
      : user.status;
  const isActive = user.status === "active";
  const actionCls =
    "inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-border bg-surface px-3 py-2 text-[12px] font-semibold text-ink-secondary transition-colors hover:border-accent/40 hover:bg-accent-soft/50 hover:text-accent";

  // When the detail opens (or switches member) the grid it replaced may have
  // been scrolled down — bring the detail into view so it doesn't render above
  // the viewport and look like nothing happened.
  const topRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    topRef.current?.scrollIntoView({ block: "start", behavior: "auto" });
  }, [user.id]);

  /* Tab state · ?view=overview (default) | ?view=org-performance. URL-state
     so a deep-link or refresh lands on the right tab; the existing default
     (no query string) still lands on Overview. */
  const [searchParams, setSearchParams] = useSearchParams();
  const view: "overview" | "org-performance" =
    searchParams.get("view") === "org-performance" ? "org-performance" : "overview";
  const setView = (next: "overview" | "org-performance") => {
    const sp = new URLSearchParams(searchParams);
    if (next === "overview") sp.delete("view");
    else sp.set("view", next);
    setSearchParams(sp, { replace: true });
  };

  return (
    <div ref={topRef}>
      <button
        type="button"
        onClick={onBack}
        className="mb-4 inline-flex items-center gap-1.5 text-[12px] font-medium text-ink-muted transition-colors hover:text-accent"
      >
        <ArrowLeft size={14} /> Back to members
      </button>

      {/* Tab strip — Overview / Org & Performance. Brands & Commission stays a side-drawer. */}
      <div className="mb-4 flex items-center gap-1 border-b border-border" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={view === "overview"}
          onClick={() => setView("overview")}
          className={cn(
            "px-3 py-2 text-[12.5px] font-semibold transition-colors",
            view === "overview"
              ? "text-primary shadow-[inset_0_-2px_0_var(--tw-color-primary,#16695f)]"
              : "text-ink-muted hover:text-ink",
          )}
          style={
            view === "overview"
              ? { boxShadow: "inset 0 -2px 0 #16695f" }
              : undefined
          }
        >
          Overview
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === "org-performance"}
          onClick={() => setView("org-performance")}
          className={cn(
            "px-3 py-2 text-[12.5px] font-semibold transition-colors",
            view === "org-performance"
              ? "text-primary"
              : "text-ink-muted hover:text-ink",
          )}
          style={
            view === "org-performance"
              ? { boxShadow: "inset 0 -2px 0 #16695f" }
              : undefined
          }
        >
          Org &amp; Performance
        </button>
      </div>

      {view === "org-performance" && (
        <MemberOrgPerformance
          user={user}
          members={members}
          posName={posName}
          onOpenMember={onOpenMember}
        />
      )}

      {view === "overview" && (
      <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
        {/* Profile card */}
        <div className="self-start rounded-lg border border-border bg-surface p-5 shadow-stone">
          <div className="flex flex-col items-center text-center">
            <span className="relative">
              <Avatar
                userId={user.id}
                hasImage={user.profile_pic_r2_key}
                name={user.name}
                email={user.email}
                size={80}
              />
              {online && (
                <span
                  className="absolute bottom-1 right-1 h-3.5 w-3.5 rounded-full border-2 border-surface bg-synced"
                  title="Online now"
                />
              )}
            </span>
            <h2 className="mt-3 text-[16px] font-bold leading-tight text-ink">
              {user.name || user.email}
            </h2>
            <div className="mt-0.5 text-[12px] text-ink-muted">
              {posName || "—"}
              {user.department_name ? ` · ${user.department_name}` : ""}
            </div>
            <div className="mt-2 flex items-center justify-center gap-1.5">
              <Badge tone={tone} size="sm">
                {statusLabel}
              </Badge>
              {online && (
                <span className="text-[11px] font-medium text-synced">● Online</span>
              )}
            </div>
            {user.status === "disabled" && user.status_reason && (
              <div className="mt-2 w-full rounded-md border border-err/20 bg-err/5 px-2.5 py-1.5 text-left text-[11px] text-err">
                <span className="font-semibold">Disabled:</span> {user.status_reason}
              </div>
            )}
          </div>

          <div className="mt-4 space-y-2 border-t border-border-subtle pt-4">
            {user.phone && (
              <div className="flex items-center gap-2 text-[12px] text-ink-secondary">
                <Phone size={12} className="shrink-0 text-ink-muted" />
                <span className="truncate">{formatPhone(user.phone)}</span>
              </div>
            )}
            <div className="flex items-center gap-2 text-[12px] text-ink-secondary">
              <Mail size={12} className="shrink-0 text-ink-muted" />
              <span className="truncate" title="Login email">{user.email}</span>
            </div>
            {user.email_alias && (
              <div
                className="flex items-center gap-2 text-[12px] text-ink-secondary"
                title="Mail Center alias — the member's outward email address"
              >
                <AtSign size={12} className="shrink-0 text-ink-muted" />
                <span className="truncate">{user.email_alias}</span>
              </div>
            )}
          </div>

          {(canManage || canEditScoped) && (
            <div className="mt-4 grid gap-2 border-t border-border-subtle pt-4">
              {/* Edit + enable/disable are available to a full admin AND a
                  dept-scoped Sales Director; the rest stay full-admin only. */}
              <Button variant="brass" className="w-full" icon={<Pencil size={13} />} onClick={onEdit}>
                Edit member
              </Button>
              {canManage && user.status !== "invited" && (
                <button type="button" onClick={onSendReset} className={actionCls}>
                  <KeyRound size={13} /> Reset password
                </button>
              )}
              {canManage && onSetPin && (
                <button type="button" onClick={onSetPin} className={actionCls}>
                  <KeyRound size={13} /> Set POS PIN
                </button>
              )}
              {canManage && user.status === "invited" && (
                <button type="button" onClick={onResendInvite} className={actionCls}>
                  <Mail size={13} /> Resend invitation
                </button>
              )}
              <button type="button" onClick={onToggleStatus} className={actionCls}>
                {isActive ? <UserX size={13} /> : <UserCheck size={13} />}
                {isActive ? "Disable account" : "Enable account"}
              </button>
              {canManage && (
                <button
                  type="button"
                  onClick={onRemove}
                  className="inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-err/30 bg-surface px-3 py-2 text-[12px] font-semibold text-err transition-colors hover:bg-err/10"
                >
                  <Trash2 size={13} /> Delete permanently
                </button>
              )}
            </div>
          )}
        </div>

        {/* Grouped columns */}
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <DetailCol title="Organisation">
            <DetailKV label="Department">
              {user.department_name || extraDepts.length > 0 ? (
                <span className="inline-flex flex-wrap items-center gap-1.5">
                  {user.department_name && (
                    <span className="inline-flex items-center gap-1.5">
                      {user.department_color && (
                        <span
                          className="h-2 w-2 shrink-0 rounded-full"
                          style={{ backgroundColor: `#${user.department_color}` }}
                        />
                      )}
                      {user.department_name}
                    </span>
                  )}
                  {extraDepts.map((d) => (
                    <span
                      key={d.id}
                      className="inline-flex items-center gap-1 rounded-full bg-surface-dim px-1.5 py-px text-[11px] text-ink-secondary"
                    >
                      <span
                        className="h-1.5 w-1.5 shrink-0 rounded-full"
                        style={{ backgroundColor: `#${d.color}` }}
                      />
                      {d.name}
                    </span>
                  ))}
                </span>
              ) : (
                <span className="text-ink-muted">—</span>
              )}
            </DetailKV>
            <DetailKV label="Position">{posName || <span className="text-ink-muted">—</span>}</DetailKV>
            <DetailKV label="Division">{user.division || <span className="text-ink-muted">—</span>}</DetailKV>
            <DetailKV label="Role">{user.role_name || <span className="text-ink-muted">—</span>}</DetailKV>
            <DetailKV label="Reports to">
              {user.manager_name || user.manager_email || <span className="text-ink-muted">—</span>}
            </DetailKV>
          </DetailCol>

          <DetailCol title={`Direct reports (${reports.length})`}>
            {reports.length === 0 ? (
              <div className="py-1 text-[12px] text-ink-muted">No direct reports.</div>
            ) : (
              reports.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => onOpenMember(r.id)}
                  className="-mx-1.5 flex w-[calc(100%+0.75rem)] items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-accent-soft/40"
                >
                  <Avatar
                    userId={r.id}
                    hasImage={r.profile_pic_r2_key}
                    name={r.name}
                    email={r.email}
                    size={28}
                  />
                  <span className="min-w-0">
                    <span className="block truncate text-[12px] font-medium text-ink">
                      {r.name || r.email}
                    </span>
                    <span className="block truncate text-[10.5px] text-ink-muted">
                      {r.position_name || r.department_name || r.email}
                    </span>
                  </span>
                </button>
              ))
            )}
          </DetailCol>

          <DetailCol title={`Page access (${grantedPages.length})`}>
            {pageAccessQ.loading ? (
              <div className="py-1 text-[12px] text-ink-muted">Loading…</div>
            ) : user.position_id == null ? (
              <div className="py-1 text-[12px] text-ink-muted">
                No position set — no page access.
              </div>
            ) : grantedPages.length === 0 ? (
              <div className="py-1 text-[12px] text-ink-muted">No pages granted.</div>
            ) : (
              <div className="space-y-1.5">
                {grantedPages.map((p) => (
                  <div
                    key={p.page_key}
                    className="flex items-center justify-between gap-2 text-[12px]"
                  >
                    <span className="truncate text-ink-secondary">
                      {prettyPageKey(p.page_key)}
                    </span>
                    <Badge
                      tone={p.level === "full" ? "accent" : p.level === "edit" ? "success" : "neutral"}
                      size="xs"
                    >
                      {p.level}
                    </Badge>
                  </div>
                ))}
              </div>
            )}
          </DetailCol>

          <DetailCol title="Timeline">
            <DetailKV label="Created">{relativeTime(user.created_at)}</DetailKV>
            {user.invited_at && (
              <DetailKV label="Invited">{relativeTime(user.invited_at)}</DetailKV>
            )}
            {(user.invited_by_name || user.invited_by_email) && (
              <DetailKV label="Invited by">
                {user.invited_by_name || user.invited_by_email}
              </DetailKV>
            )}
            <DetailKV label="Joined">
              {user.joined_at ? relativeTime(user.joined_at) : <span className="text-ink-muted">—</span>}
            </DetailKV>
            <DetailKV label="Last sign-in">
              {user.last_login_at ? relativeTime(user.last_login_at) : "never"}
            </DetailKV>
            <DetailKV label="Presence">
              {online ? (
                <span className="font-medium text-synced">Online now</span>
              ) : (
                <span className="text-ink-muted">Offline</span>
              )}
            </DetailKV>
          </DetailCol>
        </div>
      </div>
      )}
    </div>
  );
}

/**
 * Member card for the grid view (reference layout, Houzs theme). Avatar +
 * name + position, contact lines, a status chip, and a hover "Edit" hint.
 * Clicking opens the Edit Member panel when the viewer can manage.
 */
function MemberCard({
  u,
  posName,
  isYou,
  online,
  onOpen,
}: {
  u: TeamMember;
  posName?: string;
  isYou: boolean;
  online?: boolean;
  onOpen: () => void;
}) {
  const tone: "success" | "warning" | "error" | "neutral" =
    u.status === "active"
      ? "success"
      : u.status === "invited"
      ? "warning"
      : u.status === "disabled"
      ? "error"
      : "neutral";
  const label =
    u.status === "active"
      ? "Active"
      : u.status === "invited"
      ? "Pending"
      : u.status === "disabled"
      ? "Disabled"
      : u.status;
  const inner = (
    <>
      <span className="absolute right-2 top-2">
        <Badge tone={tone} size="xs">
          {label}
        </Badge>
      </span>
      <span className="relative">
        <Avatar
          userId={u.id}
          hasImage={u.profile_pic_r2_key}
          name={u.name}
          email={u.email}
          size={56}
        />
        {online && (
          <span
            className="absolute bottom-0 right-0 h-3 w-3 rounded-full border-2 border-surface bg-synced"
            title="Online now"
          />
        )}
      </span>
      <div className="mt-2.5 w-full px-1">
        <div className="flex items-center justify-center gap-1.5">
          <span className="truncate text-[13px] font-semibold text-ink">
            {u.name || u.email}
          </span>
          {isYou && (
            <span className="shrink-0 rounded bg-accent-soft px-1 py-px font-mono text-[8px] font-semibold uppercase tracking-wider text-accent-ink">
              You
            </span>
          )}
        </div>
        <div className="truncate text-[11px] text-ink-muted">
          {posName || u.department_name || "—"}
        </div>
      </div>
      <div className="mt-2.5 w-full space-y-1 border-t border-border-subtle pt-2.5 text-left">
        {u.phone && (
          <div className="flex items-center gap-1.5 text-[11px] text-ink-secondary">
            <Phone size={11} className="shrink-0 text-ink-muted" />
            <span className="truncate">{formatPhone(u.phone)}</span>
          </div>
        )}
        <div className="flex items-center gap-1.5 text-[11px] text-ink-secondary">
          <Mail size={11} className="shrink-0 text-ink-muted" />
          <span className="truncate">{u.email}</span>
        </div>
      </div>
      <span className="pointer-events-none mt-2.5 inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-ink-muted opacity-0 transition-opacity group-hover:text-accent group-hover:opacity-100">
        View details
      </span>
    </>
  );
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "group relative flex flex-col items-center rounded-lg border border-border bg-surface p-4 text-center shadow-stone transition-all hover:-translate-y-px hover:border-accent/40 hover:shadow-slab",
        u.status === "disabled" && "opacity-70",
      )}
    >
      {inner}
    </button>
  );
}

/**
 * Edit Member side panel — the single hub for one member. Replaces the
 * inline per-row <select>s + the four text action buttons that cluttered
 * the table. Editable fields (name/email/phone/department/position/
 * reports-to) save in ONE PATCH; account actions (brands, reset, disable,
 * delete) are handed in from the parent so their confirms/toasts stay put.
 */
function EditMemberPanel({
  user,
  departments,
  positions,
  members,
  onClose,
  onSaved,
  onChanged,
  onSendReset,
  onResendInvite,
  onToggleStatus,
  onRemove,
  multiCompany,
  companies,
}: {
  user: TeamMember;
  departments: Department[];
  positions: Position[];
  members: TeamMember[];
  onClose: () => void;
  onSaved: () => void;
  /** Reload the list without closing the panel (e.g. after a photo change). */
  onChanged: () => void;
  onSendReset: (u: TeamMember) => void;
  onResendInvite: (u: TeamMember) => void;
  onToggleStatus: (u: TeamMember) => void | Promise<void>;
  onRemove: (u: TeamMember) => void | Promise<void>;
  multiCompany: boolean;
  companies: CompanyOpt[];
}) {
  const toast = useToast();
  const [name, setName] = useState(user.name || "");
  const [email, setEmail] = useState(user.email || "");
  const [emailAlias, setEmailAlias] = useState(user.email_alias || "");
  const [phone, setPhone] = useState(user.phone || "");
  const [deptId, setDeptId] = useState<number | "">(user.department_id ?? "");
  // Full department membership (mig 0020). Primary (deptId) is always part of
  // this set; extra chips add/remove the others.
  const [deptIds, setDeptIds] = useState<number[]>(() => deptIdsOf(user));
  const [positionId, setPositionId] = useState<number | "">(user.position_id ?? "");
  // Role editor re-added to the panel (owner 2026-07-20). Seeded from the
  // member's current role_id (never null in prod — invites default to the neutral
  // "Position Preview" role).
  const [roleId, setRoleId] = useState<number | "">(user.role_id ?? "");
  const [managerId, setManagerId] = useState<number | "">(user.manager_id ?? "");
  const [division, setDivision] = useState(user.division || "");
  // Company grants (Phase 0e). Seeded from the member's current grant set; an
  // empty set (legacy no-grant → fail-open ALL) shows no segment selected and,
  // if left untouched, is preserved unchanged.
  const [companyIds, setCompanyIds] = useState<number[]>(() => user.company_ids ?? []);
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [picBusy, setPicBusy] = useState(false);
  const [picBump, setPicBump] = useState(0);

  /* ── SHOWROOM PARKING (owner 2026-07-19) ────────────────────────────────
     The PRIMARY venue binding, and the reason it lives HERE rather than on a
     project: HR/admin parks a salesperson under a Showroom ONCE, on this
     panel, and every sales order that person raises from then on attributes to
     that showroom's venue — no per-event work, nothing to keep re-entering,
     and it keeps working when nobody touches a project team.

     An exhibition assignment still WINS over this default while that project
     is running (see backend lib/venue-binding.ts), and the salesperson can
     always override the venue on the order itself. This is the floor, not a
     lock. */
  const showrooms = useQuery<{ showrooms: ShowroomOption[] }>(
    "/api/scm/staff/showrooms",
    () => api.get("/api/scm/staff/showrooms"),
    [],
    { staleTime: 300_000 },
  );
  const qc = useQueryClient();
  const scmStaff = useQuery<{ staff: ScmStaffRow[] }>(
    "/api/scm/staff",
    () => api.get("/api/scm/staff"),
    [],
    { staleTime: 300_000 },
  );
  // Roles list for the Role editor. Role = what the member can DO (action
  // permissions + the "*" wildcard); Position (above) = what they can SEE. The
  // backend PATCH /api/users/:id already accepts + validates role_id (gated on
  // users.manage), so this is a frontend-only re-exposure of that control.
  const rolesQ = useQuery<{ roles: Role[] }>(
    "/api/roles",
    () => api.get("/api/roles"),
    [],
    { staleTime: 60_000 },
  );
  const roleList = (rolesQ.data?.roles ?? [])
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));
  /* The scm.staff row is joined by user_id — migration 0066's deterministic
     link between a Houzs user and their sales profile. No row means this
     member has no sales profile and cannot be parked; the UI says so rather
     than offering a control that would silently do nothing. */
  const myScmStaff = (scmStaff.data?.staff ?? []).find(
    (r) => Number(r.userId) === Number(user.id),
  );
  const [showroomId, setShowroomId] = useState<string>("");
  const [showroomDirty, setShowroomDirty] = useState(false);
  useEffect(() => {
    /* Seed from the server once loaded, but never stomp an edit in progress. */
    if (!showroomDirty) setShowroomId(myScmStaff?.showroomWarehouseId ?? "");
  }, [myScmStaff?.showroomWarehouseId, showroomDirty]);
  const selectedShowroom = (showrooms.data?.showrooms ?? []).find(
    (sr) => sr.id === showroomId,
  );

  async function uploadPic(rawFile: File) {
    if (!rawFile.type.startsWith("image/")) {
      toast.error("Pick an image file");
      return;
    }
    setPicBusy(true);
    try {
      // WO-7 — avatars render small; compress before upload (also absorbs
      // what used to be a hard "under 5 MB" rejection for phone shots).
      const { file } = await prepareImageForUpload(rawFile, { maxDimension: 1000, wantThumb: false });
      if (file.size > 5 * 1024 * 1024) {
        toast.error("Image must be under 5 MB");
        setPicBusy(false);
        return;
      }
      await api.putBinary(
        `/api/users/${user.id}/profile-pic?name=${encodeURIComponent(file.name)}`,
        file,
        file.type,
      );
      setPicBump((n) => n + 1); // remount the preview avatar to bust its cache
      onChanged();
      toast.success("Photo updated");
    } catch (e: any) {
      toast.error(e?.message || "Upload failed");
    } finally {
      setPicBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const inputCls =
    "h-10 w-full rounded-md border border-border bg-surface px-3 text-[13px] text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/20";
  const labelCls =
    "mb-1.5 block text-[10px] font-semibold uppercase tracking-brand text-ink-muted";
  const actionCls =
    "inline-flex w-full items-center gap-2 rounded-md border border-border bg-surface px-3 py-2 text-[12px] font-semibold text-ink-secondary transition-colors hover:border-accent/40 hover:bg-accent-soft/50 hover:text-accent";

  async function save() {
    const em = email.toLowerCase().trim();
    if (!em || !em.includes("@")) {
      toast.error("A valid email is required");
      return;
    }
    const patch: Record<string, unknown> = {};
    if (name.trim() !== (user.name || "")) patch.name = name.trim() || null;
    if (em !== (user.email || "")) patch.email = em;
    if ((emailAlias.trim() || null) !== (user.email_alias ?? null))
      patch.email_alias = emailAlias.trim().toLowerCase() || null;
    if (phone.trim() !== (user.phone || "")) patch.phone = phone.trim() || null;
    if ((deptId || null) !== (user.department_id ?? null)) patch.department_id = deptId || null;
    // Full membership set — always carry the primary; send only when changed.
    const finalDeptIds = (() => {
      const s = new Set(deptIds);
      if (deptId !== "") s.add(deptId);
      return [...s];
    })();
    const initialDeptIds = deptIdsOf(user);
    const sameDeptSet =
      finalDeptIds.length === initialDeptIds.length &&
      finalDeptIds.every((d) => initialDeptIds.includes(d));
    if (!sameDeptSet) patch.department_ids = finalDeptIds;
    if ((positionId || null) !== (user.position_id ?? null)) patch.position_id = positionId || null;
    // Role — send only when changed to a real role. A member always has a role
    // (never cleared to none from here), so an empty roleId (roles still loading)
    // is never written.
    if (roleId !== "" && roleId !== (user.role_id ?? "")) patch.role_id = roleId;
    if ((managerId || null) !== (user.manager_id ?? null)) patch.manager_id = managerId || null;
    if ((division.trim() || null) !== (user.division ?? null))
      patch.division = division.trim() || null;
    // Company grants — send only when changed (and multi-company is active).
    if (multiCompany) {
      const initialCompany = (user.company_ids ?? []).slice().sort((a, b) => a - b);
      const nextCompany = companyIds.slice().sort((a, b) => a - b);
      const sameCompany =
        nextCompany.length === initialCompany.length &&
        nextCompany.every((x, i) => x === initialCompany[i]);
      if (!sameCompany) patch.company_ids = companyIds;
    }
    if (password.trim()) {
      if (password.trim().length < 12) {
        toast.error("Password must be at least 12 characters");
        return;
      }
      patch.password = password.trim();
    }

    // Save if EITHER the user fields OR the showroom parking changed. The
    // showroom lives in scm.staff (the separate call below), so an "only the
    // showroom changed" edit has an EMPTY user patch — the old early-return here
    // dropped it silently (owner: picked a venue, hit Save, nothing persisted).
    if (Object.keys(patch).length === 0 && !showroomDirty) {
      onClose();
      return;
    }
    setBusy(true);
    try {
      if (Object.keys(patch).length > 0) {
        await api.patch(`/api/users/${user.id}`, patch);
      }
      /* Showroom parking lives in scm.staff, not on the user record, so it is a
         second call — made only when it actually changed, and AFTER the user
         patch succeeded. Its failure is surfaced separately rather than being
         folded into the user save's success message: reporting "Saved" when the
         venue binding did not persist is exactly the silent-miss this feature
         cannot afford. */
      if (showroomDirty) {
        try {
          await api.patch(`/api/scm/staff/by-user/${user.id}/showroom`, {
            showroomWarehouseId: showroomId || null,
          });
          setShowroomDirty(false);
          /* The /api/scm/staff list feeds this panel's showroom dropdown and has
             a 5-min staleTime, so without an explicit invalidation the NEXT open
             re-seeds the control from the pre-save cache and the parking reads as
             "Not parked" even though it persisted (owner 2026-08-02: saved
             successfully, reverted on reopen). Invalidate so every reader
             refetches the row we just wrote. */
          void qc.invalidateQueries({ queryKey: ["uq", "/api/scm/staff"] });
        } catch (e: any) {
          toast.error(e?.message || "Saved the member, but the showroom could not be set");
          setBusy(false);
          onSaved();
          return;
        }
      }
      toast.success(`Saved ${name.trim() || em}`);
      onSaved();
    } catch (e: any) {
      toast.error(e?.message || "Save failed");
    } finally {
      setBusy(false);
    }
  }

  const isActive = user.status === "active";

  return (
    <Panel
      open
      onClose={onClose}
      title={user.name || user.email}
      subtitle="Edit member"
      width={440}
    >
      <PanelSection title="Details">
        <div className="flex items-center gap-3">
          <Avatar
            key={picBump}
            userId={user.id}
            hasImage={user.profile_pic_r2_key}
            name={user.name}
            email={user.email}
            size={52}
          />
          <div>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) uploadPic(f);
              }}
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={picBusy}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] font-semibold text-ink-secondary transition-colors hover:border-accent/40 hover:bg-accent-soft/50 hover:text-accent disabled:opacity-50"
            >
              {picBusy ? "Uploading…" : "Change photo"}
            </button>
            <div className="mt-1 text-[10px] text-ink-muted">JPG/PNG, under 5 MB.</div>
          </div>
        </div>
        <div>
          <label className={labelCls}>Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Full name"
            className={inputCls}
            autoFocus
          />
        </div>
        <div>
          <label className={labelCls}>Email</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="member@houzscentury.com"
            className={inputCls}
          />
        </div>
        <div>
          <label className={labelCls}>Email Alias</label>
          <input
            type="email"
            value={emailAlias}
            onChange={(e) => setEmailAlias(e.target.value)}
            placeholder="e.g. lim@houzscentury.com (optional)"
            className={inputCls}
          />
          <div className="mt-1 text-[10px] text-ink-muted">
            The member's outward Mail Center address — defaults their reply From.
          </div>
        </div>
        <div>
          <label className={labelCls}>Phone</label>
          <PhoneInput
            value={phone}
            onChange={setPhone}
            placeholder="12-345 6789 (optional)"
            className={inputCls}
          />
        </div>
      </PanelSection>

      <PanelSection title="Organisation">
        <div>
          <label className={labelCls}>Primary department</label>
          <SearchableSelect
            className={inputCls}
            ariaLabel="Primary department"
            placeholder="— None —"
            value={String(deptId)}
            onChange={(v) => {
              const next = v ? Number(v) : "";
              setDeptId(next);
              setPositionId(""); // positions are department-scoped — reset
              // The primary is always part of the membership set.
              if (next !== "")
                setDeptIds((prev) => (prev.includes(next) ? prev : [...prev, next]));
            }}
            options={[
              { value: "", label: "— None —" },
              ...departments.map((d) => ({ value: String(d.id), label: d.name })),
            ]}
          />
          <div className="mt-1 text-[10px] text-ink-muted">
            Drives the member's colour and position scope.
          </div>
        </div>
        <div>
          <label className={labelCls}>Also in</label>
          <div className="flex flex-wrap gap-1.5">
            {departments.length === 0 && (
              <span className="text-[11px] text-ink-muted">No departments defined.</span>
            )}
            {departments.map((d) => {
              const isPrimary = deptId === d.id;
              const on = isPrimary || deptIds.includes(d.id);
              return (
                <button
                  key={d.id}
                  type="button"
                  // The primary can't be removed here — change it above first.
                  disabled={isPrimary}
                  onClick={() =>
                    setDeptIds((prev) =>
                      prev.includes(d.id)
                        ? prev.filter((x) => x !== d.id)
                        : [...prev, d.id],
                    )
                  }
                  className={cn(
                    "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors",
                    on
                      ? "border-transparent text-white"
                      : "border-border bg-surface text-ink-secondary hover:border-accent/40 hover:text-accent",
                    isPrimary && "cursor-default opacity-90",
                  )}
                  style={on ? { backgroundColor: `#${d.color}` } : undefined}
                  title={isPrimary ? "Primary department" : undefined}
                >
                  <span
                    className={cn(
                      "h-1.5 w-1.5 shrink-0 rounded-full",
                      on ? "bg-white/80" : "",
                    )}
                    style={on ? undefined : { backgroundColor: `#${d.color}` }}
                  />
                  {d.name}
                  {isPrimary && (
                    <span className="ml-0.5 text-[9px] font-bold uppercase tracking-wider opacity-80">
                      primary
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          <div className="mt-1 text-[10px] text-ink-muted">
            A member can belong to several departments. The primary is set above.
          </div>
        </div>
        <div>
          <label className={labelCls}>Position</label>
          <SearchableSelect
            className={inputCls}
            ariaLabel="Position"
            placeholder="— None —"
            value={String(positionId)}
            onChange={(v) => setPositionId(v ? Number(v) : "")}
            options={[
              { value: "", label: "— None —" },
              ...positions
                .filter((p) => deptId === "" || !p.department_id || p.department_id === deptId)
                .map((p) => ({ value: String(p.id), label: p.name }))
                .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" })),
            ]}
          />
          <div className="mt-1 text-[10px] text-ink-muted">
            Controls which pages this member can see (least-privilege per position).
          </div>
        </div>
        <div>
          <label className={labelCls}>Role</label>
          <SearchableSelect
            className={inputCls}
            ariaLabel="Role"
            placeholder="— Pick a role —"
            disabled={roleList.length === 0}
            value={String(roleId)}
            onChange={(v) => setRoleId(v ? Number(v) : "")}
            options={roleList
              .map((r) => ({ value: String(r.id), label: r.name }))
              .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }))}
          />
          <div className="mt-1 text-[10px] text-ink-muted">
            Controls what this member can DO (actions + admin). Position above
            controls what they can SEE. "Super Admin" grants everything.
          </div>
        </div>
        <div>
          <label className={labelCls}>Division</label>
          <input
            list="member-division-options"
            value={division}
            onChange={(e) => setDivision(e.target.value)}
            placeholder="e.g. Team Peter (optional)"
            className={inputCls}
          />
          <datalist id="member-division-options">
            {Array.from(
              new Set(
                members
                  .map((m) => m.division?.trim())
                  .filter((d): d is string => !!d),
              ),
            )
              .sort((a, b) => a.localeCompare(b))
              .map((d) => (
                <option key={d} value={d} />
              ))}
          </datalist>
          <div className="mt-1 text-[10px] text-ink-muted">
            Sub-group within the department — becomes a column in the org chart.
          </div>
        </div>
        {multiCompany && (
          <div>
            <label className={labelCls}>Company</label>
            <CompanySelect
              companies={companies}
              value={companyIds}
              onChange={setCompanyIds}
            />
            <div className="mt-1 text-[10px] text-ink-muted">
              Which company this member works in. "Both" grants access to all
              companies.
            </div>
          </div>
        )}
        <div>
          <label className={labelCls}>Reports to</label>
          <SearchableSelect
            className={inputCls}
            ariaLabel="Reports to"
            placeholder="— None —"
            value={String(managerId)}
            onChange={(v) => setManagerId(v ? Number(v) : "")}
            options={[
              { value: "", label: "— None —" },
              ...members
                .filter((m) => m.id !== user.id && m.status !== "disabled")
                .map((m) => ({
                  value: String(m.id),
                  label: m.department_name
                    ? `${m.name || m.email} · ${m.department_name}`
                    : m.name || m.email,
                }))
                .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" })),
            ]}
          />
        </div>
        <div>
          <label className={labelCls}>Set password</label>
          <div className="relative">
            <input
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Leave blank to keep current"
              autoComplete="new-password"
              className={cn(inputCls, "pr-10")}
            />
            <button
              type="button"
              onClick={() => setShowPassword((s) => !s)}
              className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-ink-muted transition-colors hover:text-accent"
              aria-label={showPassword ? "Hide password" : "Show password"}
              title={showPassword ? "Hide password" : "Show password"}
            >
              {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          </div>
          <div className="mt-1 text-[10px] text-ink-muted">
            Sets a new password for this member (min 12 chars). They can change it
            later — leave blank to keep their current one.
          </div>
        </div>
      </PanelSection>

      <PanelSection title="Sales venue">
        <div>
          <label className={labelCls}>Showroom</label>
          {!myScmStaff && !scmStaff.loading ? (
            <div className="rounded border border-hairline bg-surface-2 px-2.5 py-2 text-[11px] text-ink-muted">
              This member has no sales profile yet, so they cannot be parked
              under a showroom.
            </div>
          ) : (
            <select
              value={showroomId}
              onChange={(e) => {
                setShowroomId(e.target.value);
                setShowroomDirty(true);
              }}
              className={inputCls}
              disabled={scmStaff.loading || showrooms.loading}
            >
              <option value="">— Not parked —</option>
              {(showrooms.data?.showrooms ?? []).map((sr) => (
                <option key={sr.id} value={sr.id}>
                  {sr.name}
                  {sr.venueName ? ` · ${sr.venueName}` : " · no venue set"}
                </option>
              ))}
            </select>
          )}
          <div className="mt-1 text-[10px] text-ink-muted">
            {/* State WHAT the setting does to real documents, and be explicit
                about the two ways it does not apply — those are the questions
                the owner will actually have, and both are deliberate. */}
            {selectedShowroom && !selectedShowroom.venueName ? (
              <span className="text-danger">
                This showroom has no Venue name yet, so orders will still have no
                venue. Set its Venue name in Warehouses.
              </span>
            ) : selectedShowroom?.venueName ? (
              <>
                Sales orders this member raises will default to venue
                {" "}<strong className="text-ink">{selectedShowroom.venueName}</strong>.
                An exhibition they are assigned to overrides it while it runs, and
                they can always change the venue on the order itself.
              </>
            ) : (
              <>
                Parking a salesperson under a showroom sets the default venue on
                every sales order they raise. Showrooms are warehouses marked as
                a Showroom — mark one in Warehouses to see it here. Left unparked,
                their orders carry no venue unless they pick one.
              </>
            )}
          </div>
        </div>
      </PanelSection>

      <div className="pb-1">
        <Button variant="brass" className="w-full" onClick={save} disabled={busy}>
          {busy ? "Saving…" : "Save Changes"}
        </Button>
      </div>

      <PanelSection title="Account">
        {user.status !== "invited" && (
          <button type="button" onClick={() => onSendReset(user)} className={actionCls}>
            <KeyRound size={13} /> Send password reset link
          </button>
        )}
        {user.status === "invited" && (
          <button type="button" onClick={() => onResendInvite(user)} className={actionCls}>
            <Mail size={13} /> Resend invitation
          </button>
        )}
        <button type="button" onClick={() => onToggleStatus(user)} className={actionCls}>
          {isActive ? <UserX size={13} /> : <UserCheck size={13} />}
          {isActive ? "Disable account" : "Enable account"}
        </button>
        <button
          type="button"
          onClick={() => onRemove(user)}
          className="inline-flex w-full items-center gap-2 rounded-md border border-err/30 bg-surface px-3 py-2 text-[12px] font-semibold text-err transition-colors hover:bg-err/10"
        >
          <Trash2 size={13} /> Delete permanently
        </button>
      </PanelSection>
    </Panel>
  );
}

// ──────────────────────────────────────────────────────────
// Org hierarchy helpers
// ──────────────────────────────────────────────────────────


// One departmental box in the org chart (a dept with non-root members, or the
// "Unassigned" catch-all). Shared between OrgChartTab (which owns per-box
// expand/collapse state) and OrgDeptChart (which renders them).
type OrgGroup = {
  key: string;
  deptId: number | null;
  name: string;
  color: string | null;
  members: TeamMember[];
};

// Build the departmental boxes: one per department that has non-root members
// (matching ANY of a member's departments, mig 0020), then a catch-all for the
// unassigned. Root people are pulled into a separate top row by the caller.
function buildDeptGroups(
  users: TeamMember[],
  roots: TeamMember[],
  departments: Department[],
): OrgGroup[] {
  const rootIds = new Set(roots.map((r) => r.id));
  const rest = users.filter((u) => !rootIds.has(u.id));
  const groups: OrgGroup[] = [];
  for (const d of departments) {
    const ms = rest.filter((u) => inDept(u, d.id));
    if (ms.length)
      groups.push({ key: `d${d.id}`, deptId: d.id, name: d.name, color: d.color, members: ms });
  }
  const placed = new Set(groups.flatMap((g) => g.members.map((m) => m.id)));
  const noDept = rest.filter((u) => !placed.has(u.id));
  if (noDept.length)
    groups.push({ key: "none", deptId: null, name: "Unassigned", color: null, members: noDept });
  return groups;
}

// Initial-render card budget: department boxes are expanded (their member cards
// mounted) greedily in order until this many cards are on screen; the rest stay
// collapsed to a header + count, mounting zero cards until the user expands
// them. This bounds the initial DOM so the chart doesn't freeze at scale — a
// collapsed box contributes 0 card nodes. Roots/leadership always render.
const ORG_INITIAL_CARD_BUDGET = 60;

// ──────────────────────────────────────────────────────────
// Org Chart tab — top-down visual tree with drag-to-assign
// ──────────────────────────────────────────────────────────
//
// Renders each team as a proper top-down hierarchy (parent → children
// below, connected by hairlines). Interactions:
//   • Drag a node onto another node → assigns that user as report.
//   • Drag a node onto the "Top level" strip → removes their manager.
//   • Click the pencil on a card → inline manager dropdown (keyboard-
//     accessible fallback for drag-and-drop).
// Cycle prevention is enforced both client-side (drop target refuses)
// and server-side (PATCH /api/users/:id walks the chain).

function OrgChartTab() {
  const { can } = useAuth();
  const toast = useToast();
  const canManage = can("users.manage");
  const members = useQuery<{ users: TeamMember[] }>("/api/users", () => api.get("/api/users"));
  const depts = useQuery<{ departments: Department[] }>("/api/departments", () =>
    api.get("/api/departments")
  );
  // Multi-company (Phase 0e). Each company gets its OWN reporting tree; a member
  // is placed in a company's tree when granted to it — using the same grant
  // resolution as the Members table (empty grant = every company; "Both" = all
  // ids, so those members appear in EVERY tree). Pre-activation this returns 0/1
  // companies, so `companyOpts.length > 1` is false and the chart falls back to a
  // single combined tree — single-company Houzs is visually unchanged.
  const companiesQ = useQuery<{
    companies: Array<{ id: number; code: string; name: string }>;
  }>("/api/companies", () => api.get("/api/companies"), [], { staleTime: 60_000 });
  const companyOpts: CompanyOpt[] = companiesQ.data?.companies ?? [];

  // Department filter — null = "All". When a dept is selected the chart
  // narrows to that dept's members only; reps reporting up to a manager
  // outside the filtered set get re-rooted so the team's lineup is
  // visible end-to-end. Persists per-tab in the URL so a "Sales chart"
  // bookmark stays usable.
  const [params, setParams] = useSearchParams();
  const filterDeptId = params.get("dept")
    ? parseInt(params.get("dept") || "", 10)
    : null;
  function setFilterDeptId(id: number | null) {
    const next = new URLSearchParams(params);
    if (id == null) next.delete("dept");
    else next.set("dept", String(id));
    setParams(next, { replace: true });
  }

  const allActive = (members.data?.users ?? []).filter(
    (u) => u.status !== "disabled"
  );
  const users = useMemo(() => {
    if (filterDeptId == null) return allActive;
    // Match ANY of the member's departments, not just the primary (mig 0020).
    return allActive.filter((u) => inDept(u, filterDeptId));
  }, [allActive, filterDeptId]);

  // Global lookup for the mutation handlers (manager reassignment, cycle checks)
  // — keyed across the full filtered set, not one company's slice.
  const byId = useMemo(() => new Map(users.map((u) => [u.id, u])), [users]);

  // One reporting tree PER company (or a single combined tree when there is not
  // more than one company). Within each tree the manager -> report hierarchy is
  // preserved exactly as before: a user whose manager_id points at someone NOT in
  // that tree (inactive, missing, out-of-dept-filter, or granted to a different
  // company) is re-rooted so they stay visible. A member granted to both
  // companies is present in both slices, so they render in BOTH trees under their
  // reporting line there — not in a separate side section.
  const companyViews = useMemo(() => {
    const departments = depts.data?.departments ?? [];
    const buildView = (
      key: string,
      label: string,
      viewUsers: TeamMember[],
    ) => {
      const inSet = new Set(viewUsers.map((u) => u.id));
      const childrenOf = new Map<number | null, TeamMember[]>();
      for (const u of viewUsers) {
        const parentId =
          u.manager_id != null && inSet.has(u.manager_id) ? u.manager_id : null;
        const arr = childrenOf.get(parentId) ?? [];
        arr.push(u);
        childrenOf.set(parentId, arr);
      }
      for (const arr of childrenOf.values()) {
        arr.sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email));
      }
      const roots = childrenOf.get(null) ?? [];
      // Namespace each box's key by tree so expand/collapse state never collides
      // between companies (both trees can have a "d5" or "none" box).
      const groups = buildDeptGroups(viewUsers, roots, departments).map((g) => ({
        ...g,
        key: `${key}:${g.key}`,
      }));
      return { key, label, users: viewUsers, roots, groups };
    };

    if (companyOpts.length > 1) {
      // Grant resolution mirrors the Members table (companyLabelFor): an empty
      // grant is fail-open (member acts in every company) so it appears in every
      // tree; otherwise the member appears in each company whose id it carries.
      return companyOpts.map((co) =>
        buildView(
          `c${co.id}`,
          co.name,
          users.filter((u) => {
            const ids = u.company_ids ?? [];
            return ids.length === 0 || ids.includes(co.id);
          }),
        ),
      );
    }
    return [buildView("all", "", users)];
  }, [companyOpts, users, depts.data?.departments]);

  // Flat list of every box across every tree — drives the shared expand/collapse
  // controls and the initial-render card budget (bounds total DOM at scale).
  const allGroups = useMemo(
    () => companyViews.flatMap((v) => v.groups),
    [companyViews],
  );

  const [draggingId, setDraggingId] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [zoom, setZoom] = useState(1);

  // Which department boxes are expanded. Lazy-mount: a collapsed box shows only
  // its header (name + count + chevron) and mounts none of its member cards, so
  // deep/large departments contribute 0 DOM nodes until opened. Keys are
  // tree-namespaced (see companyViews) so the state spans every company tree.
  // null = "use the budget-based default". Once the user toggles anything we
  // hold their explicit set instead.
  const [expandedGroups, setExpandedGroups] = useState<Set<string> | null>(null);
  const defaultExpandedGroups = useMemo(() => {
    const s = new Set<string>();
    let budget = ORG_INITIAL_CARD_BUDGET;
    for (const g of allGroups) {
      if (g.members.length <= budget) {
        s.add(g.key);
        budget -= g.members.length;
      }
    }
    return s;
  }, [allGroups]);
  const expandedKeys = expandedGroups ?? defaultExpandedGroups;
  function toggleGroup(key: string) {
    const base = expandedGroups ?? defaultExpandedGroups;
    const next = new Set(base);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setExpandedGroups(next);
  }
  function expandAllGroups() {
    setExpandedGroups(new Set(allGroups.map((g) => g.key)));
  }
  function collapseAllGroups() {
    setExpandedGroups(new Set());
  }
  const allGroupsExpanded =
    allGroups.length > 0 && allGroups.every((g) => expandedKeys.has(g.key));

  /* Export → Print preview → Print now. Expanding every box FIRST is what makes
     the printout the whole chart (a collapsed box mounts none of its cards);
     the two frames let those cards mount before each tree is measured and
     scaled to a landscape page (see the @media print rule in index.css). */
  const orgChartPrint = usePrintPreview(() => {
    expandAllGroups();
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        document
          .querySelectorAll<HTMLElement>(".org-print-scale")
          .forEach((el) =>
            el.style.setProperty(
              "--print-zoom",
              String(Math.min(1, 1000 / (el.scrollWidth || 1))),
            ),
          );
        window.print();
      }),
    );
  });

  async function reassign(userId: number, managerId: number | null) {
    if (userId === managerId) return;
    const current = byId.get(userId);
    if (!current) return;
    if ((current.manager_id ?? null) === managerId) return; // no-op
    if (managerId != null && isDescendantOf(managerId, userId, users)) {
      toast.error("That user reports to this one — would create a loop");
      return;
    }
    try {
      await api.patch(`/api/users/${userId}`, { manager_id: managerId });
      const targetName = managerId ? byId.get(managerId)?.name || byId.get(managerId)?.email : null;
      toast.success(
        targetName
          ? `${current.name || current.email} now reports to ${targetName}`
          : `${current.name || current.email} is now top-level`
      );
      members.reload();
    } catch (e: any) {
      toast.error(e?.message || "Failed to update");
    } finally {
      setEditingId(null);
    }
  }

  async function changeDept(userId: number, departmentId: number | null) {
    const current = byId.get(userId);
    if (!current || (current.department_id ?? null) === departmentId) return;
    try {
      await api.patch(`/api/users/${userId}`, { department_id: departmentId });
      const name = departmentId
        ? (depts.data?.departments.find((d) => d.id === departmentId)?.name ?? "department")
        : null;
      toast.success(
        name
          ? `${current.name || current.email} → ${name}`
          : `${current.name || current.email} removed from department`,
      );
      members.reload();
    } catch (e: any) {
      toast.error(e?.message || "Failed to update department");
    }
  }

  // Replace-set the member's full department list (mig 0020). The backend keeps
  // the primary in the set, so this is safe to call with any selection.
  async function changeDepts(userId: number, departmentIds: number[]) {
    const current = byId.get(userId);
    if (!current) return;
    try {
      await api.patch(`/api/users/${userId}`, { department_ids: departmentIds });
      toast.success(`Updated ${current.name || current.email}'s departments`);
      members.reload();
    } catch (e: any) {
      toast.error(e?.message || "Failed to update departments");
    }
  }

  // Set a member's division (org-chart column) — free text, mig 0021.
  async function changeDivision(userId: number, division: string | null) {
    const current = byId.get(userId);
    if (!current) return;
    const next = division?.trim() || null;
    if ((current.division ?? null) === next) return; // no-op
    try {
      await api.patch(`/api/users/${userId}`, { division: next });
      members.reload();
    } catch (e: any) {
      toast.error(e?.message || "Failed to update division");
    }
  }

  // Drag-drop target: move a member into a department column. Sets both the
  // primary department and the division in one shot.
  async function moveMember(
    userId: number,
    departmentId: number | null,
    division: string | null,
  ) {
    const current = byId.get(userId);
    if (!current) return;
    const next = division?.trim() || null;
    if (
      (current.department_id ?? null) === departmentId &&
      (current.division ?? null) === next
    )
      return; // no-op
    try {
      await api.patch(`/api/users/${userId}`, {
        department_id: departmentId,
        division: next,
      });
      const where = [
        departmentId
          ? depts.data?.departments.find((d) => d.id === departmentId)?.name
          : "No department",
        next,
      ]
        .filter(Boolean)
        .join(" · ");
      toast.success(`${current.name || current.email} → ${where}`);
      members.reload();
    } catch (e: any) {
      toast.error(e?.message || "Failed to move member");
    }
  }

  if (members.loading && users.length === 0) {
    return <ListSkeleton rows={4} />;
  }
  if (members.error) {
    return <div className="text-[12px] text-err">{members.error}</div>;
  }

  const deptList = depts.data?.departments ?? [];
  const filterDept = filterDeptId
    ? deptList.find((d) => d.id === filterDeptId)
    : null;
  // Existing division names (for the editor's autocomplete) — deduped, sorted.
  const divisionOptions = Array.from(
    new Set(
      allActive
        .map((u) => u.division?.trim())
        .filter((d): d is string => !!d),
    ),
  ).sort((a, b) => a.localeCompare(b));

  return (
    <div className="space-y-4">
      {/* Department pill row — pick "All" or any dept to narrow the
          tree to that team. Bookmarkable via ?dept= so a Sales chart
          link is shareable. */}
      {deptList.length > 0 && (
        <div className="no-scrollbar -mx-1 flex items-center gap-1.5 overflow-x-auto px-1 pb-1">
          <span className="shrink-0 font-mono text-[9px] font-semibold uppercase tracking-brand text-ink-muted">
            Filter
          </span>
          <button
            type="button"
            onClick={() => setFilterDeptId(null)}
            className={cn(
              "shrink-0 rounded-full border px-2.5 py-1 font-mono text-[10px] font-semibold uppercase tracking-wider transition-colors",
              filterDeptId == null
                ? "border-accent bg-accent text-white"
                : "border-border bg-surface text-ink-secondary hover:border-accent/40 hover:text-accent"
            )}
          >
            All
            <span className="ml-1.5 font-normal opacity-70">
              {allActive.length}
            </span>
          </button>
          {deptList.map((d) => {
            const on = filterDeptId === d.id;
            const count = allActive.filter((u) => inDept(u, d.id)).length;
            return (
              <button
                key={d.id}
                type="button"
                onClick={() => setFilterDeptId(d.id)}
                className={cn(
                  "shrink-0 rounded-full border px-2.5 py-1 font-mono text-[10px] font-semibold uppercase tracking-wider transition-colors"
                )}
                style={
                  on
                    ? {
                        backgroundColor: `#${d.color}`,
                        color: "white",
                        borderColor: `#${d.color}`,
                      }
                    : {
                        backgroundColor: `#${d.color}1a`,
                        color: `#${d.color}`,
                        borderColor: `#${d.color}40`,
                      }
                }
              >
                {d.name}
                <span className="ml-1.5 font-normal opacity-70">{count}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* Top-level drop zone — drop a user here to remove their manager */}
      {canManage && (
        <TopLevelDropZone
          dragging={draggingId != null}
          onDrop={(userId) => reassign(userId, null)}
        />
      )}

      {users.length === 0 ? (
        <div className="rounded-md border border-border bg-surface px-5 py-8 text-center text-[12px] text-ink-muted">
          {filterDept
            ? `No active members in ${filterDept.name}.`
            : "No active members yet."}
        </div>
      ) : (
        <>
          {/* Controls: expand · export · zoom */}
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            {allGroups.length > 1 && (
              <button
                type="button"
                onClick={allGroupsExpanded ? collapseAllGroups : expandAllGroups}
                className="mr-1 inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 text-[11px] font-semibold text-ink-secondary transition-colors hover:border-accent/40 hover:text-accent"
                title={
                  allGroupsExpanded
                    ? "Collapse every department"
                    : "Expand every department (mounts all cards)"
                }
              >
                {allGroupsExpanded ? (
                  <ChevronRight size={13} strokeWidth={2} />
                ) : (
                  <ChevronDown size={13} strokeWidth={2} />
                )}
                {allGroupsExpanded ? "Collapse all" : "Expand all"}
              </button>
            )}
            <button
              type="button"
              onClick={orgChartPrint.openPreview}
              className="mr-1 inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 text-[11px] font-semibold text-ink-secondary transition-colors hover:border-accent/40 hover:text-accent"
              title="Export as PDF or print"
            >
              <Printer size={13} strokeWidth={2} />
              Export
            </button>
            {/* Same Print preview every printable surface in the app opens. The
                chart prints from the page itself (.org-print-area), so there is
                no PDF file to download or open in a tab. */}
            <PrintPreviewModal
              open={orgChartPrint.open}
              onClose={orgChartPrint.close}
              docTitle="Org Chart"
              docNo="Team"
              rows={[
                { label: "Prints", value: "Every department box, fully expanded" },
                { label: "Fit", value: "Each company tree is scaled to one landscape page" },
              ]}
              onPrint={orgChartPrint.handlers.onPrint}
            />
            <button
              type="button"
              onClick={() => setZoom((z) => Math.max(0.4, +(z - 0.1).toFixed(2)))}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border bg-surface text-[15px] leading-none text-ink-secondary transition-colors hover:border-accent/40 hover:text-accent"
              title="Zoom out"
              aria-label="Zoom out"
            >
              −
            </button>
            <button
              type="button"
              onClick={() => setZoom(1)}
              className="inline-flex h-7 min-w-[3.25rem] items-center justify-center rounded-md border border-border bg-surface text-[11px] font-semibold text-ink-secondary transition-colors hover:border-accent/40 hover:text-accent"
              title="Reset zoom to 100%"
            >
              {Math.round(zoom * 100)}%
            </button>
            <button
              type="button"
              onClick={() => setZoom((z) => Math.min(1.6, +(z + 0.1).toFixed(2)))}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border bg-surface text-[15px] leading-none text-ink-secondary transition-colors hover:border-accent/40 hover:text-accent"
              title="Zoom in"
              aria-label="Zoom in"
            >
              +
            </button>
          </div>

          <div className="org-print-area thin-scroll space-y-8 overflow-auto pb-6">
            {companyViews.map((view) => {
              // Only label the tree when there is more than one — a single
              // combined tree stays header-less, exactly as before.
              const showHeader = companyViews.length > 1;
              return (
                <section key={view.key} className="space-y-2">
                  {showHeader && (
                    <div className="flex items-center gap-2 px-1">
                      <h3 className="font-mono text-[11px] font-semibold uppercase tracking-brand text-ink-secondary">
                        {view.label}
                      </h3>
                      <span className="rounded-full bg-surface-dim px-1.5 py-px text-[10px] font-semibold text-ink-muted">
                        {view.users.length}
                      </span>
                      <span className="h-px flex-1 bg-border" />
                    </div>
                  )}
                  {view.users.length === 0 ? (
                    <div className="rounded-md border border-border bg-surface px-5 py-6 text-center text-[12px] text-ink-muted">
                      No active members in this company.
                    </div>
                  ) : (
                    <div
                      className="org-print-scale mx-auto flex min-w-fit items-start justify-center gap-10 px-4 pt-2"
                      style={{ transform: `scale(${zoom})`, transformOrigin: "top center" }}
                    >
                      <OrgDeptChart
                        users={view.users}
                        roots={view.roots}
                        groups={view.groups}
                        expandedKeys={expandedKeys}
                        onToggleGroup={toggleGroup}
                        departments={deptList}
                        divisionOptions={divisionOptions}
                        canManage={canManage}
                        draggingId={draggingId}
                        setDraggingId={setDraggingId}
                        onReassign={reassign}
                        onChangeDept={changeDept}
                        onChangeDepts={changeDepts}
                        onChangeDivision={changeDivision}
                        onMoveMember={moveMember}
                        editingId={editingId}
                        setEditingId={setEditingId}
                      />
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        </>
      )}

      <div className="text-[10.5px] text-ink-muted">
        <span className="font-semibold">Tip:</span> drag a card into a department /
        division column to move it there; drop on the strip at the top to make
        someone top-level. Use the pencil on a card to edit reporting or division.
      </div>
    </div>
  );
}

function TopLevelDropZone({
  dragging,
  onDrop,
}: {
  dragging: boolean;
  onDrop: (userId: number) => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <div
      onDragOver={(e) => {
        if (!dragging) return;
        e.preventDefault();
        setHover(true);
      }}
      onDragLeave={() => setHover(false)}
      onDrop={(e) => {
        e.preventDefault();
        setHover(false);
        const id = parseInt(e.dataTransfer.getData("user-id"), 10);
        if (!isNaN(id)) onDrop(id);
      }}
      className={cn(
        "rounded-md border-2 border-dashed px-4 py-2 text-center font-mono text-[10px] uppercase tracking-brand transition-colors",
        hover
          ? "border-accent bg-accent-soft/40 text-accent"
          : dragging
          ? "border-accent/40 text-accent/70"
          : "border-border text-ink-muted"
      )}
    >
      Top level — drop here to remove manager
    </div>
  );
}

// ──────────────────────────────────────────────────────────
// Departmental org chart (Chart view)
//
// A root box at the top (people with no manager) over a connector bus into one
// titled box PER DEPARTMENT — each a dark header bar (white, uppercase dept
// name) over square-photo cards, sub-grouped by position. Mirrors a classic
// printed org chart, not a manager→report tree. Editing (reports-to, primary
// dept, extra depts) stays on each card's pencil popover.
// ──────────────────────────────────────────────────────────

// Float seniority-sounding positions to the top of a department box so the
// lead reads first (e.g. Supervisor above the Storekeepers it leads).
const ORG_RANK = [
  "owner", "director", "head", "manager", "supervisor", "lead",
  "executive", "senior", "admin", "officer",
];
function orgSeniority(positionName?: string | null): number {
  const p = (positionName || "").toLowerCase();
  const i = ORG_RANK.findIndex((k) => p.includes(k));
  return i < 0 ? ORG_RANK.length : i;
}

/** Group a department's members by position into clusters, most-senior first.
 *  A cluster of 2+ gets a small label (e.g. "Storekeepers"); lone members
 *  render label-less so the box doesn't become a wall of headings. */
function clusterByPosition(
  members: TeamMember[],
): { label: string | null; members: TeamMember[] }[] {
  const byPos = new Map<string, TeamMember[]>();
  for (const m of members) {
    const key = m.position_name || m.role_name || "—";
    const arr = byPos.get(key) ?? [];
    arr.push(m);
    byPos.set(key, arr);
  }
  const clusters = [...byPos.entries()].map(([label, ms]) => ({
    label,
    members: ms.sort((a, b) => (a.name || a.email || "").localeCompare(b.name || b.email || "")),
  }));
  clusters.sort(
    (a, b) =>
      orgSeniority(a.label) - orgSeniority(b.label) ||
      b.members.length - a.members.length ||
      a.label.localeCompare(b.label),
  );
  return clusters.map((c) => ({
    label: c.members.length >= 2 ? c.label : null,
    members: c.members,
  }));
}

function OrgDeptChart({
  users,
  roots,
  groups,
  expandedKeys,
  onToggleGroup,
  departments,
  divisionOptions,
  canManage,
  draggingId,
  setDraggingId,
  onReassign,
  onChangeDept,
  onChangeDepts,
  onChangeDivision,
  onMoveMember,
  editingId,
  setEditingId,
}: {
  users: TeamMember[];
  roots: TeamMember[];
  /** Prebuilt department boxes (see buildDeptGroups) — the caller owns them so
   *  it can also own the expand/collapse state. */
  groups: OrgGroup[];
  /** Keys of the boxes that are expanded; collapsed boxes mount no cards. */
  expandedKeys: Set<string>;
  onToggleGroup: (key: string) => void;
  departments: Department[];
  divisionOptions: string[];
  canManage: boolean;
  draggingId: number | null;
  setDraggingId: (id: number | null) => void;
  onReassign: (userId: number, managerId: number | null) => void;
  onChangeDept: (userId: number, departmentId: number | null) => void;
  onChangeDepts: (userId: number, departmentIds: number[]) => void;
  onChangeDivision: (userId: number, division: string | null) => void;
  onMoveMember: (userId: number, departmentId: number | null, division: string | null) => void;
  editingId: number | null;
  setEditingId: (id: number | null) => void;
}) {
  const renderCard = (u: TeamMember) => (
    <OrgCard
      key={u.id}
      user={u}
      accent={false}
      square
      noReportDrop
      canManage={canManage}
      draggingId={draggingId}
      setDraggingId={setDraggingId}
      onDrop={onReassign}
      editing={editingId === u.id}
      setEditing={(on) => setEditingId(on ? u.id : null)}
      users={users}
      departments={departments}
      divisionOptions={divisionOptions}
      onChangeDept={onChangeDept}
      onChangeDepts={onChangeDepts}
      onChangeDivision={onChangeDivision}
      onPickManager={onReassign}
    />
  );

  // Department boxes are prebuilt and owned by the caller (which also owns the
  // expand/collapse state); see buildDeptGroups. Root people render in the top
  // row below.
  const hasRoots = roots.length > 0;

  return (
    <div className="flex flex-col items-center">
      {hasRoots && (
        <div className="flex flex-wrap items-start justify-center gap-4">
          {roots.map((r) => (
            <div
              key={r.id}
              className="overflow-hidden rounded-lg border border-border bg-surface shadow-stone"
            >
              <div className="bg-[#33404e] px-3 py-1.5 text-center text-[10.5px] font-semibold uppercase tracking-wide text-white/95">
                {r.position_name || r.role_name || "Leadership"}
              </div>
              <div className="p-2">{renderCard(r)}</div>
            </div>
          ))}
        </div>
      )}

      {hasRoots && groups.length > 0 && <div className="h-5 w-px bg-border" />}

      <div className="flex items-start justify-center gap-5">
        {groups.map((g, i) => (
          <div key={g.key} className="relative flex flex-col items-center">
            {/* Connector bus across the department boxes (only when there's a
                root above to hang them from). */}
            {hasRoots && groups.length > 1 && (
              <span
                aria-hidden
                className="absolute top-0 h-px bg-border"
                style={{ left: i === 0 ? "50%" : 0, right: i === groups.length - 1 ? "50%" : 0 }}
              />
            )}
            {hasRoots && <div className="h-5 w-px bg-border" />}
            <DeptGroupBox
              group={g}
              collapsed={!expandedKeys.has(g.key)}
              onToggle={() => onToggleGroup(g.key)}
              renderCard={renderCard}
              canManage={canManage}
              draggingId={draggingId}
              onMoveMember={onMoveMember}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function DeptGroupBox({
  group,
  collapsed,
  onToggle,
  renderCard,
  canManage,
  draggingId,
  onMoveMember,
}: {
  group: {
    deptId: number | null;
    name: string;
    color: string | null;
    members: TeamMember[];
  };
  /** When collapsed the box mounts only its header — none of its member cards.
   *  This is what bounds the chart's DOM at scale. */
  collapsed: boolean;
  onToggle: () => void;
  renderCard: (u: TeamMember) => ReactNode;
  canManage: boolean;
  draggingId: number | null;
  onMoveMember: (userId: number, departmentId: number | null, division: string | null) => void;
}) {
  // Columns = divisions within the department. Members with no division fall
  // into a leading default column ("" key); named divisions sort alpha after.
  // Only computed when expanded, since a collapsed box renders no columns.
  const byDiv = new Map<string, TeamMember[]>();
  if (!collapsed) {
    for (const m of group.members) {
      const key = m.division?.trim() || "";
      const arr = byDiv.get(key) ?? [];
      arr.push(m);
      byDiv.set(key, arr);
    }
  }
  const columns = [...byDiv.entries()].sort((a, b) => {
    if (a[0] === "") return -1;
    if (b[0] === "") return 1;
    return a[0].localeCompare(b[0]);
  });
  const multiCol = columns.length > 1;

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface shadow-stone">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        title={collapsed ? `Expand ${group.name}` : `Collapse ${group.name}`}
        className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-white/95 transition-colors hover:brightness-110"
        style={{
          backgroundColor: "#33404e",
          borderLeft: group.color ? `4px solid #${group.color}` : undefined,
        }}
      >
        {collapsed ? (
          <ChevronRight size={13} strokeWidth={2.5} className="shrink-0 text-white/70" />
        ) : (
          <ChevronDown size={13} strokeWidth={2.5} className="shrink-0 text-white/70" />
        )}
        <span className="truncate">{group.name}</span>
        <span className="ml-auto pl-1.5 font-normal text-white/55">{group.members.length}</span>
      </button>
      {!collapsed && (
        <div className="flex items-start gap-2 p-2.5">
          {columns.map(([div, ms]) => (
            <DivisionColumn
              key={div || "_default"}
              deptId={group.deptId}
              division={div || null}
              members={ms}
              showLabel={multiCol || div !== ""}
              renderCard={renderCard}
              canManage={canManage}
              draggingId={draggingId}
              onMoveMember={onMoveMember}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// One division = one column inside a department box, and a drop target: drag a
// card onto it to set that member's department + division in one move.
function DivisionColumn({
  deptId,
  division,
  members,
  showLabel,
  renderCard,
  canManage,
  draggingId,
  onMoveMember,
}: {
  deptId: number | null;
  division: string | null;
  members: TeamMember[];
  showLabel: boolean;
  renderCard: (u: TeamMember) => ReactNode;
  canManage: boolean;
  draggingId: number | null;
  onMoveMember: (userId: number, departmentId: number | null, division: string | null) => void;
}) {
  const [hover, setHover] = useState(false);
  const isDropZone = canManage && draggingId != null;
  const clusters = clusterByPosition(members);
  return (
    <div
      onDragOver={
        isDropZone
          ? (e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              setHover(true);
            }
          : undefined
      }
      onDragLeave={() => setHover(false)}
      onDrop={
        isDropZone
          ? (e) => {
              e.preventDefault();
              setHover(false);
              const id = parseInt(e.dataTransfer.getData("user-id"), 10);
              if (!isNaN(id)) onMoveMember(id, deptId, division);
            }
          : undefined
      }
      className={cn(
        "flex w-[202px] shrink-0 flex-col gap-2 rounded-md p-1.5 transition-colors",
        isDropZone && "outline-dashed outline-1 -outline-offset-2 outline-border",
        hover && "bg-accent-soft/40 outline-accent",
      )}
    >
      {showLabel && (
        <div className="flex items-center gap-1 px-0.5">
          <span className="truncate text-[9.5px] font-semibold uppercase tracking-wide text-ink-muted">
            {division || "—"}
          </span>
          <span className="text-[9px] text-ink-muted/60">{members.length}</span>
        </div>
      )}
      {clusters.map((c, ci) => (
        <div key={ci} className="flex flex-col gap-2">
          {c.label && (
            <div className="px-0.5 text-[9px] font-medium uppercase tracking-wide text-ink-muted/80">
              {c.label}
            </div>
          )}
          {c.members.map(renderCard)}
        </div>
      ))}
    </div>
  );
}

// Chip multi-select for a member's extra departments, used in both org-chart
// edit popovers. Toggling applies immediately (replace-set via onChangeDepts),
// matching the popover's other always-live controls. The primary chip is shown
// but locked — change the primary with the Department select above it.
function DeptChipsEditor({
  user,
  departments,
  onChangeDepts,
}: {
  user: TeamMember;
  departments: Department[];
  onChangeDepts: (userId: number, departmentIds: number[]) => void;
}) {
  if (departments.length === 0) return null;
  return (
    <div>
      <label className="mb-1 block font-mono text-[9px] font-semibold uppercase tracking-brand text-ink-muted">
        Also in
      </label>
      <div className="flex flex-wrap gap-1">
        {departments.map((d) => {
          const isPrimary = user.department_id === d.id;
          const on = inDept(user, d.id);
          return (
            <button
              key={d.id}
              type="button"
              disabled={isPrimary}
              onClick={() => {
                const cur = deptIdsOf(user);
                const next = cur.includes(d.id)
                  ? cur.filter((x) => x !== d.id)
                  : [...cur, d.id];
                onChangeDepts(user.id, next);
              }}
              className={cn(
                "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold transition-colors",
                on
                  ? "border-transparent text-white"
                  : "border-border bg-surface text-ink-secondary hover:border-accent/40 hover:text-accent",
                isPrimary && "cursor-default opacity-90",
              )}
              style={on ? { backgroundColor: `#${d.color}` } : undefined}
              title={isPrimary ? "Primary department" : undefined}
            >
              {d.name}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function OrgCard({
  user,
  accent,
  square,
  noReportDrop,
  canManage,
  draggingId,
  setDraggingId,
  onDrop,
  editing,
  setEditing,
  users,
  departments,
  divisionOptions,
  onChangeDept,
  onChangeDepts,
  onChangeDivision,
  onPickManager,
}: {
  user: TeamMember;
  /** Manager cards get the top department-colour bar; leaf report cards don't. */
  accent: boolean;
  /** Departmental chart cards use a square photo + a wider body (ID-card look). */
  square?: boolean;
  /** In the departmental chart the division COLUMN is the drop target, so the
   *  card opts out of being a reporting drop target (it stays a drag source). */
  noReportDrop?: boolean;
  canManage: boolean;
  draggingId: number | null;
  setDraggingId: (id: number | null) => void;
  onDrop: (userId: number, managerId: number | null) => void;
  editing: boolean;
  setEditing: (on: boolean) => void;
  users: TeamMember[];
  departments: Department[];
  /** Existing division names for the editor's autocomplete. */
  divisionOptions?: string[];
  onChangeDept: (userId: number, departmentId: number | null) => void;
  onChangeDepts: (userId: number, departmentIds: number[]) => void;
  onChangeDivision?: (userId: number, division: string | null) => void;
  onPickManager: (userId: number, managerId: number | null) => void;
}) {
  const [dropHover, setDropHover] = useState(false);
  const isDragSource = draggingId === user.id;
  const isValidDropTarget =
    draggingId != null &&
    draggingId !== user.id &&
    // Can't drop user onto their own descendant.
    !isDescendantOf(user.id, draggingId, users);

  return (
    <div
      draggable={canManage}
      onDragStart={(e) => {
        if (!canManage) return;
        e.dataTransfer.setData("user-id", String(user.id));
        e.dataTransfer.effectAllowed = "move";
        setDraggingId(user.id);
      }}
      onDragEnd={() => setDraggingId(null)}
      onDragOver={
        noReportDrop
          ? undefined
          : (e) => {
              if (!canManage || !isValidDropTarget) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              setDropHover(true);
            }
      }
      onDragLeave={noReportDrop ? undefined : () => setDropHover(false)}
      onDrop={
        noReportDrop
          ? undefined
          : (e) => {
              if (!canManage) return;
              e.preventDefault();
              setDropHover(false);
              const id = parseInt(e.dataTransfer.getData("user-id"), 10);
              if (!isNaN(id) && id !== user.id) onDrop(id, user.id);
            }
      }
      className={cn(
        "relative shrink-0 overflow-hidden rounded-lg border bg-surface shadow-stone transition-all",
        square ? "w-[190px]" : accent ? "w-[196px]" : "w-[160px]",
        isDragSource && "opacity-50",
        dropHover && isValidDropTarget ? "border-accent ring-2 ring-accent/30" : "border-border",
        canManage && "cursor-grab active:cursor-grabbing",
      )}
    >
      {/* Department colour bar — only on manager cards, so the report grid
          below stays clean (reference look). In the departmental chart the
          dept colour lives on the group header instead, so square cards skip it. */}
      {accent && !square && (
        <span
          aria-hidden
          className="block h-1 w-full"
          style={{
            backgroundColor: user.department_color ? `#${user.department_color}` : "transparent",
          }}
        />
      )}
      <div className="flex items-center gap-2.5 p-2">
        <Avatar
          userId={user.id}
          hasImage={user.profile_pic_r2_key}
          name={user.name}
          email={user.email}
          size={square ? 42 : 32}
          shape={square ? "square" : "circle"}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-1.5">
            <span
              title={user.name || user.email}
              className="line-clamp-2 min-w-0 flex-1 break-words text-[12.5px] font-bold leading-snug text-ink"
            >
              {user.name || user.email}
            </span>
            <ExtraDeptCount user={user} deptById={new Map(departments.map((d) => [d.id, d]))} />
            {user.status !== "active" && (
              <span className="shrink-0 rounded bg-bg px-1 py-px font-mono text-[9px] font-semibold uppercase text-ink-muted">
                {user.status}
              </span>
            )}
            {canManage && !editing && (
              <button
                onClick={() => setEditing(true)}
                className="-mr-0.5 -mt-0.5 shrink-0 rounded p-0.5 text-ink-muted transition-colors hover:bg-surface-dim hover:text-accent"
                aria-label="Edit reporting & department"
                title="Edit reporting & department"
              >
                <Pencil size={11} />
              </button>
            )}
          </div>
          <div className="mt-0.5 truncate text-[11px] font-medium text-ink-secondary">
            {user.position_name || user.role_name || "—"}
            {accent && user.department_name ? (
              <span className="text-ink-muted"> · {user.department_name}</span>
            ) : null}
          </div>
        </div>
      </div>

      {editing && (
        <div className="space-y-2 border-t border-border-subtle bg-bg/60 px-3 py-2.5">
          <div>
            <label className="mb-1 block font-mono text-[9px] font-semibold uppercase tracking-brand text-ink-muted">
              Reports to
            </label>
            <SearchableSelect
              className={ORG_PICKER_CLS}
              ariaLabel="Reports to"
              placeholder="— No manager —"
              value={String(user.manager_id ?? "")}
              onChange={(v) => onPickManager(user.id, v ? Number(v) : null)}
              options={managerOptions(user, users)}
            />
          </div>
          <div>
            <label className="mb-1 block font-mono text-[9px] font-semibold uppercase tracking-brand text-ink-muted">
              Primary department
            </label>
            <SearchableSelect
              className={ORG_PICKER_CLS}
              ariaLabel="Primary department"
              placeholder="— No department —"
              value={String(user.department_id ?? "")}
              onChange={(v) => onChangeDept(user.id, v ? Number(v) : null)}
              options={[
                { value: "", label: "— No department —" },
                ...departments.map((d) => ({ value: String(d.id), label: d.name })),
              ]}
            />
          </div>
          {onChangeDivision && (
            <div>
              <label className="mb-1 block font-mono text-[9px] font-semibold uppercase tracking-brand text-ink-muted">
                Division (org-chart column)
              </label>
              <input
                list="org-division-options"
                defaultValue={user.division ?? ""}
                placeholder="e.g. Penang Team"
                onBlur={(e) => onChangeDivision(user.id, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                }}
                className="h-8 w-full rounded-md border border-border bg-surface px-2 text-[11px] text-ink outline-none focus:border-primary"
              />
              {divisionOptions && divisionOptions.length > 0 && (
                <datalist id="org-division-options">
                  {divisionOptions.map((d) => (
                    <option key={d} value={d} />
                  ))}
                </datalist>
              )}
            </div>
          )}
          <DeptChipsEditor
            user={user}
            departments={departments}
            onChangeDepts={onChangeDepts}
          />
          <button
            type="button"
            onClick={() => setEditing(false)}
            className="text-[10px] text-ink-muted hover:text-ink"
          >
            Done
          </button>
        </div>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────
// Departments tab — small CRUD list of org groupings
// ──────────────────────────────────────────────────────────

/** Fixed palette shown in the colour picker. Values are 6-char hex
 *  without '#', to match the backend contract. Room for 8 entries so
 *  the swatches fit on one row without crowding. */
const DEPT_PALETTE = [
  { hex: "64748b", label: "Slate" },
  { hex: "3b82f6", label: "Blue" },
  { hex: "06b6d4", label: "Cyan" },
  { hex: "10b981", label: "Emerald" },
  { hex: "f59e0b", label: "Amber" },
  { hex: "f97316", label: "Orange" },
  { hex: "ec4899", label: "Pink" },
  { hex: "8b5cf6", label: "Violet" },
];

function DepartmentsTab({
  creating,
  onCloseCreate,
}: {
  creating: boolean;
  onCloseCreate: () => void;
}) {
  const { can } = useAuth();
  const toast = useToast();
  const dialog = useDialog();
  const canManage = can("users.manage");
  const depts = useQuery<{ departments: Department[] }>("/api/departments", () =>
    api.get("/api/departments")
  );
  const [editing, setEditing] = useState<Department | null>(null);

  async function save(
    d: Department | null,
    body: { name: string; description: string | null; color: string; sort_order: number }
  ) {
    try {
      if (d) {
        await api.patch(`/api/departments/${d.id}`, body);
        toast.success(`Updated ${body.name}`);
      } else {
        await api.post("/api/departments", body);
        toast.success(`Created ${body.name}`);
      }
      depts.reload();
      onCloseCreate();
      setEditing(null);
    } catch (e: any) {
      toast.error(e?.message || "Something went wrong. Please try again.");
    }
  }

  async function remove(d: Department) {
    if (
      !(await dialog.confirm(
        `Delete "${d.name}"? Members in this department will be unassigned.`
      ))
    )
      return;
    try {
      await api.del(`/api/departments/${d.id}`);
      toast.success(`Deleted ${d.name}`);
      depts.reload();
    } catch (e: any) {
      toast.error(e?.message || "Something went wrong. Please try again.");
    }
  }

  const rows = depts.data?.departments ?? [];
  const editorOpen = creating || editing !== null;
  const editorRole = creating ? null : editing;

  return (
    <div className="space-y-4">
      {depts.loading && rows.length === 0 && <ListSkeleton rows={3} />}
      {depts.error && <div className="text-[12px] text-err">{depts.error}</div>}

      {rows.length === 0 && !depts.loading ? (
        <EmptyState
          message="No departments yet."
          description="Create one to start tagging members."
        />
      ) : (
        <div className="overflow-hidden rounded-md border border-border bg-surface shadow-stone">
          {rows.map((d) => (
            <div
              key={d.id}
              className="flex items-center gap-3 border-b border-border-subtle px-4 py-3 last:border-b-0"
            >
              <span
                className="h-8 w-2 shrink-0 rounded-sm"
                style={{ backgroundColor: `#${d.color}` }}
                aria-hidden
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[13px] font-semibold text-ink">
                    {d.name}
                  </span>
                </div>
                {d.description && (
                  <div className="mt-0.5 truncate text-[11px] text-ink-muted">
                    {d.description}
                  </div>
                )}
              </div>
              <span
                className="rounded px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider"
                style={{
                  backgroundColor: `#${d.color}22`,
                  color: `#${d.color}`,
                }}
              >
                {d.member_count} member{d.member_count === 1 ? "" : "s"}
              </span>
              {canManage && (
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setEditing(d)}
                    className="rounded p-1.5 text-ink-muted transition-colors hover:bg-surface-dim hover:text-accent"
                    aria-label="Edit"
                    title="Edit department"
                  >
                    <Pencil size={13} />
                  </button>
                  <button
                    onClick={() => remove(d)}
                    className="rounded p-1.5 text-ink-muted transition-colors hover:bg-err/10 hover:text-err"
                    aria-label="Delete"
                    title="Delete department"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {editorOpen && (
        <DepartmentEditor
          department={editorRole}
          onClose={() => {
            onCloseCreate();
            setEditing(null);
          }}
          onSave={(body) => save(editorRole, body)}
        />
      )}
    </div>
  );
}

function DepartmentEditor({
  department,
  onClose,
  onSave,
}: {
  department: Department | null;
  onClose: () => void;
  onSave: (body: {
    name: string;
    description: string | null;
    color: string;
    sort_order: number;
  }) => void;
}) {
  const isCreate = !department;
  const [name, setName] = useState(department?.name || "");
  const [description, setDescription] = useState(department?.description || "");
  const [color, setColor] = useState(department?.color || DEPT_PALETTE[0].hex);
  const [sortOrder, setSortOrder] = useState<number>(department?.sort_order ?? 0);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await onSave({
        name: name.trim(),
        description: description.trim() || null,
        color,
        sort_order: sortOrder,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel
      open
      onClose={onClose}
      title={isCreate ? "New Department" : department!.name}
      subtitle={isCreate ? "Create a team grouping" : "Edit department"}
      width={440}
      footer={
        <div className="flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-md border border-border bg-surface px-3 py-2 text-[12px] text-ink-secondary"
          >
            Cancel
          </button>
          <Button variant="primary" onClick={submit} disabled={busy || !name.trim()}>
            {busy ? "Saving…" : isCreate ? "Create" : "Save"}
          </Button>
        </div>
      }
    >
      <PanelSection title="Details">
        <div>
          <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
            Name
          </label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Sales, Operations, Finance"
            className="h-10 w-full rounded-md border border-border bg-surface px-3 text-[13px] text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            autoFocus
          />
        </div>
        <div>
          <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
            Description
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What this team owns"
            className="min-h-[60px] w-full resize-y rounded-md border border-border bg-surface px-3 py-2 text-[13px] text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
          />
        </div>
        <div>
          <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
            Colour
          </label>
          <div className="flex items-center gap-3">
            <ColorPicker
              value={color}
              onChange={setColor}
              presets={DEPT_PALETTE.map((p) => p.hex)}
              size={36}
            />
          </div>
        </div>
        <div>
          <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
            Sort order
          </label>
          <input
            type="number"
            value={sortOrder}
            onChange={(e) => setSortOrder(parseInt(e.target.value, 10) || 0)}
            className="h-9 w-24 rounded-md border border-border bg-surface px-3 text-[13px]"
          />
          <div className="mt-1 text-[10px] text-ink-muted">
            Lower numbers render first in the list.
          </div>
        </div>
      </PanelSection>
    </Panel>
  );
}

// ──────────────────────────────────────────────────────────
// Invite panel
// ──────────────────────────────────────────────────────────
export function InvitePanel({
  open,
  onClose,
  roles,
  departments,
  positions,
  members,
  companies,
  multiCompany,
  lockDeptId,
  onInvited,
}: {
  open: boolean;
  onClose: () => void;
  roles: Role[];
  departments: Department[];
  positions: Position[];
  members: TeamMember[];
  companies: CompanyOpt[];
  multiCompany: boolean;
  /** Sales Director (scoped) — when provided (number or null), the new member
   *  is FORCED into this department and the Department/Position/Role pickers are
   *  hidden. `undefined` = normal full-admin invite (all pickers shown). */
  lockDeptId?: number | null;
  onInvited: () => void;
}) {
  const toast = useToast();
  // Scoped Sales-Director invite: department is fixed, extra org pickers hidden.
  const scoped = lockDeptId !== undefined;
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [roleId, setRoleId] = useState<number | "">("");
  // Company grants for the new member (Phase 0e). Defaults to Houzs (id 1) so a
  // new user is never created with zero grants. Scoped Sales-Director invites
  // don't show the picker — they are forced to Houzs server-side.
  const [companyIds, setCompanyIds] = useState<number[]>([1]);
  const [deptId, setDeptId] = useState<number | "">(
    scoped ? lockDeptId ?? "" : "",
  );
  const [positionId, setPositionId] = useState<number | "">("");
  const [managerId, setManagerId] = useState<number | "">("");
  const [managerQuery, setManagerQuery] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [posPin, setPosPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<{
    active?: boolean;
    token?: string;
    email: string;
    invite_url?: string;
    email_sent?: boolean;
    pos_pin_set?: boolean;
  } | null>(null);

  // POS PIN is the TABLET credential and it is separate from the password above:
  // pos.2990shome.com signs in by picking a name + 6-digit PIN, with no password
  // field at all. Only a sales position can PIN-login (backend /api/pos/pin-login
  // refuses the rest), so the field appears for exactly those positions.
  const selectedPosition = positions.find((p) => p.id === positionId);
  const isSalesPosition = !!selectedPosition?.slug?.startsWith("sales");
  const salesDeptNoPosition =
    positionId === "" &&
    deptId !== "" &&
    (departments.find((d) => d.id === deptId)?.name ?? "")
      .toLowerCase()
      .includes("sales");

  // Page access for the chosen position — the invitee can only reach pages
  // their position grants, so a position with zero granted pages drops them
  // on a blank/Forbidden app. Fetched on demand to warn before sending.
  const positionPages = useQuery<{
    page_access: Record<string, { explicit?: boolean; level: string }>;
  }>("position-page-access#selected",
    () =>
      positionId !== ""
        ? api.get(`/api/positions/${positionId}/page-access`)
        : Promise.resolve({ page_access: {} }),
    [positionId],
  );
  const positionPageCount =
    positionId === ""
      ? null
      : Object.values(positionPages.data?.page_access ?? {}).filter(
          (v) => v?.level && v.level !== "none",
        ).length;
  const positionHasNoPages =
    positionId !== "" && !positionPages.loading && positionPageCount === 0;

  // Default the role once roles load. Prefer the "Position Preview" role
  // (action permissions only — page visibility still follows the position);
  // fall back to the first non-system role, then any role. Kept in an effect
  // (not the render body) so it never sets state during render.
  useEffect(() => {
    if (roleId !== "" || roles.length === 0) return;
    const preview = roles.find(
      (r) => r.name.trim().toLowerCase() === "position preview",
    );
    // Prefer the neutral "Position Preview" role; else ANY zero-permission
    // non-system role (so the invitee's access comes purely from their
    // position); only then fall back to the first non-system role. Without the
    // zero-perm guard the alphabetically-first non-system role (e.g. "BD Exec",
    // which carries users.manage) was auto-assigned to every invitee.
    const defaultRole =
      preview ||
      roles.find((r) => !r.is_system && (r.permissions?.length ?? 0) === 0) ||
      roles.find((r) => !r.is_system) ||
      roles[0];
    setRoleId(defaultRole.id);
  }, [roles, roleId]);

  async function submit() {
    if (!email) {
      toast.error("Email is required");
      return;
    }
    const pw = password.trim();
    if (pw && pw.length < 12) {
      toast.error("Password must be at least 12 characters");
      return;
    }
    const pin = isSalesPosition ? posPin.trim() : "";
    if (pin && !/^\d{6}$/.test(pin)) {
      toast.error("POS PIN must be exactly 6 digits");
      return;
    }
    setBusy(true);
    try {
      const res = await api.post<{
        active?: boolean;
        token?: string;
        email: string;
        invite_url?: string;
        email_sent?: boolean;
        pos_pin_set?: boolean;
      }>("/api/users/invite", {
        email: email.toLowerCase().trim(),
        name: name.trim() || undefined,
        // Scoped Sales-Director invite: department is FORCED server-side to the
        // director's own; role is defaulted server-side; no position sent. The
        // full-admin flow keeps sending all picked org dimensions.
        role_id: scoped ? undefined : roleId,
        department_id: scoped ? lockDeptId ?? undefined : deptId || undefined,
        position_id: scoped ? undefined : positionId || undefined,
        manager_id: managerId || undefined,
        phone: phone.trim() || undefined,
        // Company grants (Phase 0e). Omitted for scoped invites (forced to
        // Houzs server-side). Backend defaults to [1] (Houzs) if absent.
        company_ids: scoped ? undefined : companyIds,
        password: pw || undefined,
        pos_pin: pin || undefined,
      });
      setIssued(res);
      toast.success(
        res.active
          ? `${res.email} can sign in now`
          : res.email_sent
          ? `Invitation emailed to ${res.email}`
          : `Invitation issued for ${res.email}`
      );
      // The member exists either way; only the tablet PIN failed. Say so
      // instead of letting them find out at the POS.
      if (pin && res.pos_pin_set === false) {
        toast.error(
          "Member created, but the POS PIN could not be set (no sales profile yet) — use Set PIN on their row.",
        );
      }
      onInvited();
    } catch (e: any) {
      toast.error(e?.message || "Failed to invite");
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setEmail("");
    setName("");
    setPhone("");
    setDeptId("");
    setPositionId("");
    setManagerId("");
    setManagerQuery("");
    setCompanyIds([1]);
    setPassword("");
    setShowPassword(false);
    setPosPin("");
    setIssued(null);
    onClose();
  }

  function copyLink() {
    if (!issued) return;
    const link =
      issued.invite_url || `${window.location.origin}/#invite=${issued.token}`;
    navigator.clipboard.writeText(link).then(
      () => toast.success("Invite link copied"),
      () => toast.error("Couldn't access clipboard")
    );
  }

  return (
    <Panel
      open={open}
      onClose={reset}
      title="Invite Member"
      subtitle="Set a password to create the account now, or send an invite link"
      width={440}
    >
      {!issued ? (
        <PanelSection title="Details">
          <div>
            <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
              Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Full name"
              className="h-10 w-full rounded-md border border-border bg-surface px-3 text-[13px] text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
              autoFocus
            />
          </div>
          <div>
            <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
              Email
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="member@houzscentury.com"
              className="h-10 w-full rounded-md border border-border bg-surface px-3 text-[13px] text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
              Password
            </label>
            <div className="relative">
              <input
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Set an initial password (min 12 chars)"
                autoComplete="new-password"
                className="h-10 w-full rounded-md border border-border bg-surface px-3 pr-10 text-[13px] text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
              />
              <button
                type="button"
                onClick={() => setShowPassword((s) => !s)}
                className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-ink-muted transition-colors hover:text-accent"
                aria-label={showPassword ? "Hide password" : "Show password"}
                title={showPassword ? "Hide password" : "Show password"}
              >
                {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
            <div className="mt-1 text-[10px] text-ink-muted">
              Set a password to create the account now — they sign in with email +
              this password (changeable later). Leave blank to send an invite link.
            </div>
          </div>
          <div>
            <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
              Phone
            </label>
            <PhoneInput
              value={phone}
              onChange={setPhone}
              placeholder="12-345 6789 (optional)"
              className="h-10 w-full rounded-md border border-border bg-surface px-3 text-[13px] text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
          </div>
          {scoped ? (
            /* Sales-Director scoped invite — department is fixed to the
               director's own; Position + Role pickers are hidden (assigned by
               an admin later / defaulted server-side). */
            <div>
              <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
                Department
              </label>
              <div className="flex h-10 w-full items-center rounded-md border border-border bg-surface-2 px-3 text-[13px] text-ink-secondary">
                {departments.find((d) => d.id === lockDeptId)?.name ??
                  "Your department"}
              </div>
              <div className="mt-1 text-[10px] text-ink-muted">
                New members join your department. Their position &amp; role can be
                set by an admin afterwards.
              </div>
            </div>
          ) : (
            <>
              <div>
                <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
                  Department
                </label>
                <select
                  value={deptId}
                  onChange={(e) => {
                    setDeptId(e.target.value ? Number(e.target.value) : "");
                    setPositionId(""); // positions are department-scoped — reset
                  }}
                  className="h-10 w-full rounded-md border border-border bg-surface px-3 text-[13px] text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                >
                  <option value="">— Select department —</option>
                  {departments.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
                  Position
                </label>
                <select
                  value={positionId}
                  onChange={(e) => setPositionId(e.target.value ? Number(e.target.value) : "")}
                  className="h-10 w-full rounded-md border border-border bg-surface px-3 text-[13px] text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                >
                  <option value="">— Select position —</option>
                  {positions
                    .filter((p) => deptId === "" || !p.department_id || p.department_id === deptId)
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                </select>
                <div className="mt-1 text-[10px] text-ink-muted">
                  Controls which pages this member can see (least-privilege per position).
                </div>
                {positionHasNoPages && (
                  <div className="mt-1.5 rounded-md border border-warning-text/30 bg-warning-bg px-2.5 py-1.5 text-[10.5px] text-warning-text">
                    This position has no pages enabled yet — set its access under
                    Team → Positions first, or the member sees a blank screen.
                  </div>
                )}
                {salesDeptNoPosition && (
                  <div className="mt-1 text-[10px] text-ink-muted">
                    Pick a Sales position to give this member a POS tablet PIN.
                  </div>
                )}
              </div>
              {isSalesPosition && (
                <div>
                  <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
                    POS PIN
                  </label>
                  <input
                    type="text"
                    value={posPin}
                    onChange={(e) => setPosPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
                    placeholder="6 digits (optional)"
                    inputMode="numeric"
                    autoComplete="off"
                    className="h-10 w-full rounded-md border border-border bg-surface px-3 font-mono text-[13px] tracking-[0.3em] text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                  />
                  <div className="mt-1 text-[10px] text-ink-muted">
                    Tablet sign-in for the POS — they pick their name and enter this
                    PIN (there is no password on the POS). Same PIN re-confirms My
                    Orders. Changeable later from the POS, or via Set PIN on their
                    row.
                  </div>
                </div>
              )}
              <div>
                <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
                  Role
                </label>
                <select
                  value={roleId}
                  onChange={(e) => setRoleId(e.target.value ? Number(e.target.value) : "")}
                  className="h-10 w-full rounded-md border border-border bg-surface px-3 text-[13px] text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                >
                  <option value="">— Select role —</option>
                  {roles.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
                <div className="mt-1 text-[10px] text-ink-muted">
                  Action permissions (which pages they see still follows the Position).
                </div>
              </div>
            </>
          )}
          {!scoped && multiCompany && (
            <div>
              <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
                Company
              </label>
              <CompanySelect
                companies={companies}
                value={companyIds}
                onChange={setCompanyIds}
              />
              <div className="mt-1 text-[10px] text-ink-muted">
                Which company this member works in. "Both" grants access to all
                companies. Defaults to Houzs.
              </div>
            </div>
          )}
          <div>
            <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
              Reports to
            </label>
            <div className="relative">
              <input
                type="text"
                value={managerQuery}
                onChange={(e) => {
                  setManagerQuery(e.target.value);
                  setManagerId("");
                }}
                placeholder="Search a member… (optional)"
                className="h-10 w-full rounded-md border border-border bg-surface px-3 text-[13px] text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
              />
              {managerQuery.trim() !== "" && !managerId && (
                <div className="absolute z-20 mt-1 max-h-48 w-full overflow-auto rounded-md border border-border bg-surface shadow-slab">
                  {(() => {
                    const q = managerQuery.trim().toLowerCase();
                    const matches = members.filter(
                      (m) =>
                        m.status !== "disabled" &&
                        ((m.name || "").toLowerCase().includes(q) ||
                          (m.email || "").toLowerCase().includes(q)),
                    );
                    if (matches.length === 0)
                      return <div className="px-3 py-2 text-[11px] text-ink-muted">No match.</div>;
                    return matches.slice(0, 8).map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => {
                          setManagerId(m.id);
                          setManagerQuery(m.name || m.email);
                        }}
                        className="flex w-full flex-col items-start px-3 py-1.5 text-left transition-colors hover:bg-accent-soft/50"
                      >
                        <span className="text-[12.5px] text-ink">{m.name || m.email}</span>
                        {m.name && <span className="text-[10.5px] text-ink-muted">{m.email}</span>}
                      </button>
                    ));
                  })()}
                </div>
              )}
            </div>
            {managerId !== "" && (
              <button
                type="button"
                onClick={() => {
                  setManagerId("");
                  setManagerQuery("");
                }}
                className="mt-1 text-[10px] text-ink-muted transition-colors hover:text-err"
              >
                Clear report-to
              </button>
            )}
          </div>
          <div className="pt-2">
            <Button variant="brass" className="w-full" onClick={submit} disabled={busy}>
              {busy
                ? "Saving…"
                : password.trim()
                ? "Create Account"
                : "Issue Invitation"}
            </Button>
          </div>
        </PanelSection>
      ) : issued.active ? (
        <PanelSection title="Account Created">
          <p className="text-[12.5px] text-ink-secondary">
            <span className="font-semibold text-ink">{issued.email}</span> can sign in
            now with the password you set. They can change it anytime from their
            profile.
          </p>
          <Button variant="brass" className="w-full" onClick={reset}>
            Done
          </Button>
        </PanelSection>
      ) : (
        <PanelSection title="Invitation Issued">
          <p className="text-[12.5px] text-ink-secondary">
            {issued.email_sent ? (
              <>
                We emailed the invitation to{" "}
                <span className="font-semibold text-ink">{issued.email}</span>.
                The same link is below if you want to share it directly.
              </>
            ) : (
              <>
                The invitation email could not be sent — copy this link and
                share it with{" "}
                <span className="font-semibold text-ink">{issued.email}</span>{" "}
                yourself.
              </>
            )}
          </p>
          <div className="rounded-md border border-border bg-bg p-3">
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
              Invite Link
            </div>
            <div className="break-all font-mono text-[11px] text-ink">
              {issued.invite_url ||
                `${window.location.origin}/#invite=${issued.token}`}
            </div>
          </div>
          <Button variant="brass" className="w-full" icon={<Copy size={14} />} onClick={copyLink}>
            Copy Link
          </Button>
          <div className="text-[10px] text-ink-muted">
            The link expires in 14 days. You can also revoke it from the Pending Invitations
            list at any time.
          </div>
        </PanelSection>
      )}
    </Panel>
  );
}
