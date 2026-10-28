-- 066_pm_workflow_template_refresh.sql
--
-- Boss-driven refresh of the project checklist templates to match
-- the new PM Workflow design. Both Exhibition (template 1) and
-- Solo (template 2) get the same 7-section / 20-item structure;
-- project owners flip per-project items to N/A when something
-- doesn't apply.
--
-- Sections (in display order):
--   CONTRACT, 3D APPROVAL, OPERATION, CLOSEOUT,
--   BOOTH LAYOUT & SETUP, SETUP & DISMANTLE DOCUMENTS,
--   EXPO MAP — COMPETITOR RESEARCH
--
-- Existing project_checklist rows on live projects are NOT touched
-- — only the templates that future projects clone from.

-- Wipe existing template items + sections for templates 1 and 2.
DELETE FROM project_checklist_template_items WHERE template_id IN (1, 2);
DELETE FROM project_checklist_template_sections WHERE template_id IN (1, 2);

-- ── Sections ──────────────────────────────────────────────
INSERT INTO project_checklist_template_sections (template_id, name, sort_order) VALUES (1, 'CONTRACT',                       10);
INSERT INTO project_checklist_template_sections (template_id, name, sort_order) VALUES (1, '3D APPROVAL',                    20);
INSERT INTO project_checklist_template_sections (template_id, name, sort_order) VALUES (1, 'OPERATION',                      30);
INSERT INTO project_checklist_template_sections (template_id, name, sort_order) VALUES (1, 'CLOSEOUT',                       40);
INSERT INTO project_checklist_template_sections (template_id, name, sort_order) VALUES (1, 'BOOTH LAYOUT & SETUP',           50);
INSERT INTO project_checklist_template_sections (template_id, name, sort_order) VALUES (1, 'SETUP & DISMANTLE DOCUMENTS',    60);
INSERT INTO project_checklist_template_sections (template_id, name, sort_order) VALUES (1, 'EXPO MAP — COMPETITOR RESEARCH', 70);

INSERT INTO project_checklist_template_sections (template_id, name, sort_order) VALUES (2, 'CONTRACT',                       10);
INSERT INTO project_checklist_template_sections (template_id, name, sort_order) VALUES (2, '3D APPROVAL',                    20);
INSERT INTO project_checklist_template_sections (template_id, name, sort_order) VALUES (2, 'OPERATION',                      30);
INSERT INTO project_checklist_template_sections (template_id, name, sort_order) VALUES (2, 'CLOSEOUT',                       40);
INSERT INTO project_checklist_template_sections (template_id, name, sort_order) VALUES (2, 'BOOTH LAYOUT & SETUP',           50);
INSERT INTO project_checklist_template_sections (template_id, name, sort_order) VALUES (2, 'SETUP & DISMANTLE DOCUMENTS',    60);
INSERT INTO project_checklist_template_sections (template_id, name, sort_order) VALUES (2, 'EXPO MAP — COMPETITOR RESEARCH', 70);

-- ── Items (Exhibition, template 1) ────────────────────────
-- Each row JOINs against the freshly inserted sections to resolve
-- section_id. requires_review = 1 clones into project_checklist
-- with required_perm = 'projects.approve' (gates that step).
INSERT INTO project_checklist_template_items (template_id, seq, title, description, due_offset_days, required_perm, requires_review, section_id)
  SELECT 1,  10, 'Agreement / Quotation',     NULL,                                                 -30, NULL,                0, id FROM project_checklist_template_sections WHERE template_id = 1 AND name = 'CONTRACT';
INSERT INTO project_checklist_template_items (template_id, seq, title, description, due_offset_days, required_perm, requires_review, section_id)
  SELECT 1,  20, '3D Checked by MGT',         NULL,                                                 -14, NULL,                0, id FROM project_checklist_template_sections WHERE template_id = 1 AND name = '3D APPROVAL';
INSERT INTO project_checklist_template_items (template_id, seq, title, description, due_offset_days, required_perm, requires_review, section_id)
  SELECT 1,  30, '3D Approved by Peter',      NULL,                                                 -10, 'projects.approve',  1, id FROM project_checklist_template_sections WHERE template_id = 1 AND name = '3D APPROVAL';
