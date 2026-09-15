-- 20260915T1900_scm_so_amendment_lane_flag_note.sql
-- REVERSAL:
--   ALTER TABLE scm.so_amendments DROP COLUMN IF EXISTS lane_flag_note;
--   The column is new and nullable; dropping it loses ONLY the requester's
--   note that the computed approver looked wrong — the amendment, its lane,
--   its lines and the AMENDMENT_REQUESTED history row (which also carries the
--   note) stay. GRANTS: none touched — ALTER TABLE keeps the table's ACL.
--
-- WHAT THIS IS FOR (owner 2026-09-15, option B of 「后期再发生可以给我选项选择
-- approver?」). The approval lane of a Sales Order amendment is COMPUTED at
-- submit from the lane table (shared/amendment-lane.ts) and is not the
-- requester's to choose — twice this month the rule itself was what was wrong
-- (docs/bugs/0816, 0895), and an amendment stored with a stale lane could only
-- be moved by the relane workflow (docs/bugs/0928). The submit dialog now shows
-- the requester which desk the request is going to, and lets them FLAG it when
-- that looks wrong, with a note. The request still goes where the rule says;
-- the note travels with it so both desks see the doubt, and an administrator
-- can move it.
--
--   so_amendments.lane_flag_note   the requester's note, NULL when not flagged
--
-- Text, not a boolean: a flag with no words is a shrug, and the note is what the
-- other desk reads to decide whether to ask for the move. Trimmed and capped at
-- 500 characters by the submit route.
SET search_path = scm, public;

ALTER TABLE scm.so_amendments ADD COLUMN IF NOT EXISTS lane_flag_note text;
