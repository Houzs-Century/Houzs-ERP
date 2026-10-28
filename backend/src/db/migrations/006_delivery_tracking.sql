-- ═══════════════════════════════════════
-- Migration 006 — Delivery tracking
--
-- Unified per-order delivery record. Tracks the full lifecycle from
-- DO Ready through to delivered, with region-aware status pipelines,
-- milestone dates, and logistics costing.
--
-- Status pipeline (full EM path):
--   do_ready → pending_shipout → shipped → in_transit →
--   at_warehouse → out_for_delivery → delivered
--
-- WEST orders skip most steps: do_ready → out_for_delivery → delivered
-- SG orders: do_ready → pending_shipout → shipped → delivered
--
-- Idempotent: CREATE IF NOT EXISTS, ALTERs can be re-run.
-- ═══════════════════════════════════════

CREATE TABLE IF NOT EXISTS delivery_tracking (
  doc_no TEXT PRIMARY KEY,

  -- Region determines which steps apply
  region TEXT NOT NULL CHECK(region IN ('WEST','EAST','SG')),

  -- ── Status pipeline ──
  status TEXT NOT NULL DEFAULT 'do_ready'
    CHECK(status IN (
      'do_ready',
      'pending_shipout',
      'shipped',
      'in_transit',
      'at_warehouse',
      'out_for_delivery',
      'delivered',
      'failed'
    )),

  -- ── Milestone dates ──
  do_ready_at TEXT,               -- when goods were marked ready
  shipout_date TEXT,              -- planned shipout (SG/EM)
  pickup_confirmed_at TEXT,       -- verified pickup occurred (SG/EM step 3)
  est_arrival_date TEXT,          -- estimated arrival at EM warehouse (EM step 4)
  arrived_warehouse_at TEXT,      -- confirmed arrival at SBH/SRW (EM step 5)
  est_delivery_date TEXT,         -- estimated final delivery (all regions)
  out_for_delivery_at TEXT,       -- dispatched for last mile
  delivered_at TEXT,              -- actual delivery confirmed
  failed_at TEXT,
  failure_reason TEXT,

  -- ── Costing ──
  order_revenue REAL DEFAULT 0,   -- copied from sales_orders.local_total
  budget_pct REAL DEFAULT 3,      -- from system_settings at creation time
  budget_amount REAL DEFAULT 0,   -- revenue × pct / 100

  freight_cost REAL DEFAULT 0,    -- EM: sea freight / SG: SST
  last_mile_cost REAL DEFAULT 0,  -- all regions
  total_cost REAL DEFAULT 0,      -- freight + last_mile (auto-computed)

  customer_transport_fee REAL DEFAULT 0,  -- what customer was charged (SG/EM)
  delivery_method TEXT DEFAULT 'self'
    CHECK(delivery_method IN ('self','outsource')),

  -- ── Links ──
  trip_id INTEGER,                -- FK to trips (WEST/SG drop-off trip)
  vendor_id INTEGER,              -- FK to vendors (future, nullable)
  em_warehouse TEXT,              -- SBH / SRW for EM orders
  vendor_name TEXT,               -- outsource vendor name (until vendor table)

  -- ── Notes ──
  notes TEXT,

  -- ── Audit ──
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),

  FOREIGN KEY (doc_no) REFERENCES sales_orders(doc_no),
  FOREIGN KEY (trip_id) REFERENCES trips(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_dt_region ON delivery_tracking(region);
CREATE INDEX IF NOT EXISTS idx_dt_status ON delivery_tracking(status);
CREATE INDEX IF NOT EXISTS idx_dt_trip ON delivery_tracking(trip_id);
CREATE INDEX IF NOT EXISTS idx_dt_shipout ON delivery_tracking(shipout_date);
CREATE INDEX IF NOT EXISTS idx_dt_est_delivery ON delivery_tracking(est_delivery_date);

-- ── Delivery tracking status history (audit log) ─────────────────
CREATE TABLE IF NOT EXISTS delivery_status_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_no TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  changed_by INTEGER,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (doc_no) REFERENCES delivery_tracking(doc_no),
  FOREIGN KEY (changed_by) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_dsl_doc ON delivery_status_log(doc_no);
