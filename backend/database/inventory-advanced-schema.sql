-- =====================================================
-- ADVANCED INVENTORY CONTROL ENHANCEMENTS
-- =====================================================

-- =====================================================
-- INVENTORY BATCHES (Material Traceability)
-- =====================================================
CREATE TABLE inventory_batches (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  item_id UUID NOT NULL REFERENCES inventory_items(id),
  warehouse_id UUID NOT NULL REFERENCES warehouses(id),
  batch_number VARCHAR(100) NOT NULL,
  barcode VARCHAR(100) UNIQUE,
  received_date DATE NOT NULL,
  expiry_date DATE,
  supplier_id UUID REFERENCES parties(id),
  grn_id UUID REFERENCES goods_receipt_notes(id),
  quantity_received DECIMAL(15,2) NOT NULL,
  quantity_available DECIMAL(15,2) NOT NULL,
  quantity_reserved DECIMAL(15,2) DEFAULT 0,
  quantity_consumed DECIMAL(15,2) DEFAULT 0,
  rate DECIMAL(15,2) NOT NULL,
  status VARCHAR(50) DEFAULT 'active', -- active, expired, depleted
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(item_id, warehouse_id, batch_number)
);

CREATE INDEX idx_batches_item ON inventory_batches(item_id);
CREATE INDEX idx_batches_warehouse ON inventory_batches(warehouse_id);
CREATE INDEX idx_batches_status ON inventory_batches(status);
CREATE INDEX idx_batches_expiry ON inventory_batches(expiry_date);

-- =====================================================
-- INVENTORY ALLOCATIONS (Track where materials are used)
-- =====================================================
CREATE TABLE inventory_allocations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  item_id UUID NOT NULL REFERENCES inventory_items(id),
  batch_id UUID REFERENCES inventory_batches(id),
  warehouse_id UUID NOT NULL REFERENCES warehouses(id),
  allocation_type VARCHAR(50) NOT NULL, -- project, department, sales, service, production
  reference_type VARCHAR(50), -- project_id, department_id, sales_order_id, service_ticket_id
  reference_id UUID,
  quantity DECIMAL(15,2) NOT NULL,
  rate DECIMAL(15,2),
  allocation_date DATE NOT NULL,
  allocated_by INTEGER,
  purpose TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_allocations_item ON inventory_allocations(item_id);
CREATE INDEX idx_allocations_type ON inventory_allocations(allocation_type);
CREATE INDEX idx_allocations_reference ON inventory_allocations(reference_type, reference_id);
CREATE INDEX idx_allocations_date ON inventory_allocations(allocation_date);

-- =====================================================
-- INVENTORY RESERVATIONS (Stock Reservation System)
-- =====================================================
CREATE TABLE inventory_reservations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  item_id UUID NOT NULL REFERENCES inventory_items(id),
  warehouse_id UUID NOT NULL REFERENCES warehouses(id),
  batch_id UUID REFERENCES inventory_batches(id),
  reservation_type VARCHAR(50) NOT NULL, -- project, sales_order, production_order, service
  reference_type VARCHAR(50) NOT NULL,
  reference_id UUID NOT NULL,
  reference_number VARCHAR(100),
  quantity_reserved DECIMAL(15,2) NOT NULL,
  quantity_consumed DECIMAL(15,2) DEFAULT 0,
  quantity_remaining DECIMAL(15,2) NOT NULL,
  reserved_date DATE NOT NULL,
  expiry_date DATE,
  status VARCHAR(50) DEFAULT 'active', -- active, partially_consumed, fully_consumed, cancelled, expired
  reserved_by INTEGER,
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_reservations_item ON inventory_reservations(item_id);
CREATE INDEX idx_reservations_warehouse ON inventory_reservations(warehouse_id);
CREATE INDEX idx_reservations_status ON inventory_reservations(status);
CREATE INDEX idx_reservations_reference ON inventory_reservations(reference_type, reference_id);

