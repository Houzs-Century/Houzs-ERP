import type { OnboardingPath } from "./mcp-howto-types";

export const ONBOARDING: OnboardingPath[] = [
  {
    role: "outlet-sales",
    title: "Outlet and fair salesperson: first week",
    keywords: ["new salesperson", "sales onboarding", "outlet sales", "fair sales", "新销售", "销售培训", "入职", "jurujual baru", "latihan jualan"],
    days: [
      {
        day: "Day 1",
        goals: [
          "Sign in, find Overview, Sales Orders and My Cases in the sidebar.",
          "Read three existing Sales Orders end to end: customer, lines, venue, fair, payments, Processing Date and Delivery Date.",
          "Learn the order statuses from Draft to Invoiced.",
        ],
        guides: ["flow-sales"],
        pages: ["/", "/scm/sales-orders"],
      },
      {
        day: "Day 2",
        goals: [
          "Create a customer and a draft Sales Order with a supervisor watching.",
          "Pick the venue and the fair (or No fair for a showroom sale) and the salesperson.",
          "Key the deposit and check the balance.",
        ],
        guides: ["customer-create", "so-create"],
        pages: ["/scm/sales-orders", "/scm/sales-orders/new"],
      },
      {
        day: "Day 3",
        goals: [
          "Edit an order before it is processed and understand when it locks.",
          "Raise a Sales Order Amendment on a locked order and see who approves it.",
          "Print the order PDF for the customer.",
        ],
        guides: ["so-edit", "pdf-print"],
        pages: ["/scm/sales-orders", "/scm/amendments"],
      },
      {
        day: "Day 4",
        goals: [
          "Follow an order through delivery: Delivery Order, delivery date and invoice.",
          "Ask for a customer refund through Payment Requests and learn when a cancel needs approval.",
        ],
        guides: ["so-cancel", "delivery-planning"],
        pages: ["/scm/delivery-orders", "/scm/sales-invoices", "/scm/payment-requests"],
      },
      {
        day: "Day 5",
        goals: [
          "Raise a Service Case for a customer complaint and follow it on My Cases.",
          "Review the week's orders with your Sales Director.",
        ],
        guides: ["case-open"],
        pages: ["/my-cases", "/assr?view=cases"],
      },
    ],
    contact: "Your Sales Director; Sales Admin for order corrections.",
  },
  {
    role: "2990s",
    title: "2990s Home staff: first week",
    keywords: ["2990", "2990s", "2990 staff", "2990 销售", "2990 入职", "staf 2990"],
    days: [
      {
        day: "Day 1",
        goals: [
          "Sign in to the 2990 ERP site and check the top-bar company shows 2990.",
          "Learn that 2990 orders carry the 2990- prefix and keep a 50% deposit on processing (Houzs keeps 30%).",
          "Read three existing 2990 Sales Orders.",
        ],
        guides: ["flow-sales"],
        pages: ["/", "/scm/sales-orders"],
      },
      {
        day: "Day 2",
        goals: [
          "Create a 2990 Sales Order with a supervisor watching.",
          "Understand that orders made in 2990's own system are read-only in Houzs ERP and must be changed in 2990.",
        ],
        guides: ["so-create-2990", "customer-create"],
        pages: ["/scm/sales-orders/new"],
      },
      {
        day: "Day 3",
        goals: ["Edit and amend an order; print the order for the customer."],
        guides: ["so-edit", "pdf-print"],
        pages: ["/scm/sales-orders", "/scm/amendments"],
      },
      {
        day: "Day 4",
        goals: ["Learn the booth POS for Cash & Carry events.", "Follow a delivery for a 2990 order."],
        guides: ["pos-sale", "flow-outlet-pos", "delivery-planning"],
        pages: ["/pos-admin", "/scm/delivery-orders"],
      },
      {
        day: "Day 5",
        goals: ["Raise a Service Case for a 2990 customer and follow it.", "Review the week with your manager."],
        guides: ["case-open"],
        pages: ["/my-cases"],
      },
    ],
    contact: "The 2990 showroom manager; Sales Admin for order corrections.",
  },
  {
    role: "purchasing",
    title: "Purchaser: first week",
    keywords: ["purchaser", "purchasing onboarding", "procurement", "采购", "采购培训", "入职", "pembelian", "pegawai pembelian"],
    days: [
      {
        day: "Day 1",
        goals: [
          "Tour Procurement: Procurement Overview, Products & Maintenance, Suppliers, MRP.",
          "Read how a Sales Order released by its Processing Date becomes demand in MRP.",
        ],
        guides: ["flow-purchasing"],
        pages: ["/scm/procurement-overview", "/scm/products", "/scm/suppliers", "/scm/mrp"],
      },
      {
        day: "Day 2",
        goals: ["Raise a Purchase Order from Sales Orders and one by hand.", "Learn when a PO locks and how a PO amendment works."],
        guides: ["po-from-so", "po-create"],
        pages: ["/scm/purchase-orders", "/scm/purchase-orders/from-so", "/scm/po-amendments"],
      },
      {
        day: "Day 3",
        goals: ["Approve the line amendments waiting for the Purchaser.", "Answer a Product Request."],
        guides: ["so-edit"],
        pages: ["/scm/amendments", "/scm/product-requests"],
      },
      {
        day: "Day 4",
        goals: ["Receive goods against a PO and raise the Purchase Invoice from the receipt."],
        guides: ["grn-receive", "pi-create"],
        pages: ["/scm/grns", "/scm/purchase-invoices"],
      },
      {
        day: "Day 5",
        goals: ["Check stock and cancellation requests; review supplier lateness with your lead."],
        guides: ["stock-check", "supplier-payment"],
        pages: ["/scm/inventory", "/scm/cancel-requests"],
      },
    ],
    contact: "The Purchasing lead.",
  },
  {
    role: "warehouse",
    title: "Storekeeper and warehouse staff: first week",
    keywords: ["storekeeper", "warehouse onboarding", "仓库", "仓管", "入职", "stor", "penjaga stor", "gudang"],
    days: [
      {
        day: "Day 1",
        goals: ["Tour Warehouse: Loading List, Warehouses, Racks & Bins, Inventory.", "Look up a SKU's stock and its stock card."],
        guides: ["stock-check"],
        pages: ["/scm/loading-list", "/scm/warehouses", "/scm/warehouses/racks", "/scm/inventory"],
      },
      {
        day: "Day 2",
        goals: ["Receive goods against a Purchase Order and put them on racks."],
        guides: ["grn-receive"],
        pages: ["/scm/grns"],
      },
      {
        day: "Day 3",
        goals: ["Load a Delivery Order using the loading list and the QR scan.", "Understand that confirming a DO moves stock out."],
        guides: ["do-create", "delivery-planning"],
        pages: ["/scm/delivery-orders", "/scm/loading-list"],
      },
      {
        day: "Day 4",
        goals: ["Move stock between warehouses and correct stock with an adjustment (if your role has it)."],
        guides: ["stock-transfer", "stock-adjust"],
        pages: ["/scm/stock-transfers", "/scm/stock-adjustments"],
      },
      {
        day: "Day 5",
        goals: ["Count a section with a stock take and learn when it needs supervisor approval.", "Receive a customer delivery return."],
        guides: ["stock-take", "delivery-return"],
        pages: ["/scm/stock-takes", "/scm/stock-take-approvals", "/scm/delivery-returns"],
      },
    ],
    contact: "The Warehouse Supervisor.",
  },
  {
    role: "finance",
    title: "Finance and accounts staff: first week",
    keywords: ["finance onboarding", "accounts", "accountant", "财务", "会计", "入职", "kewangan", "akaun", "akauntan"],
    days: [
      {
        day: "Day 1",
        goals: [
          "Tour Finance: To do, Money today, Money in, Money out, Bank & cards, Books, Reports, Setup.",
          "Learn that money is shown in RM and stored in sen, and that each company's books are separate.",
        ],
        guides: [],
        pages: ["/scm/finance", "/scm/daily-bank?view=board"],
      },
      {
        day: "Day 2",
        goals: ["Record and confirm customer receipts; read Outstanding and Not yet billed.", "Learn deposit invoices."],
        guides: ["receipt-record"],
        pages: ["/scm/receipts", "/scm/outstanding", "/scm/unbilled-deliveries", "/scm/finance/deposit-invoices"],
      },
      {
        day: "Day 3",
        goals: ["Issue Sales Invoices and customer credit notes, including from a delivery return."],
        guides: ["si-create", "credit-note"],
        pages: ["/scm/sales-invoices", "/scm/credit-notes"],
      },
      {
        day: "Day 4",
        goals: ["Pay suppliers: supplier bills, payment vouchers through Prepare, Check and Approve, payment requests."],
        guides: ["supplier-payment", "pi-create"],
        pages: ["/scm/ap-invoices", "/scm/payment-vouchers", "/scm/payment-requests"],
      },
      {
        day: "Day 5",
        goals: ["Match bank statements and merchant reports; read the journal entries, general ledger, trial balance and AR / AP aging."],
        guides: [],
        pages: ["/scm/bank-recon", "/scm/merchant-recon", "/scm/accounting?tab=tb", "/scm/accounting?tab=ar"],
      },
    ],
    contact: "The Finance Manager.",
  },
  {
    role: "after-sales",
    title: "Service Admin (after-sales): first week",
    keywords: ["after sales onboarding", "service admin", "售后", "售后培训", "入职", "khidmat selepas jualan", "servis"],
    days: [
      {
        day: "Day 1",
        goals: ["Tour Service Cases: Quality Overview, the case board, Service Maintenance.", "Learn the 7 stages from Review to Completed."],
        guides: ["flow-after-sales"],
        pages: ["/assr?view=metrics", "/assr?view=cases"],
      },
      {
        day: "Day 2",
        goals: ["Open a case from a customer complaint and link it to the Sales Order."],
        guides: ["case-open"],
        pages: ["/assr?view=cases"],
      },
      {
        day: "Day 3",
        goals: ["Move cases through the stages and add notes the team can see."],
        guides: ["case-stages", "case-note"],
        pages: ["/assr?view=cases"],
      },
      {
        day: "Day 4",
        goals: ["Book own-team pickup and delivery legs onto Delivery Planning; handle a delivery return and its credit note."],
        guides: ["delivery-return", "credit-note"],
        pages: ["/scm/delivery-planning", "/scm/delivery-returns"],
      },
      {
        day: "Day 5",
        goals: ["Answer customer emails from the shared mailbox and assign them."],
        guides: ["mail-reply-assign"],
        pages: ["/mail-center"],
      },
    ],
    contact: "The Service Admin lead.",
  },
  {
    role: "admin",
    title: "Office admin: first week",
    keywords: ["admin onboarding", "office admin", "sales admin", "行政", "文员", "入职", "pentadbir", "kerani"],
    days: [
      {
        day: "Day 1",
        goals: ["Tour Supply Chain and its sub-groups; learn the document chain SO to DO to SI and SO to PO to GRN to PI."],
        guides: ["flow-sales", "flow-purchasing"],
        pages: ["/scm", "/scm/sales-order", "/scm/procurement"],
      },
      {
        day: "Day 2",
        goals: ["Create customers and Sales Orders for salespeople; settle orders on Fair Links to Settle."],
        guides: ["customer-create", "so-create"],
        pages: ["/scm/sales-orders", "/scm/fair-pending"],
      },
      {
        day: "Day 3",
        goals: ["Raise Delivery Orders and Sales Invoices from orders."],
        guides: ["do-create", "si-create"],
        pages: ["/scm/delivery-orders", "/scm/sales-invoices"],
      },
      {
        day: "Day 4",
        goals: ["Work the shared mailbox and announcements; check documents in AutoCount Sync if your role has it."],
        guides: ["mail-reply-assign"],
        pages: ["/mail-center", "/announcements", "/autocount-sync"],
      },
      {
        day: "Day 5",
        goals: ["Look up colleagues in the directory and learn who approves what."],
        guides: [],
        pages: ["/team?tab=directory"],
      },
    ],
    contact: "The Office Manager; IT Support for login and access problems.",
  },
];
