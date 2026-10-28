-- Announcements gain a `source` tag so SYSTEM-generated per-user notices
-- (currently: background slip-scan results, source='scan') can be delivered
-- through the same announcements machinery a salesperson already sees — private
-- (target_type USER_IDS), with the unread dot + banner — WITHOUT cluttering the
-- office Announcements composer list. The admin GET /api/announcements filters
-- source='scan' out; the per-user /banner still surfaces them. NULL = a normal
-- human-authored announcement (back-compat default).
ALTER TABLE announcements ADD COLUMN IF NOT EXISTS source text;
