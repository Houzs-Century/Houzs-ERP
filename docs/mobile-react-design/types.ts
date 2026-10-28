// Houzs ERP Mobile — shared prop types for the React port.
// All money fields end `_centi` (divide by 100 on display). snake_case = real backend column.

export type DocStatus = 'Draft' | 'Submitted' | 'Confirmed' | 'Cancelled';

export interface SoLine {
  item_code: string;          // SKU, e.g. "MIL-LSH"
  description: string;        // product name, e.g. "Milano L-shape sofa"
  variants: string;           // category-specific spec, e.g. "Fabric · Charcoal grey · RHF chaise"
  qty: number;
  unit_price_centi: number;
}
export interface SoPayment {
  payment_method: string;     // "Bank transfer" | "Card" | "Cash"
  account_name: string;       // "CIMB 8001 2231"
  collected_by: string;
  payment_date: string;       // DDMMYYYY
  amount_centi: number;
  approval_code?: string;
}
export interface SalesOrder {
  doc_no: string;             // server-generated, e.g. "SO-2406-0231"
  status: DocStatus;
  customer_name: string;
  phone: string;              // E.164 / display
  email: string;
  customer_type: string;
  salesperson_name: string;
  customer_so_no: string;     // customer's own ref
  building_type: string;
  venue_name: string;         // derived from salesperson venue_id
  processing_date: string;   // Processing date, DDMMYYYY
  customer_delivery_date: string; // Delivery date, DDMMYYYY
  sales_location: string;     // derived warehouse code
  note: string;
  address1: string; address2: string; city: string; customer_state: string; postcode: string;
  total_centi: number;
  paid_centi: number;
  // balance_centi is COMPUTED = total_centi - paid_centi (do not store)
  items: SoLine[];
  payments: SoPayment[];
}

// Generic read-only list/detail engine (Delivery Orders, Invoices, PO, GRN, Products, etc.)
export interface ListColumn { key: string; label: string; }
export interface ListConfig {
  eyebrow: string;
  title: string;
  search_placeholder: string;
  chips?: { value: string; label: string }[];   // status filter chips
  chip_key?: string;
  fields: ListColumn[];       // fields shown per row + in detail
  title_key: string;          // which field is the bold row title
  pill_key?: string;          // which field renders as a status badge
}
export type ListRow = Record<string, string | number>;

export const money = (centi: number) =>
  'RM ' + (centi / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
