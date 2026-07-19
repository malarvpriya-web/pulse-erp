# Advanced Inventory Control Module

Complete advanced inventory management system with batch tracking, reservations, stock alerts, and material traceability.

## 🎯 Features Implemented

### ✅ Batch Tracking & Traceability
- Batch number tracking
- Received date and expiry date management
- Supplier information per batch
- Quantity tracking (received, available, reserved, consumed)
- Batch status management (active, expired, depleted)
- Stock aging analysis

### ✅ Inventory Reservations
- Reserve stock for projects, sales orders, production, service
- Track reserved vs available stock
- Consumption tracking against reservations
- Automatic status updates (active, partially_consumed, fully_consumed)
- Reservation expiry management
- Cancel reservations

### ✅ Stock Allocation Tracking
- Track material usage by:
  - Projects
  - Departments
  - Sales orders
  - Service tickets
  - Production orders
- Batch-level allocation tracking
- Purpose and notes for each allocation

### ✅ Stock Alert Engine
- Automatic low stock alerts
- Out of stock notifications
- Expiring batch alerts (30 days)
- Expired batch tracking
- Alert acknowledgment and resolution
- Real-time alert generation

### ✅ Purchase Suggestions
- Auto-generated purchase recommendations
- Priority-based suggestions (high, medium, low)
- Suggested quantity calculation
- Convert suggestions to purchase requests
- Reject suggestions with reasons
- Track suggestion status

### ✅ Advanced Analytics
- Reserved vs Available Stock
- Stock Aging Report (0-30, 31-60, 61-90, 91-180, 180+ days)
- Material Consumption by Project
- Batch-wise stock tracking
- Dashboard metrics

## 📂 File Structure

### Backend (3 files)
```
backend/
├── database/
│   └── inventory-advanced-schema.sql
└── src/modules/inventory/
    ├── repositories/
    │   └── advancedInventory.repository.js
    └── routes/
        └── advancedInventory.routes.js
```

### Frontend (6 files)
```
frontend/src/features/inventory/pages/
├── AdvancedInventoryDashboard.jsx
├── BatchTracking.jsx
├── StockReservations.jsx
├── StockAlertsAndSuggestions.jsx
├── MaterialConsumption.jsx
├── AdvancedInventory.css
└── index.js
```

## 🗄️ Database Schema

### New Tables (7)
1. **inventory_batches** - Batch tracking with expiry
2. **inventory_allocations** - Material usage tracking
3. **inventory_reservations** - Stock reservation system
4. **stock_alerts** - Alert management
5. **purchase_suggestions** - Auto-generated suggestions
6. **stock_aging_snapshots** - Aging analysis data

### Functions & Triggers
- `calculate_available_stock()` - Calculate available = total - reserved
- `check_stock_alerts()` - Auto-generate alerts on stock changes
- `update_batch_on_reservation()` - Update batch quantities
- `check_expiring_batches()` - Check and alert expiring batches

### Views (3)
- `v_stock_summary` - Current stock with reservations
- `v_batch_stock` - Batch-wise stock details
- `v_material_consumption_by_project` - Project consumption

## 🔌 API Endpoints

### Batch Management
- `POST /api/inventory/advanced/batches` - Create batch
- `GET /api/inventory/advanced/batches` - Get batches
- `PUT /api/inventory/advanced/batches/:id/consume` - Consume from batch

### Reservations
- `POST /api/inventory/advanced/reservations` - Create reservation
- `GET /api/inventory/advanced/reservations` - Get reservations
- `POST /api/inventory/advanced/reservations/:id/consume` - Consume reservation
- `POST /api/inventory/advanced/reservations/:id/cancel` - Cancel reservation

### Allocations
- `POST /api/inventory/advanced/allocations` - Create allocation
- `GET /api/inventory/advanced/allocations` - Get allocations

### Stock Alerts
- `GET /api/inventory/advanced/alerts` - Get alerts
- `POST /api/inventory/advanced/alerts/:id/acknowledge` - Acknowledge alert
- `POST /api/inventory/advanced/alerts/:id/resolve` - Resolve alert

### Purchase Suggestions
- `GET /api/inventory/advanced/purchase-suggestions` - Get suggestions
- `POST /api/inventory/advanced/purchase-suggestions/:id/convert` - Convert to PR
- `POST /api/inventory/advanced/purchase-suggestions/:id/reject` - Reject suggestion

### Analytics
- `GET /api/inventory/advanced/stock-summary` - Stock summary with reservations
- `GET /api/inventory/advanced/available-stock/:item_id/:warehouse_id` - Available stock
- `GET /api/inventory/advanced/stock-aging` - Aging report
- `GET /api/inventory/advanced/material-consumption` - Consumption by project
- `GET /api/inventory/advanced/dashboard` - Dashboard metrics
- `GET /api/inventory/advanced/reserved-vs-available` - Reserved vs available

## 🚀 Setup Instructions

### 1. Database Setup
```bash
psql -U postgres -d Pulse -f backend/database/inventory-advanced-schema.sql
```