-- =====================================================
-- STOCK ALERTS (Minimum Stock Alert Engine)
-- =====================================================
CREATE TABLE stock_alerts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  item_id UUID NOT NULL REFERENCES inventory_items(id),
  warehouse_id UUID NOT NULL REFERENCES warehouses(id),
  alert_type VARCHAR(50) NOT NULL, -- low_stock, out_of_stock, expiring_soon, expired
  current_stock DECIMAL(15,2),
  available_stock DECIMAL(15,2),
  reserved_stock DECIMAL(15,2),
  reorder_level DECIMAL(15,2),
  alert_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  status VARCHAR(50) DEFAULT 'active', -- active, acknowledged, resolved
  acknowledged_by INTEGER,
  acknowledged_at TIMESTAMP,
  resolved_at TIMESTAMP,
  notes TEXT
);

CREATE INDEX idx_alerts_item ON stock_alerts(item_id);
CREATE INDEX idx_alerts_status ON stock_alerts(status);
CREATE INDEX idx_alerts_type ON stock_alerts(alert_type);
CREATE INDEX idx_alerts_date ON stock_alerts(alert_date);

-- =====================================================
-- PURCHASE SUGGESTIONS (Auto-generated)
-- =====================================================
CREATE TABLE purchase_suggestions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  item_id UUID NOT NULL REFERENCES inventory_items(id),
  warehouse_id UUID NOT NULL REFERENCES warehouses(id),
  current_stock DECIMAL(15,2) NOT NULL,
  available_stock DECIMAL(15,2) NOT NULL,
  reserved_stock DECIMAL(15,2) NOT NULL,
  reorder_level DECIMAL(15,2) NOT NULL,
  suggested_quantity DECIMAL(15,2) NOT NULL,
  priority VARCHAR(20) DEFAULT 'medium', -- high, medium, low
  status VARCHAR(50) DEFAULT 'pending', -- pending, converted_to_pr, rejected
  generated_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  converted_to_pr_id UUID REFERENCES purchase_requests(id),
  converted_at TIMESTAMP,
  rejected_by INTEGER,
  rejected_at TIMESTAMP,
  rejection_reason TEXT
);

CREATE INDEX idx_suggestions_item ON purchase_suggestions(item_id);
CREATE INDEX idx_suggestions_status ON purchase_suggestions(status);
CREATE INDEX idx_suggestions_priority ON purchase_suggestions(priority);

