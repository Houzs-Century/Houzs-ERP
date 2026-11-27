# How-to guides (AI Connector)

Generated from `backend/src/services/mcp-howto-guides*.ts` — do not edit by hand. Regenerate: `HOWTO_WRITE=1 npx vitest run --config vitest.light.config.mts src/services/mcp-howto-readme.test.ts` in `backend/`.

Staff ask Claude "how do I ..."; the connector's `how_to` tool returns the full SOP (purpose, prerequisites, fields, click-by-click steps with `?highlight=` links, checks, warnings, undo, approvals, deadlines, common mistakes, worked example, contact) with `canDo` from the person's own ERP permissions. Every page path and every quoted UI label is checked against `frontend/src` by `mcp-howto-honesty.test.ts`.

## Task guides (27)

| id | Title | Module | Page | Sidebar | Steps |
| --- | --- | --- | --- | --- | --- |
| `so-create` | Create a Houzs sales order | Sales Order | `/scm/sales-orders/new` | Supply Chain > Sales Order > Sales Orders (sales staff: Sales Orders, at the top of the sidebar) | 11 |
| `so-create-2990` | Create a sales order for 2990, an outlet or a fair venue | Sales Order | `/scm/sales-orders/new` | Supply Chain > Sales Order > Sales Orders (sales staff: Sales Orders, at the top of the sidebar) | 6 |
| `so-edit` | Edit a sales order (and when an amendment is needed) | Sales Order | `/scm/sales-orders` | Supply Chain > Sales Order > Sales Orders (sales staff: Sales Orders, at the top of the sidebar) | 6 |
| `so-cancel` | Cancel a sales order (cancellation request and approval) | Sales Order | `/scm/sales-orders` | Supply Chain > Sales Order > Sales Orders (sales staff: Sales Orders, at the top of the sidebar); approvers: Supply Chain > Procurement > Cancellation Requests, or Supply Chain > Sales Order > Sales Order Amendment | 6 |
| `delivery-planning` | Plan deliveries on the Delivery Planning board | Delivery / Transportation | `/scm/delivery-planning` | Supply Chain > Transportation > Delivery Planning | 6 |
| `do-create` | Create a delivery order from a sales order | Delivery Order | `/scm/delivery-orders/from-so` | Supply Chain > Sales Order > Delivery Orders | 6 |
| `si-create` | Create a sales invoice from a delivery order | Sales Invoice | `/scm/sales-invoices/from-do` | Supply Chain > Sales Order > Sales Invoices | 5 |
| `pdf-print` | Print or download the PDF of a sales order, delivery order or invoice | Sales Order | `/scm/sales-orders` | Supply Chain > Sales Order > Sales Orders / Delivery Orders / Sales Invoices | 4 |
| `customer-create` | Create a customer | Sales Order | `/scm/sales-orders/new` | Supply Chain > Sales Order > Sales Orders (sales staff: Sales Orders, at the top of the sidebar) | 4 |
| `po-create` | Create and confirm a purchase order (PO) | Procurement > Purchase Orders | `/scm/purchase-orders/new` | Supply Chain > Procurement > Purchase Orders | 12 |
| `po-from-so` | Create purchase orders from sales orders | Procurement > Purchase Orders | `/scm/purchase-orders/from-so` | Supply Chain > Procurement > Purchase Orders | 7 |
| `grn-receive` | Receive goods from a purchase order (Goods Receipt / GRN) | Procurement > Goods Receipt | `/scm/grns/from-po` | Supply Chain > Procurement > Goods Receipt | 9 |
| `pi-create` | Create a purchase invoice from a Goods Receipt | Procurement > Purchase Invoices | `/scm/purchase-invoices/from-grn` | Supply Chain > Procurement > Purchase Invoices | 7 |
| `supplier-payment` | Pay a supplier (AP payment voucher) | Finance > Money out > Payment vouchers | `/scm/payment-vouchers/new?type=ap` | Finance > Money out > Payment vouchers | 10 |
| `stock-check` | Check the stock of an item (Inventory and Stock Card) | Warehouse > Inventory | `/scm/inventory` | Supply Chain > Warehouse > Inventory | 7 |
| `stock-transfer` | Transfer stock between warehouses | Warehouse > Transfers | `/scm/stock-transfers/new` | Supply Chain > Warehouse > Transfers | 5 |
| `stock-adjust` | Make a stock adjustment | Warehouse > Adjustments | `/scm/stock-adjustments/new` | Supply Chain > Warehouse > Adjustments | 5 |
| `stock-take` | Do a stock take (count, post, approve) | Warehouse > Stock Take | `/scm/stock-takes/new` | Supply Chain > Warehouse > Stock Take | 7 |
| `case-open` | Open a service case (ASSR) | Service Cases | `/assr?view=cases` | Service Cases > Service Cases | 9 |
| `case-stages` | Move a service case through its stages | Service Cases | `/assr?view=cases` | Service Cases > Service Cases | 7 |
| `case-note` | Add a note to a service case | Service Cases | `/assr?view=cases` | Service Cases > Service Cases (office) or Service Cases > My Cases (Sales) | 5 |
| `delivery-return` | Create a delivery return | Delivery Returns | `/scm/delivery-returns/from-do` | Supply Chain > Sales Order > Delivery Returns | 7 |
| `credit-note` | Create a customer credit note | Finance | `/scm/credit-notes` | Finance > Money in > Credit / debit notes | 7 |
| `receipt-record` | Record a customer payment / receipt | Finance | `/scm/receipts` | Finance > Money in > Receipts (and Supply Chain > Sales Order > Sales Orders for the payment) | 6 |
| `mail-reply-assign` | Mail Center: reply to an email and assign a thread | Mail Center | `/mail-center` | Mail Center | 7 |
| `leave-request` | Request leave | HR | `/hr/employees?tab=leave` | HR > Employees & Attendance > Leave (desktop); phone menu > Punch In / Out > Leave | 5 |
| `pos-sale` | Booth POS sale and its admin side | POS | `/pos-admin` | POS Admin (System section) | 8 |

