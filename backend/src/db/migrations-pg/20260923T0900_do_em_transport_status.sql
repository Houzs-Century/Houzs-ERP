-- EM Order layout, phase 1: the East-Malaysia / Singapore cross-border transport
-- status the Delivery Planning board tracks per delivery order (owner 2026-09-23).
-- These sit on scm.delivery_orders beside the existing cross-border columns
-- (shipout_date / eta_arriving_port / arrives_em_warehouse_date, mig 0053): an EM
-- shipment is a DO, and the /fields route already writes DO-execution fields to
-- the order's latest live DO. Two 3PL transporters back-fill them by hand for now
-- (owner's option A): ESB = the sea-freight leg (Port Klang -> EM port), BS = the
-- EM last-mile leg (e.g. KK, Sabah). Nullable, no default; free TEXT for refs and
-- remarks, DATE for the three dated milestones. The cost breakdown (seafreight,
-- local charges, LSS, ... -> 3PL COGS) is PHASE 2 and deliberately not here.
--   em_delivery_status : ESB shipment status / note
--   consignment_no     : ESB bill-of-lading number
--   vessel_voyage      : ESB vessel name & voyage
--   etd_port_klang     : sail date from Port Klang
--   bs_delivery_date   : BS last-mile delivery date (distinct from
--                        arrives_em_warehouse_date = warehouse arrival)
--   esb_remarks        : ESB free remark
--   bs_remarks         : BS free remark
--   ctn                : carton count (free text, e.g. "10")
--   em_delivered_date  : admin "Done Delivery" confirmation date
-- REVERSAL: ALTER TABLE scm.delivery_orders DROP COLUMN IF EXISTS em_delivery_status, DROP COLUMN IF EXISTS consignment_no, DROP COLUMN IF EXISTS vessel_voyage, DROP COLUMN IF EXISTS etd_port_klang, DROP COLUMN IF EXISTS bs_delivery_date, DROP COLUMN IF EXISTS esb_remarks, DROP COLUMN IF EXISTS bs_remarks, DROP COLUMN IF EXISTS ctn, DROP COLUMN IF EXISTS em_delivered_date;
ALTER TABLE scm.delivery_orders ADD COLUMN IF NOT EXISTS em_delivery_status text;
ALTER TABLE scm.delivery_orders ADD COLUMN IF NOT EXISTS consignment_no      text;
ALTER TABLE scm.delivery_orders ADD COLUMN IF NOT EXISTS vessel_voyage       text;
ALTER TABLE scm.delivery_orders ADD COLUMN IF NOT EXISTS etd_port_klang      date;
ALTER TABLE scm.delivery_orders ADD COLUMN IF NOT EXISTS bs_delivery_date    date;
ALTER TABLE scm.delivery_orders ADD COLUMN IF NOT EXISTS esb_remarks         text;
ALTER TABLE scm.delivery_orders ADD COLUMN IF NOT EXISTS bs_remarks          text;
ALTER TABLE scm.delivery_orders ADD COLUMN IF NOT EXISTS ctn                 text;
ALTER TABLE scm.delivery_orders ADD COLUMN IF NOT EXISTS em_delivered_date   date;
