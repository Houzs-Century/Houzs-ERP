-- 20261128T1700_outsource_transporter_dispatch.sql
-- REVERSAL:
--   DELETE FROM public.position_capabilities
--    WHERE capability = 'scm.do.dispatch'
--      AND position_id IN (SELECT id FROM public.positions WHERE slug = 'outsource_transporter');
--
-- Owner 2026-11-28: an "Outsource Transporter" (a 3PL driver who uploads POD on the
-- Last Mile app) must be able to DISPATCH. The POD submit is gated on the
-- scm.do.dispatch POSITION capability (services/positionCapabilities.ts
-- hasPositionCapability), NOT on the Role. Migration 0322 granted it to
-- 'driver' / 'logistic' / 'ops_executive' / 'ops_director', but not to
-- 'outsource_transporter' (which did not exist then). Without this grant the 3PL
-- drivers log in and see their own stops, but the POD write is refused. Mirrors
-- 0322's grant pattern (presence of a row = the capability); idempotent.
INSERT INTO public.position_capabilities (position_id, capability)
SELECT p.id, 'scm.do.dispatch'
  FROM public.positions p
 WHERE p.slug = 'outsource_transporter'
ON CONFLICT (position_id, capability) DO NOTHING;
