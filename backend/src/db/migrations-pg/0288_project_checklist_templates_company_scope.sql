-- 0288 — project checklist TEMPLATES become per-company: record the contract in
-- the schema, and re-assert the column the routes are about to depend on.
--
-- READ THE NEXT PARAGRAPH BEFORE ASSUMING THIS ADDS A COLUMN. IT USUALLY DOES
-- NOT. Mig 0093 already added company_id to all three template tables
-- (0093:58/61/64) with the full shape — NOT NULL, DEFAULT the HOUZS id, FK to
-- public.companies, index. On any database where 0093 succeeded, every DO block
-- below is a no-op and only the three COMMENTs change anything. That is stated
-- up front on purpose: a migration whose header implies work it is not doing is
-- the same lie this repository keeps digging out of its own documentation.
--
-- WHAT ACTUALLY BREAKS TODAY, and it is in the ROUTES, not the DDL.
-- routes/projects.ts drives the Project Maintenance template editor, and every
-- one of its statements is company-BLIND on BOTH sides:
--
--   GET    /checklist-templates                       list, no predicate
--   GET    /checklist-templates/:id/items             body by id, no predicate
--   POST   /checklist-templates/:id/items             no stamp, unscoped parent
--   PATCH  /checklist-templates/items/:itemId         UPDATE ... WHERE id = ?
--   DELETE /checklist-templates/items/:itemId         DELETE ... WHERE id = ?
--   PUT    /checklist-templates/:id/items/reorder     UPDATE ... WHERE id = ?
--   POST   /checklist-templates/:id/sections          no stamp, unscoped parent
--   PATCH  /checklist-templates/sections/:sectionId   UPDATE ... WHERE id = ?
--   DELETE /checklist-templates/sections/:sectionId   DELETE ... WHERE id = ?
--   PUT    /checklist-templates/:id/sections/reorder  UPDATE ... WHERE id = ?
--   GET    /sections-distinct     MAX(t.id) WHERE t.active = 1, no predicate
--   GET    /task-titles-distinct  MAX(t.id) WHERE t.active = 1, no predicate
--
-- Blind on both sides is SELF-CONSISTENT — one shared master, every company
-- editing the same rows and seeing the result — so this is not a leak that
-- silently drops writes. It is a design the owner has now reversed.
--
-- THE OWNER'S DECISION (2026-08-13): "应该按公司分开" — the templates split per
-- company, matching project_brands and project_venues, which sit in the same
-- router, carry company_id from the same migration 0093, and are already scoped
-- on both sides (GET /brands:216, GET /venues:1323, POST /venues:1413). The
-- checklist templates were the odd ones out among their own neighbours.
--
-- WHY THE COLUMN STILL GETS RE-ASSERTED. 0093's blocks open with
-- `SELECT id INTO hid FROM public.companies WHERE code = 'HOUZS'; IF hid IS NULL
-- THEN RETURN; END IF;` — on a database whose companies master had no HOUZS row
-- when 0093 ran, the whole block returned early and added NOTHING, silently. The
-- routes are about to depend on this column existing; a predicate against a
-- missing column is a 500 on every template read, not a degradation. Re-asserting
-- is idempotent and costs nothing where 0093 worked, so it is the cheap guard.
--
-- EXISTING ROWS BACKFILL TO HOUZS. Same as 0093 did for these very tables, and
-- the same choice mig 0083 made for all 116 of its tables: every template row in
-- production today was authored by Houzs, so HOUZS is the true owner, not a
-- guess. 2990 starts with an EMPTY template master and builds its own — which is
-- the visible consequence of the split and is what the owner asked for.
--
-- ORDER MATTERS: add column -> backfill -> NOT NULL -> DEFAULT -> FK + index. A
-- SET NOT NULL before the backfill fails on the first legacy row.
--
-- WHAT IT DOES NOT DO:
--   * It does NOT add a unique key. None of the three tables has a UNIQUE
--     constraint to widen — project_checklist_templates is keyed on `id serial`
--     alone with no unique name (0000_baseline:315), and both child tables key on
--     `id serial` too. So there is no repeat of the 0284 / 0287 defect here: no
--     key exists that one company could take from the other.
--   * It does NOT scope project_event_types.default_template_id, the pointer the
--     clone-on-create path (services/projects.ts::instantiateChecklistFromEventType)
--     follows into a template. project_event_types carries NO company_id at all —
--     0093 did not stamp it — so there is nothing to scope it BY. Making event
--     types per-company is a separate decision the owner has not been asked, and
--     inventing one here would silently re-shape which checklist a new project
--     inherits. Left as-is, deliberately, and recorded so the next reader finds
--     the gap named rather than having to rediscover it.
--   * It does NOT touch the per-PROJECT checklist tables (project_checklist,
--     project_checklist_sections). Those are read through their parent project's
--     project_id, which routes/projects.ts already scopes; their own company_id
--     stays the schema-parity backstop 0093 describes.
--
-- ADDITIVE + idempotent + re-run-safe. The runner splits on ';\n', so each
-- guarded block stays on ONE line (mirrors 0093, 0284 and 0287).

