-- 0104_create_product_with_pricing_company.sql — multi-company hardening of the
-- scm.create_product_with_pricing RPC (called by products.ts POST /products).
--
-- BEFORE: the function INSERTed into scm.products (+ pricing children) WITHOUT
-- company_id, relying on the HOUZS DEFAULT (mig 0091). So a product created while
-- the active company was 2990 was silently stamped HOUZS — a cross-company
-- mislabel. FIX: add a p_company_id parameter and stamp it on the product AND
-- every pricing child (compartments / bundles / fabrics / size variants — all
-- company_id NOT NULL via 0083). NULL → COALESCE to the HOUZS base, so single-
-- company Houzs is unchanged. The caller (products.ts) passes activeCompanyId(c).
--
-- The old 1-arg overload create_product_with_pricing(jsonb) is DROPPED first so
-- PostgREST has exactly one signature to resolve (no overload ambiguity when the
-- 2-arg form carries a DEFAULT).
--
-- pg-migrate splits on /;\s*\n/ (semicolon at end-of-line). A plpgsql body is
-- full of internal `;` — so the whole CREATE FUNCTION is written on ONE physical
-- line (no `;\n` until the closing `$$;`), matching the 0089/0091 single-line
-- convention. Idempotent + re-run-safe (DROP IF EXISTS + CREATE OR REPLACE).

DROP FUNCTION IF EXISTS scm.create_product_with_pricing(jsonb);

CREATE OR REPLACE FUNCTION scm.create_product_with_pricing(p jsonb, p_company_id bigint DEFAULT NULL) RETURNS uuid LANGUAGE plpgsql SET search_path = scm, pg_temp AS $$ DECLARE v_product_id uuid; v_kind text := p->>'pricingKind'; v_company_id bigint := COALESCE(p_company_id, (SELECT id FROM public.companies WHERE code = 'HOUZS')); BEGIN INSERT INTO products (sku, category_id, series_id, pricing_kind, name, detail, size_display, img_key, thumb_key, stock, low_at, visible, flat_price, recliner_upgrade_price, company_id) VALUES (p->>'sku', p->>'categoryId', NULLIF(p->>'seriesId', ''), v_kind::pricing_kind, p->>'name', NULLIF(p->>'detail', ''), NULLIF(p->>'sizeDisplay', ''), p->>'imgKey', p->>'thumbKey', COALESCE((p->>'stock')::int, 0), COALESCE((p->>'lowAt')::int, 5), COALESCE((p->>'visible')::boolean, true), CASE WHEN v_kind = 'flat' THEN (p->>'flatPrice')::int ELSE NULL END, CASE WHEN v_kind = 'sofa_build' THEN (p->>'reclinerUpgradePrice')::int ELSE NULL END, v_company_id) RETURNING id INTO v_product_id; IF v_kind = 'sofa_build' THEN INSERT INTO product_compartments (product_id, compartment_id, active, price, company_id) SELECT v_product_id, (r->>'compartmentId')::text, (r->>'active')::boolean, (r->>'price')::int, v_company_id FROM jsonb_array_elements(p->'compartments') r; INSERT INTO product_bundles (product_id, bundle_id, active, price, company_id) SELECT v_product_id, (r->>'bundleId')::text, (r->>'active')::boolean, (r->>'price')::int, v_company_id FROM jsonb_array_elements(p->'bundles') r; INSERT INTO product_fabrics (product_id, fabric_id, active, surcharge, company_id) SELECT v_product_id, (r->>'fabricId')::text, (r->>'active')::boolean, (r->>'surcharge')::int, v_company_id FROM jsonb_array_elements(COALESCE(p->'fabrics', '[]'::jsonb)) r; ELSIF v_kind = 'size_variants' THEN INSERT INTO product_size_variants (product_id, size_id, active, price, company_id) SELECT v_product_id, (r->>'sizeId')::text, (r->>'active')::boolean, (r->>'price')::int, v_company_id FROM jsonb_array_elements(p->'sizes') r; END IF; RETURN v_product_id; END; $$;