INSERT INTO project_checklist_template_items (template_id, seq, title, description, due_offset_days, required_perm, requires_review, section_id)
  SELECT 1,  40, 'Weekend Activity (Theme)',  NULL,                                                  -7, NULL,                0, id FROM project_checklist_template_sections WHERE template_id = 1 AND name = 'OPERATION';
INSERT INTO project_checklist_template_items (template_id, seq, title, description, due_offset_days, required_perm, requires_review, section_id)
  SELECT 1,  50, 'License (from Majlis)',     NULL,                                                  -7, NULL,                0, id FROM project_checklist_template_sections WHERE template_id = 1 AND name = 'OPERATION';
INSERT INTO project_checklist_template_items (template_id, seq, title, description, due_offset_days, required_perm, requires_review, section_id)
  SELECT 1,  60, 'Work / Loading Bay Permit', NULL,                                                  -3, NULL,                0, id FROM project_checklist_template_sections WHERE template_id = 1 AND name = 'OPERATION';
INSERT INTO project_checklist_template_items (template_id, seq, title, description, due_offset_days, required_perm, requires_review, section_id)
  SELECT 1,  70, 'Deco / Coffee Table',       NULL,                                                  -1, NULL,                0, id FROM project_checklist_template_sections WHERE template_id = 1 AND name = 'OPERATION';
INSERT INTO project_checklist_template_items (template_id, seq, title, description, due_offset_days, required_perm, requires_review, section_id)
  SELECT 1,  80, 'Security Deposit',          NULL,                                                  14, NULL,                0, id FROM project_checklist_template_sections WHERE template_id = 1 AND name = 'CLOSEOUT';
INSERT INTO project_checklist_template_items (template_id, seq, title, description, due_offset_days, required_perm, requires_review, section_id)
  SELECT 1,  90, 'Stocks Request Listing',    NULL,                                                 -21, NULL,                0, id FROM project_checklist_template_sections WHERE template_id = 1 AND name = 'BOOTH LAYOUT & SETUP';
INSERT INTO project_checklist_template_items (template_id, seq, title, description, due_offset_days, required_perm, requires_review, section_id)
  SELECT 1, 100, 'Stock Transfer Record',     NULL,                                                 -14, NULL,                0, id FROM project_checklist_template_sections WHERE template_id = 1 AND name = 'BOOTH LAYOUT & SETUP';
INSERT INTO project_checklist_template_items (template_id, seq, title, description, due_offset_days, required_perm, requires_review, section_id)
  SELECT 1, 110, '3D Design',                 NULL,                                                 -21, NULL,                0, id FROM project_checklist_template_sections WHERE template_id = 1 AND name = 'BOOTH LAYOUT & SETUP';
INSERT INTO project_checklist_template_items (template_id, seq, title, description, due_offset_days, required_perm, requires_review, section_id)
  SELECT 1, 120, '2D Design with Display',    NULL,                                                 -21, NULL,                0, id FROM project_checklist_template_sections WHERE template_id = 1 AND name = 'BOOTH LAYOUT & SETUP';
INSERT INTO project_checklist_template_items (template_id, seq, title, description, due_offset_days, required_perm, requires_review, section_id)
  SELECT 1, 130, 'Setup Image (Driver)',      'Taken by driver on arrival',                          -1, NULL,                0, id FROM project_checklist_template_sections WHERE template_id = 1 AND name = 'SETUP & DISMANTLE DOCUMENTS';
INSERT INTO project_checklist_template_items (template_id, seq, title, description, due_offset_days, required_perm, requires_review, section_id)
  SELECT 1, 140, 'Setup Image (Sales PIC)',   'Taken by sales at showroom',                          -1, NULL,                0, id FROM project_checklist_template_sections WHERE template_id = 1 AND name = 'SETUP & DISMANTLE DOCUMENTS';
INSERT INTO project_checklist_template_items (template_id, seq, title, description, due_offset_days, required_perm, requires_review, section_id)
  SELECT 1, 150, 'Defect List',               'Check after setup',                                   -1, NULL,                0, id FROM project_checklist_template_sections WHERE template_id = 1 AND name = 'SETUP & DISMANTLE DOCUMENTS';
INSERT INTO project_checklist_template_items (template_id, seq, title, description, due_offset_days, required_perm, requires_review, section_id)
  SELECT 1, 160, 'Exchange List',             'After event completes',                                1, NULL,                0, id FROM project_checklist_template_sections WHERE template_id = 1 AND name = 'SETUP & DISMANTLE DOCUMENTS';