-- public.project_checklist_templates
DO $$ DECLARE hid bigint; BEGIN IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='project_checklist_templates' AND c.relkind IN ('r','p')) THEN SELECT id INTO hid FROM public.companies WHERE code = 'HOUZS'; IF hid IS NULL THEN RETURN; END IF; ALTER TABLE public.project_checklist_templates ADD COLUMN IF NOT EXISTS company_id bigint; EXECUTE format('UPDATE public.project_checklist_templates SET company_id = %s WHERE company_id IS NULL', hid); ALTER TABLE public.project_checklist_templates ALTER COLUMN company_id SET NOT NULL; EXECUTE format('ALTER TABLE public.project_checklist_templates ALTER COLUMN company_id SET DEFAULT %s', hid); ALTER TABLE public.project_checklist_templates DROP CONSTRAINT IF EXISTS project_checklist_templates_company_id_fkey; ALTER TABLE public.project_checklist_templates ADD CONSTRAINT project_checklist_templates_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id); CREATE INDEX IF NOT EXISTS idx_project_checklist_templates_company_id ON public.project_checklist_templates (company_id); END IF; END $$;

-- public.project_checklist_template_sections
DO $$ DECLARE hid bigint; BEGIN IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='project_checklist_template_sections' AND c.relkind IN ('r','p')) THEN SELECT id INTO hid FROM public.companies WHERE code = 'HOUZS'; IF hid IS NULL THEN RETURN; END IF; ALTER TABLE public.project_checklist_template_sections ADD COLUMN IF NOT EXISTS company_id bigint; EXECUTE format('UPDATE public.project_checklist_template_sections SET company_id = %s WHERE company_id IS NULL', hid); ALTER TABLE public.project_checklist_template_sections ALTER COLUMN company_id SET NOT NULL; EXECUTE format('ALTER TABLE public.project_checklist_template_sections ALTER COLUMN company_id SET DEFAULT %s', hid); ALTER TABLE public.project_checklist_template_sections DROP CONSTRAINT IF EXISTS project_checklist_template_sections_company_id_fkey; ALTER TABLE public.project_checklist_template_sections ADD CONSTRAINT project_checklist_template_sections_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id); CREATE INDEX IF NOT EXISTS idx_project_checklist_template_sections_company_id ON public.project_checklist_template_sections (company_id); END IF; END $$;

-- public.project_checklist_template_items
DO $$ DECLARE hid bigint; BEGIN IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='project_checklist_template_items' AND c.relkind IN ('r','p')) THEN SELECT id INTO hid FROM public.companies WHERE code = 'HOUZS'; IF hid IS NULL THEN RETURN; END IF; ALTER TABLE public.project_checklist_template_items ADD COLUMN IF NOT EXISTS company_id bigint; EXECUTE format('UPDATE public.project_checklist_template_items SET company_id = %s WHERE company_id IS NULL', hid); ALTER TABLE public.project_checklist_template_items ALTER COLUMN company_id SET NOT NULL; EXECUTE format('ALTER TABLE public.project_checklist_template_items ALTER COLUMN company_id SET DEFAULT %s', hid); ALTER TABLE public.project_checklist_template_items DROP CONSTRAINT IF EXISTS project_checklist_template_items_company_id_fkey; ALTER TABLE public.project_checklist_template_items ADD CONSTRAINT project_checklist_template_items_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id); CREATE INDEX IF NOT EXISTS idx_project_checklist_template_items_company_id ON public.project_checklist_template_items (company_id); END IF; END $$;

COMMENT ON TABLE public.project_checklist_templates IS 'Master checklist templates cloned into every new project. PER-COMPANY since mig 0288 (owner decision 2026-08-13): company_id names the owning company AND is the READ-SCOPE predicate - routes/projects.ts filters every template list and every by-id body read with activeCompanySql(c), so one company cannot see or edit the other company template master. Column itself was added by mig 0093, which described it as a schema-parity backstop NOT used to scope reads; 0288 reverses that for the three template tables only. Existing rows backfilled to HOUZS (all pre-split templates were authored by Houzs); 2990 starts empty and builds its own.';

COMMENT ON TABLE public.project_checklist_template_sections IS 'Sections of a checklist template. PER-COMPANY since mig 0288 - company_id is stamped on insert from the active company AND is the read/write-scope predicate. Note the parent template_id is ALSO re-checked against the active company before any create/reorder, because a stamp is not a predicate: stamping company_id on a new section says nothing about whose template it was hung under. Existing rows backfilled to HOUZS.';

COMMENT ON TABLE public.project_checklist_template_items IS 'Task rows of a checklist template, cloned into project_checklist on project create. PER-COMPANY since mig 0288 - company_id is stamped on insert from the active company AND scopes every UPDATE/DELETE by item id, so a cross-company id reaches nothing and answers 404 rather than silently mutating. The parent template_id is re-checked against the active company on create and reorder. Existing rows backfilled to HOUZS.';
