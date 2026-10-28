// ----------------------------------------------------------------------------
// positionAccessSnapshot — a PHOTOGRAPH of `position_page_access`, generated.
//
// DO NOT HAND-EDIT. DO NOT "fix" a cell that looks wrong to you. Every value
// here was read out of the owner's live rows by a script. If a cell is wrong,
// the TABLE is wrong — change it there and regenerate, or the next regeneration
// silently reverts you.
//
// FROZEN 2026-09-17: the table this photographed (position_page_access) and the
// export that regenerated it are gone. The file stays as the fixture the
// position-policy parity tests compare against; it is no longer regenerated.
//
// Generated from : https://erp.houzscentury.com (autocount-sync-api.houzs-erp.workers.dev)
// Positions      : 17
// Explicit rows  : 144
// Orphan rows    : 6 (page_key absent from the registry; inert at login)
// Gap cells      : 712 (registry page with no row for that position)
//
// WHY A PHOTOGRAPH AND NOT A REDRAWING. The rules are moving out of this matrix
// and into backend code, one JD at a time (services/salesJdAccess.ts is the
// first). The owner's constraint on that move is the whole acceptance test:
// "如果你能在拆掉的同時，又保持我現在看到的東西和我會 edit 的東西完全不受影響，
// 每一個 position 的數據都保留". He must not re-configure a single cell — so the
// values cannot be inferred from code, reconstructed from git history, or
// recalled from memory. They are read from his rows. On 2026-07-17 a report of
// Sales Director's access made from the code alone was WRONG and he corrected
// it from memory: nav visibility ORs anyPerm/anyAccess (navFilter.ts:76-91) and
// with scm_l2_configured the scm.access term is dropped, so for a non-`*` user
// the matrix cell alone decides. The data is the authority, not the code.
//
// `entries` IS THE EXPLICIT ROWS ONLY — the keys that HAVE a row. A key absent
// from `entries` had NO ROW, which is NOT the same fact as a row of "none":
// loadPageAccessForPosition resolves a child as `explicit[key] ?? out[parent]`
// (pageAccess.ts:748), so absent means INHERIT THE PARENT and "none" means
// DENIED even under a full parent. Anything that consumes this must preserve
// that distinction. Backfilling the gaps to "none" would sever inheritance on
// every child and is exactly the bug this file is built to avoid
// (reference_houzs_nullish_hides_ignorance).
//
// NOT WIRED. Nothing reads this yet. auth.ts still hydrates page_access from
// the live table (auth.ts:295-299) and the matrix is still editable. The
// sequence is deliberate: export -> the owner reviews the table -> he states
// his adjustments -> we encode them -> THEN the switch. Shipping the switch
// before he has reviewed the table is what would force him to reconfigure.
// ----------------------------------------------------------------------------

import type { AccessLevel } from "./pageAccess";

export interface PositionAccessSnapshotEntry {
  id: number;
  name: string;
  slug: string;
  department_id: number | null;
  department_name: string | null;
  /** EXPLICIT rows only. An absent key means NO ROW (inherit), not "none". */
  entries: Readonly<Partial<Record<string, AccessLevel>>>;
}

/** Which database this was photographed from. Provenance is part of the data:
 *  staging and prod are different Supabase projects with different rows. */
export const POSITION_ACCESS_SNAPSHOT_SOURCE = "https://erp.houzscentury.com (autocount-sync-api.houzs-erp.workers.dev)";

