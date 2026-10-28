// PostgreSQL scale contract derived from the production readers, the 2990 SCM
// schema export, and migrations 0074/0083/0104/0108/0111. It deliberately uses
// the real public/scm relation and column names so PostgreSQL plans the same
// joins, view aggregation, row width, predicates and indexes as the hot routes.

export const REAL_SCHEMA_CONTRACT_VERSION = "2026-08-26.1";

export const SO_LIST_COLUMNS = [
  "doc_no", "transfer_to", "so_date", "branding", "debtor_code", "debtor_name",
  "agent", "sales_location", "ref", "venue", "venue_id",
  "address1", "address2", "address3", "address4", "phone",
  "mattress_sofa_sen", "bedframe_sen", "accessories_sen", "others_sen",
  "service_sen", "local_total_sen", "balance_sen",
  "mattress_sofa_cost_sen", "bedframe_cost_sen", "accessories_cost_sen",
  "others_cost_sen", "service_cost_sen", "total_cost_sen",
  "total_revenue_sen", "total_margin_sen", "margin_pct_basis", "line_count",
  "currency", "status", "remark2", "remark3", "remark4", "note",
  "sales_exemption_expiry", "customer_id", "customer_so_no", "hub_id", "hub_name",
  "customer_state", "customer_country", "customer_delivery_date",
  "processing_date", "linked_do_doc_no", "ship_to_address", "bill_to_address",
  "install_to_address", "subtotal_sen", "overdue", "email", "customer_type",
  "salesperson_id", "city", "postcode", "building_type", "emergency_contact_name",
  "emergency_contact_phone", "emergency_contact_relationship", "target_date",
  "payment_method", "installment_months", "merchant_provider", "approval_code",
  "payment_date", "deposit_sen", "paid_sen", "delivery_fee_sen",
  /* `proceeded_at` left this list on 2026-08-18 with the route's LIST_COLS —
     the SO list projection no longer carries the second Processing-Date
     storage. The COLUMN is still declared on the synthetic table below, because
     the real table still has it until the follow-up drop; what moved is the
     list CONTRACT this benchmark is asserting against. */
  "created_at", "created_by", "updated_at",
  /* Migration 0324 — the HOLD MARKER. It rides in the route's HEADER via the
     shared HOLD_COLUMNS constant, so it is part of the list projection the
     benchmark has to issue; scaleRouteDrift.test.mjs resolves that constant out
     of scm/lib/document-hold.ts and fails this list if the two drift. */
  "on_hold", "hold_reason", "held_at", "held_by",
  "paid_total_sen",
  "balance_sen_live", "company_id",
].join(", ");

