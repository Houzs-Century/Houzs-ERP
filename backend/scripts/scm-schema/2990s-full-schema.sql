CREATE TYPE "public"."addon_kind" AS ENUM('qty', 'floors_items', 'flat');
CREATE TYPE "public"."comp_group" AS ENUM('1-seater', '2-seater', 'Corner', 'L-Shape', 'Accessory');
CREATE TYPE "public"."currency_code" AS ENUM('MYR', 'RMB', 'USD', 'SGD');
CREATE TYPE "public"."delivery_return_status" AS ENUM('PENDING', 'RECEIVED', 'INSPECTED', 'REFUNDED', 'CREDIT_NOTED', 'REJECTED', 'CANCELLED');
CREATE TYPE "public"."do_status" AS ENUM('LOADED', 'DISPATCHED', 'IN_TRANSIT', 'SIGNED', 'DELIVERED', 'INVOICED', 'CANCELLED');
CREATE TYPE "public"."fabric_category" AS ENUM('B.M-FABR', 'S-FABR', 'S.M-FABR', 'LINING', 'WEBBING');
CREATE TYPE "public"."fabric_price_tier" AS ENUM('PRICE_1', 'PRICE_2', 'PRICE_3');
CREATE TYPE "public"."grn_status" AS ENUM('POSTED', 'CLOSED', 'CANCELLED');
CREATE TYPE "public"."hr_item_kpi_type" AS ENUM('product', 'fabric', 'special');
CREATE TYPE "public"."hr_tier" AS ENUM('sales', 'manager');
CREATE TYPE "public"."inventory_movement_type" AS ENUM('IN', 'OUT', 'ADJUSTMENT', 'TRANSFER');
CREATE TYPE "public"."maintenance_config_scope" AS ENUM('master', 'customer');
CREATE TYPE "public"."material_kind" AS ENUM('mfg_product', 'fabric', 'raw');
CREATE TYPE "public"."mfg_product_category" AS ENUM('SOFA', 'BEDFRAME', 'ACCESSORY', 'MATTRESS', 'SERVICE');
CREATE TYPE "public"."mfg_product_status" AS ENUM('ACTIVE', 'INACTIVE');
CREATE TYPE "public"."mfg_so_status" AS ENUM('CONFIRMED', 'IN_PRODUCTION', 'READY_TO_SHIP', 'SHIPPED', 'DELIVERED', 'INVOICED', 'CLOSED', 'ON_HOLD', 'CANCELLED');
CREATE TYPE "public"."order_item_kind" AS ENUM('product', 'addon');
CREATE TYPE "public"."order_lane" AS ENUM('received', 'proceed', 'logistics', 'ready', 'dispatched', 'delivered');
CREATE TYPE "public"."payment_kind" AS ENUM('deposit', 'balance', 'topup', 'refund', 'adjustment');
CREATE TYPE "public"."payment_method" AS ENUM('credit', 'debit', 'installment', 'transfer', 'merchant', 'cash');
CREATE TYPE "public"."po_status" AS ENUM('SUBMITTED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED');
CREATE TYPE "public"."pricing_kind" AS ENUM('size_variants', 'sofa_build', 'bedframe_build', 'flat', 'tbc');
CREATE TYPE "public"."purchase_invoice_status" AS ENUM('POSTED', 'PARTIALLY_PAID', 'PAID', 'CANCELLED');
CREATE TYPE "public"."purchase_return_status" AS ENUM('POSTED', 'COMPLETED', 'CANCELLED');
CREATE TYPE "public"."sales_invoice_status" AS ENUM('SENT', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'CANCELLED');
CREATE TYPE "public"."slip_state" AS ENUM('none', 'pending', 'verified', 'flagged');
CREATE TYPE "public"."slip_upload_status" AS ENUM('pending', 'uploaded', 'promoted', 'failed');
CREATE TYPE "public"."staff_role" AS ENUM('sales', 'showroom_lead', 'coordinator', 'finance', 'admin', 'sales_executive', 'outlet_manager', 'sales_director', 'super_admin', 'master_account');
CREATE TYPE "public"."supplier_status" AS ENUM('ACTIVE', 'INACTIVE', 'BLOCKED');
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_code" text NOT NULL,
	"account_name" text NOT NULL,
	"account_type" text NOT NULL,
	"parent_code" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_account_code_unique" UNIQUE("account_code")
);

CREATE TABLE "addons" (
	"id" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"description" text,
	"icon" text NOT NULL,
	"kind" "addon_kind" NOT NULL,
	"price" integer NOT NULL,
	"per_floor_item" integer,
	"unit" text,
	"default_qty" integer DEFAULT 1 NOT NULL,
	"stock" integer,
	"enabled" boolean DEFAULT true NOT NULL,
	"show_at_handover" boolean DEFAULT false NOT NULL,
	"service_sku" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "app_config" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"description" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);

CREATE TABLE "bedframe_colours" (
	"id" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"swatch_hex" text,
	"surcharge" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);

CREATE TABLE "bedframe_options" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"value" text NOT NULL,
	"surcharge" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);

CREATE TABLE "bundle_library" (
	"id" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"sub" text NOT NULL,
	"signature" text NOT NULL,
	"base_width_cm" integer NOT NULL,
	"base_depth_cm" integer NOT NULL,
	"cushions" integer NOT NULL,
	"default_price" integer NOT NULL,
	"art_left" text,
	"art_right" text,
	"art_base" text,
	"sort_order" integer DEFAULT 0 NOT NULL
);

CREATE TABLE "categories" (
	"id" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"icon" text NOT NULL,
	"tbc" boolean DEFAULT false NOT NULL,
	"hero_image_key" text,
	"sort_order" integer DEFAULT 0 NOT NULL
);

CREATE TABLE "compartment_library" (
	"id" text PRIMARY KEY NOT NULL,
	"comp_group" "comp_group" NOT NULL,
	"label" text NOT NULL,
	"width_cm" integer NOT NULL,
	"depth_cm" integer NOT NULL,
	"cushions" integer DEFAULT 1 NOT NULL,
	"default_price" integer NOT NULL,
	"art_filename" text,
	"is_accessory" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);

CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"phone" text,
	"email" text,
	"customer_code" text,
	"address" text,
	"address_line2" text,
	"postcode" text,
	"city" text,
	"state" text,
	"notes" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "delivery_fee_config" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"base_fee" integer DEFAULT 250 NOT NULL,
	"cross_category_fee" integer DEFAULT 175 NOT NULL,
	"mattress_bedframe_lead_days" integer DEFAULT 20 NOT NULL,
	"sofa_lead_days" integer DEFAULT 30 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);

CREATE TABLE "delivery_order_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delivery_order_id" uuid NOT NULL,
	"so_item_id" uuid,
	"item_code" text NOT NULL,
	"description" text,
	"qty" integer NOT NULL,
	"m3_milli" integer DEFAULT 0 NOT NULL,
	"unit_price_centi" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"gap_inches" integer,
	"divan_height_inches" integer,
	"divan_price_sen" integer DEFAULT 0 NOT NULL,
	"leg_height_inches" integer,
	"leg_price_sen" integer DEFAULT 0 NOT NULL,
	"custom_specials" jsonb,
	"line_suffix" text,
	"special_order_price_sen" integer DEFAULT 0 NOT NULL,
	"variants" jsonb,
	"item_group" text,
	"description2" text,
	"uom" text DEFAULT 'UNIT' NOT NULL,
	"discount_centi" integer DEFAULT 0 NOT NULL,
	"line_total_centi" integer DEFAULT 0 NOT NULL,
	"line_no" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "delivery_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"do_number" text NOT NULL,
	"so_doc_no" text,
	"debtor_code" text,
	"debtor_name" text NOT NULL,
	"do_date" date DEFAULT now() NOT NULL,
	"expected_delivery_at" date,
	"signed_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"dispatched_at" timestamp with time zone,
	"driver_id" uuid,
	"driver_name" text,
	"vehicle" text,
	"m3_total_milli" integer DEFAULT 0 NOT NULL,
	"address1" text,
	"address2" text,
	"city" text,
	"state" text,
	"postcode" text,
	"phone" text,
	"pod_r2_key" text,
	"signature_data" text,
	"status" "do_status" DEFAULT 'LOADED' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_orders_do_number_unique" UNIQUE("do_number")
);

CREATE TABLE "delivery_return_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delivery_return_id" uuid NOT NULL,
	"do_item_id" uuid,
	"item_code" text NOT NULL,
	"description" text,
	"qty_returned" integer NOT NULL,
	"condition" text,
	"unit_price_centi" integer DEFAULT 0 NOT NULL,
	"refund_centi" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "delivery_returns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"return_number" text NOT NULL,
	"delivery_order_id" uuid,
	"sales_invoice_id" uuid,
	"debtor_code" text,
	"debtor_name" text NOT NULL,
	"return_date" date DEFAULT now() NOT NULL,
	"reason" text,
	"status" "delivery_return_status" DEFAULT 'PENDING' NOT NULL,
	"received_at" timestamp with time zone,
	"inspected_at" timestamp with time zone,
	"refunded_at" timestamp with time zone,
	"refund_centi" integer DEFAULT 0 NOT NULL,
	"inspection_notes" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_returns_return_number_unique" UNIQUE("return_number")
);

CREATE TABLE "drivers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"driver_code" text NOT NULL,
	"name" text NOT NULL,
	"phone" text NOT NULL,
	"ic_number" text,
	"vehicle" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "drivers_driver_code_unique" UNIQUE("driver_code")
);

CREATE TABLE "fabric_colours" (
	"fabric_id" text NOT NULL,
	"colour_id" text NOT NULL,
	"label" text NOT NULL,
	"swatch_hex" text,
	"swatch_key" text,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "fabric_colours_fabric_id_colour_id_pk" PRIMARY KEY("fabric_id","colour_id")
);

CREATE TABLE "fabric_library" (
	"id" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"tier" text DEFAULT 'standard' NOT NULL,
	"default_surcharge" integer DEFAULT 0 NOT NULL,
	"swatch_key" text,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"sofa_tier" text,
	"bedframe_tier" text,
	"fabric_code" text
);

