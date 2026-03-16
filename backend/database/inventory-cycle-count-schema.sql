-- =====================================================
-- CYCLE COUNTING / PHYSICAL STOCK AUDIT MODULE
-- =====================================================

-- Main table to manage a counting session
CREATE TABLE inventory_physical_counts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  count_number VARCHAR(50) UNIQUE NOT NULL,
  warehouse_id UUID NOT NULL REFERENCES warehouses(id),
  count_date DATE NOT NULL,
  status VARCHAR(50) DEFAULT 'draft', -- draft, in_progress, pending_approval, completed, cancelled
  counted_by INTEGER,
  approved_by INTEGER,
  approved_at TIMESTAMP,
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_phys_count_warehouse ON inventory_physical_counts(warehouse_id);
CREATE INDEX idx_phys_count_status ON inventory_physical_counts(status);

-- Table to store the details of each item counted
CREATE TABLE inventory_physical_count_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  physical_count_id UUID NOT NULL REFERENCES inventory_physical_counts(id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES inventory_items(id),
  batch_id UUID REFERENCES inventory_batches(id), -- Optional, for batch-wise counting
  system_quantity DECIMAL(15,2) NOT NULL,
  physical_quantity DECIMAL(15,2) NOT NULL,
  variance_quantity DECIMAL(15,2) GENERATED ALWAYS AS (physical_quantity - system_quantity) STORED,
  unit_cost DECIMAL(15,2),
  variance_value DECIMAL(15,2) GENERATED ALWAYS AS ((physical_quantity - system_quantity) * unit_cost) STORED,
  reason TEXT, -- Reason for variance
  is_adjusted BOOLEAN DEFAULT false, -- Flag to check if stock adjustment is created
  adjustment_id UUID REFERENCES stock_adjustments(id),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_phys_count_items_count ON inventory_physical_count_items(physical_count_id);
CREATE INDEX idx_phys_count_items_item ON inventory_physical_count_items(item_id);