export const POSITION_ACCESS_SNAPSHOT: readonly PositionAccessSnapshotEntry[] = [
  // Management
  {
    id: 1,
    name: "Super Admin",
    slug: "super_admin",
    department_id: 5,
    department_name: "Management",
    entries: {
      "projects": "full",
      "sales": "full",
      "scm": "full",
      "service_cases": "full",
      "settings": "full",
      "system_health": "full",
      "team": "full",
    },
  },
  // Management
  {
    id: 2,
    name: "HR Manager",
    slug: "hr_manager",
    department_id: 5,
    department_name: "Management",
    entries: {
      "team": "view",
    },
  },
  // Management
  // orphan keys (not in the page registry, inert at login): orders, orders.balance, orders.overdue, orders.pnl, overview, petty_cash
  {
    id: 3,
    name: "Finance Manager",
    slug: "finance_manager",
    department_id: 5,
    department_name: "Management",
    entries: {
      "orders": "view",
      "orders.balance": "view",
      "orders.overdue": "view",
      "orders.pnl": "full",
      "overview": "full",
      "petty_cash": "view",
      "projects": "view",
      "projects.calendar": "view",
      "projects.finances": "full",
      "projects.list": "view",
      "projects.maintenance": "view",
      "sales": "none",
      "scm": "view",
      "scm.consignment": "view",
      "scm.consignment.notes": "view",
      "scm.consignment.orders": "view",
      "scm.consignment.po_orders": "view",
      "scm.consignment.po_receives": "view",
      "scm.consignment.po_returns": "view",
      "scm.consignment.returns": "view",
      "scm.finance": "full",
      "scm.finance.accounting": "full",
      "scm.finance.outstanding": "full",
      "scm.procurement": "view",
      "scm.procurement.grn": "view",
      "scm.procurement.mrp": "view",
      "scm.procurement.pi": "view",
      "scm.procurement.po": "view",
      "scm.procurement.pr": "view",
      "scm.procurement.products": "view",
      "scm.procurement.suppliers": "view",
      "scm.sales": "view",
      "scm.sales.delivery": "view",
      "scm.sales.invoices": "view",
      "scm.sales.orders": "view",
      "scm.sales.returns": "view",
      "scm.transportation": "view",
      "scm.transportation.drivers": "view",
      "scm.warehouse": "view",
      "scm.warehouse.adjustments": "view",
      "scm.warehouse.inventory": "view",
      "scm.warehouse.stock_take": "view",
      "scm.warehouse.transfers": "view",
      "service_cases": "view",
      "service_cases.by_creditor": "view",
      "service_cases.cases": "view",
      "service_cases.metrics": "view",
      "service_cases.pnl": "full",
      "service_cases.settings": "none",
      "team": "view",
      "team.departments": "view",
      "team.members": "view",
      "team.org_chart": "view",
      "team.roles": "view",
    },
  },
  // Sales Department
  {
    id: 5,
    name: "Sales Director",
    slug: "sales_director",
    department_id: 1,
    department_name: "Sales Department",
    entries: {
      "projects": "view",
      "projects.calendar": "view",
      "sales": "none",
      "scm.sales": "full",
      "service_cases": "edit",
    },
  },
  // Sales Department
  {
    id: 6,
    name: "Sales Manager",
    slug: "sales_manager",
    department_id: 1,
    department_name: "Sales Department",
    entries: {
      "projects": "view",
      "sales": "none",
      "scm.sales": "view",
      "service_cases": "edit",
    },
  },
  // Sales Department
  {
    id: 7,
    name: "Sales Executive",
    slug: "sales_executive",
    department_id: 1,
    department_name: "Sales Department",
    entries: {
      "projects": "view",
      "sales": "none",
      "scm.sales": "view",
      "service_cases": "edit",
    },
  },
  // Sales Department
  {
    id: 8,
    name: "Sales Person",
    slug: "sales_person",
    department_id: 1,
    department_name: "Sales Department",
    entries: {
      "projects": "view",
      "sales": "none",
      "scm.sales": "view",
      "service_cases": "edit",
    },
  },
  // Operation Department
  {
    id: 10,
    name: "Operation Manager",
    slug: "ops_director",
    department_id: 2,
    department_name: "Operation Department",
    entries: {
      "projects": "view",
      "sales": "none",
      "scm": "full",
      "scm.sales": "view",
      "service_cases": "full",
      "team": "view",
      "team.departments": "view",
      "team.members": "view",
      "team.org_chart": "view",
      "team.roles": "view",
    },
  },
  // Operation Department
  {
    id: 12,
    name: "Operation Executive",
    slug: "ops_executive",
    department_id: 2,
    department_name: "Operation Department",
    entries: {
      "projects": "view",
      "projects.calendar": "edit",
      "projects.list": "edit",
      "sales": "none",
      "scm.procurement": "edit",
      "scm.sales.delivery": "edit",
      "scm.sales.returns": "edit",
      "scm.transportation": "edit",
      "service_cases": "edit",
    },
  },
  // Operation Department
  {
    id: 13,
    name: "Procurement/Purchasing",
    slug: "purchasing",
    department_id: 2,
    department_name: "Operation Department",
    entries: {
      "projects.calendar": "view",
      "scm.procurement": "full",
      "service_cases": "view",
    },
  },
  // Operation Department
  {
    id: 14,
    name: "Logistic Admin",
    slug: "logistic",
    department_id: 2,
    department_name: "Operation Department",
    entries: {
      "projects": "edit",
      "projects.calendar": "view",
      "projects.finances": "view",
      "scm.sales.delivery": "full",
      "scm.sales.returns": "full",
      "scm.transportation": "full",
      "service_cases": "view",
    },
  },
  // Operation Department
  {
    id: 15,
    name: "Storekeeper",
    slug: "storekeeper",
    department_id: 2,
    department_name: "Operation Department",
    entries: {
      "projects": "view",
      "projects.calendar": "view",
      "projects.finances": "none",
      "projects.list": "view",
      "projects.maintenance": "none",
      "scm.procurement.grn": "view",
      "scm.sales.delivery": "view",
      "scm.warehouse": "view",
    },
  },
  // Operation Department
  {
    id: 16,
    name: "Driver",
    slug: "driver",
    department_id: 2,
    department_name: "Operation Department",
    entries: {
      "projects": "view",
      "projects.calendar": "view",
      "projects.finances": "none",
      "projects.list": "view",
      "projects.maintenance": "none",
      "scm.transportation.drivers": "view",
    },
  },
  // Operation Department
  {
    id: 17,
    name: "Helper",
    slug: "helper",
    department_id: 2,
    department_name: "Operation Department",
    entries: {
      "projects": "view",
      "projects.calendar": "view",
      "projects.finances": "none",
      "projects.list": "view",
      "projects.maintenance": "none",
      "scm.sales.delivery": "view",
      "scm.warehouse": "view",
    },
  },
  // Operation Department
  {
    id: 18,
    name: "Service Admin",
    slug: "service_admin",
    department_id: 2,
    department_name: "Operation Department",
    entries: {
      "projects": "view",
      "scm.procurement": "view",
      "service_cases": "full",
    },
  },
  // Operation Department
  {
    id: 19,
    name: "Storekeeper Supervisor",
    slug: "storekeeper_supervisor",
    department_id: 2,
    department_name: "Operation Department",
    entries: {
      "projects": "view",
      "projects.calendar": "view",
      "projects.finances": "none",
      "projects.list": "view",
      "projects.maintenance": "none",
      "scm.procurement.grn": "view",
      "scm.sales.delivery": "view",
      "scm.warehouse": "view",
    },
  },
  // Management
  {
    id: 20,
    name: "Calendar Viewer",
    slug: "calendar-viewer",
    department_id: 5,
    department_name: "Management",
    entries: {
      "projects": "view",
      "projects.calendar": "view",
      "projects.finances": "none",
      "projects.maintenance": "none",
    },
  },
];
