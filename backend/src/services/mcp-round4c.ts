import type { AuthUser } from "./auth";
import { hasPermission } from "./permissions";
import { hasScmUmbrella } from "./scmUmbrella";
import { scmAreaReadable } from "../scm/middleware/area-guard";
import { fairReportAccess } from "../scm/lib/fair-report";
import type { ActionSwitches } from "./mcp-store";
import { kindAllowed } from "./mcp-write-actions";

type Obj = Record<string, unknown>;
type Gate = (u: AuthUser) => boolean;

const scmRead = (area: string): Gate => (u) => scmAreaReadable(u, area);
const perm = (...keys: string[]): Gate => (u) => keys.some((k) => hasPermission(u.permissions_set, k));
const fairSo: Gate = (u) => hasScmUmbrella(u) && fairReportAccess("so", u).allowed;
const accounting = scmRead("scm.finance.accounting");
const outstanding = scmRead("scm.finance.outstanding");
const inventory = scmRead("scm.warehouse.inventory");
const purchaseOrders = scmRead("scm.procurement.po");

/**
 * Round 4c P1: the ERP gate of the endpoint(s) each read tool needs, as the ERP's
 * own predicates (scmAreaReadable is pinned to scmAreaGuard by tests/scmAreaReadable.test.ts;
 * fairReportAccess is the Sales Report's own check; the flat keys are the
 * routes' requirePermission). A tool is listed when ANY gate passes. A tool not
 * named here is always listed and the ERP answers for it. Listing never grants:
 * a hidden tool called directly still goes through the ERP and gets "no access".
 */
export const TOOL_GATES: Record<string, readonly Gate[]> = {
  sales_summary: [fairSo],
  outlet_sales: [fairSo],
  delivery_summary: [scmRead("scm.transportation.drivers")],
  pos_sales: [perm("pos.manage")],
  attendance_today: [perm("hr.employees.read", "hr.employees.manage", "hr.attendance.read")],
  after_sales_sla: [perm("service_cases.read")],
  payables_summary: [accounting],
  receivables_summary: [accounting, outstanding],
  uninvoiced_deliveries: [outstanding],
  stock_check: [inventory],
  inventory_summary: [inventory],
  po_overdue: [purchaseOrders],
  po_awaiting_receipt: [purchaseOrders],
  supplier_lateness: [purchaseOrders],
  company_report: [accounting, fairSo, perm("service_cases.read")],
  propose_note: [perm("service_cases.write", "service_cases.create", "service_cases.manage")],
};

const ACTION_TOOL_KIND: Record<string, "meeting" | "email" | "mail_reply" | "note"> = {
  propose_meeting: "meeting",
  propose_email: "email",
  propose_mail_reply: "mail_reply",
  propose_note: "note",
};

/** Is this tool listed for this person? Read tools by their ERP gate; action tools also need their switch on. */
export function toolVisible(name: string, user: AuthUser, sw: ActionSwitches): boolean {
  const kind = Object.prototype.hasOwnProperty.call(ACTION_TOOL_KIND, name) ? ACTION_TOOL_KIND[name] : null;
  if (kind && !kindAllowed(kind, sw)) return false;
  if ((name === "confirm_action" || name === "cancel_action") && !sw.master) return false;
  const gates = Object.prototype.hasOwnProperty.call(TOOL_GATES, name) ? TOOL_GATES[name] : null;
  return !gates || gates.some((g) => g(user));
}

/** tools/list for this person. */
export function visibleTools<T extends { name: string }>(tools: readonly T[], user: AuthUser, sw: ActionSwitches): T[] {
  return tools.filter((t) => toolVisible(t.name, user, sw));
}

const COMPANY_ARG = { name: "company", description: "HOUZS (default) or 2990", required: false };
const PERIOD_ARG = { name: "period", description: "today | week | month | last_month | quarter | year, or YYYY-MM (default month)", required: false };

/** Round 4c P2: one prompt per role, each naming the tools it uses. */
export const ROLE_PROMPTS = [
  { name: "owner_morning_report", title: "Owner morning report", description: "The day's management picture: my to-do, this month vs last, today's outlet sales, overdue orders and POs, cases past deadline.", arguments: [COMPANY_ARG], tools: ["daily_brief", "company_report", "outlet_sales", "so_overdue", "po_overdue", "after_sales_sla"] },
  { name: "finance_review", title: "Finance review", description: "Receivables, payables, delivered-not-invoiced and the month's P&L.", arguments: [PERIOD_ARG, COMPANY_ARG], tools: ["receivables_summary", "payables_summary", "uninvoiced_deliveries", "company_report"] },
  { name: "purchasing_review", title: "Purchasing review", description: "Overdue POs, POs still being received by outlet, late suppliers and short stock.", arguments: [COMPANY_ARG], tools: ["po_overdue", "po_awaiting_receipt", "supplier_lateness", "inventory_summary"] },
  { name: "outlet_manager_review", title: "Outlet manager review", description: "One outlet's sales vs the previous period, its overdue orders, deliveries due and service cases.", arguments: [{ name: "outlet", description: "The showroom / outlet name (default: all)", required: false }, PERIOD_ARG, COMPANY_ARG], tools: ["outlet_sales", "so_overdue", "deliveries_due", "service_cases"] },
  { name: "after_sales_review", title: "After-sales review", description: "Open service cases by stage and age, cases past deadline, and what this period's cases are about.", arguments: [PERIOD_ARG, COMPANY_ARG], tools: ["after_sales_summary", "after_sales_sla", "service_cases"] },
  { name: "hr_today", title: "HR today", description: "Who is on leave, absent or late today, and the leave requests waiting for me.", arguments: [], tools: ["attendance_today", "daily_brief"] },
] as const;