CREATE TABLE "fabric_tier_addon_config" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"sofa_tier2_delta" integer DEFAULT 0 NOT NULL,
	"sofa_tier3_delta" integer DEFAULT 0 NOT NULL,
	"bedframe_tier2_delta" integer DEFAULT 0 NOT NULL,
	"bedframe_tier3_delta" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);

CREATE TABLE "fabric_trackings" (
	"id" text PRIMARY KEY NOT NULL,
	"fabric_code" text NOT NULL,
	"fabric_description" text,
	"fabric_category" "fabric_category",
	"price_tier" "fabric_price_tier",
	"sofa_price_tier" "fabric_price_tier",
	"bedframe_price_tier" "fabric_price_tier",
	"price_centi" integer DEFAULT 0 NOT NULL,
	"soh_centi" integer DEFAULT 0 NOT NULL,
	"po_outstanding_centi" integer DEFAULT 0 NOT NULL,
	"last_month_usage_centi" integer DEFAULT 0 NOT NULL,
	"one_week_usage_centi" integer DEFAULT 0 NOT NULL,
	"two_weeks_usage_centi" integer DEFAULT 0 NOT NULL,
	"one_month_usage_centi" integer DEFAULT 0 NOT NULL,
	"shortage_centi" integer DEFAULT 0 NOT NULL,
	"reorder_point_centi" integer DEFAULT 0 NOT NULL,
	"supplier" text,
	"supplier_code" text,
	"lead_time_days" integer DEFAULT 0 NOT NULL,
	"series" text,
	"is_active" boolean DEFAULT true NOT NULL
);

CREATE TABLE "fabrics" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"category" text,
	"price_sen" integer DEFAULT 0 NOT NULL,
	"soh_meters_centi" integer DEFAULT 0 NOT NULL,
	"reorder_level_centi" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "fabrics_code_unique" UNIQUE("code")
);

CREATE TABLE "free_item_campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"max_free_qty" integer DEFAULT 1 NOT NULL,
	"eligible" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "grn_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"grn_id" uuid NOT NULL,
	"purchase_order_item_id" uuid,
	"material_kind" "material_kind" NOT NULL,
	"material_code" text NOT NULL,
	"material_name" text NOT NULL,
	"qty_received" integer NOT NULL,
	"qty_accepted" integer NOT NULL,
	"qty_rejected" integer DEFAULT 0 NOT NULL,
	"rejection_reason" text,
	"unit_price_centi" integer NOT NULL,
	"notes" text,
	"gap_inches" integer,
	"divan_height_inches" integer,
	"divan_price_sen" integer DEFAULT 0 NOT NULL,
	"leg_height_inches" integer,
	"leg_price_sen" integer DEFAULT 0 NOT NULL,
	"custom_specials" jsonb,
	"line_suffix" text,
	"special_order_price_sen" integer DEFAULT 0 NOT NULL,
	"variants" jsonb,
	"item_group" text,
	"description" text,
	"description2" text,
	"uom" text DEFAULT 'UNIT' NOT NULL,
	"discount_centi" integer DEFAULT 0 NOT NULL,
	"line_total_centi" integer DEFAULT 0 NOT NULL,
	"delivery_date" date,
	"unit_cost_centi" integer DEFAULT 0 NOT NULL,
	"supplier_sku" text,
	"invoiced_qty" integer DEFAULT 0 NOT NULL,
	"returned_qty" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "grns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"grn_number" text NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"received_at" date DEFAULT now() NOT NULL,
	"delivery_note_ref" text,
	"status" "grn_status" DEFAULT 'POSTED' NOT NULL,
	"notes" text,
	"currency" "currency_code" DEFAULT 'MYR' NOT NULL,
	"subtotal_centi" integer DEFAULT 0 NOT NULL,
	"tax_centi" integer DEFAULT 0 NOT NULL,
	"total_centi" integer DEFAULT 0 NOT NULL,
	"posted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grns_grn_number_unique" UNIQUE("grn_number")
);

CREATE TABLE "hr_commission_config" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"base_bps" integer DEFAULT 100 NOT NULL,
	"personal_kpi_threshold_centi" integer DEFAULT 10000000 NOT NULL,
	"personal_kpi_bonus_bps" integer DEFAULT 50 NOT NULL,
	"showroom_kpi_threshold_centi" integer DEFAULT 40000000 NOT NULL,
	"showroom_kpi_bonus_bps" integer DEFAULT 50 NOT NULL,
	"override_base_bps" integer DEFAULT 50 NOT NULL,
	"override_kpi_bonus_bps" integer DEFAULT 50 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);

CREATE TABLE "hr_item_kpi" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"flag_type" "hr_item_kpi_type" NOT NULL,
	"ref" text NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"bonus_centi" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "hr_salesperson_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"staff_id" uuid NOT NULL,
	"tier" "hr_tier" DEFAULT 'sales' NOT NULL,
	"showroom_id" uuid NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hr_salesperson_profiles_staff_id_unique" UNIQUE("staff_id")
);

CREATE TABLE "inventory_lot_consumptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lot_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"product_code" text NOT NULL,
	"variant_key" text DEFAULT '' NOT NULL,
	"qty_consumed" integer NOT NULL,
	"unit_cost_sen" integer NOT NULL,
	"total_cost_sen" integer NOT NULL,
	"consumed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_doc_type" text,
	"source_doc_id" uuid,
	"source_doc_no" text,
	"movement_id" uuid,
	"created_by" uuid
);

CREATE TABLE "inventory_lots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"product_code" text NOT NULL,
	"product_name" text,
	"variant_key" text DEFAULT '' NOT NULL,
	"qty_received" integer NOT NULL,
	"qty_remaining" integer NOT NULL,
	"unit_cost_sen" integer DEFAULT 0 NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_doc_type" text,
	"source_doc_id" uuid,
	"source_doc_no" text,
	"movement_id" uuid,
	"batch_no" text,
	"notes" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "inventory_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"movement_type" "inventory_movement_type" NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"product_code" text NOT NULL,
	"product_name" text,
	"variant_key" text DEFAULT '' NOT NULL,
	"qty" integer NOT NULL,
	"unit_cost_sen" integer DEFAULT 0,
	"total_cost_sen" integer DEFAULT 0,
	"source_doc_type" text,
	"source_doc_id" uuid,
	"source_doc_no" text,
	"batch_no" text,
	"notes" text,
	"performed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "journal_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"je_no" text NOT NULL,
	"entry_date" date DEFAULT now() NOT NULL,
	"source_type" text NOT NULL,
	"source_doc_no" text,
	"narration" text,
	"total_debit_sen" integer DEFAULT 0 NOT NULL,
	"total_credit_sen" integer DEFAULT 0 NOT NULL,
	"posted" boolean DEFAULT false NOT NULL,
	"posted_at" timestamp with time zone,
	"posted_by" uuid,
	"reversed" boolean DEFAULT false NOT NULL,
	"reversed_by_je" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "journal_entries_je_no_unique" UNIQUE("je_no")
);

CREATE TABLE "journal_entry_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"journal_entry_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"account_code" text NOT NULL,
	"debit_sen" integer DEFAULT 0 NOT NULL,
	"credit_sen" integer DEFAULT 0 NOT NULL,
	"party_type" text,
	"party_code" text,
	"party_name" text,
	"notes" text
);

CREATE TABLE "maintenance_config_history" (
	"id" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"config" jsonb NOT NULL,
	"effective_from" date NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);

CREATE TABLE "master_price_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_code" text NOT NULL,
	"field" text NOT NULL,
	"old_value_sen" integer,
	"new_value_sen" integer,
	"reason" text,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_by" uuid
);

CREATE TABLE "mfg_products" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"category" "mfg_product_category" NOT NULL,
	"description" text,
	"base_model" text,
	"size_code" text,
	"size_label" text,
	"fabric_usage_centi" integer DEFAULT 0 NOT NULL,
	"unit_m3_milli" integer DEFAULT 0 NOT NULL,
	"status" "mfg_product_status" DEFAULT 'ACTIVE' NOT NULL,
	"cost_price_sen" integer DEFAULT 0 NOT NULL,
	"base_price_sen" integer,
	"price1_sen" integer,
	"sell_price_sen" integer,
	"pwp_price_sen" integer DEFAULT 0 NOT NULL,
	"pos_active" boolean DEFAULT true NOT NULL,
	"included_addons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"default_free_gifts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"production_time_minutes" integer DEFAULT 0 NOT NULL,
	"sub_assemblies" jsonb,
	"sku_code" text,
	"fabric_color" text,
	"branding" text,
	"barcode" text,
	"one_shot" boolean DEFAULT false NOT NULL,
	"source_doc_no" text,
	"pieces" jsonb,
	"seat_height_prices" jsonb,
	"default_variants" jsonb,
	"retail_product_id" uuid,
	"model_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "mfg_sales_order_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"doc_no" text NOT NULL,
	"line_date" date DEFAULT now() NOT NULL,
	"debtor_code" text,
	"debtor_name" text,
	"agent" text,
	"item_group" text NOT NULL,
	"item_code" text NOT NULL,
	"description" text,
	"description2" text,
	"uom" text DEFAULT 'UNIT' NOT NULL,
	"location" text,
	"warehouse_id" uuid,
	"qty" integer DEFAULT 1 NOT NULL,
	"unit_price_centi" integer DEFAULT 0 NOT NULL,
	"discount_centi" integer DEFAULT 0 NOT NULL,
	"total_centi" integer DEFAULT 0 NOT NULL,
	"tax_centi" integer DEFAULT 0 NOT NULL,
	"total_inc_centi" integer DEFAULT 0 NOT NULL,
	"balance_centi" integer DEFAULT 0 NOT NULL,
	"payment_status" text DEFAULT 'Unchecked' NOT NULL,
	"venue" text,
	"branding" text,
	"remark" text,
	"cancelled" boolean DEFAULT false NOT NULL,
	"variants" jsonb,
	"unit_cost_centi" integer DEFAULT 0 NOT NULL,
	"line_cost_centi" integer DEFAULT 0 NOT NULL,
	"line_margin_centi" integer DEFAULT 0 NOT NULL,
	"gap_inches" integer,
	"divan_height_inches" integer,
	"divan_price_sen" integer DEFAULT 0 NOT NULL,
	"leg_height_inches" integer,
	"leg_price_sen" integer DEFAULT 0 NOT NULL,
	"custom_specials" jsonb,
	"line_suffix" text,
	"special_order_price_sen" integer DEFAULT 0 NOT NULL,
	"po_qty_picked" integer DEFAULT 0 NOT NULL,
	"line_delivery_date" date,
	"line_delivery_date_overridden" boolean DEFAULT false NOT NULL,
	"photo_urls" text[] DEFAULT '{}' NOT NULL,
	"stock_status" text DEFAULT 'PENDING' NOT NULL,
	"line_no" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "mfg_sales_order_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"so_doc_no" text NOT NULL,
	"paid_at" date DEFAULT now() NOT NULL,
	"method" text NOT NULL,
	"merchant_provider" text,
	"installment_months" integer,
	"approval_code" text,
	"amount_centi" integer NOT NULL,
	"account_sheet" text,
	"slip_key" text,
	"collected_by" uuid,
	"note" text,
	"is_deposit" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);

