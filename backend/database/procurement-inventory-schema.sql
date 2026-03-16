-- =====================================================
-- PROCUREMENT & INVENTORY MODULE DATABASE SCHEMA
-- =====================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =====================================================
-- ITEM MASTER
-- =====================================================
CREATE TABLE inventory_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  item_code VARCHAR(50) UNIQUE NOT NULL,
  item_name VARCHAR(255) NOT NULL,
  item_type VARCHAR(50) NOT NULL, -- raw_material, finished_goods, consumable, spare
  barcode VARCHAR(100) UNIQUE,
  unit_of_measure VARCHAR(20) NOT NULL,
  parent_item_id UUID REFERENCES inventory_items(id), -- For variants
  variant_attributes JSONB, -- e.g. {"color": "red", "size": "L"}
  reorder_level DECIMAL(15,2) DEFAULT 0,
  standard_cost DECIMAL(15,2) DEFAULT 0,
  inventory_account_id UUID REFERENCES chart_of_accounts(id),
  expense_account_id UUID REFERENCES chart_of_accounts(id),
  description TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP
);

CREATE INDEX idx_items_code ON inventory_items(item_code);
CREATE INDEX idx_items_type ON inventory_items(item_type);
CREATE INDEX idx_items_active ON inventory_items(is_active);

-- =====================================================
-- WAREHOUSES
-- =====================================================
CREATE TABLE warehouses (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  warehouse_code VARCHAR(20) UNIQUE NOT NULL,
  warehouse_name VARCHAR(255) NOT NULL,
  location VARCHAR(255),
  manager_employee_id INTEGER,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP
);

CREATE INDEX idx_warehouses_active ON warehouses(is_active);

