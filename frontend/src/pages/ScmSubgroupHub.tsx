import { useNavigate } from "react-router-dom";
import { PageHeader } from "../components/Layout";
import { NAV_TABS, type NavTab } from "../components/Sidebar";
import { HubGrid, type HubCard } from "../components/HubGrid";
import { useAuth } from "../auth/AuthContext";

/**
 * Card copy per module — Nick 2026-07-09 "加上description". Keyed by
 * the same `to` URL each leaf declares in NAV_TABS so a rename there
 * lights up the empty-string fallback (safe) and adding a new leaf
 * defaults to no description until we add it here (deliberate — copy
 * is a hand-authored, on-brand line, not something to autogenerate).
 * Kept as a plain object at module scope so it's a single flat lookup.
 */
const CARD_DESCRIPTIONS: Record<string, string> = {
  // Sales Order
  "/scm/sales-orders":     "Customer orders — draft to delivered.",
  "/scm/delivery-orders":  "Dispatch and delivery tracking.",
  "/scm/sales-invoices":   "Billing issued after delivery.",
  "/scm/delivery-returns": "Returned goods and credit notes.",

  // Consignment
  "/scm/consignment-orders":            "Stock sent out on consignment terms.",
  "/scm/consignment-notes":             "Delivery notes against consignment orders.",
  "/scm/consignment-returns":           "Consigned stock returned to base.",
  "/scm/purchase-consignment-orders":   "Stock received in on consignment terms.",
  "/scm/product-requests":              "New product or repack requests, approved by the Purchaser.",
  "/scm/purchase-consignment-receives": "Consigned stock coming in from suppliers.",
  "/scm/purchase-consignment-returns":  "Consigned stock returned to supplier.",

  // Procurement
  "/scm/products":          "SKU master, categories, product models.",
  "/scm/suppliers":         "Vendor directory and contact details.",
  "/scm/mrp":               "Material requirements and stock status.",
  "/scm/purchase-orders":   "Orders raised to suppliers.",
  "/scm/grns":              "Goods received against a purchase order.",
  "/scm/purchase-invoices": "Supplier invoices to pay.",
  "/scm/purchase-returns":  "Stock returned to supplier.",

  // Transportation
  "/scm/delivery-planning":         "Route planning and dispatch board.",
  "/scm/fleet":                     "Drivers, helpers, and lorries.",
  "/scm/lorry-capacity":            "Available capacity by lorry.",
  "/scm/delivery-planning-regions": "Delivery region maintenance.",

  // Warehouse
  "/scm/warehouses":         "Location master.",
  "/scm/inventory":          "Stock on hand by SKU and warehouse.",
  "/scm/stock-adjustments":  "Manual stock corrections.",
  "/scm/stock-transfers":    "Stock moved between warehouses.",
  "/scm/stock-takes":        "Physical count sessions.",

  // Finance
  "/scm/accounting":  "SCM-scoped GL and journals.",
  "/scm/outstanding": "Receivables and payables ageing.",
};

/**
 * Generic Level 2 hub for a Supply Chain sub-group — Nick 2026-07-09:
 *   "这些也需要做成这样的页面 - 和 project"
 *
 * Drops the operator on a landing page mirroring /projects?view=hub:
 * an eyebrow + title + description, then a card grid of the group's
 * child modules. Driven off NAV_TABS (single source of truth shared
 * with the Sidebar) so adding / removing a leaf under the sub-group
 * lists it here automatically — same permission filter (perm /
 * anyPerm / anyAccess / pageAccess) as ScmHub so an operator only
 * sees the cards they can actually reach.
 *
 * Mounted per sub-group by App.tsx with a static `groupId` prop:
 *   /scm/sales-order    → groupId="scm-sales"
 *   /scm/consignment    → groupId="scm-consignment"
 *   /scm/procurement    → groupId="scm-procurement"
 *   /scm/transportation → groupId="scm-transportation"
 *   /scm/warehouse      → groupId="scm-warehouse"
 *   /scm/finance        → groupId="scm-finance"
 */
export function ScmSubgroupHub({
  groupId,
  description,
}: {
  groupId: string;
  /** One-line landing pitch shown under the title. Kept as a prop so each
   *  sub-group can tune the copy without a NAV_TABS churn. */
  description: string;
}) {
  const navigate = useNavigate();
  const { can, pageAccess } = useAuth();

  // Same visibility filter ScmHub uses so the two hubs never drift.
  const visible = (t: NavTab): boolean => {
    if (t.perm && !can(t.perm)) return false;
    if (t.anyPerm || t.anyAccess) {
      const permOk = t.anyPerm ? t.anyPerm.some((p) => can(p)) : false;
      const accessOk = t.anyAccess
        ? t.anyAccess.some((k) => pageAccess(k) !== "none")
        : false;
      if (!permOk && !accessOk) return false;
    }
    if (t.hidePerm && can(t.hidePerm)) return false;
    if (t.pageAccess && pageAccess(t.pageAccess) === "none") return false;
    if (t.pageAccessFull && pageAccess(t.pageAccessFull) !== "full") return false;
    return true;
  };

  /* Search the WHOLE registry, not just Supply Chain's children. Finance was
     lifted to a root nav group (owner 2026-07-18: "finance and HR is not under
     supply chain") and a lookup anchored to `scm.children` silently turned
     /scm/finance — a live, bookmarkable URL — into "Not found". The sub-group
     hubs are keyed by groupId, so where that group SITS in the tree is not this
     component's business. */
  const findGroup = (tabs: readonly NavTab[]): NavTab | undefined => {
    for (const t of tabs) {
      if (t.groupId === groupId) return t;
      const hit = t.children && findGroup(t.children);
      if (hit) return hit;
    }
    return undefined;
  };
  const group = findGroup(NAV_TABS);
  const kids = (group?.children ?? []).filter(visible);

  // Empty state — a role with SCM access but no leaves inside this specific
  // sub-group (e.g. warehouse without inventory / stock take). Better than a
  // blank grid.
  if (!group) {
    return (
      <div>
        <PageHeader
          eyebrow="Operations · Supply Chain"
          title="Not found"
          description="This section doesn't exist."
        />
      </div>
    );
  }

  const cards: HubCard[] = kids
    .filter((k): k is NavTab & { to: string } => Boolean(k.to))
    .map((k) => ({
      key: k.to,
      label: k.label,
      description: CARD_DESCRIPTIONS[k.to],
      icon: k.icon,
      onClick: () => navigate(k.to),
    }));

  return (
    <div>
      <PageHeader
        eyebrow={`Operations · Supply Chain · ${group.label}`}
        title={group.label}
        description={description}
      />
      {cards.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface p-8 text-center text-[12px] text-ink-muted shadow-stone">
          You don't have access to any {group.label.toLowerCase()} modules yet.
        </div>
      ) : (
        <HubGrid cards={cards} />
      )}
    </div>
  );
}
