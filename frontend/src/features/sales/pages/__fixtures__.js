// Sales pages – sample/mock data for DEV mode only.
// Do not import this file in production code paths; always guard with import.meta.env.DEV.

// Quotations.jsx
export const SAMPLE_QUOTATIONS = [
  { id: 1, quotationNumber: 'QT-001', customerName: 'Infosys Ltd', quotationDate: '2026-03-10', validityDate: '2026-04-10', totalAmount: 285000, status: 'Sent' },
  { id: 2, quotationNumber: 'QT-002', customerName: 'Wipro Technologies', quotationDate: '2026-03-12', validityDate: '2026-04-12', totalAmount: 142000, status: 'Accepted' },
  { id: 3, quotationNumber: 'QT-003', customerName: 'TCS India', quotationDate: '2026-03-14', validityDate: '2026-04-14', totalAmount: 560000, status: 'Draft' },
  { id: 4, quotationNumber: 'QT-004', customerName: 'HCL Technologies', quotationDate: '2026-02-20', validityDate: '2026-03-20', totalAmount: 98000, status: 'Expired' },
  { id: 5, quotationNumber: 'QT-005', customerName: 'Mphasis Ltd', quotationDate: '2026-03-15', validityDate: '2026-04-15', totalAmount: 376000, status: 'Accepted' },
];

// Quotations.jsx
export const SAMPLE_QUOTATIONS_CUSTOMERS = [
  { id: 1, name: 'Infosys Ltd' }, { id: 2, name: 'Wipro Technologies' },
  { id: 3, name: 'TCS India' }, { id: 4, name: 'HCL Technologies' }, { id: 5, name: 'Mphasis Ltd' },
];

// SalesOrders.jsx
export const SAMPLE_ORDERS = [
  { id: 1, orderNumber: 'SO-001', customerName: 'Wipro Technologies', orderDate: '2026-03-13', deliveryDate: '2026-03-28', totalAmount: 142000, quotationRef: 'QT-002', fulfillmentStatus: 'Partial', status: 'Confirmed' },
  { id: 2, orderNumber: 'SO-002', customerName: 'Mphasis Ltd', orderDate: '2026-03-16', deliveryDate: '2026-04-05', totalAmount: 376000, quotationRef: 'QT-005', fulfillmentStatus: 'Pending', status: 'Confirmed' },
  { id: 3, orderNumber: 'SO-003', customerName: 'Tech Mahindra', orderDate: '2026-02-20', deliveryDate: '2026-03-10', totalAmount: 218000, quotationRef: null, fulfillmentStatus: 'Complete', status: 'Delivered' },
  { id: 4, orderNumber: 'SO-004', customerName: 'L&T Infotech', orderDate: '2026-01-15', deliveryDate: '2026-02-15', totalAmount: 495000, quotationRef: null, fulfillmentStatus: 'Complete', status: 'Closed' },
  { id: 5, orderNumber: 'SO-005', customerName: 'Cognizant India', orderDate: '2026-03-17', deliveryDate: '2026-04-10', totalAmount: 320000, quotationRef: null, fulfillmentStatus: 'Pending', status: 'Draft' },
];

// SalesTargets.jsx
export const SAMPLE_TARGETS = [
  { id: 1, employee: 'Vikram Singh', role: 'Sr. Sales Manager', target: 2000000, achieved: 1640000, period: 'Q1 FY2026' },
  { id: 2, employee: 'Arjun Mehta', role: 'Sales Manager', target: 1500000, achieved: 1425000, period: 'Q1 FY2026' },
  { id: 3, employee: 'Priya Sharma', role: 'Sales Executive', target: 1000000, achieved: 760000, period: 'Q1 FY2026' },
  { id: 4, employee: 'Sneha Iyer', role: 'Sales Executive', target: 800000, achieved: 820000, period: 'Q1 FY2026' },
  { id: 5, employee: 'Kiran Das', role: 'BD Manager', target: 1200000, achieved: 480000, period: 'Q1 FY2026' },
  { id: 6, employee: 'Rohit Gupta', role: 'Sales Manager', target: 1500000, achieved: 1350000, period: 'Q1 FY2026' },
];

// SalesOrders.jsx
export const SAMPLE_ORDERS_CUSTOMERS = [
  { id: 1, name: 'Infosys Ltd' }, { id: 2, name: 'Wipro Technologies' }, { id: 3, name: 'TCS India' },
  { id: 4, name: 'Tech Mahindra' }, { id: 5, name: 'Mphasis Ltd' }, { id: 6, name: 'Cognizant India' },
];

// Subscriptions.jsx
export const SAMPLE_SUBSCRIPTIONS = [
  { id: 1, customer_name: 'Acme Corp', plan: 'Enterprise', billing_cycle: 'Annual', amount: 120000, start_date: '2026-01-01', next_billing: '2027-01-01', status: 'active' },
  { id: 2, customer_name: 'TechStart Pvt', plan: 'Growth', billing_cycle: 'Monthly', amount: 8500, start_date: '2026-02-15', next_billing: '2026-04-15', status: 'active' },
  { id: 3, customer_name: 'BuildFast Ltd', plan: 'Starter', billing_cycle: 'Monthly', amount: 2500, start_date: '2025-12-01', next_billing: '2026-04-01', status: 'trial' },
  { id: 4, customer_name: 'DataViz Inc', plan: 'Growth', billing_cycle: 'Quarterly', amount: 22500, start_date: '2025-10-01', next_billing: '2026-04-01', status: 'paused' },
  { id: 5, customer_name: 'OldCo Pvt', plan: 'Starter', billing_cycle: 'Annual', amount: 18000, start_date: '2024-01-01', next_billing: '2025-01-01', status: 'expired' },
];