-- =====================================================
-- STOCK LEDGER (CORE TABLE)
-- =====================================================
CREATE TABLE stock_ledger (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  item_id UUID NOT NULL REFERENCES inventory_items(id),
  warehouse_id UUID NOT NULL REFERENCES warehouses(id),
  transaction_type VARCHAR(50) NOT NULL, -- purchase, consumption, transfer, adjustment, sale, return
  quantity_in DECIMAL(15,2) DEFAULT 0,
  quantity_out DECIMAL(15,2) DEFAULT 0,
  balance_qty DECIMAL(15,2) NOT NULL,
  rate DECIMAL(15,2) DEFAULT 0,
  value DECIMAL(15,2) DEFAULT 0,
  reference_type VARCHAR(50), -- grn, rm_issue, transfer, adjustment, delivery_note
  reference_id UUID,
  transaction_date DATE NOT NULL,
  remarks TEXT,
  created_by INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_stock_item ON stock_ledger(item_id);
CREATE INDEX idx_stock_warehouse ON stock_ledger(warehouse_id);
CREATE INDEX idx_stock_date ON stock_ledger(transaction_date);
CREATE INDEX idx_stock_reference ON stock_ledger(reference_type, reference_id);

-- =====================================================
-- PURCHASE REQUESTS (PR)
-- =====================================================
CREATE TABLE purchase_requests (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  request_number VARCHAR(50) UNIQUE NOT NULL,
  requested_by_employee_id INTEGER NOT NULL,
  department_id INTEGER,
  request_date DATE NOT NULL,
  required_date DATE,
  status VARCHAR(50) DEFAULT 'draft', -- draft, pending_approval, approved, rejected, converted_to_po
  approval_request_id UUID,
  approved_by INTEGER,
  approved_at TIMESTAMP,
  rejection_reason TEXT,
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP
);

CREATE INDEX idx_pr_status ON purchase_requests(status);
CREATE INDEX idx_pr_employee ON purchase_requests(requested_by_employee_id);
CREATE INDEX idx_pr_date ON purchase_requests(request_date);

-- =====================================================
-- PURCHASE REQUEST ITEMS
-- =====================================================
CREATE TABLE purchase_request_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  pr_id UUID NOT NULL REFERENCES purchase_requests(id) ON DELETE CASCADE,
  item_id UUID REFERENCES inventory_items(id),
  item_name VARCHAR(255) NOT NULL,
  quantity DECIMAL(15,2) NOT NULL,
  expected_price DECIMAL(15,2),
  required_date DATE,
  remarks TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_pr_items_pr ON purchase_request_items(pr_id);

-- =====================================================
-- PURCHASE ORDERS (PO)
-- =====================================================
CREATE TABLE purchase_orders (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  po_number VARCHAR(50) UNIQUE NOT NULL,
  pr_id UUID REFERENCES purchase_requests(id),
  supplier_id UUID NOT NULL REFERENCES parties(id),
  order_date DATE NOT NULL,
  expected_delivery_date DATE,
  status VARCHAR(50) DEFAULT 'draft', -- draft, sent, partially_received, completed, cancelled
  subtotal DECIMAL(15,2) DEFAULT 0,
  tax_amount DECIMAL(15,2) DEFAULT 0,
  total_amount DECIMAL(15,2) DEFAULT 0,
  terms_conditions TEXT,
  notes TEXT,
  created_by INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP
);

CREATE INDEX idx_po_status ON purchase_orders(status);
CREATE INDEX idx_po_supplier ON purchase_orders(supplier_id);
CREATE INDEX idx_po_date ON purchase_orders(order_date);

-- =====================================================
-- PURCHASE ORDER ITEMS
-- =====================================================
CREATE TABLE purchase_order_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  po_id UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES inventory_items(id),
  quantity DECIMAL(15,2) NOT NULL,
  received_quantity DECIMAL(15,2) DEFAULT 0,
  rate DECIMAL(15,2) NOT NULL,
  tax_rate DECIMAL(5,2) DEFAULT 0,
  tax_amount DECIMAL(15,2) DEFAULT 0,
  total_amount DECIMAL(15,2) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_po_items_po ON purchase_order_items(po_id);
CREATE INDEX idx_po_items_item ON purchase_order_items(item_id);

-- =====================================================
-- LOCAL PURCHASE REQUESTS
-- =====================================================
CREATE TABLE local_purchase_requests (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  request_number VARCHAR(50) UNIQUE NOT NULL,
  requested_by_employee_id INTEGER NOT NULL,
  request_date DATE NOT NULL,
  description TEXT NOT NULL,
  vendor_name_text VARCHAR(255),
  amount DECIMAL(15,2) NOT NULL,
  bill_status VARCHAR(50) DEFAULT 'without_bill', -- with_bill, without_bill, bill_pending
  approval_request_id UUID,
  approved_by INTEGER,
  approved_at TIMESTAMP,
  converted_to_supplier_bill BOOLEAN DEFAULT false,
  supplier_bill_id UUID,
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP
);

CREATE INDEX idx_lpr_status ON local_purchase_requests(bill_status);
CREATE INDEX idx_lpr_employee ON local_purchase_requests(requested_by_employee_id);

-- =====================================================
-- GOODS RECEIPT NOTE (GRN)
-- =====================================================
CREATE TABLE goods_receipt_notes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  grn_number VARCHAR(50) UNIQUE NOT NULL,
  po_id UUID NOT NULL REFERENCES purchase_orders(id),
  received_by INTEGER NOT NULL,
  received_date DATE NOT NULL,
  warehouse_id UUID NOT NULL REFERENCES warehouses(id),
  status VARCHAR(50) DEFAULT 'partial', -- partial, completed
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP
);

CREATE INDEX idx_grn_po ON goods_receipt_notes(po_id);
CREATE INDEX idx_grn_date ON goods_receipt_notes(received_date);
CREATE INDEX idx_grn_warehouse ON goods_receipt_notes(warehouse_id);

-- =====================================================
-- GRN ITEMS
-- =====================================================
CREATE TABLE grn_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  grn_id UUID NOT NULL REFERENCES goods_receipt_notes(id) ON DELETE CASCADE,
  po_item_id UUID NOT NULL REFERENCES purchase_order_items(id),
  item_id UUID NOT NULL REFERENCES inventory_items(id),
  quantity_received DECIMAL(15,2) NOT NULL,
  quantity_rejected DECIMAL(15,2) DEFAULT 0,
  rate DECIMAL(15,2) NOT NULL,
  remarks TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_grn_items_grn ON grn_items(grn_id);
CREATE INDEX idx_grn_items_item ON grn_items(item_id);

-- =====================================================
-- STOCK TRANSFERS
-- =====================================================
CREATE TABLE stock_transfers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  transfer_number VARCHAR(50) UNIQUE NOT NULL,
  from_warehouse_id UUID NOT NULL REFERENCES warehouses(id),
  to_warehouse_id UUID NOT NULL REFERENCES warehouses(id),
  transfer_date DATE NOT NULL,
  status VARCHAR(50) DEFAULT 'draft', -- draft, in_transit, completed
  transferred_by INTEGER,
  received_date DATE,
  received_by INTEGER,
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP
);

CREATE INDEX idx_transfer_from ON stock_transfers(from_warehouse_id);
CREATE INDEX idx_transfer_to ON stock_transfers(to_warehouse_id);
CREATE INDEX idx_transfer_date ON stock_transfers(transfer_date);

