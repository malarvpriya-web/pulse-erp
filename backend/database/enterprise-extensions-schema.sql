-- =====================================================
-- ENTERPRISE EXTENSIONS - COMPLETE SCHEMA
-- =====================================================

-- =====================================================
-- 1. MANUFACTURING / PRODUCTION MODULE
-- =====================================================

CREATE TABLE bill_of_materials (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  product_item_id UUID NOT NULL REFERENCES inventory_items(id),
  version VARCHAR(20) NOT NULL DEFAULT '1.0',
  description TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP,
  UNIQUE(product_item_id, version)
);

CREATE TABLE bom_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  bom_id UUID NOT NULL REFERENCES bill_of_materials(id) ON DELETE CASCADE,
  raw_material_item_id UUID NOT NULL REFERENCES inventory_items(id),
  quantity_required DECIMAL(15,4) NOT NULL,
  wastage_percentage DECIMAL(5,2) DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE work_orders (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  work_order_number VARCHAR(50) UNIQUE NOT NULL,
  product_item_id UUID NOT NULL REFERENCES inventory_items(id),
  bom_id UUID REFERENCES bill_of_materials(id),
  quantity_to_produce DECIMAL(15,2) NOT NULL,
  quantity_produced DECIMAL(15,2) DEFAULT 0,
  planned_start_date DATE NOT NULL,
  planned_end_date DATE,
  actual_start_date DATE,
  actual_end_date DATE,
  status VARCHAR(50) DEFAULT 'planned' CHECK (status IN ('planned', 'in_progress', 'completed', 'cancelled')),
  warehouse_id UUID REFERENCES warehouses(id),
  notes TEXT,
  created_by INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP
);

CREATE TABLE production_entries (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  work_order_id UUID NOT NULL REFERENCES work_orders(id),
  entry_type VARCHAR(50) NOT NULL CHECK (entry_type IN ('material_issue', 'finished_goods', 'scrap', 'wastage')),
  item_id UUID NOT NULL REFERENCES inventory_items(id),
  quantity DECIMAL(15,2) NOT NULL,
  rate DECIMAL(15,2),
  warehouse_id UUID REFERENCES warehouses(id),
  entry_date DATE NOT NULL,
  notes TEXT,
  created_by INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_bom_product ON bill_of_materials(product_item_id);
CREATE INDEX idx_work_orders_status ON work_orders(status);
CREATE INDEX idx_production_entries_wo ON production_entries(work_order_id);

-- =====================================================
-- 2. SERVICE & AMC MODULE
-- =====================================================

CREATE TABLE service_contracts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  contract_number VARCHAR(50) UNIQUE NOT NULL,
  customer_id UUID NOT NULL REFERENCES parties(id),
  contract_type VARCHAR(50) DEFAULT 'amc' CHECK (contract_type IN ('amc', 'warranty', 'one_time')),
  contract_start DATE NOT NULL,
  contract_end DATE NOT NULL,
  service_frequency VARCHAR(50), -- monthly, quarterly, half_yearly, yearly
  contract_value DECIMAL(15,2),
  status VARCHAR(50) DEFAULT 'active' CHECK (status IN ('draft', 'active', 'expired', 'cancelled')),
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP
);

CREATE TABLE service_schedules (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  contract_id UUID NOT NULL REFERENCES service_contracts(id),
  scheduled_date DATE NOT NULL,
  service_type VARCHAR(100),
  status VARCHAR(50) DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'skipped', 'rescheduled')),
  completed_date DATE,
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE serial_numbers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  item_id UUID NOT NULL REFERENCES inventory_items(id),
  serial_number VARCHAR(100) UNIQUE NOT NULL,
  customer_id UUID REFERENCES parties(id),
  installation_date DATE,
  warranty_start DATE,
  warranty_end DATE,
  status VARCHAR(50) DEFAULT 'in_stock' CHECK (status IN ('in_stock', 'installed', 'under_repair', 'scrapped')),
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP
);

CREATE INDEX idx_contracts_customer ON service_contracts(customer_id);
CREATE INDEX idx_contracts_status ON service_contracts(status);
CREATE INDEX idx_serial_numbers_item ON serial_numbers(item_id);

