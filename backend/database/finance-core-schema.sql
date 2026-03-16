-- Chart of Accounts
CREATE TABLE IF NOT EXISTS chart_of_accounts (
  id SERIAL PRIMARY KEY,
  code VARCHAR(20) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  type VARCHAR(50) NOT NULL,
  parent VARCHAR(20),
  status VARCHAR(20) DEFAULT 'Active',
  created_at TIMESTAMP DEFAULT NOW()
);

-- Invoices
CREATE TABLE IF NOT EXISTS invoices (
  id SERIAL PRIMARY KEY,
  invoice_number VARCHAR(50) UNIQUE NOT NULL,
  customer VARCHAR(255) NOT NULL,
  invoice_date DATE NOT NULL,
  due_date DATE NOT NULL,
  amount DECIMAL(15, 2) NOT NULL,
  paid_amount DECIMAL(15, 2) DEFAULT 0,
  balance DECIMAL(15, 2) NOT NULL,
  status VARCHAR(20) DEFAULT 'Pending',
  created_at TIMESTAMP DEFAULT NOW()
);

-- Supplier Bills
CREATE TABLE IF NOT EXISTS supplier_bills (
  id SERIAL PRIMARY KEY,
  bill_number VARCHAR(50) UNIQUE NOT NULL,
  supplier VARCHAR(255) NOT NULL,
  bill_date DATE NOT NULL,
  due_date DATE NOT NULL,
  amount DECIMAL(15, 2) NOT NULL,
  status VARCHAR(20) DEFAULT 'Pending',
  created_at TIMESTAMP DEFAULT NOW()
);

-- Sample Data
INSERT INTO chart_of_accounts (code, name, type, parent) VALUES
('1000', 'Assets', 'Asset', NULL),
('1100', 'Current Assets', 'Asset', '1000'),
('1110', 'Cash', 'Asset', '1100'),
('1120', 'Bank', 'Asset', '1100'),
('2000', 'Liabilities', 'Liability', NULL),
('3000', 'Equity', 'Equity', NULL),
('4000', 'Revenue', 'Revenue', NULL),
('5000', 'Expenses', 'Expense', NULL);

INSERT INTO invoices (invoice_number, customer, invoice_date, due_date, amount, paid_amount, balance, status) VALUES
('INV-001', 'ABC Corp', '2024-01-15', '2024-02-15', 15000, 15000, 0, 'Paid'),
('INV-002', 'XYZ Ltd', '2024-01-20', '2024-02-20', 25000, 0, 25000, 'Pending'),
('INV-003', 'Tech Solutions', '2024-01-10', '2024-02-10', 18000, 0, 18000, 'Overdue');

INSERT INTO supplier_bills (bill_number, supplier, bill_date, due_date, amount, status) VALUES
('BILL-001', 'Office Supplies Co', '2024-01-15', '2024-02-15', 5000, 'Pending'),
('BILL-002', 'Tech Vendor', '2024-01-20', '2024-02-20', 12000, 'Approved'),
('BILL-003', 'Utilities Provider', '2024-01-10', '2024-02-10', 3500, 'Overdue');