-- =====================================================
-- STOCK AGING REPORT DATA
-- =====================================================
CREATE TABLE stock_aging_snapshots (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  item_id UUID NOT NULL REFERENCES inventory_items(id),
  warehouse_id UUID NOT NULL REFERENCES warehouses(id),
  batch_id UUID REFERENCES inventory_batches(id),
  quantity DECIMAL(15,2) NOT NULL,
  value DECIMAL(15,2) NOT NULL,
  age_days INTEGER NOT NULL,
  age_category VARCHAR(50), -- 0-30, 31-60, 61-90, 91-180, 180+
  snapshot_date DATE NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_aging_item ON stock_aging_snapshots(item_id);
CREATE INDEX idx_aging_date ON stock_aging_snapshots(snapshot_date);
CREATE INDEX idx_aging_category ON stock_aging_snapshots(age_category);

-- =====================================================
-- FUNCTIONS & TRIGGERS
-- =====================================================

-- Function to calculate available stock
CREATE OR REPLACE FUNCTION calculate_available_stock(
  p_item_id UUID,
  p_warehouse_id UUID
) RETURNS DECIMAL(15,2) AS $$
DECLARE
  v_total_stock DECIMAL(15,2);
  v_reserved_stock DECIMAL(15,2);
BEGIN
  -- Get total stock from batches
  SELECT COALESCE(SUM(quantity_available), 0)
  INTO v_total_stock
  FROM inventory_batches
  WHERE item_id = p_item_id 
    AND warehouse_id = p_warehouse_id
    AND status = 'active';
  
  -- Get reserved stock
  SELECT COALESCE(SUM(quantity_remaining), 0)
  INTO v_reserved_stock
  FROM inventory_reservations
  WHERE item_id = p_item_id 
    AND warehouse_id = p_warehouse_id
    AND status = 'active';
  
  RETURN v_total_stock - v_reserved_stock;
END;
$$ LANGUAGE plpgsql;

-- Function to check and generate stock alerts
CREATE OR REPLACE FUNCTION check_stock_alerts()
RETURNS TRIGGER AS $$
DECLARE
  v_available_stock DECIMAL(15,2);
  v_reserved_stock DECIMAL(15,2);
  v_reorder_level DECIMAL(15,2);
  v_alert_exists BOOLEAN;
BEGIN
  -- Calculate available stock
  v_available_stock := calculate_available_stock(NEW.item_id, NEW.warehouse_id);
  
  -- Get reserved stock
  SELECT COALESCE(SUM(quantity_remaining), 0)
  INTO v_reserved_stock
  FROM inventory_reservations
  WHERE item_id = NEW.item_id 
    AND warehouse_id = NEW.warehouse_id
    AND status = 'active';
  
  -- Get reorder level
  SELECT reorder_level INTO v_reorder_level
  FROM inventory_items WHERE id = NEW.item_id;
  
  -- Check if alert already exists
  SELECT EXISTS(
    SELECT 1 FROM stock_alerts
    WHERE item_id = NEW.item_id
      AND warehouse_id = NEW.warehouse_id
      AND status = 'active'
      AND alert_type = 'low_stock'
  ) INTO v_alert_exists;
  
  -- Generate alert if below reorder level and no active alert exists
  IF v_available_stock <= v_reorder_level AND NOT v_alert_exists THEN
    INSERT INTO stock_alerts (
      item_id, warehouse_id, alert_type,
      current_stock, available_stock, reserved_stock, reorder_level
    ) VALUES (
      NEW.item_id, NEW.warehouse_id, 'low_stock',
      v_available_stock + v_reserved_stock, v_available_stock, v_reserved_stock, v_reorder_level
    );
    
    -- Auto-generate purchase suggestion
    INSERT INTO purchase_suggestions (
      item_id, warehouse_id, current_stock, available_stock,
      reserved_stock, reorder_level, suggested_quantity, priority
    ) VALUES (
      NEW.item_id, NEW.warehouse_id,
      v_available_stock + v_reserved_stock, v_available_stock,
      v_reserved_stock, v_reorder_level,
      v_reorder_level * 2 - v_available_stock,
      CASE WHEN v_available_stock <= 0 THEN 'high' ELSE 'medium' END
    );
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger on batch updates
CREATE TRIGGER trigger_check_stock_alerts
AFTER INSERT OR UPDATE ON inventory_batches
FOR EACH ROW
EXECUTE FUNCTION check_stock_alerts();

-- Function to update batch quantities on reservation
CREATE OR REPLACE FUNCTION update_batch_on_reservation()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE inventory_batches
    SET quantity_reserved = quantity_reserved + NEW.quantity_reserved,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = NEW.batch_id;
  ELSIF TG_OP = 'UPDATE' THEN
    UPDATE inventory_batches
    SET quantity_reserved = quantity_reserved - OLD.quantity_reserved + NEW.quantity_reserved,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = NEW.batch_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE inventory_batches
    SET quantity_reserved = quantity_reserved - OLD.quantity_reserved,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = OLD.batch_id;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_batch_reservation
AFTER INSERT OR UPDATE OR DELETE ON inventory_reservations
FOR EACH ROW
WHEN (NEW.batch_id IS NOT NULL OR OLD.batch_id IS NOT NULL)
EXECUTE FUNCTION update_batch_on_reservation();

-- Function to check expiring batches
CREATE OR REPLACE FUNCTION check_expiring_batches()
RETURNS void AS $$
BEGIN
  -- Mark expired batches
  UPDATE inventory_batches
  SET status = 'expired'
  WHERE expiry_date < CURRENT_DATE
    AND status = 'active';
  
  -- Generate alerts for expiring batches (within 30 days)
  INSERT INTO stock_alerts (item_id, warehouse_id, alert_type, current_stock, notes)
  SELECT 
    item_id, warehouse_id, 'expiring_soon', quantity_available,
    'Batch ' || batch_number || ' expires on ' || expiry_date
  FROM inventory_batches
  WHERE expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '30 days'
    AND status = 'active'
    AND NOT EXISTS (
      SELECT 1 FROM stock_alerts sa
      WHERE sa.item_id = inventory_batches.item_id
        AND sa.warehouse_id = inventory_batches.warehouse_id
        AND sa.alert_type = 'expiring_soon'
        AND sa.status = 'active'
    );
END;
$$ LANGUAGE plpgsql;

-- =====================================================
-- VIEWS FOR REPORTING
-- =====================================================

-- Current Stock Summary with Reservations
CREATE OR REPLACE VIEW v_stock_summary AS
SELECT 
  ii.id as item_id,
  ii.item_code,
  ii.item_name,
  ii.unit_of_measure,
  ii.reorder_level,
  w.id as warehouse_id,
  w.warehouse_name,
  COALESCE(SUM(ib.quantity_available), 0) as total_stock,
  COALESCE(SUM(ib.quantity_reserved), 0) as reserved_stock,
  COALESCE(SUM(ib.quantity_available), 0) - COALESCE(SUM(ib.quantity_reserved), 0) as available_stock,
  CASE 
    WHEN COALESCE(SUM(ib.quantity_available), 0) - COALESCE(SUM(ib.quantity_reserved), 0) <= 0 THEN 'out_of_stock'
    WHEN COALESCE(SUM(ib.quantity_available), 0) - COALESCE(SUM(ib.quantity_reserved), 0) <= ii.reorder_level THEN 'low_stock'
    ELSE 'in_stock'
  END as stock_status
FROM inventory_items ii
CROSS JOIN warehouses w
LEFT JOIN inventory_batches ib ON ib.item_id = ii.id AND ib.warehouse_id = w.id AND ib.status = 'active'
WHERE ii.is_active = true AND w.is_active = true
GROUP BY ii.id, ii.item_code, ii.item_name, ii.unit_of_measure, ii.reorder_level, w.id, w.warehouse_name;

-- Batch-wise Stock
CREATE OR REPLACE VIEW v_batch_stock AS
SELECT 
  ib.id as batch_id,
  ib.batch_number,
  ii.item_code,
  ii.item_name,
  w.warehouse_name,
  ib.received_date,
  ib.expiry_date,
  CURRENT_DATE - ib.received_date as age_days,
  p.party_name as supplier_name,
  ib.quantity_received,
  ib.quantity_available,
  ib.quantity_reserved,
  ib.quantity_available - ib.quantity_reserved as available_for_use,
  ib.quantity_consumed,
  ib.rate,
  ib.quantity_available * ib.rate as stock_value,
  ib.status
FROM inventory_batches ib
JOIN inventory_items ii ON ib.item_id = ii.id
JOIN warehouses w ON ib.warehouse_id = w.id
LEFT JOIN parties p ON ib.supplier_id = p.id;

-- Material Consumption by Project
CREATE OR REPLACE VIEW v_material_consumption_by_project AS
SELECT 
  ia.reference_id as project_id,
  ii.item_code,
  ii.item_name,
  ii.unit_of_measure,
  SUM(ia.quantity) as total_consumed,
  AVG(ia.rate) as avg_rate,
  SUM(ia.quantity * ia.rate) as total_value,
  COUNT(*) as transaction_count
FROM inventory_allocations ia
JOIN inventory_items ii ON ia.item_id = ii.id
WHERE ia.allocation_type = 'project'
GROUP BY ia.reference_id, ii.item_code, ii.item_name, ii.unit_of_measure;

COMMIT;