-- =====================================================
-- STOCK TRANSFER ITEMS
-- =====================================================
CREATE TABLE stock_transfer_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  transfer_id UUID NOT NULL REFERENCES stock_transfers(id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES inventory_items(id),
  quantity DECIMAL(15,2) NOT NULL,
  quantity_received DECIMAL(15,2) DEFAULT 0,
  quantity_rejected DECIMAL(15,2) DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_transfer_items_transfer ON stock_transfer_items(transfer_id);

-- =====================================================
-- STOCK ADJUSTMENTS
-- =====================================================
CREATE TABLE stock_adjustments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  adjustment_number VARCHAR(50) UNIQUE NOT NULL,
  warehouse_id UUID NOT NULL REFERENCES warehouses(id),
  adjustment_date DATE NOT NULL,
  adjustment_type VARCHAR(50) NOT NULL, -- increase, decrease
  reason TEXT NOT NULL,
  approved_by INTEGER,
  approved_at TIMESTAMP,
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP
);

CREATE INDEX idx_adjustment_warehouse ON stock_adjustments(warehouse_id);
CREATE INDEX idx_adjustment_date ON stock_adjustments(adjustment_date);

-- =====================================================
-- STOCK ADJUSTMENT ITEMS
-- =====================================================
CREATE TABLE stock_adjustment_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  adjustment_id UUID NOT NULL REFERENCES stock_adjustments(id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES inventory_items(id),
  quantity DECIMAL(15,2) NOT NULL,
  remarks TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_adjustment_items_adj ON stock_adjustment_items(adjustment_id);

-- =====================================================
-- RM CONSUMPTION / ISSUE
-- =====================================================
CREATE TABLE rm_issues (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  issue_number VARCHAR(50) UNIQUE NOT NULL,
  department_id INTEGER,
  issued_by INTEGER NOT NULL,
  issue_date DATE NOT NULL,
  warehouse_id UUID NOT NULL REFERENCES warehouses(id),
  purpose TEXT,
  approval_request_id UUID,
  approved_by INTEGER,
  approved_at TIMESTAMP,
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP
);

CREATE INDEX idx_rm_issue_dept ON rm_issues(department_id);
CREATE INDEX idx_rm_issue_date ON rm_issues(issue_date);
CREATE INDEX idx_rm_issue_warehouse ON rm_issues(warehouse_id);

-- =====================================================
-- RM ISSUE ITEMS
-- =====================================================
CREATE TABLE rm_issue_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  issue_id UUID NOT NULL REFERENCES rm_issues(id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES inventory_items(id),
  quantity DECIMAL(15,2) NOT NULL,
  rate DECIMAL(15,2),
  remarks TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_rm_issue_items_issue ON rm_issue_items(issue_id);
CREATE INDEX idx_rm_issue_items_item ON rm_issue_items(item_id);

-- =====================================================
-- DELIVERY NOTES
-- =====================================================
CREATE TABLE delivery_notes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  delivery_note_number VARCHAR(50) UNIQUE NOT NULL,
  customer_id UUID REFERENCES parties(id),
  delivery_date DATE NOT NULL,
  warehouse_id UUID NOT NULL REFERENCES warehouses(id),
  status VARCHAR(50) DEFAULT 'draft', -- draft, dispatched, delivered
  dispatched_by INTEGER,
  vehicle_number VARCHAR(50),
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP
);

CREATE INDEX idx_delivery_customer ON delivery_notes(customer_id);
CREATE INDEX idx_delivery_date ON delivery_notes(delivery_date);
CREATE INDEX idx_delivery_status ON delivery_notes(status);

-- =====================================================
-- DELIVERY NOTE ITEMS
-- =====================================================
CREATE TABLE delivery_note_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  delivery_note_id UUID NOT NULL REFERENCES delivery_notes(id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES inventory_items(id),
  quantity DECIMAL(15,2) NOT NULL,
  rate DECIMAL(15,2),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_delivery_items_dn ON delivery_note_items(delivery_note_id);
CREATE INDEX idx_delivery_items_item ON delivery_note_items(item_id);

-- =====================================================
-- INITIAL DATA
-- =====================================================
INSERT INTO warehouses (warehouse_code, warehouse_name, location) VALUES
('WH001', 'Main Warehouse', 'Head Office'),
('WH002', 'Production Warehouse', 'Factory Floor'),
('WH003', 'Finished Goods Warehouse', 'Dispatch Area');