/** A role prompt's message (prompts/get). Unknown name → null. */
export function rolePromptText(name: string, a: Record<string, unknown>): string | null {
  const v = (k: string) => (typeof a[k] === "string" && (a[k] as string).trim() ? (a[k] as string).trim().slice(0, 80) : "");
  const co = v("company") ? ` Pass company "${v("company")}" to every call.` : "";
  const period = v("period") || "month";
  const close = " Money in RM. Give each item's ERP link. Keep it short, in plain language. If a call says I have no access, say so in one line and carry on.";
  switch (name) {
    case "owner_morning_report":
      return `Give me my morning report.${co} Call daily_brief, company_report {period: "month"}, outlet_sales {period: "today"}, so_overdue, po_overdue and after_sales_sla. Start with what needs me today, then this month vs last month, today's sales by outlet, then overdue orders, overdue POs and cases past deadline.${close}`;
    case "finance_review":
      return `Finance review for ${period}.${co} Call receivables_summary, payables_summary, uninvoiced_deliveries {min_age_days: 31} and company_report {period: "${period}"}. Cover what customers owe and how old it is, what we owe suppliers and what is due this week, goods delivered but not invoiced, and the P&L vs the previous period.${close}`;
    case "purchasing_review":
      return `Purchasing review.${co} Call po_overdue, po_awaiting_receipt, supplier_lateness and inventory_summary. Cover overdue POs by supplier, what is still being received by outlet, the suppliers late most often, and items short or negative.${close}`;
    case "outlet_manager_review": {
      const outlet = v("outlet");
      return `Outlet review${outlet ? ` for ${outlet}` : ""} for ${period}.${co} Call outlet_sales {period: "${period}"}, so_overdue, deliveries_due and service_cases {period: "${period}"}.${outlet ? ` Focus on ${outlet}: its sales vs the previous period and vs other outlets, its overdue orders, its deliveries due and its service cases.` : " Cover sales by outlet vs the previous period, overdue orders, deliveries due and service cases by outlet."}${close}`;
    }
    case "after_sales_review":
      return `After-sales review for ${period}.${co} Call after_sales_summary, after_sales_sla and service_cases {period: "${period}"}. Cover open cases by stage and age, the cases past deadline (most overdue first), cases stuck in a stage, and what this period's cases are about vs the previous period.${close}`;
    case "hr_today":
      return `HR today. Call attendance_today and daily_brief. Who is on leave, absent, late or not clocked in yet, and the leave requests waiting for my approval.${close}`;
    default:
      return null;
  }
}

/** prompts/list for this person: a role prompt is listed when at least one of its tools is. */
export function visibleRolePrompts(user: AuthUser, sw: ActionSwitches) {
  return ROLE_PROMPTS.filter((p) => p.tools.some((t) => toolVisible(t, user, sw))).map(({ tools, ...p }) => ({ ...p, description: `${p.description} Uses ${tools.join(", ")}.` }));
}

const prop = (description: string) => ({ description });
const ROWS_WITH_LINKS = "Each row that is a document carries url, its ERP page.";