export const PG_REAL_SCHEMA_DDL = `
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE SCHEMA scm;

  CREATE TYPE scm.currency_code AS ENUM ('MYR', 'RMB', 'USD', 'SGD');
  CREATE TYPE scm.mfg_product_category AS ENUM ('SOFA', 'BEDFRAME', 'ACCESSORY', 'MATTRESS', 'SERVICE');
  CREATE TYPE scm.mfg_product_status AS ENUM ('ACTIVE', 'INACTIVE');
  CREATE TYPE scm.mfg_so_status AS ENUM ('DRAFT', 'CONFIRMED', 'IN_PRODUCTION', 'READY_TO_SHIP', 'SHIPPED', 'DELIVERED', 'INVOICED', 'CLOSED', 'ON_HOLD', 'CANCELLED');

  CREATE TABLE public.companies (
    id bigint PRIMARY KEY,
    code text NOT NULL UNIQUE,
    name text NOT NULL
  );
  CREATE TABLE public.roles (
    id integer PRIMARY KEY,
    name text NOT NULL UNIQUE,
    description text,
    permissions text NOT NULL DEFAULT '[]',
    is_system integer NOT NULL DEFAULT 0,
    scope_to_pic integer NOT NULL DEFAULT 0,
    created_at text
  );
  CREATE TABLE public.departments (
    id integer PRIMARY KEY,
    name text NOT NULL UNIQUE,
    description text,
    color text NOT NULL DEFAULT '64748b',
    sort_order integer NOT NULL DEFAULT 0,
    created_at text
  );
  CREATE TABLE public.positions (
    id integer PRIMARY KEY,
    department_id integer,
    slug text NOT NULL UNIQUE,
    name text NOT NULL,
    level integer NOT NULL DEFAULT 100,
    sort_order integer NOT NULL DEFAULT 100,
    active integer NOT NULL DEFAULT 1,
    created_at text
  );
  CREATE TABLE public.users (
    id integer PRIMARY KEY,
    email text NOT NULL UNIQUE,
    name text,
    password_hash text,
    role_id integer NOT NULL,
    status text NOT NULL DEFAULT 'invited',
    status_reason text,
    invited_by integer,
    invited_at text,
    joined_at text,
    last_login_at text,
    created_at text,
    manager_id integer,
    department_id integer,
    division text,
    position_id integer,
    points_balance integer NOT NULL DEFAULT 0,
    gifting_balance integer NOT NULL DEFAULT 0,
    gifting_reset_at text,
    current_streak integer NOT NULL DEFAULT 0,
    profile_pic_r2_key text,
    phone text,
    email_alias text,
    assr_email_muted integer NOT NULL DEFAULT 0
  );
  CREATE TABLE public.user_brands (
    user_id integer NOT NULL,
    brand text NOT NULL,
    created_at text,
    PRIMARY KEY (user_id, brand)
  );
  CREATE TABLE public.user_departments (
    user_id integer NOT NULL,
    department_id integer NOT NULL,
    created_at text,
    PRIMARY KEY (user_id, department_id)
  );
  CREATE TABLE public.user_companies (
    user_id integer NOT NULL,
    company_id bigint NOT NULL,
    PRIMARY KEY (user_id, company_id)
  );

  CREATE TABLE scm.product_models (
    id uuid PRIMARY KEY,
    allowed_options jsonb
  );
  CREATE TABLE scm.mfg_products (
    id text PRIMARY KEY,
    code text NOT NULL,
    name text NOT NULL,
    category scm.mfg_product_category NOT NULL,
    description text,
    base_model text,
    size_code text,
    size_label text,
    fabric_usage_sen integer NOT NULL DEFAULT 0,
    unit_m3_milli integer NOT NULL DEFAULT 0,
    status scm.mfg_product_status NOT NULL DEFAULT 'ACTIVE',
    cost_price_sen integer NOT NULL DEFAULT 0,
    base_price_sen integer,
    price1_sen integer,
    sell_price_sen integer,
    pwp_price_sen integer NOT NULL DEFAULT 0,
    pos_active boolean NOT NULL DEFAULT true,
    included_addons jsonb NOT NULL DEFAULT '[]',
    default_free_gifts jsonb NOT NULL DEFAULT '[]',
    production_time_minutes integer NOT NULL DEFAULT 0,
    sub_assemblies jsonb,
    sku_code text,
    fabric_color text,
    branding text,
    barcode text,
    one_shot boolean NOT NULL DEFAULT false,
    source_doc_no text,
    pieces jsonb,
    seat_height_prices jsonb,
    default_variants jsonb,
    retail_product_id uuid,
    model_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    company_id bigint NOT NULL
  );

  CREATE TABLE scm.mfg_sales_orders (
    doc_no text PRIMARY KEY,
    transfer_to text,
    so_date date NOT NULL DEFAULT now(),
    branding text,
    debtor_code text,
    debtor_name text NOT NULL,
    agent text,
    sales_location text,
    ref text,
    po_doc_no text,
    venue text,
    venue_id uuid,
    address1 text, address2 text, address3 text, address4 text, phone text,
    mattress_sofa_sen integer NOT NULL DEFAULT 0,
    bedframe_sen integer NOT NULL DEFAULT 0,
    accessories_sen integer NOT NULL DEFAULT 0,
    others_sen integer NOT NULL DEFAULT 0,
    mattress_sofa_cost_sen integer NOT NULL DEFAULT 0,
    bedframe_cost_sen integer NOT NULL DEFAULT 0,
    accessories_cost_sen integer NOT NULL DEFAULT 0,
    others_cost_sen integer NOT NULL DEFAULT 0,
    service_sen integer NOT NULL DEFAULT 0,
    service_cost_sen integer NOT NULL DEFAULT 0,
    local_total_sen integer NOT NULL DEFAULT 0,
    balance_sen integer NOT NULL DEFAULT 0,
    total_cost_sen integer NOT NULL DEFAULT 0,
    total_revenue_sen integer NOT NULL DEFAULT 0,
    total_margin_sen integer NOT NULL DEFAULT 0,
    margin_pct_basis integer NOT NULL DEFAULT 0,
    line_count integer NOT NULL DEFAULT 0,
    fabric_tier_addon_sen integer NOT NULL DEFAULT 0,
    delivery_fee_sen integer NOT NULL DEFAULT 0,
    cross_category_source_doc_no text,
    currency scm.currency_code NOT NULL DEFAULT 'MYR',
    status scm.mfg_so_status NOT NULL DEFAULT 'CONFIRMED',
    remark2 text, remark3 text, remark4 text, note text,
    proceeded_at timestamptz,
    sales_exemption_expiry date,
    customer_id uuid,
    customer_state text,
    customer_country text,
    customer_po text,
    customer_po_id text,
    customer_po_date date,
    customer_po_image_b64 text,
    customer_so_no text,
    hub_id uuid,
    hub_name text,
    customer_delivery_date date,
    processing_date date,
    linked_do_doc_no text,
    ship_to_address text,
    bill_to_address text,
    install_to_address text,
    subtotal_sen integer,
    overdue text,
    email text,
    customer_type text,
    salesperson_id uuid,
    city text,
    postcode text,
    building_type text,
    emergency_contact_name text,
    emergency_contact_phone text,
    emergency_contact_relationship text,
    target_date date,
    payment_method text,
    installment_months integer,
    merchant_provider text,
    approval_code text,
    payment_date date,
    deposit_sen integer NOT NULL DEFAULT 0,
    paid_sen integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid,
    updated_at timestamptz NOT NULL DEFAULT now(),
    on_hold boolean NOT NULL DEFAULT false,
    hold_reason text,
    held_at timestamptz,
    held_by uuid,
    company_id bigint NOT NULL
  );

  CREATE TABLE scm.mfg_sales_order_items (
    id uuid PRIMARY KEY,
    doc_no text NOT NULL,
    line_date date NOT NULL DEFAULT now(),
    debtor_code text,
    debtor_name text,
    agent text,
    item_group text NOT NULL,
    item_code text NOT NULL,
    description text,
    description2 text,
    uom text NOT NULL DEFAULT 'UNIT',
    location text,
    warehouse_id uuid,
    qty integer NOT NULL DEFAULT 1,
    unit_price_sen integer NOT NULL DEFAULT 0,
    discount_sen integer NOT NULL DEFAULT 0,
    total_sen integer NOT NULL DEFAULT 0,
    tax_sen integer NOT NULL DEFAULT 0,
    total_inc_sen integer NOT NULL DEFAULT 0,
    balance_sen integer NOT NULL DEFAULT 0,
    payment_status text NOT NULL DEFAULT 'Unchecked',
    venue text,
    branding text,
    remark text,
    cancelled boolean NOT NULL DEFAULT false,
    variants jsonb,
    unit_cost_sen integer NOT NULL DEFAULT 0,
    line_cost_sen integer NOT NULL DEFAULT 0,
    line_margin_sen integer NOT NULL DEFAULT 0,
    line_no integer,
    created_at timestamptz NOT NULL DEFAULT now(),
    company_id bigint NOT NULL
  );

  CREATE TABLE scm.mfg_sales_order_payments (
    id uuid PRIMARY KEY,
    so_doc_no text NOT NULL,
    paid_at date NOT NULL DEFAULT now(),
    method text NOT NULL,
    amount_sen integer NOT NULL,
    is_deposit boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    company_id bigint NOT NULL
  );

  CREATE INDEX trgm_users_name ON public.users USING gin (name gin_trgm_ops);
  CREATE INDEX trgm_users_email ON public.users USING gin (email gin_trgm_ops);
  CREATE INDEX idx_user_companies_user ON public.user_companies (user_id);
  CREATE INDEX idx_mfg_products_company_id ON scm.mfg_products (company_id);
  CREATE INDEX idx_mfg_prod_active_category ON scm.mfg_products (category) WHERE status = 'ACTIVE';
  CREATE INDEX trgm_mfg_prod_code ON scm.mfg_products USING gin (code gin_trgm_ops);
  CREATE INDEX trgm_mfg_prod_name ON scm.mfg_products USING gin (name gin_trgm_ops);
  CREATE INDEX trgm_mfg_prod_desc ON scm.mfg_products USING gin (description gin_trgm_ops);
  CREATE INDEX trgm_mfg_prod_barcode ON scm.mfg_products USING gin (barcode gin_trgm_ops);
  CREATE INDEX idx_scm_mfg_so_company_so_date ON scm.mfg_sales_orders (company_id, so_date DESC);
  CREATE INDEX idx_scm_mfg_so_salesperson_id ON scm.mfg_sales_orders (salesperson_id);
  CREATE INDEX trgm_mfg_so_doc_no ON scm.mfg_sales_orders USING gin (doc_no gin_trgm_ops);
  CREATE INDEX trgm_mfg_so_debtor_name ON scm.mfg_sales_orders USING gin (debtor_name gin_trgm_ops);
  CREATE INDEX trgm_mfg_so_ref ON scm.mfg_sales_orders USING gin (ref gin_trgm_ops);
  CREATE INDEX trgm_mfg_so_phone ON scm.mfg_sales_orders USING gin (phone gin_trgm_ops);
  CREATE INDEX idx_scm_mfg_so_items_doc_no ON scm.mfg_sales_order_items (doc_no);
  CREATE INDEX idx_mfg_so_payments_doc ON scm.mfg_sales_order_payments (so_doc_no);

  CREATE VIEW scm.mfg_sales_orders_with_payment_totals AS
  SELECT so.*,
         coalesce(p.paid_total, 0) AS paid_total_sen,
         GREATEST(so.local_total_sen - coalesce(p.paid_total, 0), 0) AS balance_sen_live
    FROM scm.mfg_sales_orders so
    LEFT JOIN (
      SELECT so_doc_no, sum(amount_sen)::bigint AS paid_total
        FROM scm.mfg_sales_order_payments
       GROUP BY so_doc_no
    ) p ON p.so_doc_no = so.doc_no;
`;

