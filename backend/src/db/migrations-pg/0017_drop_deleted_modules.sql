-- Strip-to-core cutover: drop the tables owned ONLY by the deleted modules
-- (Operations/fleet leaf data, Engagement/gamify, Petty Cash, Overdue history).
--
-- IRREVERSIBLE on prod (PITR is off). Runs on the next deploy via
-- scripts/pg-migrate.mjs. Every table below was verified to have ZERO
-- references from the retained code (Service/QMS, Projects, People, Settings,
-- and the shared search / inbox / notifications / events / users infra).
--
-- DELIBERATELY RETAINED (the retained modules / dependency-only restored routes
-- still read these, so they are NOT dropped here): trips, trip_stops, lorries
-- (events calendar + inbox + global search), sales_orders, order_details,
-- creditors, purchase_orders, purchase_order_docs, warehouses (ASSR cost-
-- suggestion / by-creditor / search), sales_reps + sales_* (Projects sales
-- attendees + rep picker), lorry_incidents + salary_trip_lines (the fleet.ts
-- route restored for the Projects crew/lorry pickers still reads them), and the
-- users.points_balance / users.current_streak COLUMNS (the notifications
-- snapshot reads them — only the point_transactions ledger table is dropped).

-- Operations / fleet — trip_locations is the only fleet table nothing reads
-- (trips/trip_stops/lorries/lorry_incidents/salary_trip_lines all still read).
DROP TABLE IF EXISTS trip_locations CASCADE;

-- Engagement / gamify (Houzs Points, Awards, Innovations, Suggestions)
DROP TABLE IF EXISTS award_redemptions CASCADE;
DROP TABLE IF EXISTS awards CASCADE;
DROP TABLE IF EXISTS votes CASCADE;
DROP TABLE IF EXISTS idea_attachments CASCADE;
DROP TABLE IF EXISTS innovations CASCADE;
DROP TABLE IF EXISTS suggestions CASCADE;
DROP TABLE IF EXISTS leaderboard_cache CASCADE;
DROP TABLE IF EXISTS user_streak_weeks CASCADE;
DROP TABLE IF EXISTS point_transactions CASCADE;
DROP TABLE IF EXISTS gamify_settings CASCADE;

-- Finance (Petty Cash) + Overdue history
DROP TABLE IF EXISTS petty_cash_entries CASCADE;
DROP TABLE IF EXISTS overdue_history CASCADE;
