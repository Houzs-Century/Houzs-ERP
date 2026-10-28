-- 0254 — an outbound email can go to more than one person.
--
-- WHY. Owner, 2026-08-03: "为什么 Email Center 里面的 email 栏那边不能加多个或者
-- CC 谁吗?" and "我的整个 email 功能是要完善的，可以 CC。然后那些人回复我的话，我要
-- 怎么回复他?"
--
-- The whole stack was built one-recipient, at four layers: the compose form has
-- one field, the route types `to` as a single string and validates it with a
-- single-address regex, sendEmail takes one string, and this table has one
-- `to_address` column. Resend — the provider underneath all of it — has always
-- accepted arrays and cc/bcc. The capability was there; nothing above it asked.
--
-- THE WORSE HALF, which this also unblocks: the REPLY route has no recipient
-- field at all. An email that CC'd three people is answered to exactly one of
-- them, silently. `email_messages` already stores the inbound `cc_addresses`
-- (mig 0039) — the data for a reply-all has been sitting there unused.
--
-- STORAGE SHAPE. `to_address` keeps its name and its NOT NULL and now holds a
-- comma-separated list; cc/bcc are new nullable columns of the same shape. A
-- separate recipients table would be the tidier model and the wrong trade here:
-- the outbox is a queue row that is written once, drained once and never
-- queried by recipient.
--
-- ONE SEND, NOT N SENDS — this is the important one. The drain makes a SINGLE
-- Resend call carrying every recipient, so a delivery either happens or does
-- not. Looping per recipient would make a mid-loop failure leave the row
-- 'pending', and the */5 cron retry would then deliver a SECOND copy to
-- everyone who already received it. The list must stay one row and one call.
--
-- HOUSE STYLE. Additive, idempotent, one transaction. RE-CHECK THE NUMBER AT
-- MERGE — 0254 was next free above 0253 (which is open on another branch).

ALTER TABLE email_outbox
  ADD COLUMN IF NOT EXISTS cc_address  text NULL,
  ADD COLUMN IF NOT EXISTS bcc_address text NULL;
