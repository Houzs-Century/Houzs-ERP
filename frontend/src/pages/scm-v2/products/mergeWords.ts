/* What a merge moves, in the words staff use for those documents. */
const NAMES: Partial<Record<string, [string, string]>> = {
  mfg_sales_order_items: ['sales order line', 'sales order lines'],
  purchase_order_items: ['purchase order line', 'purchase order lines'],
  grn_items: ['goods receipt line', 'goods receipt lines'],
  purchase_invoice_items: ['purchase invoice line', 'purchase invoice lines'],
  purchase_return_items: ['purchase return line', 'purchase return lines'],
  delivery_order_items: ['delivery order line', 'delivery order lines'],
  sales_invoice_items: ['sales invoice line', 'sales invoice lines'],
  delivery_return_items: ['delivery return line', 'delivery return lines'],
  inventory_movements: ['stock movement', 'stock movements'],
  inventory_lots: ['stock batch', 'stock batches'],
  inventory_lot_consumptions: ['cost record', 'cost records'],
  stock_transfer_lines: ['stock transfer line', 'stock transfer lines'],
  stock_adjustment_lines: ['stock adjustment line', 'stock adjustment lines'],
  stock_take_lines: ['stock take line', 'stock take lines'],
  warehouse_rack_items: ['rack record', 'rack records'],
  warehouse_rack_movements: ['rack record', 'rack records'],
};

export function movedText(rekey: ReadonlyArray<{ table: string; rows: number }>): string {
  const parts: string[] = [];
  let other = 0;
  for (const r of rekey) {
    const name = NAMES[r.table];
    if (name) parts.push(`${r.rows} ${r.rows === 1 ? name[0] : name[1]}`);
    else other += r.rows;
  }
  if (other > 0) parts.push(`${other} other ${other === 1 ? 'record' : 'records'}`);
  return parts.join(', ') || 'nothing yet';
}