CREATE TABLE "mfg_sales_orders" (
	"doc_no" text PRIMARY KEY NOT NULL,
	"transfer_to" text,
	"so_date" date DEFAULT now() NOT NULL,
	"branding" text,
	"debtor_code" text,
	"debtor_name" text NOT NULL,
	"agent" text,
	"sales_location" text,
	"ref" text,
	"po_doc_no" text,
	"venue" text,
	"venue_id" uuid,
	"address1" text,
	"address2" text,
	"address3" text,
	"address4" text,
	"phone" text,
	"mattress_sofa_centi" integer DEFAULT 0 NOT NULL,
	"bedframe_centi" integer DEFAULT 0 NOT NULL,
	"accessories_centi" integer DEFAULT 0 NOT NULL,
	"others_centi" integer DEFAULT 0 NOT NULL,
	"mattress_sofa_cost_centi" integer DEFAULT 0 NOT NULL,
	"bedframe_cost_centi" integer DEFAULT 0 NOT NULL,
	"accessories_cost_centi" integer DEFAULT 0 NOT NULL,
	"others_cost_centi" integer DEFAULT 0 NOT NULL,
	"service_centi" integer DEFAULT 0 NOT NULL,
	"service_cost_centi" integer DEFAULT 0 NOT NULL,
	"local_total_centi" integer DEFAULT 0 NOT NULL,
	"balance_centi" integer DEFAULT 0 NOT NULL,
	"total_cost_centi" integer DEFAULT 0 NOT NULL,
	"total_revenue_centi" integer DEFAULT 0 NOT NULL,
	"total_margin_centi" integer DEFAULT 0 NOT NULL,
	"margin_pct_basis" integer DEFAULT 0 NOT NULL,
	"line_count" integer DEFAULT 0 NOT NULL,
	"fabric_tier_addon_centi" integer DEFAULT 0 NOT NULL,
	"delivery_fee_centi" integer DEFAULT 0 NOT NULL,
	"cross_category_source_doc_no" text,
	"currency" "currency_code" DEFAULT 'MYR' NOT NULL,
	"status" "mfg_so_status" DEFAULT 'CONFIRMED' NOT NULL,
	"remark2" text,
	"remark3" text,
	"remark4" text,
	"note" text,
	"processing_date" date,
	"proceeded_at" timestamp with time zone,
	"sales_exemption_expiry" date,
	"customer_id" uuid,
	"customer_state" text,
	"customer_country" text,
	"customer_po" text,
	"customer_po_id" text,
	"customer_po_date" date,
	"customer_po_image_b64" text,
	"customer_so_no" text,
	"hub_id" uuid,
	"hub_name" text,
	"customer_delivery_date" date,
	"internal_expected_dd" date,
	"linked_do_doc_no" text,
	"ship_to_address" text,
	"bill_to_address" text,
	"install_to_address" text,
	"subtotal_sen" integer,
	"overdue" text,
	"email" text,
	"customer_type" text,
	"salesperson_id" uuid,
	"city" text,
	"postcode" text,
	"building_type" text,
	"emergency_contact_name" text,
	"emergency_contact_phone" text,
	"emergency_contact_relationship" text,
	"target_date" date,
	"signature_b64" text,
	"slip_key" text,
	"slip_state" "slip_state" DEFAULT 'none' NOT NULL,
	"payment_method" text,
	"installment_months" integer,
	"merchant_provider" text,
	"approval_code" text,
	"payment_date" date,
	"deposit_centi" integer DEFAULT 0 NOT NULL,
	"paid_centi" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "mfg_so_audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"so_doc_no" text NOT NULL,
	"action" text NOT NULL,
	"actor_id" uuid,
	"actor_name_snapshot" text,
	"field_changes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status_snapshot" text,
	"source" text DEFAULT 'web',
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "mfg_so_price_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"doc_no" text NOT NULL,
	"item_id" uuid NOT NULL,
	"item_code" text NOT NULL,
	"original_price_sen" integer NOT NULL,
	"override_price_sen" integer NOT NULL,
	"reason" text,
	"approved_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "mfg_so_status_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"doc_no" text NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"changed_by" uuid,
	"notes" text,
	"auto_actions" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "model_default_free_gifts" (
	"model_id" uuid PRIMARY KEY NOT NULL,
	"gifts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);

CREATE TABLE "model_fabric_tier_overrides" (
	"model_id" uuid PRIMARY KEY NOT NULL,
	"tier2_delta" integer,
	"tier3_delta" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);

CREATE TABLE "model_special_delivery_fees" (
	"model_id" uuid PRIMARY KEY NOT NULL,
	"standalone_fee" integer DEFAULT 0 NOT NULL,
	"cross_cat_followup_fee" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);

CREATE TABLE "my_localities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"postcode" text NOT NULL,
	"city" text NOT NULL,
	"state" text NOT NULL,
	"state_code" text NOT NULL,
	"country" text DEFAULT 'Malaysia' NOT NULL,
	"warehouse_id" uuid
);

CREATE TABLE "order_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" text NOT NULL,
	"kind" "order_item_kind" NOT NULL,
	"product_id" uuid,
	"addon_id" text,
	"qty" integer DEFAULT 1 NOT NULL,
	"unit_price" integer NOT NULL,
	"line_total" integer NOT NULL,
	"config" jsonb,
	"floors_count" integer,
	"items_count" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_or_addon" CHECK (
    ("order_items"."kind" = 'product' AND "order_items"."product_id" IS NOT NULL AND "order_items"."addon_id" IS NULL) OR
    ("order_items"."kind" = 'addon'   AND "order_items"."addon_id"   IS NOT NULL AND "order_items"."product_id" IS NULL)
  )
);

CREATE TABLE "order_lane_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" text NOT NULL,
	"from_lane" "order_lane",
	"to_lane" "order_lane" NOT NULL,
	"changed_by" uuid NOT NULL,
	"reason" text,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "order_slip_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" text NOT NULL,
	"event" text NOT NULL,
	"actor_id" uuid,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "orders" (
	"id" text PRIMARY KEY NOT NULL,
	"placed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"staff_id" uuid NOT NULL,
	"showroom_id" uuid NOT NULL,
	"lane" "order_lane" DEFAULT 'received' NOT NULL,
	"customer_name" text NOT NULL,
	"customer_phone" text,
	"customer_email" text,
	"customer_address" text,
	"customer_address_line2" text,
	"customer_postcode" text,
	"customer_city" text,
	"customer_state" text,
	"customer_type" text,
	"building_type" text,
	"billing_same" boolean DEFAULT true NOT NULL,
	"salesperson_id" uuid,
	"emergency_name" text,
	"emergency_phone" text,
	"emergency_relation" text,
	"customer_id" uuid,
	"subtotal" integer NOT NULL,
	"addon_total" integer DEFAULT 0 NOT NULL,
	"total" integer NOT NULL,
	"paid" integer DEFAULT 0 NOT NULL,
	"delivery_fee_base" integer DEFAULT 0 NOT NULL,
	"delivery_fee_cross_category" integer DEFAULT 0 NOT NULL,
	"delivery_fee_additional" integer DEFAULT 0 NOT NULL,
	"pricing_version" text NOT NULL,
	"payment_method" "payment_method" NOT NULL,
	"approval_code" text,
	"installment_months" integer,
	"merchant_provider" text,
	"slip_state" "slip_state" DEFAULT 'none' NOT NULL,
	"slip_key" text,
	"slip_verified_by" uuid,
	"slip_verified_at" timestamp with time zone,
	"slip_flag_reason" text,
	"delivery_date" date,
	"delivery_slot" text,
	"delivery_tbd" boolean DEFAULT false NOT NULL,
	"delivery_notes" text,
	"confirmed_delivery_date" date,
	"driver_id" uuid,
	"confirmed_with" text,
	"dispatched_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"do_signed" boolean DEFAULT false NOT NULL,
	"do_key" text,
	"signature_data" text,
	"notes" text,
	"stock_note" text,
	"po_issued" boolean DEFAULT false NOT NULL,
	"po_issued_at" timestamp with time zone,
	"po_issued_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" text NOT NULL,
	"kind" "payment_kind" NOT NULL,
	"amount" integer NOT NULL,
	"method" "payment_method" NOT NULL,
	"approval_code" text,
	"slip_key" text,
	"slip_state" "slip_state" DEFAULT 'none' NOT NULL,
	"recorded_by" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notes" text
);

CREATE TABLE "pending_slip_uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"upload_session_id" text NOT NULL,
	"staff_id" uuid NOT NULL,
	"showroom_id" uuid NOT NULL,
	"order_draft_id" text,
	"r2_key" text NOT NULL,
	"content_type" text,
	"content_hash" text,
	"content_size" integer,
	"status" "slip_upload_status" DEFAULT 'pending' NOT NULL,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"error_msg" text,
	"claimed_by" text,
	"lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"promoted_at" timestamp with time zone,
	"promoted_to_order_id" text,
	CONSTRAINT "pending_slip_uploads_upload_session_id_unique" UNIQUE("upload_session_id")
);