INSERT INTO project_checklist_template_items (template_id, seq, title, description, due_offset_days, required_perm, requires_review, section_id)
  SELECT 1, 170, 'Event Complete Image',      'After event completes',                                1, NULL,                0, id FROM project_checklist_template_sections WHERE template_id = 1 AND name = 'SETUP & DISMANTLE DOCUMENTS';
INSERT INTO project_checklist_template_items (template_id, seq, title, description, due_offset_days, required_perm, requires_review, section_id)
  SELECT 1, 180, 'Dismantle Image (Driver)',  'Taken by driver after dismantle',                      1, NULL,                0, id FROM project_checklist_template_sections WHERE template_id = 1 AND name = 'SETUP & DISMANTLE DOCUMENTS';
INSERT INTO project_checklist_template_items (template_id, seq, title, description, due_offset_days, required_perm, requires_review, section_id)
  SELECT 1, 190, 'Blank Floorplan',           'Download from venue · no markings yet',               -7, NULL,                0, id FROM project_checklist_template_sections WHERE template_id = 1 AND name = 'EXPO MAP — COMPETITOR RESEARCH';
INSERT INTO project_checklist_template_items (template_id, seq, title, description, due_offset_days, required_perm, requires_review, section_id)
  SELECT 1, 200, 'Filled Floorplan',          'Annotated with competitor booths during the fair',     0, NULL,                0, id FROM project_checklist_template_sections WHERE template_id = 1 AND name = 'EXPO MAP — COMPETITOR RESEARCH';

-- ── Items (Solo, template 2) — same 20 items ──────────────
INSERT INTO project_checklist_template_items (template_id, seq, title, description, due_offset_days, required_perm, requires_review, section_id)
  SELECT 2,  10, 'Agreement / Quotation',     NULL,                                                 -30, NULL,                0, id FROM project_checklist_template_sections WHERE template_id = 2 AND name = 'CONTRACT';
INSERT INTO project_checklist_template_items (template_id, seq, title, description, due_offset_days, required_perm, requires_review, section_id)
  SELECT 2,  20, '3D Checked by MGT',         NULL,                                                 -14, NULL,                0, id FROM project_checklist_template_sections WHERE template_id = 2 AND name = '3D APPROVAL';
INSERT INTO project_checklist_template_items (template_id, seq, title, description, due_offset_days, required_perm, requires_review, section_id)
  SELECT 2,  30, '3D Approved by Peter',      NULL,                                                 -10, 'projects.approve',  1, id FROM project_checklist_template_sections WHERE template_id = 2 AND name = '3D APPROVAL';
INSERT INTO project_checklist_template_items (template_id, seq, title, description, due_offset_days, required_perm, requires_review, section_id)
  SELECT 2,  40, 'Weekend Activity (Theme)',  NULL,                                                  -7, NULL,                0, id FROM project_checklist_template_sections WHERE template_id = 2 AND name = 'OPERATION';
INSERT INTO project_checklist_template_items (template_id, seq, title, description, due_offset_days, required_perm, requires_review, section_id)
  SELECT 2,  50, 'License (from Majlis)',     NULL,                                                  -7, NULL,                0, id FROM project_checklist_template_sections WHERE template_id = 2 AND name = 'OPERATION';
INSERT INTO project_checklist_template_items (template_id, seq, title, description, due_offset_days, required_perm, requires_review, section_id)
  SELECT 2,  60, 'Work / Loading Bay Permit', NULL,                                                  -3, NULL,                0, id FROM project_checklist_template_sections WHERE template_id = 2 AND name = 'OPERATION';
INSERT INTO project_checklist_template_items (template_id, seq, title, description, due_offset_days, required_perm, requires_review, section_id)
  SELECT 2,  70, 'Deco / Coffee Table',       NULL,                                                  -1, NULL,                0, id FROM project_checklist_template_sections WHERE template_id = 2 AND name = 'OPERATION';
INSERT INTO project_checklist_template_items (template_id, seq, title, description, due_offset_days, required_perm, requires_review, section_id)
  SELECT 2,  80, 'Security Deposit',          NULL,                                                  14, NULL,                0, id FROM project_checklist_template_sections WHERE template_id = 2 AND name = 'CLOSEOUT';
