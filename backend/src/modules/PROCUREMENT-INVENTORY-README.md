# Procurement & Inventory Management Module

## Overview
Enterprise-grade procurement and inventory management system with complete workflow automation, stock tracking, and financial integration.

## Module Architecture

### Backend Structure
```
backend/src/modules/
├── procurement/
│   ├── routes/
│   ├── controllers/
│   ├── services/
│   └── repositories/
├── inventory/
│   ├── routes/
│   ├── controllers/
│   ├── services/
│   └── repositories/
└── shared/
    └── db.js
```

## PROCUREMENT MODULE

### 1. Purchase Request (PR)
**Workflow**: Employee Request → Approval → Convert to PO

**Features**:
- Multi-item purchase requests
- Department-wise tracking
- Approval workflow integration
- Expected price tracking
- Required date management

**API Endpoints**:
```
POST /api/procurement/purchase-requests
GET /api/procurement/purchase-requests
GET /api/procurement/purchase-requests/:id
PUT /api/procurement/purchase-requests/:id/approve
```

### 2. Purchase Order (PO)
**Workflow**: Create from PR → Send to Supplier → Receive Goods

**Features**:
- Supplier integration (from finance parties)
- Multi-item orders
- Tax calculation
- Delivery tracking
- Status management (draft, sent, partially_received, completed, cancelled)

**API Endpoints**:
```
POST /api/procurement/purchase-orders
GET /api/procurement/purchase-orders
GET /api/procurement/purchase-orders/:id
PUT /api/procurement/purchase-orders/:id/status
```

### 3. Goods Receipt Note (GRN)
**Workflow**: Receive Goods → Update Stock → Update PO Status

**Features**:
- Automatic stock ledger creation
- Quality rejection tracking
- Warehouse assignment
- PO completion tracking
- Partial/full receipt support

**API Endpoints**:
```
POST /api/procurement/grn
GET /api/procurement/grn
GET /api/procurement/grn/:id
```

**Automatic Actions**:
- Creates stock ledger entry (quantity_in)
- Updates PO item received quantity
- Changes PO status to completed when fully received
- Updates inventory balance

### 4. Local Purchase Request
**Features**:
- Emergency purchases without formal PO
- Bill status tracking (with_bill, without_bill, bill_pending)
- Vendor name as text (no master required)
- Approval workflow ready

**API Endpoints**:
```
POST /api/procurement/local-purchase
GET /api/procurement/local-purchase
```

### 5. Procurement Dashboard
**Metrics**:
- Pending PRs count
- Pending POs count
- Late deliveries
- Monthly purchase value

**API Endpoint**:
```
GET /api/procurement/dashboard
```

## INVENTORY MODULE

### 1. Item Master
**Features**:
- Item code auto-generation (ITEM0001, ITEM0002...)
- Item types: raw_material, finished_goods, consumable, spare
- Unit of measure
- Reorder level tracking
- Standard cost
- Finance account linking (inventory & expense accounts)

**API Endpoints**:
```
POST /api/inventory/items
GET /api/inventory/items
GET /api/inventory/items/:id
PUT /api/inventory/items/:id
```

### 2. Warehouses
**Features**:
- Multiple warehouse support
- Location tracking
- Manager assignment

**API Endpoint**:
```
GET /api/inventory/warehouses
```

### 3. Stock Ledger (Core Table)
**Purpose**: Tracks every stock movement

**Transaction Types**:
- purchase (from GRN)
- consumption (from RM Issue)
- transfer (warehouse to warehouse)
- adjustment (manual corrections)
- sale (from delivery note)
- return

**Features**:
- Running balance calculation
- Rate tracking
- Value calculation
- Reference linking (grn, rm_issue, transfer, etc.)

**Stock Summary API**:
```
GET /api/inventory/stock/summary?warehouse_id=&item_type=
```

**Returns**:
- Item-wise, warehouse-wise stock
- Balance quantity
- Average rate
- Total value

### 4. Stock Transfers
**Workflow**: From Warehouse → To Warehouse