## End-to-end flows (4)

| id | Title | Module | Page | Sidebar | Steps |
| --- | --- | --- | --- | --- | --- |
| `flow-sales` | End-to-end sales flow: sales order to delivery, invoice and payment | Sales Order | `/scm/sales-orders` | Supply Chain > Sales Order > Sales Orders (sales staff: Sales Orders, at the top of the sidebar) | 9 |
| `flow-purchasing` | End-to-end purchasing: PO to GRN to purchase invoice to supplier payment | Procurement and Finance | `/scm/purchase-orders` | Supply Chain > Procurement > Purchase Orders | 11 |
| `flow-after-sales` | After-sales flow: service case intake to close, plus delivery return and credit note | Service Cases | `/assr?view=cases` | Service Cases > Service Cases | 9 |
| `flow-outlet-pos` | Outlet / 2990s POS flow: sale, collection and stock | POS | `/pos-admin` | POS Admin (System section) | 9 |

## Modules (`module_overview`, 27)

- **Overview** (sidebar "Overview"): The start page every signed-in user lands on.
- **Sales Orders (salesperson entry)** (sidebar "Sales Orders"): The top-level shortcut a salesperson uses to raise and follow their own Sales Orders: new orders, deposits taken, Processing Date, Delivery Date and order status.
- **Payment Requests** (sidebar "Payment Requests"): Where a person in charge asks Finance to pay a bill (for example an event's rental) and where a salesperson follows the customer refund they asked for from a Sales Order.
- **Service Cases (after-sales)** (sidebar "Service Cases"): After-sales service from complaint to close.
- **Projects (fairs and events)** (sidebar "Projects"): Exhibitions and events: the project list, calendar, venues, checklists, defects and project finance.
- **Supply Chain** (sidebar "Supply Chain"): The group that holds the whole document chain: Sales Order, Consignment, Procurement, Transportation and Warehouse.
- **Supply Chain > Sales Order** (sidebar "Sales Order"): The sell-side chain: Sales Orders, Delivery Orders that take the goods out of stock, Sales Invoices that bill the customer, Delivery Returns that bring goods back, plus amendments, fair links and payment backdate approvals.
- **Consignment** (sidebar "Consignment"): Goods that move without a sale or purchase invoice.
- **Procurement** (sidebar "Procurement"): The buy-side chain: products and suppliers, MRP stock status, Purchase Orders (often raised from Sales Orders), PO amendments, cancellation requests, Goods Receipt, Purchase Invoices and Purchase Returns.
- **Transportation** (sidebar "Transportation"): Delivery planning and the fleet: the delivery board, crew and lorry assignment, trips, last mile delivery for drivers, manual DP orders, crew leave and the maintenance masters (coverage, zones, carriers and rates).
- **Warehouse** (sidebar "Warehouse"): Stock on hand and its movements: the loading list, warehouses, racks and bins, inventory and stock cards, stock adjustments, transfers between warehouses, stock takes and their approvals.
- **Finance** (sidebar "Finance"): The company's books.
- **HR** (sidebar "HR"): People records: employees and attendance (punches, overtime, payroll), sales commission, and HR settings.
- **Mail Center** (sidebar "Mail Center"): The shared company mailboxes inside the ERP: read incoming mail, assign it to a colleague and reply.
- **Announcements** (sidebar "Announcements"): Company notices for all staff.
- **Team** (sidebar "Team"): Who is who and who can do what: staff directory, org chart, departments, mailboxes, and roles and permissions.
- **IT** (sidebar "IT"): IT's own pages: System Health, AI Usage and OCR.
- **AI Connector** (sidebar "AI Connector"): Connect an AI app such as Claude to the ERP with your own login.
- **AutoCount Sync** (sidebar "AutoCount Sync"): Watch the documents the ERP writes back to AutoCount (SO, PO, DO, GRN, SI, PI) and re-send any that were not accepted.
- **Venture Portal Feed** (sidebar "Venture Portal Feed"): The feed of ERP figures sent to the venture portal.
- **Change Log** (sidebar "Change Log"): What changed in the ERP and when.
- **Agent Console** (sidebar "Agent Console"): The console for the ERP's automated agents.
- **Meetings** (sidebar "Meetings"): Book and follow meetings.
- **IT Support** (sidebar "IT Support"): Ask IT for help with the ERP or equipment.
- **Settings** (sidebar "Settings"): ERP-wide settings for admins.
- **POS Admin** (sidebar "POS Admin"): The ERP side of the booth POS app used at Cash & Carry fairs: events, terminals, cashiers and the POS sales report.
- **Fleet Health** (sidebar "Fleet Health"): Each lorry's maintenance record: services, repairs and time off the road.

## Glossary (`glossary`, 66 terms)

SO, PO, GRN, DO, SI, PI, ASSR, credit note, debit note, delivery return, purchase return, AR aging, AP aging, unapplied payment, 2990s, company switcher, outlet, venue, fair, Fair Day, Fair Links to Settle, MRP, BOM, WIP, SKU, variant, fabric tier, sen vs RM, consignment, amendment, PO amendment, payment voucher, payment request, receipt, deposit invoice, stock take, stock adjustment, stock transfer, delivery planning, DP order, 3PL, trip, last mile, POD, JE / GL / TB, chart of accounts, AutoCount, Processing Date, Delivery Date, Product Request, cancellation request, payment backdate request, Outstanding, Not yet billed, other debtor, merchant report, bank statement, Unmatched Payments, Stock close, Daily Bank, Item groups, Loading List, Racks & Bins, Cash & Carry, SSM, P&L

## First-week paths (`onboarding`, 7)

- `outlet-sales`: Outlet and fair salesperson: first week
- `2990s`: 2990s Home staff: first week
- `purchasing`: Purchaser: first week
- `warehouse`: Storekeeper and warehouse staff: first week
- `finance`: Finance and accounts staff: first week
- `after-sales`: Service Admin (after-sales): first week
- `admin`: Office admin: first week

## Error messages (`explain_error`, 61)

- `session-expired` (system): The ERP no longer recognises your login.
- `no-permission` (system): Your role does not include the permission this action needs.
- `area-forbidden` (supply-chain): You lack page access to this Supply Chain area (for example scm.procurement.po or scm.warehouse.adjustments).
- `rate-limited` (system): Too many attempts in a short time, so the ERP paused you.
- `login-wrong` (system): The sign-in details do not match an account.
- `totp-wrong` (system): The two-factor code was wrong or expired.
- `wrong-company` (system): The record belongs to the other company (Houzs or 2990).
- `mcp-read-only` (ai-connector): The AI tried to change something directly, which the connector does not allow.
- `server-error` (system): The ERP hit an unexpected problem and saved nothing for this click.
- `so-venue-required` (sales-orders): The Sales Order has no venue, so it cannot be confirmed.
- `so-salesperson-required` (sales-orders): The order has no real salesperson on it.
- `so-fair-required` (sales-orders): A Houzs order must name the fair it was sold at, or be marked No fair.
- `so-fair-day-required` (sales-orders): The order is linked to a fair but has no Fair Day.
- `so-processing-date-past` (sales-orders): The Processing Date you keyed is before today.
- `so-processing-after-delivery` (sales-orders): The order would be released to purchasing after it is due to be delivered.
- `so-delivery-date-past` (sales-orders): The Delivery Date is before today, so the order cannot be saved or confirmed.
- `so-discount-too-big` (sales-orders): A line's discount is bigger than the line's value.
- `so-locked-downstream` (sales-orders): The order or line is already delivered or invoiced, so it cannot be edited here.
- `so-after-do-permission` (sales-orders): Only roles with the 'Edit SO after DO' permission may change an order once it has a Delivery Order.
- `so-invoiced-locked` (sales-orders): The order is already billed.
- `so-po-raised-amend` (sales-orders): Purchasing has already ordered the goods, so the order cannot be changed directly.
- `so-salesperson-change-permission` (sales-orders): Only roles with the 'attribute to another salesperson' permission may change who an order is credited to.
- `so-edit-lock-stuck` (sales-orders): Your save worked, but the order stays locked for editing for a short while.
- `so-2990-create-blocked` (sales-orders): You are trying to create a 2990 order inside Houzs ERP.
- `so-2990-read-only` (sales-orders): This 2990 order is a mirrored copy; changes here would be overwritten.
- `amendment-no-permission` (sales-orders): Your role cannot raise amendments.
- `amendment-reject-reason` (sales-orders): A rejection must say why.
- `amendment-withdraw-owner` (sales-orders): Only the requester can withdraw an amendment.
- `cancel-request-open` (supply-chain): Someone already asked to cancel this document.
- `cancel-approver-self` (supply-chain): The same person cannot raise and approve, or give both approval levels.
- `do-over-delivery` (scm-sales-order): Confirming this Delivery Order would deliver more than the order has left.
- `do-status-capability` (transportation): Your position cannot move the Delivery Order to this step.
- `do-locked-downstream` (scm-sales-order): The Delivery Order is already invoiced or returned, so it cannot be edited.
- `si-draft-no-payment` (scm-sales-order): Payments can only be recorded on an issued invoice.
- `si-over-invoice` (scm-sales-order): The invoice would bill more than the Delivery Order has left to bill.
- `dr-not-delivered` (scm-sales-order): Only goods actually delivered can be returned.
- `dr-over-return` (scm-sales-order): The return quantity is more than was delivered minus what was already returned.
- `po-locked-grn` (procurement): Goods have been received on this PO, so it is locked.
- `grn-already-received` (procurement): These PO lines were already received.
- `grn-consumed` (procurement): The received goods have already been shipped or used, so the receipt cannot be reversed.
- `grn-locked-pi` (procurement): The receipt is billed or returned, so it is locked.
- `grn-on-hold` (procurement): The receipt is on hold and cannot be invoiced.
- `pi-over-bill` (procurement): The supplier invoice bills more than was received.
- `pi-payment-locked` (procurement): Supplier invoices are paid through Finance, and once paid they are locked.
- `stock-not-enough-adjust` (warehouse): A write-off would take more stock than the warehouse holds.
- `stock-not-enough-transfer` (warehouse): The source warehouse does not have enough stock for the transfer.
- `adjustment-from-stock-take` (warehouse): This adjustment is the record of a posted stock take.
- `stock-take-self-approve` (warehouse): You cannot approve your own over-limit count.
- `stock-take-not-open` (warehouse): The stock take is posted, waiting approval or cancelled, so it takes no more counts.
- `stock-take-duplicate-line` (warehouse): The item is already on the count sheet.
- `pv-checked-locked` (finance): The payment voucher is checked or approved, so its amounts are locked.
- `refund-request-details` (payment-requests): A refund request needs the customer's bank details and a reason.
- `cancelled-order-payment` (finance): Payments on a cancelled order can only be removed by Finance.
- `debtor-bill-paid` (finance): The debtor bill already has money received on it.
- `deposit-invoice-cancel-reason` (finance): Cancelling a deposit invoice needs a reason.
- `bank-month-reopen` (finance): The bank month was locked after reconciliation; only approvers can reopen it.
- `daily-close-cash` (finance): The daily close needs the cash drawer count.
- `gl-no-permission` (finance): Your role cannot post journals or see the financial figures.
- `je-already-posted` (finance): The journal is already posted, or it belongs to a document.
- `case-reason-short` (service-cases): The reason is too short.
- `case-attachment-limit` (service-cases): The case already holds the maximum number of attachments.