INSERT INTO project_checklist_template_items (template_id, seq, title, description, due_offset_days, required_perm, requires_review, section_id)
  SELECT 2,  90, 'Stocks Request Listing',    NULL,                                                 -21, NULL,                0, id FROM project_checklist_template_sections WHERE template_id = 2 AND name = 'BOOTH LAYOUT & SETUP';
INSERT INTO project_checklist_template_items (template_id, seq, title, description, due_offset_days, required_perm, requires_review, section_id)
  SELECT 2, 100, 'Stock Transfer Record',     NULL,                                                 -14, NULL,                0, id FROM project_checklist_template_sections WHERE template_id = 2 AND name = 'BOOTH LAYOUT & SETUP';
INSERT INTO project_checklist_template_items (template_id, seq, title, description, due_offset_days, required_perm, requires_review, section_id)
  SELECT 2, 110, '3D Design',                 NULL,                                                 -21, NULL,                0, id FROM project_checklist_template_sections WHERE template_id = 2 AND name = 'BOOTH LAYOUT & SETUP';
INSERT INTO project_checklist_template_items (template_id, seq, title, description, due_offset_days, required_perm, requires_review, section_id)
  SELECT 2, 120, '2D Design with Display',    NULL,                                                 -21, NULL,                0, id FROM project_checklist_template_sections WHERE template_id = 2 AND name = 'BOOTH LAYOUT & SETUP';
INSERT INTO project_checklist_template_items (template_id, seq, title, description, due_offset_days, required_perm, requires_review, section_id)
  SELECT 2, 130, 'Setup Image (Driver)',      'Taken by driver on arrival',                          -1, NULL,                0, id FROM project_checklist_template_sections WHERE template_id = 2 AND name = 'SETUP & DISMANTLE DOCUMENTS';
INSERT INTO project_checklist_template_items (template_id, seq, title, description, due_offset_days, required_perm, requires_review, section_id)
  SELECT 2, 140, 'Setup Image (Sales PIC)',   'Taken by sales at showroom',                          -1, NULL,                0, id FROM project_checklist_template_sections WHERE template_id = 2 AND name = 'SETUP & DISMANTLE DOCUMENTS';
INSERT INTO project_checklist_template_items (template_id, seq, title, description, due_offset_days, required_perm, requires_review, section_id)
  SELECT 2, 150, 'Defect List',               'Check after setup',                                   -1, NULL,                0, id FROM project_checklist_template_sections WHERE template_id = 2 AND name = 'SETUP & DISMANTLE DOCUMENTS';
INSERT INTO project_checklist_template_items (template_id, seq, title, description, due_offset_days, required_perm, requires_review, section_id)
  SELECT 2, 160, 'Exchange List',             'After event completes',                                1, NULL,                0, id FROM project_checklist_template_sections WHERE template_id = 2 AND name = 'SETUP & DISMANTLE DOCUMENTS';
INSERT INTO project_checklist_template_items (template_id, seq, title, description, due_offset_days, required_perm, requires_review, section_id)
  SELECT 2, 170, 'Event Complete Image',      'After event completes',                                1, NULL,                0, id FROM project_checklist_template_sections WHERE template_id = 2 AND name = 'SETUP & DISMANTLE DOCUMENTS';
INSERT INTO project_checklist_template_items (template_id, seq, title, description, due_offset_days, required_perm, requires_review, section_id)
  SELECT 2, 180, 'Dismantle Image (Driver)',  'Taken by driver after dismantle',                      1, NULL,                0, id FROM project_checklist_template_sections WHERE template_id = 2 AND name = 'SETUP & DISMANTLE DOCUMENTS';
INSERT INTO project_checklist_template_items (template_id, seq, title, description, due_offset_days, required_perm, requires_review, section_id)
  SELECT 2, 190, 'Blank Floorplan',           'Download from venue · no markings yet',               -7, NULL,                0, id FROM project_checklist_template_sections WHERE template_id = 2 AND name = 'EXPO MAP — COMPETITOR RESEARCH';
INSERT INTO project_checklist_template_items (template_id, seq, title, description, due_offset_days, required_perm, requires_review, section_id)
  SELECT 2, 200, 'Filled Floorplan',          'Annotated with competitor booths during the fair',     0, NULL,                0, id FROM project_checklist_template_sections WHERE template_id = 2 AND name = 'EXPO MAP — COMPETITOR RESEARCH';
