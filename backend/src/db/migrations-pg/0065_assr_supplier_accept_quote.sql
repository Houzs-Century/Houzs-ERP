-- Supplier portal: Accept job + Submit quote (design handoff 2026-07-02).
--
-- supplier_accepted_at    — timestamp the supplier pressed "Accept job"
--                           in the portal. NULL = not yet accepted.
-- supplier_quote_labour   — labour component (RM) of the supplier's
--                           quote. Warranty cases may legitimately be 0.
-- supplier_quote_materials — materials component (RM).
-- supplier_quote_at       — when the quote was (last) submitted; a
--                           re-submit overwrites the pair and refreshes
--                           this timestamp. Full history in assr_activity.
ALTER TABLE assr_cases ADD COLUMN IF NOT EXISTS supplier_accepted_at TEXT;
ALTER TABLE assr_cases ADD COLUMN IF NOT EXISTS supplier_quote_labour REAL;
ALTER TABLE assr_cases ADD COLUMN IF NOT EXISTS supplier_quote_materials REAL;
ALTER TABLE assr_cases ADD COLUMN IF NOT EXISTS supplier_quote_at TEXT;