/** Round 4c P3: what each quick answer returns as structuredContent. Every key is optional (sections drop out when the role may not read them). */
export const OUTPUT_KEYS: Record<string, Record<string, string>> = {
  sales_summary: { from: "First day", to: "Last day", orders: "Sales orders", salesRm: "Sales (RM)", previousPeriod: "The same days of the previous period", byShowroom: "Per showroom", byBrand: "Per brand", bySalesperson: "Per salesperson", byState: "Per state", daily: "Per day" },
  delivery_summary: { from: "First day", to: "Last day", deliveryOrders: "Delivery orders", amountRm: "Amount (RM)", previousPeriod: "The same days of the previous period", byRegion: "Per region", topLorries: "Per lorry", daily: "Per day", gaps: "Open process gaps", trend: "6-month trend" },
  outlet_sales: { period: "The period asked", from: "First day", to: "Last day", totals: "All outlets, with the comparisons", outlets: "Per outlet (names merged regardless of case), each with url to the Sales Report" },
  pos_sales: { period: "The period asked", from: "First day", to: "Last day", totals: "All events", events: "Per booth event" },
  after_sales_summary: { openCases: "Open cases", pendingReview: "Pending review", pastDeadline: "Past deadline", byStage: "Per stage", byStatus: "Per status", byAge: "Per age band", oldest: "Oldest open cases" },
  attendance_today: { date: "Today", staff: "Staff counted", onLeave: "On leave", absent: "Absent", late: "Late", noRecordYet: "Not clocked in yet" },
  daily_brief: { today: "Today", waitingForYou: "Total items waiting", sections: "Each to-do with its count and first items", allClear: "Nothing waiting" },
  po_overdue: { awaitingReceipt: "Still to be received", overdue: "Past the supplier date", dueThisWeek: "Due this week", overdueBySupplier: "Per supplier" },
  supplier_lateness: { from: "First day", to: "Last day", receivedPosInWindow: "POs received", lateDeliveries: "Received late", suppliers: "Per supplier" },
  payables_summary: { asOf: "Aging date", totalRm: "Owed to suppliers (RM)", aged: "Per age band", pastDueRm: "Past due (RM)", dueThisWeekRm: "Due this week (RM)", bySupplier: "Per supplier" },
  so_overdue: { overdue: "Overdue sales orders", valueRm: "Their value (RM)", top: "Most overdue", bySalesperson: "Per salesperson" },
  deliveries_due: { today: "Due today", thisWeek: "Due in the next 6 days", byDay: "Per day", deliveryOrders: "Delivery orders", salesOrdersWithoutDo: "Sales orders due with no delivery order" },
  receivables_summary: { deliveredNotInvoiced: "Goods delivered but never invoiced", invoicedNotPaid: "The debtor aging", notAvailable: "Sections the role may not read" },
  stock_check: { query: "What was asked", matches: "Products matched", items: "Per product: on hand, reserved, available, incoming" },
  inventory_summary: { short: "Orders exceed stock + incoming", negative: "Ledger below zero", slowMoving: "No sale in the window", ledgerMismatch: "Items whose ledger and stock disagree" },
  uninvoiced_deliveries: { deliveryOrders: "Delivery orders not invoiced", unbilledRm: "Their value (RM)", byAge: "Per age band", bySalesperson: "Per salesperson", byCustomer: "Per customer", oldest: "Oldest first" },
  po_awaiting_receipt: { stillBeingReceived: "Totals", partlyReceived: "Partly received", awaitingFirstReceipt: "Waiting for the first receipt", byLocation: "Per receiving location" },
  customer_overview: { customersMatched: "Customers matched", salesOrders: "Their sales orders", outstanding: "Unpaid balance", openServiceCases: "Open service cases", lastDelivery: "Latest delivery", lastContact: "Latest touch in the ERP" },
  after_sales_sla: { pastDeadline: "Cases past deadline", pastDeadlineByStage: "Per stage", pastDeadlineByPriority: "Per priority", mostOverdue: "Most overdue first", stuckInStage: "More than 3 days in a stage" },
  service_cases: { period: "The period asked", cases: "Cases reported", previousPeriodCases: "Previous period", byCategory: "Per category", byOutlet: "Per outlet", byStage: "Per stage", recent: "Latest cases with what each is about" },
  company_report: { period: "The period", profitAndLoss: "From the books (finance only)", salesOrders: "Sales orders, by outlet", receivables: "Debtor aging", payables: "Creditor aging", afterSales: "Service cases", notAvailable: "Sections the role may not read" },
};

/** The outputSchema for a quick answer, or null for a tool that has none. Loose on purpose: no required keys, extra keys allowed. */
export function outputSchemaFor(name: string): Obj | null {
  const keys = Object.prototype.hasOwnProperty.call(OUTPUT_KEYS, name) ? OUTPUT_KEYS[name] : null;
  if (!keys) return null;
  return {
    type: "object",
    description: `Money in RM, dates in Malaysia time. ${ROWS_WITH_LINKS}`,
    properties: { note: prop("How the figures are counted"), ...Object.fromEntries(Object.entries(keys).map(([k, d]) => [k, prop(d)])) },
    additionalProperties: true,
  };
}

/** The tool list with outputSchema on every quick answer. */
export function withOutputSchemas<T extends { name: string }>(tools: readonly T[]): (T & { outputSchema?: Obj })[] {
  return tools.map((t) => {
    const s = outputSchemaFor(t.name);
    return s ? { ...t, outputSchema: s } : t;
  });
}

type TextResult = { content: { type: "text"; text: string }[]; isError?: boolean; structuredContent?: Obj };

/** A successful quick answer with its JSON also as structuredContent (the text stays). Errors and other tools are untouched. */
export function withStructured<T extends TextResult>(name: string, result: T): T & { structuredContent?: Obj } {
  if (result.isError || !outputSchemaFor(name)) return result;
  const raw = result.content.length ? result.content[0].text : "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  const structured = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Obj) : { result: parsed ?? raw };
  return { ...result, structuredContent: structured };
}
