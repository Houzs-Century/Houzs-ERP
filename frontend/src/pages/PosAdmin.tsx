/* POS Admin — the ERP side of the Houzs POS booth app (layouts E1-E9).
 * Owner / admin only (pos.manage). One page, one tab per menu entry; the URL
 * carries the tab. Sales Report, Sync Status and Import backup join in the
 * later build steps. */
import { useSearchParams } from "react-router-dom";
import { PageHeader } from "../components/Layout";
import { TabStrip, type TabOption } from "../components/TabStrip";
import { PosItemsTab } from "./pos-admin/PosItemsTab";
import { PosLabelsTab } from "./pos-admin/PosLabelsTab";
import { PosCashiersTab } from "./pos-admin/PosCashiersTab";
import { PosEventsTab } from "./pos-admin/PosEventsTab";
import { PosTerminalsTab } from "./pos-admin/PosTerminalsTab";
import { PosGeneralTab, PosPrinterScannerTab, PosSstReceiptTab } from "./pos-admin/PosSettingsTabs";

type Tab = "items" | "labels" | "cashiers" | "events" | "sst" | "printer" | "terminals" | "general";
const TABS: Tab[] = ["items", "labels", "cashiers", "events", "sst", "printer", "terminals", "general"];

const HEADER: Record<Tab, { title: string; description: string }> = {
  items: { title: "POS Items", description: "Inventory items tagged for the booth: barcodes, selling price, event price, pre-set (AUTO) discount, FOC, max manual discount, stock source, short receipt name." },
  labels: { title: "Barcode labels", description: "Items with a factory barcode, an own generated one, or none. Generate EAN-13 for the missing ones and print labels on an A4 sheet or a label printer." },
  cashiers: { title: "Cashiers", description: "Part-timer accounts for the POS login tiles. Separate from ERP users: a cashier ID can never sign in to the ERP." },
  events: { title: "Events", description: "Link a project to POS: terminals, cashiers assigned, catalog scope, stock source, event prices, SST default, receipt header. Push catalog update sends changes to prepared devices." },
  sst: { title: "SST & Receipt", description: "SST rate and defaults, receipt title, header and footer, paper width, copies, barcode, salesman and cashier lines, with a live preview." },
  printer: { title: "Printer & Scanner", description: "ESC/POS printer connection and paper, what happens when the printer is unavailable, scanner Enter suffix, beep and repeat-scan behaviour." },
  terminals: { title: "Terminals", description: "The terminal IDs devices pick in Device setup, with their event, printer, prepared time, last seen, last sync, pending bills and app version." },
  general: { title: "General", description: "Payment methods (Cash off by default), idle logout, price override, void rule, receipt number format, alert thresholds and email, heartbeat, POS stock location." },
};

export function PosAdmin() {
  const [params, setParams] = useSearchParams();
  const raw = params.get("tab") as Tab | null;
  const active: Tab = raw && TABS.includes(raw) ? raw : "items";
  const setTab = (next: Tab) => setParams((p) => { const n = new URLSearchParams(p); n.set("tab", next); return n; }, { replace: true });
  const tabs: TabOption<Tab>[] = [
    { value: "items", label: "POS Items" },
    { value: "labels", label: "Barcode labels" },
    { value: "cashiers", label: "Cashiers" },
    { value: "events", label: "Events" },
    { value: "sst", label: "SST & Receipt" },
    { value: "printer", label: "Printer & Scanner" },
    { value: "terminals", label: "Terminals" },
    { value: "general", label: "General" },
  ];
  return (
    <div className="max-w-6xl">
      <TabStrip<Tab> value={active} onChange={setTab} options={tabs} />
      <PageHeader eyebrow="System · POS Admin" title={HEADER[active].title} description={HEADER[active].description} />
      {active === "items" && <PosItemsTab />}
      {active === "labels" && <PosLabelsTab />}
      {active === "cashiers" && <PosCashiersTab />}
      {active === "events" && <PosEventsTab />}
      {active === "sst" && <PosSstReceiptTab />}
      {active === "printer" && <PosPrinterScannerTab />}
      {active === "terminals" && <PosTerminalsTab />}
      {active === "general" && <PosGeneralTab />}
    </div>
  );
}