### 2. Backend Integration
Add to `server.js`:
```javascript
const advancedInventoryRoutes = require('./src/modules/inventory/routes/advancedInventory.routes');
app.use('/api/inventory/advanced', advancedInventoryRoutes);
```

### 3. Frontend Integration
Add to `App.jsx`:
```javascript
import {
  AdvancedInventoryDashboard,
  BatchTracking,
  StockReservations,
  StockAlertsAndSuggestions,
  MaterialConsumption
} from './features/inventory/pages';

// Routes
<Route path="/inventory/advanced" element={<AdvancedInventoryDashboard />} />
<Route path="/inventory/batches" element={<BatchTracking />} />
<Route path="/inventory/reservations" element={<StockReservations />} />
<Route path="/inventory/alerts" element={<StockAlertsAndSuggestions />} />
<Route path="/inventory/purchase-suggestions" element={<StockAlertsAndSuggestions />} />
<Route path="/inventory/material-consumption" element={<MaterialConsumption />} />
```

## 💡 Usage Workflows

### Workflow 1: Batch Tracking
1. Receive goods (GRN)
2. Create batch with batch number, expiry date, supplier
3. Track batch consumption
4. Monitor expiring batches
5. System alerts 30 days before expiry

### Workflow 2: Stock Reservation
1. Project/Sales order created
2. Reserve required materials
3. System calculates: Available = Total - Reserved
4. Consume from reservation as needed
5. Track remaining reserved quantity

### Workflow 3: Stock Alert & Purchase
1. Stock falls below reorder level
2. System generates alert automatically
3. System creates purchase suggestion
4. Review suggestion in dashboard
5. Convert to purchase request or reject
6. Alert resolved when stock replenished

### Workflow 4: Material Consumption Tracking
1. Issue materials to project/department
2. Create allocation record
3. Link to batch for traceability
4. Track consumption by project
5. Generate consumption reports

## 📊 Dashboard Metrics

1. **Low Stock Alerts** - Active alerts count
2. **Active Reservations** - Current reservations
3. **Purchase Suggestions** - Pending suggestions
4. **Expiring Batches** - Batches expiring in 30 days
5. **Available Stock Value** - Total available inventory value
6. **Reserved Stock Value** - Total reserved inventory value

## 🔄 Automated Processes

### Auto-Generated Alerts
- Low stock when available ≤ reorder level
- Out of stock when available = 0
- Expiring soon (30 days before expiry)
- Expired batches

### Auto-Generated Purchase Suggestions
- Triggered when low stock alert generated
- Suggested quantity = (Reorder Level × 2) - Available Stock
- Priority based on stock level:
  - High: Available ≤ 0
  - Medium: Available > 0 but ≤ Reorder Level

### Auto-Updates
- Batch quantities on reservation
- Available stock calculation
- Reservation status on consumption
- Batch status on expiry

## 🎨 UI Features

- Modern dashboard with metrics cards
- Color-coded alerts (red, yellow, orange)
- Priority badges (high, medium, low)
- Status badges with colors
- Bar charts for reserved vs available
- Aging report cards
- Tabbed interfaces
- Modal forms
- Filters and search
- Responsive design

## 🔐 Security Features

- JWT authentication required
- User tracking for reservations
- Audit trail for allocations
- Alert acknowledgment tracking

## 📈 Reporting Capabilities

1. **Stock Summary** - Total, Reserved, Available by item/warehouse
2. **Batch Report** - All batches with aging and expiry
3. **Aging Report** - Stock grouped by age categories
4. **Consumption Report** - Material usage by project
5. **Reservation Report** - Active and consumed reservations
6. **Alert Report** - All alerts with status

## 🔧 Configuration

### Reorder Levels
Set in `inventory_items` table:
```sql
UPDATE inventory_items SET reorder_level = 100 WHERE item_code = 'ITEM001';
```

### Alert Expiry Window
Default: 30 days before expiry
Modify in `check_expiring_batches()` function

### Suggested Quantity Formula
Default: (Reorder Level × 2) - Available Stock
Modify in `check_stock_alerts()` trigger

## 📝 Best Practices

1. **Batch Management**
   - Always create batches on GRN
   - Set expiry dates for perishable items
   - Use consistent batch numbering

2. **Reservations**
   - Reserve stock before project start
   - Set expiry dates for time-sensitive reservations
   - Cancel unused reservations

3. **Alerts**
   - Acknowledge alerts promptly
   - Resolve alerts after action taken
   - Review purchase suggestions daily

4. **Allocations**
   - Record all material consumption
   - Link to batches for traceability
   - Add purpose/notes for clarity

## 🚧 Future Enhancements

- [ ] Barcode/QR code scanning
- [ ] Mobile app for warehouse operations
- [ ] Email notifications for alerts
- [ ] Automated purchase order creation
- [ ] Batch transfer between warehouses
- [ ] FIFO/LIFO consumption rules
- [ ] Batch quality tracking
- [ ] Integration with production planning

## 📞 Support

For issues or questions, refer to the main documentation or contact the development team.

---

**Version:** 1.0.0  
**Status:** Production Ready ✅
