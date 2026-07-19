// Procurement pages – sample/mock data for DEV mode only.
// Do not import this file in production code paths; always guard with import.meta.env.DEV.

// PurchaseOrders.jsx
export const SAMPLE_POS = [
  { id: 1, po_number: 'PO-2024-001', supplier_name: 'Tata Steel Ltd',       order_date: '2024-11-01', expected_date: '2024-11-15', total_amount: 185000, status: 'Received', items_count: 3 },
  { id: 2, po_number: 'PO-2024-002', supplier_name: 'ABC Packaging Co',     order_date: '2024-11-10', expected_date: '2024-11-25', total_amount: 42000,  status: 'Sent',     items_count: 2 },
  { id: 3, po_number: 'PO-2024-003', supplier_name: 'National Electricals', order_date: '2024-11-20', expected_date: '2024-12-05', total_amount: 96500,  status: 'Partial',  items_count: 5 },
  { id: 4, po_number: 'PO-2024-004', supplier_name: 'Lubes & More Pvt Ltd', order_date: '2024-11-28', expected_date: '2024-12-10', total_amount: 18200,  status: 'Draft',    items_count: 1 },
];

// PurchaseOrders.jsx
export const SAMPLE_SUPPLIERS = [
  { id: 1, name: 'Tata Steel Ltd' },
  { id: 2, name: 'ABC Packaging Co' },
  { id: 3, name: 'National Electricals' },
  { id: 4, name: 'Lubes & More Pvt Ltd' },
];

// PurchaseOrders.jsx
export const SAMPLE_ITEMS = [
  { id: 1, name: 'Steel Rods 12mm',   sku: 'SKU-005', unit: 'kg' },
  { id: 2, name: 'Ball Bearings 20mm',sku: 'SKU-001', unit: 'pcs' },
  { id: 3, name: 'Packing Tape 48mm', sku: 'SKU-003', unit: 'rolls' },
];

// PurchaseRequest.jsx
export const SAMPLE_PRS = [
  { id: 1, request_number: 'PR-2026-001', request_date: '2026-03-01', requested_by: 'Rajesh Kumar',  department: 'Engineering', status: 'pending_approval', items_count: 3, total_amount: 48500  },
  { id: 2, request_number: 'PR-2026-002', request_date: '2026-03-05', requested_by: 'Priya Sharma',  department: 'HR',          status: 'approved',          items_count: 2, total_amount: 12000  },
  { id: 3, request_number: 'PR-2026-003', request_date: '2026-03-08', requested_by: 'Anand Mehta',   department: 'Finance',     status: 'ordered',           items_count: 5, total_amount: 125000 },
  { id: 4, request_number: 'PR-2026-004', request_date: '2026-03-10', requested_by: 'Sunita Rao',    department: 'Operations',  status: 'draft',             items_count: 1, total_amount: 8500   },
  { id: 5, request_number: 'PR-2026-005', request_date: '2026-03-12', requested_by: 'Vikram Nair',   department: 'Engineering', status: 'rejected',          items_count: 2, total_amount: 32000  },
  { id: 6, request_number: 'PR-2026-006', request_date: '2026-03-14', requested_by: 'Meena Pillai',  department: 'Marketing',   status: 'received',          items_count: 4, total_amount: 67500  },
];

// GoodsReceipt.jsx
export const SAMPLE_GRN = [
  { id: 1, grn_number: 'GRN-2026-001', date: '2026-03-15', po_number: 'PO-2026-012', supplier_name: 'Infra Supplies Co', items_received: 5, total_value: 45000, status: 'completed' },
  { id: 2, grn_number: 'GRN-2026-002', date: '2026-03-18', po_number: 'PO-2026-015', supplier_name: 'Tech Parts Ltd', items_received: 2, total_value: 18500, status: 'partial' },
  { id: 3, grn_number: 'GRN-2026-003', date: '2026-03-20', po_number: 'PO-2026-018', supplier_name: 'Office Hub', items_received: 8, total_value: 12000, status: 'pending' },
  { id: 4, grn_number: 'GRN-2026-004', date: '2026-03-22', po_number: 'PO-2026-020', supplier_name: 'Industrial Supply', items_received: 0, total_value: 0, status: 'rejected' },
];
