-- 0107_mail_company_id.sql — multi-company company_id stamp for the Mail Center
-- (the in-ERP shared inbox, migration 0039).
--
-- P0 cross-company LEAK (multi-company merge, HOUZS=1 / 2990=2): mail-center.ts
-- and mail-inbound.ts had ZERO company scoping — both companies shared ONE
-- inbox (every thread, message, address, grant and label was global), so a 2990
-- user would read Houzs's mail and vice-versa once 2990's inbound address is
-- wired. This migration adds company_id to the PER-COMPANY mail tables; the
-- paired code change adds the per-request predicates + inbound tagging.
--
-- Per-company vs shared (see PR body for the full table):
--   PER-COMPANY (stamped here): email_addresses, email_address_access,
--     email_threads, email_messages, email_labels.
--   SHARED / inherit (NOT stamped): email_attachments (child of email_messages —
--     reachable only through its already-scoped thread), mail_user_scope (a
--     per-USER visibility preference keyed uniquely on user_id), email_outbox
--     (the SYSTEM-WIDE auto-send log, written by many non-mail services — a
--     separate follow-up, out of scope here).
--
-- Pattern EXACTLY mirrors 0093 (one single-line DO block per table so the
-- pg-migrate runner's /;\s*\n/ splitter keeps each block whole — a multi-line DO
-- block would break the deploy):
--   relkind ('r','p') guard -> resolve HOUZS id into a DECLAREd variable (a
--   DEFAULT expression cannot be a subquery) -> ADD COLUMN IF NOT EXISTS ->
--   backfill existing rows to HOUZS (all existing mail is Houzs's today) -> SET
--   NOT NULL -> SET DEFAULT <houzs id> via EXECUTE format (safety net: an
--   unstamped insert — e.g. inbound whose company can't be resolved — lands on
--   HOUZS instead of violating NOT NULL) -> FK public.companies -> index.
--
-- email_labels additionally swaps its GLOBAL `lower(name)` unique index for a
-- PER-COMPANY `(company_id, lower(name))` one, so each company can own a label
-- of the same name (e.g. both may have "Urgent").
--
-- ADDITIVE + idempotent + re-run-safe.

-- public.email_addresses
DO $$ DECLARE hid bigint; BEGIN IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='email_addresses' AND c.relkind IN ('r','p')) THEN SELECT id INTO hid FROM public.companies WHERE code = 'HOUZS'; IF hid IS NULL THEN RETURN; END IF; ALTER TABLE public.email_addresses ADD COLUMN IF NOT EXISTS company_id bigint; EXECUTE format('UPDATE public.email_addresses SET company_id = %s WHERE company_id IS NULL', hid); ALTER TABLE public.email_addresses ALTER COLUMN company_id SET NOT NULL; EXECUTE format('ALTER TABLE public.email_addresses ALTER COLUMN company_id SET DEFAULT %s', hid); ALTER TABLE public.email_addresses DROP CONSTRAINT IF EXISTS email_addresses_company_id_fkey; ALTER TABLE public.email_addresses ADD CONSTRAINT email_addresses_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id); CREATE INDEX IF NOT EXISTS idx_email_addresses_company_id ON public.email_addresses (company_id); END IF; END $$;

-- public.email_address_access
DO $$ DECLARE hid bigint; BEGIN IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='email_address_access' AND c.relkind IN ('r','p')) THEN SELECT id INTO hid FROM public.companies WHERE code = 'HOUZS'; IF hid IS NULL THEN RETURN; END IF; ALTER TABLE public.email_address_access ADD COLUMN IF NOT EXISTS company_id bigint; EXECUTE format('UPDATE public.email_address_access SET company_id = %s WHERE company_id IS NULL', hid); ALTER TABLE public.email_address_access ALTER COLUMN company_id SET NOT NULL; EXECUTE format('ALTER TABLE public.email_address_access ALTER COLUMN company_id SET DEFAULT %s', hid); ALTER TABLE public.email_address_access DROP CONSTRAINT IF EXISTS email_address_access_company_id_fkey; ALTER TABLE public.email_address_access ADD CONSTRAINT email_address_access_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id); CREATE INDEX IF NOT EXISTS idx_email_address_access_company_id ON public.email_address_access (company_id); END IF; END $$;

-- public.email_threads
DO $$ DECLARE hid bigint; BEGIN IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='email_threads' AND c.relkind IN ('r','p')) THEN SELECT id INTO hid FROM public.companies WHERE code = 'HOUZS'; IF hid IS NULL THEN RETURN; END IF; ALTER TABLE public.email_threads ADD COLUMN IF NOT EXISTS company_id bigint; EXECUTE format('UPDATE public.email_threads SET company_id = %s WHERE company_id IS NULL', hid); ALTER TABLE public.email_threads ALTER COLUMN company_id SET NOT NULL; EXECUTE format('ALTER TABLE public.email_threads ALTER COLUMN company_id SET DEFAULT %s', hid); ALTER TABLE public.email_threads DROP CONSTRAINT IF EXISTS email_threads_company_id_fkey; ALTER TABLE public.email_threads ADD CONSTRAINT email_threads_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id); CREATE INDEX IF NOT EXISTS idx_email_threads_company_id ON public.email_threads (company_id); END IF; END $$;

-- public.email_messages
DO $$ DECLARE hid bigint; BEGIN IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='email_messages' AND c.relkind IN ('r','p')) THEN SELECT id INTO hid FROM public.companies WHERE code = 'HOUZS'; IF hid IS NULL THEN RETURN; END IF; ALTER TABLE public.email_messages ADD COLUMN IF NOT EXISTS company_id bigint; EXECUTE format('UPDATE public.email_messages SET company_id = %s WHERE company_id IS NULL', hid); ALTER TABLE public.email_messages ALTER COLUMN company_id SET NOT NULL; EXECUTE format('ALTER TABLE public.email_messages ALTER COLUMN company_id SET DEFAULT %s', hid); ALTER TABLE public.email_messages DROP CONSTRAINT IF EXISTS email_messages_company_id_fkey; ALTER TABLE public.email_messages ADD CONSTRAINT email_messages_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id); CREATE INDEX IF NOT EXISTS idx_email_messages_company_id ON public.email_messages (company_id); END IF; END $$;

-- public.email_labels
DO $$ DECLARE hid bigint; BEGIN IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='email_labels' AND c.relkind IN ('r','p')) THEN SELECT id INTO hid FROM public.companies WHERE code = 'HOUZS'; IF hid IS NULL THEN RETURN; END IF; ALTER TABLE public.email_labels ADD COLUMN IF NOT EXISTS company_id bigint; EXECUTE format('UPDATE public.email_labels SET company_id = %s WHERE company_id IS NULL', hid); ALTER TABLE public.email_labels ALTER COLUMN company_id SET NOT NULL; EXECUTE format('ALTER TABLE public.email_labels ALTER COLUMN company_id SET DEFAULT %s', hid); ALTER TABLE public.email_labels DROP CONSTRAINT IF EXISTS email_labels_company_id_fkey; ALTER TABLE public.email_labels ADD CONSTRAINT email_labels_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id); CREATE INDEX IF NOT EXISTS idx_email_labels_company_id ON public.email_labels (company_id); END IF; END $$;

-- email_labels: swap the GLOBAL name-unique index for a PER-COMPANY one so each
-- company can own a label of the same name. Single-statement (splitter-safe).
DROP INDEX IF EXISTS ux_email_labels_name;
CREATE UNIQUE INDEX IF NOT EXISTS ux_email_labels_company_name ON public.email_labels (company_id, lower(name));
