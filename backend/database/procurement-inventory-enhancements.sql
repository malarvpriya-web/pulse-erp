-- =====================================================
-- PROCUREMENT & INVENTORY ENTERPRISE ENHANCEMENTS
-- =====================================================

-- =====================================================
-- 1. UNIT OF MEASURE CONVERSIONS
-- =====================================================
CREATE TABLE uom_conversions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  item_id UUID REFERENCES inventory_items(id), -- Null means global conversion
  from_uom VARCHAR(20) NOT NULL,
  to_uom VARCHAR(20) NOT NULL,
  conversion_factor DECIMAL(15,4) NOT NULL, -- Multiply 'from' by this to get 'to'
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(item_id, from_uom, to_uom)
);

-- =====================================================
-- 2. PURCHASE RETURNS (RTV - Return to Vendor)
-- =====================================================
CREATE TABLE purchase_returns (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  return_number VARCHAR(50) UNIQUE NOT NULL,
  po_id UUID REFERENCES purchase_orders(id),
  supplier_id UUID NOT NULL REFERENCES parties(id),
  warehouse_id UUID NOT NULL REFERENCES warehouses(id),
  return_date DATE NOT NULL,
  status VARCHAR(50) DEFAULT 'draft', -- draft, approved, shipped, completed
  reason_category VARCHAR(100), -- damaged, wrong_item, excess
  total_amount DECIMAL(15,2) DEFAULT 0,
  notes TEXT,
  created_by INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE purchase_return_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  return_id UUID NOT NULL REFERENCES purchase_returns(id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES inventory_items(id),
  batch_id UUID REFERENCES inventory_batches(id),
  quantity DECIMAL(15,2) NOT NULL,
  rate DECIMAL(15,2) NOT NULL,
  amount DECIMAL(15,2) GENERATED ALWAYS AS (quantity * rate) STORED,
  remarks TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- =====================================================
-- 3. SALES RETURNS (RMA - Return Merchandise Auth)
-- =====================================================
CREATE TABLE sales_returns (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  rma_number VARCHAR(50) UNIQUE NOT NULL,
  customer_id UUID NOT NULL REFERENCES parties(id),
  original_order_id UUID REFERENCES sales_orders(id),
  warehouse_id UUID REFERENCES warehouses(id), -- Where to receive return
  return_date DATE NOT NULL,
  status VARCHAR(50) DEFAULT 'requested', -- requested, approved, received, rejected, completed
  total_refund_amount DECIMAL(15,2) DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE sales_return_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  return_id UUID NOT NULL REFERENCES sales_returns(id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES inventory_items(id),
  quantity DECIMAL(15,2) NOT NULL,
  return_reason VARCHAR(100),
  condition VARCHAR(50) DEFAULT 'sellable', -- sellable, damaged, scrap, quarantine
  restocking_fee DECIMAL(15,2) DEFAULT 0,
  refund_amount DECIMAL(15,2) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- =====================================================
-- 4. LANDED COST ALLOCATION
-- =====================================================
CREATE TABLE landed_costs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  voucher_number VARCHAR(50) UNIQUE NOT NULL,
  grn_id UUID NOT NULL REFERENCES goods_receipt_notes(id),
  cost_type VARCHAR(50) NOT NULL, -- freight, customs, insurance, handling
  amount DECIMAL(15,2) NOT NULL,
  currency VARCHAR(10) DEFAULT 'USD',
  exchange_rate DECIMAL(15,6) DEFAULT 1,
  allocation_method VARCHAR(50) DEFAULT 'value', -- value, quantity, weight
  vendor_id UUID REFERENCES parties(id), -- Service provider (e.g., FedEx)
  bill_reference VARCHAR(100),
  status VARCHAR(50) DEFAULT 'draft', -- draft, allocated, posted
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- =====================================================
-- 5. PROCUREMENT APPROVAL MATRIX
-- =====================================================
CREATE TABLE procurement_approval_rules (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  rule_name VARCHAR(100) NOT NULL,
  department_id INTEGER, -- Null means all departments
  category_id UUID, -- Null means all categories (link to expense_categories or item groups)
  min_amount DECIMAL(15,2) DEFAULT 0,
  max_amount DECIMAL(15,2), -- Null means unlimited
  approver_role VARCHAR(50), -- e.g., 'Manager', 'Director', 'CFO'
  approver_user_id INTEGER, -- Specific user override
  priority INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- =====================================================
-- 6. DOCUMENT ATTACHMENTS
-- =====================================================
CREATE TABLE document_attachments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  reference_type VARCHAR(50) NOT NULL, -- PO, PR, GRN, RTV, RMA
  reference_id UUID NOT NULL,
  file_name VARCHAR(255) NOT NULL,
  file_url VARCHAR(500) NOT NULL,
  file_type VARCHAR(50),
  file_size INTEGER,
  uploaded_by INTEGER,
  uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_attachments_ref ON document_attachments(reference_type, reference_id);

-- =====================================================
-- 7. ANALYTICS VIEWS
-- =====================================================

-- View: Supplier Performance (Lead Time & Reliability)
CREATE OR REPLACE VIEW v_supplier_performance AS
SELECT 
  p.id as supplier_id,
  p.party_name as supplier_name,
  COUNT(DISTINCT po.id) as total_orders,
  AVG(grn.received_date - po.order_date) as avg_lead_time_days,
  SUM(CASE WHEN grn.received_date <= po.expected_delivery_date THEN 1 ELSE 0 END)::FLOAT / 
    NULLIF(COUNT(DISTINCT po.id), 0) * 100 as on_time_delivery_rate,
  SUM(gi.quantity_rejected) as total_rejected_qty,
  SUM(gi.quantity_received) as total_received_qty,
  (SUM(gi.quantity_rejected) / NULLIF(SUM(gi.quantity_received), 0) * 100) as defect_rate
FROM purchase_orders po
JOIN parties p ON po.supplier_id = p.id
JOIN goods_receipt_notes grn ON grn.po_id = po.id
JOIN grn_items gi ON gi.grn_id = grn.id
WHERE po.status = 'completed'
GROUP BY p.id, p.party_name;

-- View: Inventory Valuation (FIFO/Avg Cost approximation)
CREATE OR REPLACE VIEW v_inventory_valuation AS
SELECT 
  ii.id as item_id,
  ii.item_code,
  ii.item_name,
  w.warehouse_name,
  COALESCE(SUM(sl.quantity_in - sl.quantity_out), 0) as current_stock,
  -- Weighted Average Cost Calculation
  CASE 
    WHEN SUM(sl.quantity_in - sl.quantity_out) = 0 THEN 0
    ELSE SUM(sl.value) / NULLIF(SUM(sl.quantity_in - sl.quantity_out), 0) -- Simplified WAC
  END as avg_unit_cost,
  SUM(sl.value) as total_value
FROM inventory_items ii
CROSS JOIN warehouses w
JOIN stock_ledger sl ON sl.item_id = ii.id AND sl.warehouse_id = w.id
GROUP BY ii.id, ii.item_code, ii.item_name, w.warehouse_name;

-- View: Stock In Transit
CREATE OR REPLACE VIEW v_stock_in_transit AS
SELECT 
  st.id as transfer_id,
  st.transfer_number,
  st.transfer_date,
  wf.warehouse_name as from_warehouse,
  wt.warehouse_name as to_warehouse,
  ii.item_code,
  ii.item_name,
  sti.quantity as shipped_qty,
  sti.quantity_received,
  (sti.quantity - COALESCE(sti.quantity_received, 0)) as in_transit_qty
FROM stock_transfers st
JOIN stock_transfer_items sti ON sti.transfer_id = st.id
JOIN inventory_items ii ON sti.item_id = ii.id
JOIN warehouses wf ON st.from_warehouse_id = wf.id
JOIN warehouses wt ON st.to_warehouse_id = wt.id
WHERE st.status = 'in_transit';

-- =====================================================
-- 8. TRIGGERS FOR STATUS UPDATES
-- =====================================================

-- Auto-update Stock Transfer status when fully received
CREATE OR REPLACE FUNCTION check_transfer_completion()
RETURNS TRIGGER AS $$
DECLARE
  v_total_shipped DECIMAL;
  v_total_received DECIMAL;
BEGIN
  SELECT SUM(quantity), SUM(quantity_received)
  INTO v_total_shipped, v_total_received
  FROM stock_transfer_items
  WHERE transfer_id = NEW.transfer_id;

  IF v_total_received >= v_total_shipped THEN
    UPDATE stock_transfers SET status = 'completed', received_date = CURRENT_DATE 
    WHERE id = NEW.transfer_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_check_transfer_completion
AFTER UPDATE ON stock_transfer_items
FOR EACH ROW
EXECUTE FUNCTION check_transfer_completion();