/** A SCAN_QUEUE message: a scan job to run, an AI read to run (scm/lib/ai-read-jobs.ts),
 *  or a confirmed correction to learn from. */
export type ScanQueueMessage =
  | { jobId: string }
  | { aiRead: string }
  | { distill: { rep: string | null; companyId: number | null; userId: number | null } };

export type Env = {
  DB: D1Database;
  HYPERDRIVE?: { connectionString: string };
  DATABASE_URL?: string;
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  ANTHROPIC_API_KEY?: string;
  TOTP_ENCRYPTION_KEY?: string;
  FORM_INTAKE_KEY?: string;
  POS_APP_ORIGIN?: string;
  SHEET_SYNC_KEY?: string;
  SHEET_SYNC_KEY_2990?: string;
  CHAT_CALLBACK_KEY?: string;
  SO_CAS_GRACE_UNTIL?: string;
  /** Houzs Connect (chat.houzscentury.com) — the Delivery Planning "Send Now"
   *  POSTs to CONNECT_WEBHOOK_URL/api/webhooks/erp with CONNECT_WEBHOOK_KEY in
   *  the X-Connect-Key header (paired with Connect's own check). BOTH are
   *  wrangler secrets; while either is unset the send endpoint answers 503
   *  not_configured, so the send is OFF until it is deliberately configured.
   *  (Replaced the retired Seampify gateway, owner 2026-09-28.) */
  CONNECT_WEBHOOK_URL?: string;
  CONNECT_WEBHOOK_KEY?: string;
  POD_BUCKET: R2Bucket;
  SO_ITEM_PHOTOS: R2Bucket;
  PUBLIC_ASSETS: R2Bucket;
  SLIPS?: R2Bucket;
  SCAN_QUEUE?: Queue<ScanQueueMessage>;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_ENDPOINT?: string;
  SO_ITEM_PHOTOS_BUCKET_NAME?: string;
  SESSION_CACHE?: KVNamespace;
  SESSION_FALLBACK_ENABLED?: string;
  SESSION_FALLBACK_TTL_MS?: string;
  AUTOCOUNT_API_URL: string;
  AUTOCOUNT_API_KEY: string;
  AUTOCOUNT_SYNC_DISABLED?: string;
  GRN_POST_MODE?: string;
  DO_SHIP_MODE?: string;
  DP_BOARD_SOURCE?: string;
  RECEIPT_REBANK_MODE?: string;
  DELIVERY_RETURN_MODE?: string;
  PURCHASE_RETURN_MODE?: string;
  AC_SYNC_URL?: string;
  AC_SYNC_KEY?: string;
  DASHBOARD_API_KEY: string;
  CONNECT_SERVICE_TOKEN: string;
  GOOGLE_MAPS_API_KEY?: string;
  VELOCITY_REFRESH_TOKEN?: string;
  VELOCITY_CUSTOMER_ID?: string;
  // HC-0050 lorry GPS from iTrack (scm/lib/itrack-poll.ts). Either unset -> the poll is a no-op.
  ITRACK_ACCOUNT?: string;
  ITRACK_PASSWORD?: string;
  RESEND_API_KEY?: string;
  ONEMAP_EMAIL?: string;
  ONEMAP_PASSWORD?: string;
  APNS_TEAM_ID?: string;
  APNS_KEY_ID?: string;
  APNS_PRIVATE_KEY?: string;
  APNS_SANDBOX?: string;
  EMAIL_FROM?: string;
  EMAIL_REPLY_TO?: string;
  PUBLIC_APP_URL?: string;
  GIT_SHA?: string;
  IMPERSONATION_ENABLED?: string;
  COSTING_DISPLAY_ENABLED?: string;
  STOCK_TAKE_VARIANCE_QTY_LIMIT?: string;
  STOCK_TAKE_VARIANCE_VALUE_LIMIT_SEN?: string;
  SENTRY_DSN?: string;
  SENTRY_ENVIRONMENT?: string;
  SENTRY_SAMPLE_RATE?: string;
  HOUZS_OWNS_2990?: string;
  MAIL_INBOUND_SECRET?: string;
  SYNC_SECRET?: string;
  IT_HUB_URL?: string;
  IT_HUB_AI_USAGE_COMPANY?: string;
  SCAN_SO_MODEL?: string;
  BRIDGE_2990_SUPABASE_URL?: string;
  BRIDGE_2990_SERVICE_ROLE_KEY?: string;
  BRIDGE_2990_ANON_KEY?: string;
  BRIDGE_2990_API_URL?: string;
  BRIDGE_2990_EMAIL?: string;
  BRIDGE_2990_PASSWORD?: string;
  ERP_METRICS?: AnalyticsEngineDataset;
  CF_ACCOUNT_ID?: string;
  AE_QUERY_TOKEN?: string;
  GITHUB_TOKEN?: string;
  GITHUB_REPO?: string;
};