CREATE TABLE "pos_carts" (
	"staff_id" uuid PRIMARY KEY NOT NULL,
	"lines" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_quote_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "pos_pin_attempts" (
	"staff_id" uuid PRIMARY KEY NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"reset_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "product_bedframe_colours" (
	"product_id" uuid NOT NULL,
	"colour_id" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "product_bedframe_colours_product_id_colour_id_pk" PRIMARY KEY("product_id","colour_id")
);

CREATE TABLE "product_bundles" (
	"product_id" uuid NOT NULL,
	"bundle_id" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"price" integer NOT NULL,
	CONSTRAINT "product_bundles_product_id_bundle_id_pk" PRIMARY KEY("product_id","bundle_id")
);

CREATE TABLE "product_compartments" (
	"product_id" uuid NOT NULL,
	"compartment_id" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"price" integer NOT NULL,
	CONSTRAINT "product_compartments_product_id_compartment_id_pk" PRIMARY KEY("product_id","compartment_id")
);

CREATE TABLE "product_dept_configs" (
	"product_code" text PRIMARY KEY NOT NULL,
	"unit_m3_milli" integer DEFAULT 0 NOT NULL,
	"fabric_usage_centi" integer DEFAULT 0 NOT NULL,
	"price2_sen" integer DEFAULT 0 NOT NULL,
	"fab_cut_category" text,
	"fab_cut_minutes" integer,
	"fab_sew_category" text,
	"fab_sew_minutes" integer,
	"wood_cut_category" text,
	"wood_cut_minutes" integer,
	"foam_category" text,
	"foam_minutes" integer,
	"framing_category" text,
	"framing_minutes" integer,
	"upholstery_category" text,
	"upholstery_minutes" integer,
	"packing_category" text,
	"packing_minutes" integer,
	"sub_assemblies" jsonb,
	"heights_sub_assemblies" jsonb
);

CREATE TABLE "product_fabrics" (
	"product_id" uuid NOT NULL,
	"fabric_id" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"surcharge" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "product_fabrics_product_id_fabric_id_pk" PRIMARY KEY("product_id","fabric_id")
);

CREATE TABLE "product_models" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"branding" text,
	"model_code" text NOT NULL,
	"name" text NOT NULL,
	"category" "mfg_product_category" NOT NULL,
	"description" text,
	"photo_url" text,
	"allowed_options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "product_size_variants" (
	"product_id" uuid NOT NULL,
	"size_id" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"price" integer NOT NULL,
	CONSTRAINT "product_size_variants_product_id_size_id_pk" PRIMARY KEY("product_id","size_id")
);

CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sku" text NOT NULL,
	"category_id" text NOT NULL,
	"series_id" text,
	"pricing_kind" "pricing_kind" DEFAULT 'tbc' NOT NULL,
	"name" text NOT NULL,
	"model_code" text,
	"detail" text,
	"size_display" text,
	"img_key" text,
	"thumb_key" text,
	"stock" integer DEFAULT 0 NOT NULL,
	"low_at" integer DEFAULT 5 NOT NULL,
	"visible" boolean DEFAULT true NOT NULL,
	"flat_price" integer,
	"recliner_upgrade_price" integer,
	"seat_upgrade_label" text,
	"seat_upgrade_footrest" boolean DEFAULT true NOT NULL,
	"depth_options" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"supplier_id" uuid,
	CONSTRAINT "products_sku_unique" UNIQUE("sku"),
	CONSTRAINT "pricing_consistency" CHECK (
    ("products"."pricing_kind" = 'flat'         AND "products"."flat_price" IS NOT NULL) OR
    ("products"."pricing_kind" = 'sofa_build'   AND "products"."recliner_upgrade_price" IS NOT NULL) OR
    ("products"."pricing_kind" IN ('size_variants','bedframe_build','tbc'))
  )
);

CREATE TABLE "purchase_invoice_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purchase_invoice_id" uuid NOT NULL,
	"grn_item_id" uuid,
	"material_kind" "material_kind" NOT NULL,
	"material_code" text NOT NULL,
	"material_name" text NOT NULL,
	"qty" integer NOT NULL,
	"unit_price_centi" integer NOT NULL,
	"line_total_centi" integer NOT NULL,
	"notes" text,
	"gap_inches" integer,
	"divan_height_inches" integer,
	"divan_price_sen" integer DEFAULT 0 NOT NULL,
	"leg_height_inches" integer,
	"leg_price_sen" integer DEFAULT 0 NOT NULL,
	"custom_specials" jsonb,
	"line_suffix" text,
	"special_order_price_sen" integer DEFAULT 0 NOT NULL,
	"variants" jsonb,
	"item_group" text,
	"description" text,
	"description2" text,
	"uom" text DEFAULT 'UNIT' NOT NULL,
	"discount_centi" integer DEFAULT 0 NOT NULL,
	"unit_cost_centi" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "purchase_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_number" text NOT NULL,
	"supplier_invoice_ref" text,
	"supplier_id" uuid NOT NULL,
	"purchase_order_id" uuid,
	"grn_id" uuid,
	"invoice_date" date DEFAULT now() NOT NULL,
	"due_date" date,
	"currency" "currency_code" DEFAULT 'MYR' NOT NULL,
	"subtotal_centi" integer DEFAULT 0 NOT NULL,
	"tax_centi" integer DEFAULT 0 NOT NULL,
	"total_centi" integer DEFAULT 0 NOT NULL,
	"paid_centi" integer DEFAULT 0 NOT NULL,
	"status" "purchase_invoice_status" DEFAULT 'POSTED' NOT NULL,
	"notes" text,
	"posted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_invoices_invoice_number_unique" UNIQUE("invoice_number")
);

CREATE TABLE "purchase_order_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"binding_id" uuid,
	"material_kind" "material_kind" NOT NULL,
	"material_code" text NOT NULL,
	"material_name" text NOT NULL,
	"supplier_sku" text,
	"qty" integer NOT NULL,
	"unit_price_centi" integer NOT NULL,
	"line_total_centi" integer NOT NULL,
	"received_qty" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"gap_inches" integer,
	"divan_height_inches" integer,
	"divan_price_sen" integer DEFAULT 0 NOT NULL,
	"leg_height_inches" integer,
	"leg_price_sen" integer DEFAULT 0 NOT NULL,
	"custom_specials" jsonb,
	"line_suffix" text,
	"special_order_price_sen" integer DEFAULT 0 NOT NULL,
	"variants" jsonb,
	"item_group" text,
	"description" text,
	"description2" text,
	"uom" text DEFAULT 'UNIT' NOT NULL,
	"discount_centi" integer DEFAULT 0 NOT NULL,
	"unit_cost_centi" integer DEFAULT 0 NOT NULL,
	"delivery_date" date,
	"warehouse_id" uuid,
	"so_item_id" uuid,
	"from_mrp" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "purchase_order_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"order_id" text NOT NULL,
	"sku" text NOT NULL,
	"name" text NOT NULL,
	"size" text,
	"colour" text,
	"qty" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "purchase_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"po_number" text NOT NULL,
	"supplier_id" uuid NOT NULL,
	"status" "po_status" DEFAULT 'SUBMITTED' NOT NULL,
	"po_date" date DEFAULT now() NOT NULL,
	"expected_at" date,
	"purchase_location_id" uuid,
	"currency" "currency_code" DEFAULT 'MYR' NOT NULL,
	"subtotal_centi" integer DEFAULT 0 NOT NULL,
	"tax_centi" integer DEFAULT 0 NOT NULL,
	"total_centi" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"submitted_at" timestamp with time zone,
	"received_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_orders_po_number_unique" UNIQUE("po_number")
);

CREATE TABLE "purchase_return_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purchase_return_id" uuid NOT NULL,
	"grn_item_id" uuid,
	"material_kind" "material_kind" NOT NULL,
	"material_code" text NOT NULL,
	"material_name" text NOT NULL,
	"qty_returned" integer NOT NULL,
	"unit_price_centi" integer DEFAULT 0 NOT NULL,
	"line_refund_centi" integer DEFAULT 0 NOT NULL,
	"reason" text,
	"notes" text,
	"gap_inches" integer,
	"divan_height_inches" integer,
	"divan_price_sen" integer DEFAULT 0 NOT NULL,
	"leg_height_inches" integer,
	"leg_price_sen" integer DEFAULT 0 NOT NULL,
	"custom_specials" jsonb,
	"line_suffix" text,
	"special_order_price_sen" integer DEFAULT 0 NOT NULL,
	"variants" jsonb,
	"item_group" text,
	"description" text,
	"description2" text,
	"uom" text DEFAULT 'UNIT' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "purchase_returns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"return_number" text NOT NULL,
	"purchase_order_id" uuid,
	"grn_id" uuid,
	"supplier_id" uuid NOT NULL,
	"return_date" date DEFAULT now() NOT NULL,
	"reason" text,
	"status" "purchase_return_status" DEFAULT 'POSTED' NOT NULL,
	"posted_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"credit_note_ref" text,
	"refund_centi" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_returns_return_number_unique" UNIQUE("return_number")
);

CREATE TABLE "pwp_codes" (
	"code" text PRIMARY KEY NOT NULL,
	"rule_id" uuid,
	"reward_category" "mfg_product_category" NOT NULL,
	"eligible_reward_model_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reward_combo_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"type" text DEFAULT 'pwp' NOT NULL,
	"status" text DEFAULT 'RESERVED' NOT NULL,
	"owner_staff_id" uuid,
	"cart_line_key" text,
	"trigger_item_code" text,
	"source_doc_no" text,
	"redeemed_doc_no" text,
	"redeemed_item_code" text,
	"customer_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "pwp_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trigger_category" "mfg_product_category" NOT NULL,
	"trigger_eligible_model_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reward_category" "mfg_product_category" NOT NULL,
	"eligible_reward_model_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"trigger_combo_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reward_combo_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"qty_per_trigger" integer DEFAULT 1 NOT NULL,
	"type" text DEFAULT 'pwp' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);