**Features**:
- Multi-item transfers
- Automatic stock ledger entries (out from source, in to destination)
- Status tracking (draft, in_transit, completed)

**API Endpoints**:
```
POST /api/inventory/stock-transfers
GET /api/inventory/stock-transfers
```

### 5. Stock Adjustments
**Purpose**: Manual stock corrections for audits

**Features**:
- Increase/decrease adjustments
- Reason tracking
- Approval workflow ready
- Automatic stock ledger update

**API Endpoint**:
```
POST /api/inventory/stock-adjustments
```

### 6. RM Consumption / Issue
**Workflow**: Department Request → Approval → Issue from Warehouse

**Features**:
- Stock availability check
- Automatic stock reduction
- Department-wise tracking
- Purpose documentation
- Rate tracking for expense booking

**API Endpoints**:
```
POST /api/inventory/rm-issues
GET /api/inventory/rm-issues
GET /api/inventory/rm-issues/:id
```

**Automatic Actions**:
- Checks stock availability
- Creates stock ledger entry (quantity_out)
- Reduces inventory balance
- Ready for expense journal entry creation

### 7. Delivery Notes
**Purpose**: Track outgoing finished goods

**Features**:
- Customer linking
- Multi-item dispatch
- Warehouse tracking
- Vehicle number
- Status management (draft, dispatched, delivered)

**Future Ready**: Cost of goods sold (COGS) calculation

### 8. Inventory Analytics

**Low Stock Alerts**:
```
GET /api/inventory/stock/low-stock
```
Returns items where balance <= reorder_level

**Stock Movement**:
```
GET /api/inventory/stock/movement?item_id=&warehouse_id=&start_date=&end_date=
```
Returns all transactions for an item in a warehouse

**Inventory Valuation**:
```
GET /api/inventory/stock/valuation?warehouse_id=
```
Returns total inventory value by item

**Consumption Trends**:
```
GET /api/inventory/analytics/consumption-trends?start_date=&end_date=
```
Returns RM consumption analysis

**Dashboard**:
```
GET /api/inventory/dashboard
```
Returns:
- Total items count
- Low stock items count
- Total inventory value

## Database Schema

### Key Tables
1. **inventory_items** - Item master
2. **warehouses** - Warehouse master
3. **stock_ledger** - Core stock tracking (every movement)
4. **purchase_requests** + items
5. **purchase_orders** + items
6. **goods_receipt_notes** + items
7. **local_purchase_requests**
8. **rm_issues** + items
9. **stock_transfers** + items
10. **stock_adjustments** + items
11. **delivery_notes** + items

### UUID Primary Keys
All tables use UUID for scalability and distributed systems support.

### Soft Delete
All master tables have `deleted_at` column for data retention.

### Audit Trail
- created_at, updated_at timestamps
- created_by user tracking
- Stock ledger maintains complete history

### Indexing
- Foreign keys indexed
- Date columns indexed
- Status columns indexed
- Reference type/ID composite indexes

## Finance Integration

### Automatic Journal Entries

**1. Goods Receipt (GRN)**
```
DR: Inventory Asset (increase)
CR: Accounts Payable (supplier bill pending)
```

**2. RM Consumption**
```
DR: Expense Account (department expense)
CR: Inventory Asset (decrease)
```

**3. Stock Adjustments**
```
Increase:
DR: Inventory Asset
CR: Adjustment Account

Decrease:
DR: Loss/Shortage Account
CR: Inventory Asset
```

**4. Delivery Note (Future)**
```
DR: Cost of Goods Sold
CR: Inventory Asset
```

## Frontend Pages

### Procurement Module
1. **Purchase Requests** - Create and approve PRs
2. **Purchase Orders** - Create POs from PRs
3. **Goods Receipt** - Receive goods and update stock
4. **Local Purchase** - Emergency purchases

### Inventory Module
1. **Items Master** - Manage inventory items
2. **Stock Summary** - View stock by warehouse
3. **RM Issues** - Issue raw materials
4. **Stock Transfers** - Transfer between warehouses
5. **Stock Adjustments** - Manual corrections

## Key Features

