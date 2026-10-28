-- ═══════════════════════════════════════
-- Migration 008 — Activate SBH/SRW as delivery warehouses
--
-- EM orders have a two-leg journey:
--   Leg 1 (transfer): KL Warehouse → Port Klang (sea freight) → SBH/SRW
--   Leg 2 (delivery): SBH/SRW → customer (same model as KL/PG)
--
-- SBH/SRW warehouses become active origins for local delivery trips.
-- ═══════════════════════════════════════

-- ── Activate EM warehouses ───────────────────────────────────────
UPDATE warehouses SET is_active = 1 WHERE code IN ('SBH', 'SRW');

-- ── Update state map: EM states → their local warehouse ──────────
-- These states should map to their local warehouse for last-mile
-- planning (not KL, which is only the origin for the transfer leg).
UPDATE state_warehouse_map SET warehouse = 'SBH' WHERE state IN ('Sabah', 'Labuan');
UPDATE state_warehouse_map SET warehouse = 'SRW' WHERE state = 'Sarawak';

-- ── Remap EM order_details to local warehouse ────────────────────
UPDATE order_details SET warehouse = 'SBH'
  WHERE state IN ('Sabah', 'Labuan') AND warehouse = 'KL';
UPDATE order_details SET warehouse = 'SRW'
  WHERE state = 'Sarawak' AND warehouse = 'KL';