CREATE TABLE "quotes" (
	"id" text PRIMARY KEY NOT NULL,
	"showroom_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"customer_name" text NOT NULL,
	"customer_phone" text,
	"customer_email" text,
	"cart" jsonb NOT NULL,
	"addons" jsonb,
	"subtotal" integer NOT NULL,
	"addon_total" integer DEFAULT 0 NOT NULL,
	"total" integer NOT NULL,
	"delivery_fee_base" integer DEFAULT 0 NOT NULL,
	"delivery_fee_cross_category" integer DEFAULT 0 NOT NULL,
	"delivery_fee_additional" integer DEFAULT 0 NOT NULL,
	"pricing_version" text NOT NULL,
	"expires_at" timestamp with time zone,
	"promoted_to_order_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "sales_invoice_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sales_invoice_id" uuid NOT NULL,
	"so_item_id" uuid,
	"item_code" text NOT NULL,
	"description" text,
	"qty" integer NOT NULL,
	"unit_price_centi" integer DEFAULT 0 NOT NULL,
	"discount_centi" integer DEFAULT 0 NOT NULL,
	"tax_centi" integer DEFAULT 0 NOT NULL,
	"line_total_centi" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"gap_inches" integer,
	"divan_height_inches" integer,
	"divan_price_sen" integer DEFAULT 0 NOT NULL,
	"leg_height_inches" integer,
	"leg_price_sen" integer DEFAULT 0 NOT NULL,
	"custom_specials" jsonb,
	"line_suffix" text,
	"special_order_price_sen" integer DEFAULT 0 NOT NULL,
	"variants" jsonb,
	"item_group" text,
	"description2" text,
	"uom" text DEFAULT 'UNIT' NOT NULL,
	"line_no" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "sales_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_number" text NOT NULL,
	"so_doc_no" text,
	"delivery_order_id" uuid,
	"debtor_code" text,
	"debtor_name" text NOT NULL,
	"invoice_date" date DEFAULT now() NOT NULL,
	"due_date" date,
	"currency" "currency_code" DEFAULT 'MYR' NOT NULL,
	"subtotal_centi" integer DEFAULT 0 NOT NULL,
	"discount_centi" integer DEFAULT 0 NOT NULL,
	"tax_centi" integer DEFAULT 0 NOT NULL,
	"total_centi" integer DEFAULT 0 NOT NULL,
	"paid_centi" integer DEFAULT 0 NOT NULL,
	"status" "sales_invoice_status" DEFAULT 'SENT' NOT NULL,
	"notes" text,
	"sent_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sales_invoices_invoice_number_unique" UNIQUE("invoice_number")
);

CREATE TABLE "series" (
	"id" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);

CREATE TABLE "showrooms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"showroom_code" text NOT NULL,
	"name" text NOT NULL,
	"address" text,
	"phone" text,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "showrooms_showroom_code_unique" UNIQUE("showroom_code")
);

CREATE TABLE "size_library" (
	"id" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"width_cm" integer NOT NULL,
	"length_cm" integer NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);

CREATE TABLE "so_dropdown_options" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"category" text NOT NULL,
	"value" text NOT NULL,
	"label" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "so_dropdown_options_category_check" CHECK ("so_dropdown_options"."category" IN ('customer_type', 'building_type', 'relationship', 'payment_method', 'payment_merchant', 'online_type', 'installment_plan', 'venue'))
);

CREATE TABLE "so_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"label" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "sofa_combo_pricing" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"base_model" text NOT NULL,
	"modules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tier" "fabric_price_tier",
	"customer_id" uuid,
	"supplier_id" uuid,
	"prices_by_height" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"selling_prices_by_height" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"pwp_prices_by_height" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"default_free_gifts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"label" text,
	"effective_from" date NOT NULL,
	"deleted_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);

CREATE TABLE "sofa_personal_quick_picks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"staff_id" uuid NOT NULL,
	"base_model" text NOT NULL,
	"label" text,
	"modules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"depth" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "sofa_quick_picks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"base_model" text NOT NULL,
	"label" text,
	"modules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"depth" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);

CREATE TABLE "special_addons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"label" text NOT NULL,
	"so_description" text DEFAULT '' NOT NULL,
	"categories" text[] DEFAULT '{}'::text[] NOT NULL,
	"selling_price_sen" integer DEFAULT 0 NOT NULL,
	"cost_price_sen" integer DEFAULT 0 NOT NULL,
	"option_groups" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "special_addons_code_unique" UNIQUE("code")
);

CREATE TABLE "staff" (
	"id" uuid PRIMARY KEY NOT NULL,
	"staff_code" text NOT NULL,
	"name" text NOT NULL,
	"role" "staff_role" NOT NULL,
	"showroom_id" uuid,
	"venue_id" uuid,
	"pin_hash" text,
	"email" text,
	"phone" text,
	"initials" text NOT NULL,
	"color" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_staff_code_unique" UNIQUE("staff_code"),
	CONSTRAINT "staff_email_unique" UNIQUE("email")
);

CREATE TABLE "state_warehouse_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"state" text NOT NULL,
	"warehouse_id" uuid,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "state_warehouse_mappings_state_unique" UNIQUE("state")
);

CREATE TABLE "stock_take_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"stock_take_id" uuid NOT NULL,
	"product_code" text NOT NULL,
	"product_name" text,
	"system_qty" integer DEFAULT 0 NOT NULL,
	"counted_qty" integer,
	"variance" integer,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "stock_takes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"take_no" text NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"scope_type" text DEFAULT 'ALL' NOT NULL,
	"scope_value" text,
	"take_date" date DEFAULT now() NOT NULL,
	"notes" text,
	"posted_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "stock_takes_take_no_unique" UNIQUE("take_no"),
	CONSTRAINT "stock_takes_status_chk" CHECK (status IN ('OPEN','POSTED','CANCELLED')),
	CONSTRAINT "stock_takes_scope_type_chk" CHECK (scope_type IN ('ALL','CATEGORY','CODE_PREFIX'))
);

CREATE TABLE "stock_transfer_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"stock_transfer_id" uuid NOT NULL,
	"product_code" text NOT NULL,
	"product_name" text,
	"variant_key" text DEFAULT '' NOT NULL,
	"qty" integer NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_transfer_lines_qty_pos" CHECK (qty > 0)
);

CREATE TABLE "stock_transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transfer_no" text NOT NULL,
	"status" text DEFAULT 'POSTED' NOT NULL,
	"from_warehouse_id" uuid NOT NULL,
	"to_warehouse_id" uuid NOT NULL,
	"transfer_date" date DEFAULT now() NOT NULL,
	"notes" text,
	"posted_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "stock_transfers_transfer_no_unique" UNIQUE("transfer_no"),
	CONSTRAINT "stock_transfers_not_same_wh" CHECK (from_warehouse_id <> to_warehouse_id),
	CONSTRAINT "stock_transfers_status_chk" CHECK (status IN ('POSTED','CANCELLED'))
);

CREATE TABLE "supplier_material_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"supplier_id" uuid NOT NULL,
	"material_kind" "material_kind" NOT NULL,
	"material_code" text NOT NULL,
	"material_name" text NOT NULL,
	"supplier_sku" text NOT NULL,
	"unit_price_centi" integer DEFAULT 0 NOT NULL,
	"currency" "currency_code" DEFAULT 'MYR' NOT NULL,
	"lead_time_days" integer DEFAULT 0 NOT NULL,
	"payment_terms_override" text,
	"moq" integer DEFAULT 0 NOT NULL,
	"price_valid_from" date,
	"price_valid_to" date,
	"is_main_supplier" boolean DEFAULT false NOT NULL,
	"notes" text,
	"price_matrix" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "suppliers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"whatsapp_number" text,
	"email" text,
	"contact_person" text,
	"phone" text,
	"address" text,
	"state" text,
	"country" text DEFAULT 'Malaysia' NOT NULL,
	"payment_terms" text,
	"status" "supplier_status" DEFAULT 'ACTIVE' NOT NULL,
	"rating" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"supplier_type" text,
	"category" text,
	"tin_number" text,
	"business_reg_no" text,
	"postcode" text,
	"area" text,
	"mobile" text,
	"fax" text,
	"website" text,
	"attention" text,
	"business_nature" text,
	"currency" text DEFAULT 'MYR' NOT NULL,
	"statement_type" text DEFAULT 'OPEN_ITEM' NOT NULL,
	"aging_basis" text DEFAULT 'INVOICE_DATE' NOT NULL,
	"credit_limit_sen" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "suppliers_code_unique" UNIQUE("code")
);

CREATE TABLE "venues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"address" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "warehouse_rack_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rack_id" uuid NOT NULL,
	"product_code" text NOT NULL,
	"variant_key" text DEFAULT '' NOT NULL,
	"product_name" text,
	"size_label" text,
	"customer_name" text,
	"source_doc_no" text,
	"qty" integer DEFAULT 1 NOT NULL,
	"stocked_in_date" date DEFAULT now() NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "warehouse_rack_items_qty_pos" CHECK (qty > 0)
);

CREATE TABLE "warehouse_rack_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"movement_type" text NOT NULL,
	"rack_id" uuid,
	"rack_label" text,
	"to_rack_id" uuid,
	"to_rack_label" text,
	"warehouse_id" uuid,
	"product_code" text,
	"variant_key" text DEFAULT '' NOT NULL,
	"product_name" text,
	"source_doc_no" text,
	"quantity" integer DEFAULT 1 NOT NULL,
	"reason" text,
	"performed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "warehouse_rack_movements_type_chk" CHECK (movement_type IN ('STOCK_IN','STOCK_OUT','TRANSFER'))
);

CREATE TABLE "warehouse_racks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"rack" text NOT NULL,
	"position" text,
	"status" text DEFAULT 'EMPTY' NOT NULL,
	"reserved" boolean DEFAULT false NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "warehouse_racks_status_chk" CHECK (status IN ('OCCUPIED','EMPTY','RESERVED'))
);