export type Region = "WEST" | "EAST" | "SG";
export type SyncStatus = "SYNCED" | "ERROR";

export interface ACSalesOrder {
  DocNo: string;
  TransferTo?: string | null;
  DocDate?: string | null;
  Ref?: string | null;
  SOUDF_BRANDING?: string | null;
  DebtorName?: string | null;
  Phone1?: string | null;
  SalesLocation?: string | null;
  SalesAgent?: string | null;
  Total?: number | null;
  SOUDF_BALANCE?: number | null;
  Remark2?: string | null;
  Remark3?: string | null;
  Remark4?: string | null;
  SOUDF_PDate?: string | null;
  SalesExemptionExpiryDate?: string | null;
  SOUDF_Note?: string | null;
  SOUDF_ToPONo?: string | null;
  InvAddr1?: string | null;
  InvAddr2?: string | null;
  InvAddr3?: string | null;
  InvAddr4?: string | null;
  SOUDF_VENUE?: string | null;
  Attention?: string | null;
  LastModified?: string | null;
}

export interface ACDeliveryOrder {
  DocNo: string;
  DocDate?: string | null;
  Ref?: string | null;
  DebtorName?: string | null;
  SalesAgent?: string | null;
  SalesLocation?: string | null;
  Total?: number | null;
  Cancelled?: string | null;
  LastModified?: string | null;
}

export interface ACSalesOrderDetail {
  DocNo?: string;
  ItemCode?: string | null;
  Description?: string | null;
  ItemDescription?: string | null;
  Qty?: number | null;
  UOM?: string | null;
  UnitPrice?: number | null;
  Amount?: number | null;
  [key: string]: any;
}

export interface ACPurchaseOrder {
  DocNo: string;
  SODocNo?: string | null;
  CreditorCode?: string | null;
  CreditorName?: string | null;
  ItemCode: string;
  ItemDescription?: string | null;
  Location?: string | null;
  DocDate?: string | null;
  RemainingQty?: number | null;
  DeliveryDate?: string | null;
  SupplierDeliveryDate1?: string | null;
  SupplierDeliveryDate2?: string | null;
  SupplierDeliveryDate3?: string | null;
  UnitPrice?: number | null;
  UnitPriceAfterDiscount?: number | null;
  SubTotal?: number | null;
  LocalSubTotal?: number | null;
  LocalSubTotalExTax?: number | null;
  [key: string]: any;
}

/**
 * Doc-level Purchase Order from /PurchaseOrder/getAll. One row per PO
 * document — no line items. Used for cost roll-ups (P&L) and for the
 * "Documents" view on the PO page.
 *
 * `LocalExTax` is the line-item subtotal in local currency, ex-tax —
 * what we want for cost analysis. `LocalNetTotal` is the same with
 * tax. `Cancelled` is "T"/"F" string from AutoCount.
 */
export interface ACPurchaseOrderDoc {
  DocNo: string;
  DocDate?: string | null;
  Ref?: string | null;
  POUDF_SONo?: string | null;
  CreditorCode?: string | null;
  CreditorName?: string | null;
  PurchaseLocation?: string | null;
  DocStatus?: string | null;
  Cancelled?: string | boolean | number | null;
  ExTax?: number | null;
  LocalExTax?: number | null;
  Tax?: number | null;
  LocalTax?: number | null;
  NetTotal?: number | null;
  LocalNetTotal?: number | null;
  Total?: number | null;
  TotalWithTax?: number | null;
  FinalTotal?: number | null;
  CurrencyCode?: string | null;
  CurrencyRate?: number | null;
  Remark1?: string | null;
  Remark2?: string | null;
  Remark3?: string | null;
  Remark4?: string | null;
  Note?: string | null;
  LastModified?: string | null;
  [key: string]: any;
}

export interface SalesOrderRow {
  id: number;
  doc_no: string;
  region: Region;
  transfer_to: string | null;
  doc_date: string | null;
  ref: string | null;
  branding: string | null;
  debtor_name: string | null;
  phone: string | null;
  sales_location: string | null;
  sales_agent: string | null;
  local_total: number;
  balance: number;
  remark2: string | null;
  remark3: string | null;
  remark4: string | null;
  ac_udf_pdate: string | null;
  expiry_date: string | null;
  note: string | null;
  po_doc_no: string | null;
  inv_addr1: string | null;
  inv_addr2: string | null;
  inv_addr3: string | null;
  inv_addr4: string | null;
  venue: string | null;
  sync_status: SyncStatus;
  sync_error: string | null;
  last_modified: string | null;
  created_at: string;
  updated_at: string;
}