const safeCount = (value, name) => {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`);
  return value;
};

export function pgSeedSql(config) {
  const orders = safeCount(config.orders, "orders");
  const lines = safeCount(config.lines, "lines");
  const skus = safeCount(config.skus, "skus");
  const users = safeCount(config.users, "users");
  return `
    INSERT INTO public.companies (id, code, name) VALUES
      (1, 'PERF-A', 'Performance Tenant A'), (2, 'PERF-B', 'Performance Tenant B');
    INSERT INTO public.roles (id, name, permissions, created_at)
      VALUES (1, 'Scale Reader', '["users.read"]', '2026-01-01 00:00:00');
    INSERT INTO public.departments (id, name, created_at) VALUES
      (1, 'Scale Department A', '2026-01-01 00:00:00'),
      (2, 'Scale Department B', '2026-01-01 00:00:00');
    INSERT INTO public.positions (id, department_id, slug, name, created_at) VALUES
      (1, 1, 'scale-a', 'Scale A', '2026-01-01 00:00:00'),
      (2, 2, 'scale-b', 'Scale B', '2026-01-01 00:00:00');

    INSERT INTO public.users
      (id, email, name, role_id, status, created_at, manager_id, department_id, position_id, phone)
    SELECT ((company_id - 1) * ${users}) + g,
           'user' || lpad(g::text, 5, '0') || '@tenant' || company_id || '.perf.invalid',
           'User ' || lpad(g::text, 5, '0'), 1, 'active',
           to_char(timestamp '2026-01-01' + (g % 180) * interval '1 day', 'YYYY-MM-DD HH24:MI:SS'),
           CASE WHEN g = 1 THEN NULL ELSE ((company_id - 1) * ${users}) + 1 END,
           company_id, company_id, '+6000' || lpad(g::text, 7, '0')
      FROM generate_series(1, 2) company_id
      CROSS JOIN generate_series(1, ${users}) g;
    INSERT INTO public.user_brands (user_id, brand, created_at)
      SELECT id, CASE WHEN department_id = 1 THEN 'PERF-A' ELSE 'PERF-B' END, created_at FROM public.users;
    INSERT INTO public.user_departments (user_id, department_id, created_at)
      SELECT id, department_id, created_at FROM public.users;
    INSERT INTO public.user_companies (user_id, company_id)
      SELECT id, department_id FROM public.users;

    INSERT INTO scm.product_models (id, allowed_options)
    SELECT md5('model-' || company_id || '-' || g)::uuid, '{"sizes":["Q","K"]}'::jsonb
      FROM generate_series(1, 2) company_id
      CROSS JOIN generate_series(1, 100) g;
    INSERT INTO scm.mfg_products
      (id, code, name, category, description, base_model, size_code, size_label,
       base_price_sen, price1_sen, sell_price_sen, pwp_price_sen, unit_m3_milli,
       status, pos_active, one_shot, included_addons, sku_code, model_id, branding,
       barcode, sub_assemblies, pieces, seat_height_prices, default_variants,
       updated_at, company_id)
    SELECT 'mfg-c' || company_id || '-' || lpad(g::text, 5, '0'),
           'C' || company_id || '-SKU-' || lpad(g::text, 5, '0'),
           'Product ' || lpad(g::text, 5, '0'),
           (ARRAY['SOFA','BEDFRAME','ACCESSORY','MATTRESS','SERVICE']::scm.mfg_product_category[])[1 + (g % 5)],
           'Scale product description ' || g, 'MODEL-' || (g % 100), 'Q', 'Queen',
           100000 + g, 120000 + g, 150000 + g, 90000 + g, 1000 + (g % 500),
           'ACTIVE', true, false, '[]'::jsonb, 'SKU-' || g,
           md5('model-' || company_id || '-' || (1 + (g % 100)))::uuid,
           CASE WHEN company_id = 1 THEN 'PERF-A' ELSE 'PERF-B' END,
           '955000' || company_id || lpad(g::text, 5, '0'),
           '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb,
           now() - (g % 180) * interval '1 day', company_id
      FROM generate_series(1, 2) company_id
      CROSS JOIN generate_series(1, ${skus}) g;

    INSERT INTO scm.mfg_sales_orders
      (doc_no, so_date, branding, debtor_code, debtor_name, agent, sales_location,
       ref, po_doc_no, phone, local_total_sen, balance_sen, total_revenue_sen,
       total_cost_sen, total_margin_sen, margin_pct_basis, line_count, currency,
       status, customer_state, customer_country, email, salesperson_id,
       created_at, updated_at, proceeded_at, company_id)
    SELECT 'C' || company_id || '-SO-2607-' || lpad(g::text, 6, '0'),
           date '2024-01-01' + (g % 730),
           CASE WHEN company_id = 1 THEN 'PERF-A' ELSE 'PERF-B' END,
           'D' || company_id || '-' || lpad((g % 20000)::text, 5, '0'),
           'Customer ' || lpad((g % 20000)::text, 5, '0'),
           'Agent ' || (g % 100), 'Location ' || (g % 20),
           'REF-' || lpad(g::text, 6, '0'), 'PO-' || lpad(g::text, 6, '0'),
           '+6012' || lpad((g % 10000000)::text, 7, '0'),
           10000, 10000, 10000, 6000, 4000, 4000,
           1, 'MYR',
           (ARRAY['DRAFT','CONFIRMED','IN_PRODUCTION','DELIVERED','CANCELLED']::scm.mfg_so_status[])[1 + (g % 5)],
           'Selangor', 'Malaysia', 'customer' || g || '@perf.invalid',
           md5('salesperson-' || company_id || '-' || (g % 100))::uuid,
           now() - (g % 730) * interval '1 day',
           now() - (g % 365) * interval '1 day',
           CASE WHEN g % 5 = 0 THEN NULL ELSE now() - (g % 365) * interval '1 day' END,
           company_id
      FROM generate_series(1, 2) company_id
      CROSS JOIN generate_series(1, ${orders}) g;

    INSERT INTO scm.mfg_sales_order_items
      (id, doc_no, line_date, debtor_code, debtor_name, agent, item_group,
       item_code, description, uom, qty, unit_price_sen, total_sen,
       total_inc_sen, balance_sen, payment_status, branding, cancelled,
       variants, unit_cost_sen, line_cost_sen, line_margin_sen, line_no,
       created_at, company_id)
    SELECT md5('line-' || company_id || '-' || g)::uuid,
           'C' || company_id || '-SO-2607-' || lpad((1 + ((g - 1) % ${orders}))::text, 6, '0'),
           date '2024-01-01' + (g % 730), 'D' || company_id,
           'Customer ' || (g % 20000), 'Agent ' || (g % 100), 'SOFA',
           'C' || company_id || '-SKU-' || lpad((1 + ((g - 1) % ${skus}))::text, 5, '0'),
           'Scale order line ' || g, 'UNIT', 1 + (g % 5), 10000, 10000,
           10000, 10000, 'Unchecked',
           CASE WHEN company_id = 1 THEN 'PERF-A' ELSE 'PERF-B' END,
           false, '{}'::jsonb, 6000, 6000, 4000,
           1 + ((g - 1) / ${orders}), now() - (g % 365) * interval '1 day', company_id
      FROM generate_series(1, 2) company_id
      CROSS JOIN generate_series(1, ${lines}) g;

    INSERT INTO scm.mfg_sales_order_payments
      (id, so_doc_no, paid_at, method, amount_sen, is_deposit, created_at, company_id)
    SELECT md5('payment-' || company_id || '-' || g)::uuid,
           'C' || company_id || '-SO-2607-' || lpad(g::text, 6, '0'),
           date '2024-01-01' + (g % 730), 'cash', 1000, true,
           now() - (g % 365) * interval '1 day', company_id
      FROM generate_series(1, 2) company_id
      CROSS JOIN generate_series(1, ${orders}) g
     WHERE g % 4 = 0;

    ANALYZE public.users;
    ANALYZE public.user_brands;
    ANALYZE public.user_departments;
    ANALYZE public.user_companies;
    ANALYZE scm.mfg_products;
    ANALYZE scm.mfg_sales_orders;
    ANALYZE scm.mfg_sales_order_items;
    ANALYZE scm.mfg_sales_order_payments;
  `;
}

export const PG_QUERY_SHAPES = {
  so_summary: `
    SELECT doc_no, status, local_total_sen, created_at, so_date, company_id
      FROM scm.mfg_sales_orders
     WHERE company_id = $1 AND status <> 'DRAFT'
     ORDER BY so_date DESC
     LIMIT 500`,
  so_list_page: `
    SELECT ${SO_LIST_COLUMNS}
      FROM scm.mfg_sales_orders_with_payment_totals
     WHERE company_id = $1
     ORDER BY so_date DESC, doc_no DESC
     LIMIT $2 OFFSET $3`,
  so_search_page: `
    SELECT ${SO_LIST_COLUMNS}
      FROM scm.mfg_sales_orders_with_payment_totals
     WHERE company_id = $1
       AND (doc_no ILIKE $2 OR debtor_name ILIKE $2 OR debtor_code ILIKE $2
         OR agent ILIKE $2 OR sales_location ILIKE $2 OR ref ILIKE $2
         OR branding ILIKE $2 OR phone ILIKE $2)
     ORDER BY so_date DESC, doc_no DESC
     LIMIT $3`,
  so_money_page: `
    SELECT local_total_sen, balance_sen, balance_sen_live, paid_total_sen, company_id
      FROM scm.mfg_sales_orders_with_payment_totals
     WHERE company_id = $1
     ORDER BY doc_no
     LIMIT 1000 OFFSET $2`,
  so_status_count: `
    SELECT count(*)::integer AS count
      FROM scm.mfg_sales_orders
     WHERE company_id = $1 AND status = $2`,
  so_detail_lines: `
    SELECT id, doc_no, line_date, debtor_code, debtor_name, agent, item_group,
           item_code, description, description2, uom, location, qty,
           unit_price_sen, discount_sen, total_sen, tax_sen,
           total_inc_sen, balance_sen, payment_status, venue, branding,
           remark, cancelled, variants, unit_cost_sen, line_cost_sen,
           line_margin_sen, line_no, created_at, company_id
      FROM scm.mfg_sales_order_items
     WHERE company_id = $1 AND doc_no = $2
     ORDER BY line_no, id`,
  products_page: `
    SELECT p.id, p.code, p.name, p.category, p.description, p.base_model,
           p.size_code, p.size_label, p.base_price_sen, p.price1_sen,
           p.sell_price_sen, p.pwp_price_sen, p.unit_m3_milli, p.status,
           p.pos_active, p.one_shot, p.source_doc_no, p.included_addons,
           p.sku_code, p.model_id, p.branding, p.barcode, p.sub_assemblies,
           p.pieces, p.seat_height_prices, p.default_variants, p.updated_at,
           pm.allowed_options, p.company_id
      FROM scm.mfg_products p
      LEFT JOIN scm.product_models pm ON pm.id = p.model_id
     WHERE p.company_id = $1 AND p.status = 'ACTIVE'
     ORDER BY p.code
     LIMIT 1000 OFFSET $2`,
  products_search: `
    SELECT p.id, p.code, p.name, p.category, p.description, p.barcode, p.company_id
      FROM scm.mfg_products p
     WHERE p.company_id = $1 AND p.status = 'ACTIVE'
       AND (p.code ILIKE $2 OR p.name ILIKE $2 OR p.description ILIKE $2 OR p.barcode ILIKE $2)
     ORDER BY p.code
     LIMIT 1000`,
  users_typeahead: `
    SELECT u.id, u.email, u.name, u.status, u.status_reason, u.role_id,
           r.name AS role_name, u.manager_id, m.name AS manager_name,
           m.email AS manager_email, u.department_id, d.name AS department_name,
           d.color AS department_color, u.division, u.position_id,
           p.name AS position_name, u.invited_at, u.invited_by,
           ib.name AS invited_by_name, ib.email AS invited_by_email,
           u.joined_at, u.last_login_at, u.created_at, u.profile_pic_r2_key,
           u.phone, u.email_alias,
           (SELECT string_agg(ub.brand, chr(31)) FROM public.user_brands ub WHERE ub.user_id = u.id) AS brands_concat,
           (SELECT array_agg(ud.department_id) FROM public.user_departments ud WHERE ud.user_id = u.id) AS department_ids_arr,
           (SELECT array_agg(uc.company_id) FROM public.user_companies uc WHERE uc.user_id = u.id) AS company_ids_arr
      FROM public.users u
      JOIN public.roles r ON r.id = u.role_id
      LEFT JOIN public.users m ON m.id = u.manager_id
      LEFT JOIN public.departments d ON d.id = u.department_id
      LEFT JOIN public.positions p ON p.id = u.position_id
      LEFT JOIN public.users ib ON ib.id = u.invited_by
     WHERE (u.name ILIKE $1 OR u.email ILIKE $1)
     ORDER BY u.created_at DESC
     LIMIT 50`,
  users_full_list: `
    SELECT u.id, u.email, u.name, u.status, u.status_reason, u.role_id,
           r.name AS role_name, u.manager_id, m.name AS manager_name,
           m.email AS manager_email, u.department_id, d.name AS department_name,
           d.color AS department_color, u.division, u.position_id,
           p.name AS position_name, u.invited_at, u.invited_by,
           ib.name AS invited_by_name, ib.email AS invited_by_email,
           u.joined_at, u.last_login_at, u.created_at, u.profile_pic_r2_key,
           u.phone, u.email_alias,
           (SELECT string_agg(ub.brand, chr(31)) FROM public.user_brands ub WHERE ub.user_id = u.id) AS brands_concat,
           (SELECT array_agg(ud.department_id) FROM public.user_departments ud WHERE ud.user_id = u.id) AS department_ids_arr,
           (SELECT array_agg(uc.company_id) FROM public.user_companies uc WHERE uc.user_id = u.id) AS company_ids_arr
      FROM public.users u
      JOIN public.roles r ON r.id = u.role_id
      LEFT JOIN public.users m ON m.id = u.manager_id
      LEFT JOIN public.departments d ON d.id = u.department_id
      LEFT JOIN public.positions p ON p.id = u.position_id
      LEFT JOIN public.users ib ON ib.id = u.invited_by
     ORDER BY u.created_at DESC`,
};