CREATE TABLE "warehouses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"location" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "warehouses_code_unique" UNIQUE("code")
);

ALTER TABLE "delivery_order_items" ADD CONSTRAINT "delivery_order_items_delivery_order_id_delivery_orders_id_fk" FOREIGN KEY ("delivery_order_id") REFERENCES "public"."delivery_orders"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "delivery_order_items" ADD CONSTRAINT "delivery_order_items_so_item_id_mfg_sales_order_items_id_fk" FOREIGN KEY ("so_item_id") REFERENCES "public"."mfg_sales_order_items"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "delivery_orders" ADD CONSTRAINT "delivery_orders_so_doc_no_mfg_sales_orders_doc_no_fk" FOREIGN KEY ("so_doc_no") REFERENCES "public"."mfg_sales_orders"("doc_no") ON DELETE set null ON UPDATE no action;
ALTER TABLE "delivery_orders" ADD CONSTRAINT "delivery_orders_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "delivery_orders" ADD CONSTRAINT "delivery_orders_created_by_staff_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "delivery_return_items" ADD CONSTRAINT "delivery_return_items_delivery_return_id_delivery_returns_id_fk" FOREIGN KEY ("delivery_return_id") REFERENCES "public"."delivery_returns"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "delivery_return_items" ADD CONSTRAINT "delivery_return_items_do_item_id_delivery_order_items_id_fk" FOREIGN KEY ("do_item_id") REFERENCES "public"."delivery_order_items"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "delivery_returns" ADD CONSTRAINT "delivery_returns_delivery_order_id_delivery_orders_id_fk" FOREIGN KEY ("delivery_order_id") REFERENCES "public"."delivery_orders"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "delivery_returns" ADD CONSTRAINT "delivery_returns_sales_invoice_id_sales_invoices_id_fk" FOREIGN KEY ("sales_invoice_id") REFERENCES "public"."sales_invoices"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "delivery_returns" ADD CONSTRAINT "delivery_returns_created_by_staff_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "fabric_colours" ADD CONSTRAINT "fabric_colours_fabric_id_fabric_library_id_fk" FOREIGN KEY ("fabric_id") REFERENCES "public"."fabric_library"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "grn_items" ADD CONSTRAINT "grn_items_grn_id_grns_id_fk" FOREIGN KEY ("grn_id") REFERENCES "public"."grns"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "grn_items" ADD CONSTRAINT "grn_items_purchase_order_item_id_purchase_order_items_id_fk" FOREIGN KEY ("purchase_order_item_id") REFERENCES "public"."purchase_order_items"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "grns" ADD CONSTRAINT "grns_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "grns" ADD CONSTRAINT "grns_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "grns" ADD CONSTRAINT "grns_created_by_staff_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "hr_salesperson_profiles" ADD CONSTRAINT "hr_salesperson_profiles_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "hr_salesperson_profiles" ADD CONSTRAINT "hr_salesperson_profiles_showroom_id_showrooms_id_fk" FOREIGN KEY ("showroom_id") REFERENCES "public"."showrooms"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "inventory_lot_consumptions" ADD CONSTRAINT "inventory_lot_consumptions_lot_id_inventory_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."inventory_lots"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "inventory_lot_consumptions" ADD CONSTRAINT "inventory_lot_consumptions_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "inventory_lot_consumptions" ADD CONSTRAINT "inventory_lot_consumptions_created_by_staff_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "inventory_lots" ADD CONSTRAINT "inventory_lots_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "inventory_lots" ADD CONSTRAINT "inventory_lots_created_by_staff_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_performed_by_staff_id_fk" FOREIGN KEY ("performed_by") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_posted_by_staff_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_created_by_staff_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "journal_entry_lines" ADD CONSTRAINT "journal_entry_lines_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "journal_entry_lines" ADD CONSTRAINT "journal_entry_lines_account_code_accounts_account_code_fk" FOREIGN KEY ("account_code") REFERENCES "public"."accounts"("account_code") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "maintenance_config_history" ADD CONSTRAINT "maintenance_config_history_created_by_staff_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "master_price_history" ADD CONSTRAINT "master_price_history_changed_by_staff_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "mfg_products" ADD CONSTRAINT "mfg_products_retail_product_id_products_id_fk" FOREIGN KEY ("retail_product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "mfg_products" ADD CONSTRAINT "mfg_products_model_id_product_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."product_models"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "mfg_sales_order_items" ADD CONSTRAINT "mfg_sales_order_items_doc_no_mfg_sales_orders_doc_no_fk" FOREIGN KEY ("doc_no") REFERENCES "public"."mfg_sales_orders"("doc_no") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "mfg_sales_order_items" ADD CONSTRAINT "mfg_sales_order_items_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "mfg_sales_order_payments" ADD CONSTRAINT "mfg_sales_order_payments_so_doc_no_mfg_sales_orders_doc_no_fk" FOREIGN KEY ("so_doc_no") REFERENCES "public"."mfg_sales_orders"("doc_no") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "mfg_sales_order_payments" ADD CONSTRAINT "mfg_sales_order_payments_collected_by_staff_id_fk" FOREIGN KEY ("collected_by") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "mfg_sales_order_payments" ADD CONSTRAINT "mfg_sales_order_payments_created_by_staff_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "mfg_sales_orders" ADD CONSTRAINT "mfg_sales_orders_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "mfg_sales_orders" ADD CONSTRAINT "mfg_sales_orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "mfg_sales_orders" ADD CONSTRAINT "mfg_sales_orders_salesperson_id_staff_id_fk" FOREIGN KEY ("salesperson_id") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "mfg_sales_orders" ADD CONSTRAINT "mfg_sales_orders_created_by_staff_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "mfg_so_audit_log" ADD CONSTRAINT "mfg_so_audit_log_so_doc_no_mfg_sales_orders_doc_no_fk" FOREIGN KEY ("so_doc_no") REFERENCES "public"."mfg_sales_orders"("doc_no") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "mfg_so_audit_log" ADD CONSTRAINT "mfg_so_audit_log_actor_id_staff_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "mfg_so_price_overrides" ADD CONSTRAINT "mfg_so_price_overrides_doc_no_mfg_sales_orders_doc_no_fk" FOREIGN KEY ("doc_no") REFERENCES "public"."mfg_sales_orders"("doc_no") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "mfg_so_price_overrides" ADD CONSTRAINT "mfg_so_price_overrides_item_id_mfg_sales_order_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."mfg_sales_order_items"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "mfg_so_price_overrides" ADD CONSTRAINT "mfg_so_price_overrides_approved_by_staff_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "mfg_so_status_changes" ADD CONSTRAINT "mfg_so_status_changes_doc_no_mfg_sales_orders_doc_no_fk" FOREIGN KEY ("doc_no") REFERENCES "public"."mfg_sales_orders"("doc_no") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "mfg_so_status_changes" ADD CONSTRAINT "mfg_so_status_changes_changed_by_staff_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "model_default_free_gifts" ADD CONSTRAINT "model_default_free_gifts_model_id_product_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."product_models"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "model_fabric_tier_overrides" ADD CONSTRAINT "model_fabric_tier_overrides_model_id_product_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."product_models"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "model_special_delivery_fees" ADD CONSTRAINT "model_special_delivery_fees_model_id_product_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."product_models"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "my_localities" ADD CONSTRAINT "my_localities_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_addon_id_addons_id_fk" FOREIGN KEY ("addon_id") REFERENCES "public"."addons"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "order_lane_history" ADD CONSTRAINT "order_lane_history_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "order_lane_history" ADD CONSTRAINT "order_lane_history_changed_by_staff_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "order_slip_events" ADD CONSTRAINT "order_slip_events_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "order_slip_events" ADD CONSTRAINT "order_slip_events_actor_id_staff_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "orders" ADD CONSTRAINT "orders_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "orders" ADD CONSTRAINT "orders_showroom_id_showrooms_id_fk" FOREIGN KEY ("showroom_id") REFERENCES "public"."showrooms"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "orders" ADD CONSTRAINT "orders_salesperson_id_staff_id_fk" FOREIGN KEY ("salesperson_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "orders" ADD CONSTRAINT "orders_slip_verified_by_staff_id_fk" FOREIGN KEY ("slip_verified_by") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "orders" ADD CONSTRAINT "orders_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "orders" ADD CONSTRAINT "orders_po_issued_by_staff_id_fk" FOREIGN KEY ("po_issued_by") REFERENCES "public"."staff"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "payments" ADD CONSTRAINT "payments_recorded_by_staff_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "pending_slip_uploads" ADD CONSTRAINT "pending_slip_uploads_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "pending_slip_uploads" ADD CONSTRAINT "pending_slip_uploads_showroom_id_showrooms_id_fk" FOREIGN KEY ("showroom_id") REFERENCES "public"."showrooms"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "pending_slip_uploads" ADD CONSTRAINT "pending_slip_uploads_promoted_to_order_id_orders_id_fk" FOREIGN KEY ("promoted_to_order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "pos_carts" ADD CONSTRAINT "pos_carts_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "pos_pin_attempts" ADD CONSTRAINT "pos_pin_attempts_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "product_bedframe_colours" ADD CONSTRAINT "product_bedframe_colours_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "product_bedframe_colours" ADD CONSTRAINT "product_bedframe_colours_colour_id_bedframe_colours_id_fk" FOREIGN KEY ("colour_id") REFERENCES "public"."bedframe_colours"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "product_bundles" ADD CONSTRAINT "product_bundles_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "product_bundles" ADD CONSTRAINT "product_bundles_bundle_id_bundle_library_id_fk" FOREIGN KEY ("bundle_id") REFERENCES "public"."bundle_library"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "product_compartments" ADD CONSTRAINT "product_compartments_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "product_compartments" ADD CONSTRAINT "product_compartments_compartment_id_compartment_library_id_fk" FOREIGN KEY ("compartment_id") REFERENCES "public"."compartment_library"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "product_fabrics" ADD CONSTRAINT "product_fabrics_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "product_fabrics" ADD CONSTRAINT "product_fabrics_fabric_id_fabric_library_id_fk" FOREIGN KEY ("fabric_id") REFERENCES "public"."fabric_library"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "product_size_variants" ADD CONSTRAINT "product_size_variants_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "product_size_variants" ADD CONSTRAINT "product_size_variants_size_id_size_library_id_fk" FOREIGN KEY ("size_id") REFERENCES "public"."size_library"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "products" ADD CONSTRAINT "products_series_id_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."series"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "products" ADD CONSTRAINT "products_updated_by_staff_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "products" ADD CONSTRAINT "products_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "purchase_invoice_items" ADD CONSTRAINT "purchase_invoice_items_purchase_invoice_id_purchase_invoices_id_fk" FOREIGN KEY ("purchase_invoice_id") REFERENCES "public"."purchase_invoices"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "purchase_invoice_items" ADD CONSTRAINT "purchase_invoice_items_grn_item_id_grn_items_id_fk" FOREIGN KEY ("grn_item_id") REFERENCES "public"."grn_items"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "purchase_invoices" ADD CONSTRAINT "purchase_invoices_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "purchase_invoices" ADD CONSTRAINT "purchase_invoices_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "purchase_invoices" ADD CONSTRAINT "purchase_invoices_grn_id_grns_id_fk" FOREIGN KEY ("grn_id") REFERENCES "public"."grns"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "purchase_invoices" ADD CONSTRAINT "purchase_invoices_created_by_staff_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_binding_id_supplier_material_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."supplier_material_bindings"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_so_item_id_mfg_sales_order_items_id_fk" FOREIGN KEY ("so_item_id") REFERENCES "public"."mfg_sales_order_items"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_purchase_location_id_warehouses_id_fk" FOREIGN KEY ("purchase_location_id") REFERENCES "public"."warehouses"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_created_by_staff_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "purchase_return_items" ADD CONSTRAINT "purchase_return_items_purchase_return_id_purchase_returns_id_fk" FOREIGN KEY ("purchase_return_id") REFERENCES "public"."purchase_returns"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "purchase_return_items" ADD CONSTRAINT "purchase_return_items_grn_item_id_grn_items_id_fk" FOREIGN KEY ("grn_item_id") REFERENCES "public"."grn_items"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_grn_id_grns_id_fk" FOREIGN KEY ("grn_id") REFERENCES "public"."grns"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_created_by_staff_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "pwp_codes" ADD CONSTRAINT "pwp_codes_rule_id_pwp_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."pwp_rules"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "pwp_codes" ADD CONSTRAINT "pwp_codes_owner_staff_id_staff_id_fk" FOREIGN KEY ("owner_staff_id") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "pwp_codes" ADD CONSTRAINT "pwp_codes_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "pwp_rules" ADD CONSTRAINT "pwp_rules_created_by_staff_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_showroom_id_showrooms_id_fk" FOREIGN KEY ("showroom_id") REFERENCES "public"."showrooms"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_created_by_staff_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_promoted_to_order_id_orders_id_fk" FOREIGN KEY ("promoted_to_order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "sales_invoice_items" ADD CONSTRAINT "sales_invoice_items_sales_invoice_id_sales_invoices_id_fk" FOREIGN KEY ("sales_invoice_id") REFERENCES "public"."sales_invoices"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "sales_invoice_items" ADD CONSTRAINT "sales_invoice_items_so_item_id_mfg_sales_order_items_id_fk" FOREIGN KEY ("so_item_id") REFERENCES "public"."mfg_sales_order_items"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_so_doc_no_mfg_sales_orders_doc_no_fk" FOREIGN KEY ("so_doc_no") REFERENCES "public"."mfg_sales_orders"("doc_no") ON DELETE set null ON UPDATE no action;
ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_delivery_order_id_delivery_orders_id_fk" FOREIGN KEY ("delivery_order_id") REFERENCES "public"."delivery_orders"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_created_by_staff_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "sofa_combo_pricing" ADD CONSTRAINT "sofa_combo_pricing_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "sofa_combo_pricing" ADD CONSTRAINT "sofa_combo_pricing_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "sofa_personal_quick_picks" ADD CONSTRAINT "sofa_personal_quick_picks_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "special_addons" ADD CONSTRAINT "special_addons_created_by_staff_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "staff" ADD CONSTRAINT "staff_showroom_id_showrooms_id_fk" FOREIGN KEY ("showroom_id") REFERENCES "public"."showrooms"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "staff" ADD CONSTRAINT "staff_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "state_warehouse_mappings" ADD CONSTRAINT "state_warehouse_mappings_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "stock_take_lines" ADD CONSTRAINT "stock_take_lines_stock_take_id_stock_takes_id_fk" FOREIGN KEY ("stock_take_id") REFERENCES "public"."stock_takes"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "stock_takes" ADD CONSTRAINT "stock_takes_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "stock_takes" ADD CONSTRAINT "stock_takes_created_by_staff_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_stock_transfer_id_stock_transfers_id_fk" FOREIGN KEY ("stock_transfer_id") REFERENCES "public"."stock_transfers"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_from_warehouse_id_warehouses_id_fk" FOREIGN KEY ("from_warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_to_warehouse_id_warehouses_id_fk" FOREIGN KEY ("to_warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_created_by_staff_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "supplier_material_bindings" ADD CONSTRAINT "supplier_material_bindings_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "warehouse_rack_items" ADD CONSTRAINT "warehouse_rack_items_rack_id_warehouse_racks_id_fk" FOREIGN KEY ("rack_id") REFERENCES "public"."warehouse_racks"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "warehouse_rack_movements" ADD CONSTRAINT "warehouse_rack_movements_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "warehouse_rack_movements" ADD CONSTRAINT "warehouse_rack_movements_performed_by_staff_id_fk" FOREIGN KEY ("performed_by") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "warehouse_racks" ADD CONSTRAINT "warehouse_racks_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE cascade ON UPDATE no action;
CREATE INDEX "idx_accounts_type" ON "accounts" USING btree ("account_type");
CREATE INDEX "idx_bedframe_options_kind" ON "bedframe_options" USING btree ("kind");
CREATE INDEX "idx_customers_phone" ON "customers" USING btree ("phone");
CREATE UNIQUE INDEX "customers_name_phone_unique" ON "customers" USING btree (lower(trim("name")),"phone") WHERE "customers"."phone" IS NOT NULL;
CREATE UNIQUE INDEX "customers_customer_code_unique" ON "customers" USING btree ("customer_code") WHERE "customers"."customer_code" IS NOT NULL;
CREATE INDEX "idx_do_items_do" ON "delivery_order_items" USING btree ("delivery_order_id");
CREATE INDEX "idx_do_so" ON "delivery_orders" USING btree ("so_doc_no");
CREATE INDEX "idx_do_status" ON "delivery_orders" USING btree ("status");
CREATE INDEX "idx_do_date" ON "delivery_orders" USING btree ("do_date");
CREATE INDEX "idx_dr_items_dr" ON "delivery_return_items" USING btree ("delivery_return_id");
CREATE INDEX "idx_dr_do" ON "delivery_returns" USING btree ("delivery_order_id");
CREATE INDEX "idx_dr_status" ON "delivery_returns" USING btree ("status");
CREATE INDEX "idx_dr_debtor" ON "delivery_returns" USING btree ("debtor_code");
CREATE INDEX "idx_fabric_trackings_code" ON "fabric_trackings" USING btree ("fabric_code");
CREATE INDEX "idx_fabric_trackings_tier" ON "fabric_trackings" USING btree ("price_tier");
CREATE INDEX "idx_fabric_trackings_series" ON "fabric_trackings" USING btree ("series") WHERE "fabric_trackings"."series" IS NOT NULL;
CREATE INDEX "idx_grn_items_grn" ON "grn_items" USING btree ("grn_id");
CREATE INDEX "idx_grn_po" ON "grns" USING btree ("purchase_order_id");
CREATE INDEX "idx_grn_supplier" ON "grns" USING btree ("supplier_id");
CREATE INDEX "idx_grn_status" ON "grns" USING btree ("status");
CREATE INDEX "idx_inv_cons_lot" ON "inventory_lot_consumptions" USING btree ("lot_id");
CREATE INDEX "idx_inv_cons_doc" ON "inventory_lot_consumptions" USING btree ("source_doc_type","source_doc_id");
CREATE INDEX "idx_inv_cons_consumed" ON "inventory_lot_consumptions" USING btree ("consumed_at");
CREATE INDEX "idx_inv_lots_wh_product" ON "inventory_lots" USING btree ("warehouse_id","product_code","received_at");
CREATE INDEX "idx_inv_lots_batch" ON "inventory_lots" USING btree ("warehouse_id","batch_no","product_code","variant_key");
CREATE INDEX "idx_inv_mov_warehouse_product" ON "inventory_movements" USING btree ("warehouse_id","product_code");
CREATE INDEX "idx_inv_mov_doc" ON "inventory_movements" USING btree ("source_doc_type","source_doc_id");
CREATE INDEX "idx_inv_mov_created" ON "inventory_movements" USING btree ("created_at");
CREATE INDEX "idx_je_date" ON "journal_entries" USING btree ("entry_date");
CREATE INDEX "idx_je_source" ON "journal_entries" USING btree ("source_type","source_doc_no");
CREATE INDEX "idx_je_posted" ON "journal_entries" USING btree ("posted");
CREATE INDEX "idx_jel_je" ON "journal_entry_lines" USING btree ("journal_entry_id");
CREATE INDEX "idx_jel_account" ON "journal_entry_lines" USING btree ("account_code");
CREATE INDEX "idx_jel_party" ON "journal_entry_lines" USING btree ("party_type","party_code");
CREATE INDEX "idx_mch_scope_eff" ON "maintenance_config_history" USING btree ("scope","effective_from");
CREATE INDEX "idx_mph_code" ON "master_price_history" USING btree ("product_code");
CREATE INDEX "idx_mfg_products_code" ON "mfg_products" USING btree ("code");
CREATE INDEX "idx_mfg_products_category" ON "mfg_products" USING btree ("category");
CREATE INDEX "idx_mfg_products_base_model" ON "mfg_products" USING btree ("base_model");
CREATE INDEX "idx_mfg_products_model_id" ON "mfg_products" USING btree ("model_id");
CREATE INDEX "idx_mso_items_doc" ON "mfg_sales_order_items" USING btree ("doc_no");
CREATE INDEX "idx_mso_items_item" ON "mfg_sales_order_items" USING btree ("item_code");
CREATE INDEX "idx_mso_items_group" ON "mfg_sales_order_items" USING btree ("item_group");
CREATE INDEX "idx_msop_doc" ON "mfg_sales_order_payments" USING btree ("so_doc_no");
CREATE INDEX "idx_msop_paid_at" ON "mfg_sales_order_payments" USING btree ("paid_at");
CREATE INDEX "idx_mso_date" ON "mfg_sales_orders" USING btree ("so_date");
CREATE INDEX "idx_mso_debtor" ON "mfg_sales_orders" USING btree ("debtor_code");
CREATE INDEX "idx_mso_status" ON "mfg_sales_orders" USING btree ("status");
CREATE INDEX "idx_mso_branding" ON "mfg_sales_orders" USING btree ("branding");
CREATE INDEX "idx_mso_customer" ON "mfg_sales_orders" USING btree ("customer_id");
CREATE INDEX "idx_msoaudit_doc" ON "mfg_so_audit_log" USING btree ("so_doc_no");
CREATE INDEX "idx_msoaudit_doc_at" ON "mfg_so_audit_log" USING btree ("so_doc_no","created_at");
CREATE INDEX "idx_msoaudit_actor" ON "mfg_so_audit_log" USING btree ("actor_id");
CREATE INDEX "idx_so_overrides_doc" ON "mfg_so_price_overrides" USING btree ("doc_no");
CREATE INDEX "idx_so_overrides_item" ON "mfg_so_price_overrides" USING btree ("item_id");
CREATE INDEX "idx_so_status_changes_doc" ON "mfg_so_status_changes" USING btree ("doc_no");
CREATE INDEX "idx_so_status_changes_at" ON "mfg_so_status_changes" USING btree ("created_at");
CREATE INDEX "idx_my_localities_postcode" ON "my_localities" USING btree ("postcode");
CREATE INDEX "idx_my_localities_state" ON "my_localities" USING btree ("state");
CREATE INDEX "idx_my_localities_country" ON "my_localities" USING btree ("country");
CREATE INDEX "idx_my_localities_warehouse_id" ON "my_localities" USING btree ("warehouse_id");
CREATE INDEX "idx_order_items_order" ON "order_items" USING btree ("order_id");
CREATE INDEX "idx_order_lane_history_order" ON "order_lane_history" USING btree ("order_id","changed_at" DESC NULLS LAST);
CREATE INDEX "idx_orders_lane" ON "orders" USING btree ("lane");
CREATE INDEX "idx_orders_showroom" ON "orders" USING btree ("showroom_id");
CREATE INDEX "idx_orders_slip_state" ON "orders" USING btree ("slip_state") WHERE "orders"."slip_state" IN ('pending','flagged');
CREATE INDEX "idx_orders_placed_at" ON "orders" USING btree ("placed_at" DESC NULLS LAST);
CREATE INDEX "idx_payments_order" ON "payments" USING btree ("order_id","recorded_at" DESC NULLS LAST);
CREATE INDEX "idx_pending_slip_reaper" ON "pending_slip_uploads" USING btree ("status","expires_at") WHERE "pending_slip_uploads"."status" IN ('pending','uploaded');
CREATE INDEX "idx_pending_slip_staff" ON "pending_slip_uploads" USING btree ("staff_id");
CREATE INDEX "idx_pending_slip_session" ON "pending_slip_uploads" USING btree ("upload_session_id");
CREATE UNIQUE INDEX "product_models_code_category_unique" ON "product_models" USING btree ("model_code","category");
CREATE INDEX "idx_product_models_category" ON "product_models" USING btree ("category");
CREATE INDEX "idx_products_visible" ON "products" USING btree ("visible") WHERE "products"."visible" = TRUE;
CREATE INDEX "idx_products_category" ON "products" USING btree ("category_id");
CREATE INDEX "idx_pi_items_pi" ON "purchase_invoice_items" USING btree ("purchase_invoice_id");
CREATE INDEX "idx_pi_supplier" ON "purchase_invoices" USING btree ("supplier_id");
CREATE INDEX "idx_pi_po" ON "purchase_invoices" USING btree ("purchase_order_id");
CREATE INDEX "idx_pi_status" ON "purchase_invoices" USING btree ("status");
CREATE INDEX "idx_po_items_po" ON "purchase_order_items" USING btree ("purchase_order_id");
CREATE INDEX "idx_po_items_warehouse" ON "purchase_order_items" USING btree ("warehouse_id");
CREATE INDEX "idx_po_items_so_item" ON "purchase_order_items" USING btree ("so_item_id");
CREATE INDEX "idx_po_supplier" ON "purchase_orders" USING btree ("supplier_id");
CREATE INDEX "idx_po_status" ON "purchase_orders" USING btree ("status");
CREATE INDEX "idx_pr_items_pr" ON "purchase_return_items" USING btree ("purchase_return_id");
CREATE INDEX "idx_pr_po" ON "purchase_returns" USING btree ("purchase_order_id");
CREATE INDEX "idx_pr_supplier" ON "purchase_returns" USING btree ("supplier_id");
CREATE INDEX "idx_pr_status" ON "purchase_returns" USING btree ("status");
CREATE INDEX "idx_pwp_codes_owner_status" ON "pwp_codes" USING btree ("owner_staff_id","status");
CREATE INDEX "idx_pwp_codes_cart_line" ON "pwp_codes" USING btree ("cart_line_key");
CREATE INDEX "idx_pwp_codes_source_doc" ON "pwp_codes" USING btree ("source_doc_no");
CREATE INDEX "idx_quotes_created_by" ON "quotes" USING btree ("created_by");
CREATE INDEX "idx_quotes_showroom" ON "quotes" USING btree ("showroom_id");
CREATE INDEX "idx_si_items_si" ON "sales_invoice_items" USING btree ("sales_invoice_id");
CREATE INDEX "idx_si_so" ON "sales_invoices" USING btree ("so_doc_no");
CREATE INDEX "idx_si_debtor" ON "sales_invoices" USING btree ("debtor_code");
CREATE INDEX "idx_si_status" ON "sales_invoices" USING btree ("status");
CREATE INDEX "idx_si_due_date" ON "sales_invoices" USING btree ("due_date");
CREATE UNIQUE INDEX "so_dropdown_options_category_value_key" ON "so_dropdown_options" USING btree ("category","value");
CREATE INDEX "idx_sdo_category" ON "so_dropdown_options" USING btree ("category","sort_order");
CREATE INDEX "idx_sofa_combo_pricing_lookup" ON "sofa_combo_pricing" USING btree ("base_model","tier","customer_id","supplier_id","effective_from");
CREATE INDEX "idx_sofa_combo_pricing_history" ON "sofa_combo_pricing" USING btree ("base_model","tier","customer_id","supplier_id","effective_from","created_at");
CREATE INDEX "idx_sofa_combo_pricing_supplier" ON "sofa_combo_pricing" USING btree ("supplier_id");
CREATE INDEX "idx_personal_quick_picks_lookup" ON "sofa_personal_quick_picks" USING btree ("staff_id","base_model","sort_order") WHERE "sofa_personal_quick_picks"."deleted_at" IS NULL;
CREATE INDEX "idx_sofa_quick_picks_lookup" ON "sofa_quick_picks" USING btree ("base_model","sort_order") WHERE "sofa_quick_picks"."deleted_at" IS NULL;
CREATE INDEX "idx_stock_take_lines_take" ON "stock_take_lines" USING btree ("stock_take_id");
CREATE UNIQUE INDEX "stock_take_lines_take_product_unique" ON "stock_take_lines" USING btree ("stock_take_id","product_code");
CREATE INDEX "idx_stock_takes_status" ON "stock_takes" USING btree ("status","take_date");
CREATE INDEX "idx_stock_takes_warehouse" ON "stock_takes" USING btree ("warehouse_id");
CREATE INDEX "idx_stock_transfer_lines_xfer" ON "stock_transfer_lines" USING btree ("stock_transfer_id");
CREATE INDEX "idx_stock_transfers_status" ON "stock_transfers" USING btree ("status","transfer_date");
CREATE INDEX "idx_stock_transfers_from_wh" ON "stock_transfers" USING btree ("from_warehouse_id");
CREATE INDEX "idx_stock_transfers_to_wh" ON "stock_transfers" USING btree ("to_warehouse_id");
CREATE INDEX "idx_smb_supplier" ON "supplier_material_bindings" USING btree ("supplier_id");
CREATE INDEX "idx_smb_material" ON "supplier_material_bindings" USING btree ("material_kind","material_code");
CREATE INDEX "idx_smb_main_per_material" ON "supplier_material_bindings" USING btree ("material_kind","material_code") WHERE "supplier_material_bindings"."is_main_supplier" = true;
CREATE INDEX "idx_warehouse_rack_items_rack" ON "warehouse_rack_items" USING btree ("rack_id");
CREATE INDEX "idx_warehouse_rack_items_product" ON "warehouse_rack_items" USING btree ("product_code");
CREATE INDEX "idx_warehouse_rack_movements_type" ON "warehouse_rack_movements" USING btree ("movement_type");
CREATE INDEX "idx_warehouse_rack_movements_rack" ON "warehouse_rack_movements" USING btree ("rack_id");
CREATE INDEX "idx_warehouse_rack_movements_created" ON "warehouse_rack_movements" USING btree ("created_at");
CREATE UNIQUE INDEX "warehouse_racks_warehouse_rack_key" ON "warehouse_racks" USING btree ("warehouse_id","rack");
CREATE INDEX "idx_warehouse_racks_warehouse" ON "warehouse_racks" USING btree ("warehouse_id","rack");
CREATE INDEX "idx_warehouse_racks_status" ON "warehouse_racks" USING btree ("status");
CREATE INDEX "idx_warehouses_active" ON "warehouses" USING btree ("is_active");
