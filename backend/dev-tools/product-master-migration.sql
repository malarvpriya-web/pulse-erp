-- ============================================================
-- Pulse ERP — Product Master Extended Fields Migration
-- Run: psql -U postgres -d Pulse -f product-master-migration.sql
-- ============================================================

-- Add all power-quality / SST / HVDC product master fields
-- All columns use IF NOT EXISTS so re-running is safe.

ALTER TABLE products ADD COLUMN IF NOT EXISTS product_family     VARCHAR(50)   DEFAULT '';
ALTER TABLE products ADD COLUMN IF NOT EXISTS model_sku          VARCHAR(100)  DEFAULT '';
ALTER TABLE products ADD COLUMN IF NOT EXISTS rating             VARCHAR(100)  DEFAULT '';
ALTER TABLE products ADD COLUMN IF NOT EXISTS voltage_class      VARCHAR(50)   DEFAULT '';
ALTER TABLE products ADD COLUMN IF NOT EXISTS phase              VARCHAR(20)   DEFAULT '';
ALTER TABLE products ADD COLUMN IF NOT EXISTS frequency          VARCHAR(20)   DEFAULT '';
ALTER TABLE products ADD COLUMN IF NOT EXISTS topology           VARCHAR(100)  DEFAULT '';
ALTER TABLE products ADD COLUMN IF NOT EXISTS cooling            VARCHAR(50)   DEFAULT '';
ALTER TABLE products ADD COLUMN IF NOT EXISTS ip_rating          VARCHAR(20)   DEFAULT '';
ALTER TABLE products ADD COLUMN IF NOT EXISTS bom_template       VARCHAR(200)  DEFAULT '';
ALTER TABLE products ADD COLUMN IF NOT EXISTS routing_template   VARCHAR(200)  DEFAULT '';
ALTER TABLE products ADD COLUMN IF NOT EXISTS test_plan_template VARCHAR(200)  DEFAULT '';
ALTER TABLE products ADD COLUMN IF NOT EXISTS warranty_months    INTEGER       DEFAULT 12;
ALTER TABLE products ADD COLUMN IF NOT EXISTS hsn_sac            VARCHAR(20)   DEFAULT '';
ALTER TABLE products ADD COLUMN IF NOT EXISTS gst_rate           NUMERIC(5,2)  DEFAULT 18.00;

-- Verify
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'products'
ORDER BY ordinal_position;