### 1. Automatic Stock Updates
- GRN automatically increases stock
- RM Issue automatically decreases stock
- Transfers update both warehouses
- Adjustments update stock with reason

### 2. Stock Availability Check
- RM Issue checks stock before issuing
- Prevents negative stock
- Real-time balance calculation

### 3. PO Tracking
- Tracks received vs ordered quantity
- Auto-completes PO when fully received
- Supports partial receipts

### 4. Low Stock Alerts
- Compares balance with reorder level
- Highlights low stock items
- Warehouse-wise alerts

### 5. Inventory Valuation
- Calculates using average rate
- Warehouse-wise valuation
- Item-wise value tracking

## Setup Instructions

### 1. Database Setup
```bash
psql -U postgres -d Pulse -f backend/database/procurement-inventory-schema.sql
```

### 2. Backend Configuration
```javascript
// server.js already configured with:
import procurementRoutes from "./src/modules/procurement/routes/procurement.routes.js";
import inventoryRoutes from "./src/modules/inventory/routes/inventory.routes.js";

app.use("/api/procurement", verifyToken, procurementRoutes);
app.use("/api/inventory", verifyToken, inventoryRoutes);
```

### 3. Frontend Routes
```javascript
// Sidebar.jsx includes:
- Procurement menu (PR, PO, GRN, Local Purchase)
- Inventory menu (Items, Stock, RM Issues, Transfers, Adjustments)
```

## Usage Examples

### Create Purchase Request
```javascript
POST /api/procurement/purchase-requests
{
  "request_date": "2024-01-15",
  "required_date": "2024-02-01",
  "requested_by_employee_id": 1,
  "department_id": 5,
  "notes": "Monthly raw material requirement",
  "items": [
    {
      "item_id": "uuid",
      "item_name": "Steel Rods",
      "quantity": 100,
      "expected_price": 50,
      "required_date": "2024-02-01",
      "remarks": "Grade A"
    }
  ]
}
```

### Create GRN (Auto-updates Stock)
```javascript
POST /api/procurement/grn
{
  "po_id": "uuid",
  "received_by": 1,
  "received_date": "2024-01-20",
  "warehouse_id": "uuid",
  "notes": "All items received in good condition",
  "items": [
    {
      "po_item_id": "uuid",
      "item_id": "uuid",
      "quantity_received": 100,
      "quantity_rejected": 0,
      "rate": 50
    }
  ]
}

// Automatically:
// 1. Creates stock ledger entry (quantity_in = 100)
// 2. Updates PO item received_quantity
// 3. Changes PO status to completed if fully received
```

### Issue RM (Auto-reduces Stock)
```javascript
POST /api/inventory/rm-issues
{
  "issue_date": "2024-01-25",
  "department_id": 3,
  "issued_by": 1,
  "warehouse_id": "uuid",
  "purpose": "Production batch #123",
  "items": [
    {
      "item_id": "uuid",
      "quantity": 50,
      "rate": 50
    }
  ]
}

// Automatically:
// 1. Checks stock availability (throws error if insufficient)
// 2. Creates stock ledger entry (quantity_out = 50)
// 3. Reduces inventory balance
```

## Best Practices

### 1. Stock Management
- Always use GRN for stock receipt
- Use RM Issue for consumption
- Regular stock audits with adjustments
- Monitor low stock alerts

### 2. Procurement Workflow
- Create PR first for approval
- Convert approved PR to PO
- Receive goods through GRN
- Track delivery dates

### 3. Data Integrity
- Stock ledger is append-only (never delete)
- Use soft delete for masters
- Maintain audit trail
- Regular reconciliation

### 4. Performance
- Index on frequently queried columns
- Archive old stock ledger entries
- Use warehouse-wise queries
- Pagination for large datasets

## Future Enhancements

1. **Barcode/QR Code Integration**
2. **Mobile App for Stock Taking**
3. **Automated Reorder Point Alerts**
4. **Supplier Performance Analytics**
5. **Batch/Lot Tracking**
6. **Serial Number Tracking**
7. **Multi-currency Support**
8. **Advanced Forecasting**

## License
Proprietary - Internal Use Only