-- =====================================================
-- 3. LOGISTICS & DISPATCH MODULE
-- =====================================================

CREATE TABLE shipments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  shipment_number VARCHAR(50) UNIQUE NOT NULL,
  delivery_note_id UUID REFERENCES delivery_notes(id),
  courier_name VARCHAR(255),
  tracking_number VARCHAR(100),
  dispatch_date DATE NOT NULL,
  expected_delivery_date DATE,
  actual_delivery_date DATE,
  delivery_status VARCHAR(50) DEFAULT 'pending' CHECK (delivery_status IN ('pending', 'in_transit', 'delivered', 'failed', 'returned')),
  recipient_name VARCHAR(255),
  recipient_phone VARCHAR(50),
  delivery_address TEXT,
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP
);

CREATE TABLE shipment_tracking (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  shipment_id UUID NOT NULL REFERENCES shipments(id),
  status VARCHAR(100) NOT NULL,
  location VARCHAR(255),
  tracking_date TIMESTAMP NOT NULL,
  remarks TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_shipments_delivery_note ON shipments(delivery_note_id);
CREATE INDEX idx_shipments_status ON shipments(delivery_status);

-- =====================================================
-- 4. TAXATION (GST READY)
-- =====================================================

CREATE TABLE tax_categories (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  category_code VARCHAR(20) UNIQUE NOT NULL,
  category_name VARCHAR(100) NOT NULL,
  description TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE tax_rates (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tax_category_id UUID REFERENCES tax_categories(id),
  tax_type VARCHAR(50) NOT NULL, -- cgst, sgst, igst, cess
  rate DECIMAL(5,2) NOT NULL,
  effective_from DATE NOT NULL,
  effective_to DATE,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE hsn_sac_codes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  code VARCHAR(20) UNIQUE NOT NULL,
  code_type VARCHAR(10) CHECK (code_type IN ('HSN', 'SAC')),
  description TEXT,
  tax_category_id UUID REFERENCES tax_categories(id),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE gst_returns (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  return_period VARCHAR(20) NOT NULL, -- MM-YYYY
  return_type VARCHAR(20) NOT NULL, -- GSTR1, GSTR3B
  filing_date DATE,
  status VARCHAR(50) DEFAULT 'draft' CHECK (status IN ('draft', 'filed', 'revised')),
  total_sales DECIMAL(15,2),
  total_purchases DECIMAL(15,2),
  output_tax DECIMAL(15,2),
  input_tax DECIMAL(15,2),
  tax_payable DECIMAL(15,2),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE inventory_items ADD COLUMN hsn_sac_code_id UUID REFERENCES hsn_sac_codes(id);
ALTER TABLE inventory_items ADD COLUMN tax_category_id UUID REFERENCES tax_categories(id);

CREATE INDEX idx_tax_rates_category ON tax_rates(tax_category_id);
CREATE INDEX idx_hsn_codes ON hsn_sac_codes(code);

-- =====================================================
-- 5. MULTI-CURRENCY SUPPORT
-- =====================================================

CREATE TABLE currencies (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  currency_code VARCHAR(3) UNIQUE NOT NULL,
  currency_name VARCHAR(100) NOT NULL,
  symbol VARCHAR(10),
  is_base_currency BOOLEAN DEFAULT false,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE exchange_rates (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  from_currency_id UUID NOT NULL REFERENCES currencies(id),
  to_currency_id UUID NOT NULL REFERENCES currencies(id),
  rate DECIMAL(15,6) NOT NULL,
  effective_date DATE NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(from_currency_id, to_currency_id, effective_date)
);

CREATE TABLE forex_gain_loss (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  transaction_type VARCHAR(50) NOT NULL,
  transaction_id UUID NOT NULL,
  currency_id UUID NOT NULL REFERENCES currencies(id),
  original_amount DECIMAL(15,2) NOT NULL,
  realized_amount DECIMAL(15,2) NOT NULL,
  gain_loss_amount DECIMAL(15,2) NOT NULL,
  transaction_date DATE NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO currencies (currency_code, currency_name, symbol, is_base_currency) VALUES
('USD', 'US Dollar', '$', false),
('EUR', 'Euro', '€', false),
('GBP', 'British Pound', '£', false),
('INR', 'Indian Rupee', '₹', true);

CREATE INDEX idx_exchange_rates_date ON exchange_rates(effective_date);

-- =====================================================
-- 6. MASTER DATA GOVERNANCE
-- =====================================================

CREATE TABLE master_data_approvals (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  entity_type VARCHAR(50) NOT NULL, -- item, customer, supplier, account
  entity_id UUID NOT NULL,
  change_type VARCHAR(50) NOT NULL, -- create, update, delete
  old_data JSONB,
  new_data JSONB NOT NULL,
  requested_by INTEGER NOT NULL,
  requested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  status VARCHAR(50) DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  approved_by INTEGER,
  approved_at TIMESTAMP,
  rejection_reason TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE duplicate_detection_rules (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  entity_type VARCHAR(50) NOT NULL,
  field_name VARCHAR(100) NOT NULL,
  match_type VARCHAR(50) DEFAULT 'exact', -- exact, fuzzy, phonetic
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE entity_version_history (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  entity_type VARCHAR(50) NOT NULL,
  entity_id UUID NOT NULL,
  version_number INTEGER NOT NULL,
  data_snapshot JSONB NOT NULL,
  changed_by INTEGER,
  changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_approvals_status ON master_data_approvals(status);
CREATE INDEX idx_version_history_entity ON entity_version_history(entity_type, entity_id);

-- =====================================================
-- 7. DATA IMPORT / MIGRATION TOOLS
-- =====================================================

CREATE TABLE import_jobs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  job_name VARCHAR(255) NOT NULL,
  entity_type VARCHAR(50) NOT NULL,
  file_name VARCHAR(255),
  file_path VARCHAR(500),
  total_records INTEGER DEFAULT 0,
  processed_records INTEGER DEFAULT 0,
  success_count INTEGER DEFAULT 0,
  error_count INTEGER DEFAULT 0,
  status VARCHAR(50) DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  created_by INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE import_errors (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  import_job_id UUID NOT NULL REFERENCES import_jobs(id),
  row_number INTEGER NOT NULL,
  error_message TEXT NOT NULL,
  row_data JSONB,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_import_jobs_status ON import_jobs(status);

-- =====================================================
-- 8. API & INTEGRATION HUB
-- =====================================================

CREATE TABLE api_keys (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  key_name VARCHAR(255) NOT NULL,
  api_key VARCHAR(255) UNIQUE NOT NULL,
  api_secret VARCHAR(255),
  permissions JSONB,
  is_active BOOLEAN DEFAULT true,
  expires_at TIMESTAMP,
  last_used_at TIMESTAMP,
  created_by INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP
);

CREATE TABLE webhooks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  webhook_name VARCHAR(255) NOT NULL,
  event_type VARCHAR(100) NOT NULL,
  target_url VARCHAR(500) NOT NULL,
  http_method VARCHAR(10) DEFAULT 'POST',
  headers JSONB,
  is_active BOOLEAN DEFAULT true,
  retry_count INTEGER DEFAULT 3,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP
);

CREATE TABLE integration_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  integration_type VARCHAR(100) NOT NULL,
  direction VARCHAR(20) CHECK (direction IN ('inbound', 'outbound')),
  endpoint VARCHAR(500),
  request_data JSONB,
  response_data JSONB,
  status_code INTEGER,
  status VARCHAR(50),
  error_message TEXT,
  execution_time_ms INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_integration_logs_type ON integration_logs(integration_type);
CREATE INDEX idx_integration_logs_date ON integration_logs(created_at);

-- =====================================================
-- 9. MOBILE BACKEND LAYER
-- =====================================================

CREATE TABLE mobile_devices (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id INTEGER NOT NULL,
  device_id VARCHAR(255) UNIQUE NOT NULL,
  device_type VARCHAR(50), -- ios, android
  device_model VARCHAR(100),
  os_version VARCHAR(50),
  app_version VARCHAR(50),
  push_token VARCHAR(500),
  is_active BOOLEAN DEFAULT true,
  last_active_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE push_notifications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id INTEGER,
  device_id UUID REFERENCES mobile_devices(id),
  title VARCHAR(255) NOT NULL,
  message TEXT NOT NULL,
  notification_type VARCHAR(50),
  data JSONB,
  status VARCHAR(50) DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'read')),
  sent_at TIMESTAMP,
  read_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_mobile_devices_user ON mobile_devices(user_id);
CREATE INDEX idx_push_notifications_status ON push_notifications(status);

-- =====================================================
-- 10. AI & PREDICTION PLACEHOLDER
-- =====================================================

CREATE TABLE ai_models (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  model_name VARCHAR(255) NOT NULL,
  model_type VARCHAR(100) NOT NULL, -- lead_scoring, attrition, demand_forecast, cashflow
  version VARCHAR(20),
  accuracy_score DECIMAL(5,4),
  is_active BOOLEAN DEFAULT false,
  trained_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE ai_predictions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  model_id UUID NOT NULL REFERENCES ai_models(id),
  entity_type VARCHAR(50) NOT NULL,
  entity_id UUID NOT NULL,
  prediction_type VARCHAR(100) NOT NULL,
  prediction_value JSONB NOT NULL,
  confidence_score DECIMAL(5,4),
  predicted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE ml_training_data (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  model_type VARCHAR(100) NOT NULL,
  features JSONB NOT NULL,
  target_value JSONB NOT NULL,
  data_date DATE NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_predictions_entity ON ai_predictions(entity_type, entity_id);

-- =====================================================
-- 11. BI / DATA WAREHOUSE EXPORT
-- =====================================================

CREATE TABLE bi_export_jobs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  export_name VARCHAR(255) NOT NULL,
  export_type VARCHAR(50) NOT NULL, -- full, incremental
  data_source VARCHAR(100) NOT NULL,
  destination_type VARCHAR(50), -- s3, ftp, local
  destination_path VARCHAR(500),
  file_format VARCHAR(20) DEFAULT 'csv', -- csv, json, parquet
  status VARCHAR(50) DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  records_exported INTEGER DEFAULT 0,
  file_size_mb DECIMAL(10,2),
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  error_message TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE bi_data_snapshots (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  snapshot_name VARCHAR(255) NOT NULL,
  snapshot_date DATE NOT NULL,
  data_type VARCHAR(100) NOT NULL,
  data JSONB NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_bi_export_jobs_status ON bi_export_jobs(status);

-- =====================================================
-- 12. SYSTEM ADMIN & DEVOPS DASHBOARD
-- =====================================================

CREATE TABLE background_jobs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  job_name VARCHAR(255) NOT NULL,
  job_type VARCHAR(100) NOT NULL,
  status VARCHAR(50) DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  priority INTEGER DEFAULT 5,
  scheduled_at TIMESTAMP,
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  execution_time_ms INTEGER,
  error_message TEXT,
  retry_count INTEGER DEFAULT 0,
  max_retries INTEGER DEFAULT 3,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE email_queue (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  to_email VARCHAR(255) NOT NULL,
  cc_email VARCHAR(500),
  subject VARCHAR(500) NOT NULL,
  body_html TEXT NOT NULL,
  attachments JSONB,
  status VARCHAR(50) DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  sent_at TIMESTAMP,
  error_message TEXT,
  retry_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE system_health_metrics (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  metric_name VARCHAR(100) NOT NULL,
  metric_value DECIMAL(15,2) NOT NULL,
  metric_unit VARCHAR(50),
  status VARCHAR(50), -- healthy, warning, critical
  recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE backup_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  backup_type VARCHAR(50) NOT NULL, -- full, incremental
  backup_size_mb DECIMAL(10,2),
  backup_location VARCHAR(500),
  status VARCHAR(50) DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  error_message TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE storage_usage (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  storage_type VARCHAR(50) NOT NULL, -- database, files, logs
  used_space_mb DECIMAL(15,2) NOT NULL,
  total_space_mb DECIMAL(15,2),
  usage_percentage DECIMAL(5,2),
  recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_background_jobs_status ON background_jobs(status);
CREATE INDEX idx_email_queue_status ON email_queue(status);
CREATE INDEX idx_system_health_date ON system_health_metrics(recorded_at);

COMMIT;
