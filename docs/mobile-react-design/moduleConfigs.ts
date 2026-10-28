import { ListConfig } from './types';

// Ready-made ListConfig for every READ-ONLY module — feed into <MobileList config={…} rows={…}/>
// and <MobileDetail>. Includes the previously-excluded backend modules now covered:
// Consignment (orders/notes/returns/purchase), Finance (Outstanding/Accounting),
// Warehouse (Adjustments/Transfers/Stock Take), Transportation (Lorry Capacity/Regions).
// Engineer: swap the mock rows for real API data; field keys already match snake_case columns.

export const MODULE_CONFIGS: Record<string, ListConfig> = {
  // ---- Consignment ----
  consignment_orders: { eyebrow: 'Consignment', title: 'Consignment Orders', search_placeholder: 'Search consignment · partner',
    chip_key: 'status', chips: [{ value: 'all', label: 'All' }, { value: 'Open', label: 'Open' }, { value: 'Partially Returned', label: 'Part. ret' }, { value: 'Closed', label: 'Closed' }],
    title_key: 'partner_name', pill_key: 'status', fields: [{ key: 'doc_no', label: 'Cons No' }, { key: 'order_date', label: 'Date' }, { key: 'items_summary', label: 'Items' }, { key: 'value_centi', label: 'Value' }] },
  consignment_notes: { eyebrow: 'Consignment', title: 'Consignment Notes', search_placeholder: 'Search note · partner',
    title_key: 'partner_name', pill_key: 'status', fields: [{ key: 'doc_no', label: 'Note No' }, { key: 'note_date', label: 'Date' }, { key: 'items_summary', label: 'Items' }] },
  consignment_returns: { eyebrow: 'Consignment', title: 'Consignment Returns', search_placeholder: 'Search return · partner',
    title_key: 'partner_name', pill_key: 'status', fields: [{ key: 'doc_no', label: 'Return No' }, { key: 'return_date', label: 'Date' }, { key: 'reason', label: 'Reason' }, { key: 'value_centi', label: 'Value' }] },
  purchase_consignment: { eyebrow: 'Consignment', title: 'Purchase Consignment', search_placeholder: 'Search doc · supplier',
    title_key: 'supplier_name', pill_key: 'status', fields: [{ key: 'doc_no', label: 'Doc No' }, { key: 'doc_type', label: 'Type' }, { key: 'doc_date', label: 'Date' }, { key: 'value_centi', label: 'Value' }] },
  // ---- Finance ----
  outstanding: { eyebrow: 'Finance', title: 'Outstanding', search_placeholder: 'Search customer · supplier',
    chip_key: 'kind', chips: [{ value: 'all', label: 'All' }, { value: 'Receivable', label: 'AR' }, { value: 'Payable', label: 'AP' }],
    title_key: 'party_name', pill_key: 'kind', fields: [{ key: 'doc_no', label: 'Ref' }, { key: 'due_date', label: 'Due' }, { key: 'aging_bucket', label: 'Aging' }, { key: 'balance_centi', label: 'Balance' }] },
  accounting: { eyebrow: 'Finance', title: 'Accounting', search_placeholder: 'Search entry · account',
    chip_key: 'entry_kind', chips: [{ value: 'all', label: 'All' }, { value: 'Debit', label: 'Debit' }, { value: 'Credit', label: 'Credit' }],
    title_key: 'account_name', pill_key: 'entry_kind', fields: [{ key: 'journal_ref', label: 'Ref' }, { key: 'entry_date', label: 'Date' }, { key: 'amount_centi', label: 'Amount' }] },
  // ---- Warehouse ----
  stock_adjustments: { eyebrow: 'Warehouse', title: 'Stock Adjustments', search_placeholder: 'Search SKU · reason',
    chip_key: 'status', chips: [{ value: 'all', label: 'All' }, { value: 'Draft', label: 'Draft' }, { value: 'Posted', label: 'Posted' }],
    title_key: 'product_name', pill_key: 'status', fields: [{ key: 'sku', label: 'SKU' }, { key: 'qty_delta', label: 'Qty ±' }, { key: 'reason', label: 'Reason' }, { key: 'adjust_date', label: 'Date' }] },
  stock_transfers: { eyebrow: 'Warehouse', title: 'Stock Transfers', search_placeholder: 'Search transfer · SKU',
    chip_key: 'status', chips: [{ value: 'all', label: 'All' }, { value: 'In transit', label: 'In transit' }, { value: 'Received', label: 'Received' }],
    title_key: 'route', pill_key: 'status', fields: [{ key: 'doc_no', label: 'Transfer No' }, { key: 'sku', label: 'SKU' }, { key: 'qty', label: 'Qty' }, { key: 'transfer_date', label: 'Date' }] },
  stock_take: { eyebrow: 'Warehouse', title: 'Stock Take', search_placeholder: 'Search stock take · warehouse',
    chip_key: 'status', chips: [{ value: 'all', label: 'All' }, { value: 'Open', label: 'Open' }, { value: 'Counting', label: 'Counting' }, { value: 'Closed', label: 'Closed' }],
    title_key: 'warehouse_name', pill_key: 'status', fields: [{ key: 'doc_no', label: 'Take No' }, { key: 'take_date', label: 'Date' }, { key: 'counted', label: 'Counted' }, { key: 'variance', label: 'Variance' }] },
  // ---- Transportation ----
  lorry_capacity: { eyebrow: 'Transportation', title: 'Lorry Capacity', search_placeholder: 'Search lorry · plate',
    chip_key: 'status', chips: [{ value: 'all', label: 'All' }, { value: 'Available', label: 'Available' }, { value: 'On trip', label: 'On trip' }],
    title_key: 'plate_no', pill_key: 'status', fields: [{ key: 'lorry_type', label: 'Type' }, { key: 'max_kg', label: 'Max kg' }, { key: 'loaded_kg', label: 'Loaded' }, { key: 'free_kg', label: 'Free' }] },
  regions: { eyebrow: 'Transportation', title: 'Regions', search_placeholder: 'Search region · zone',
    title_key: 'region_name', fields: [{ key: 'zone', label: 'Zone' }, { key: 'postcode_range', label: 'Postcodes' }, { key: 'driver_count', label: 'Drivers' }] },
};
