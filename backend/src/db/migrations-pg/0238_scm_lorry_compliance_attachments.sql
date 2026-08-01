-- 0238_scm_lorry_compliance_attachments.sql — the compliance vault gets FILES.
--
-- WHY. Owner, 2026-08-01, looking at Fleet Health: "为什么我的 Compliance、Road Tax
-- 这些都是不能 Upload 的呢？" Because it was never built. The vault
-- (scm.lorry_compliance_documents, mig 0202) records a renewal's REFERENCE
-- NUMBER, dates, cost and owner — `document_ref` is text, not a file — and the
-- drawer renders that history read-only, with no add form and no file input. The
-- page's own footer meanwhile says "Renew a compliance document by adding a new
-- row", describing a control that does not exist on it.
--
-- MANY FILES PER RENEWAL, not one column on the document. Owner's call
-- 2026-08-01: one renewal can carry several scans (a PUSPAKOM report runs to
-- several pages; an insurance renewal is cover note + schedule). Four flat
-- file_* columns on the document row would cap it at one and then need a table
-- anyway, so the table is here from the start — the same shape
-- public.project_attachments already uses.
--
-- THE R2 KEY IS SERVER-MINTED. r2_key is written only by
-- PUT /fleet/vehicles/:id/compliance/:docId/attachments, which builds the key
-- from the ids and a timestamp. A client never supplies it, so it can never
-- point a row at an arbitrary bucket key. Bucket: POD_BUCKET, the same one
-- project and ASSR attachments use.
--
-- ON DELETE CASCADE from the document. The vault is APPEND-ONLY by design (you
-- renew by inserting a new row, never by editing an expiry), so a document row
-- is deleted only when the LORRY is — and mig 0202 already cascades documents
-- from scm.lorries. A file outliving the renewal it evidences would be an
-- orphan nobody can reach. The R2 OBJECT is not deleted by the cascade; the
-- delete endpoint removes it explicitly, and a cascaded row leaves a harmless
-- unreferenced object rather than risking a live key being swept.
--
-- HOUSE STYLE. Additive, idempotent (IF NOT EXISTS), schema-qualified, one
-- transaction. RE-CHECK THE NUMBER AT MERGE — 0238 was next free above 0237
-- (feat/threepl-master-fleet), which is itself unmerged at the time of writing.

SET search_path = scm, public;

CREATE TABLE IF NOT EXISTS scm.lorry_compliance_attachments (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Stamped on insert, NOT read for scoping — the fleet is unified across
  -- companies exactly as in mig 0202. Nullable + no FK, mirroring that table.
  company_id   BIGINT,
  document_id  UUID NOT NULL REFERENCES scm.lorry_compliance_documents(id) ON DELETE CASCADE,
  -- Server-minted. See the header: never accepted from a client.
  r2_key       TEXT NOT NULL,
  file_name    TEXT,
  mime_type    TEXT,
  size_bytes   BIGINT CHECK (size_bytes IS NULL OR size_bytes >= 0),
  -- The real person (public.users.id, bigint), same choice as
  -- lorry_compliance_documents.created_by.
  uploaded_by  BIGINT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The hot query: every file of a document, oldest first (upload order is the
-- order a multi-page scan was added in, and that is the order to show it in).
CREATE INDEX IF NOT EXISTS idx_lorry_compliance_attachments_doc
  ON scm.lorry_compliance_attachments (document_id, created_at);

-- A key is one object. Guards a double-submit from minting two rows against the
-- same upload, which would make the delete endpoint's "remove the object" step
-- ambiguous.
CREATE UNIQUE INDEX IF NOT EXISTS lorry_compliance_attachments_key_uq
  ON scm.lorry_compliance_attachments (r2_key);
