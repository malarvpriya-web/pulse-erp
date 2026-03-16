-- Financial Periods
CREATE TABLE IF NOT EXISTS financial_periods (
  id SERIAL PRIMARY KEY,
  period_name VARCHAR(50) NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  status VARCHAR(20) DEFAULT 'Open',
  closed_by VARCHAR(255),
  closed_date TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Journal Entries
CREATE TABLE IF NOT EXISTS journal_entries (
  id SERIAL PRIMARY KEY,
  date DATE NOT NULL,
  reference VARCHAR(50) UNIQUE NOT NULL,
  narration TEXT,
  amount DECIMAL(15, 2) NOT NULL,
  status VARCHAR(20) DEFAULT 'Posted',
  period_id INTEGER REFERENCES financial_periods(id),
  created_by INTEGER,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Journal Entry Lines
CREATE TABLE IF NOT EXISTS journal_entry_lines (
  id SERIAL PRIMARY KEY,
  journal_entry_id INTEGER REFERENCES journal_entries(id),
  account_code VARCHAR(20) NOT NULL,
  description TEXT,
  debit DECIMAL(15, 2) DEFAULT 0,
  credit DECIMAL(15, 2) DEFAULT 0,
  cost_center VARCHAR(50)
);

-- Opening Balances
CREATE TABLE IF NOT EXISTS opening_balances (
  id SERIAL PRIMARY KEY,
  account_code VARCHAR(20) NOT NULL,
  opening_date DATE NOT NULL,
  debit DECIMAL(15, 2) DEFAULT 0,
  credit DECIMAL(15, 2) DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Customer Advances
CREATE TABLE IF NOT EXISTS customer_advances (
  id SERIAL PRIMARY KEY,
  customer VARCHAR(255) NOT NULL,
  advance_date DATE NOT NULL,
  amount DECIMAL(15, 2) NOT NULL,
  utilized_amount DECIMAL(15, 2) DEFAULT 0,
  balance DECIMAL(15, 2) NOT NULL,
  status VARCHAR(20) DEFAULT 'Active',
  created_at TIMESTAMP DEFAULT NOW()
);

-- Supplier Advances
CREATE TABLE IF NOT EXISTS supplier_advances (
  id SERIAL PRIMARY KEY,
  supplier VARCHAR(255) NOT NULL,
  advance_date DATE NOT NULL,
  amount DECIMAL(15, 2) NOT NULL,
  utilized_amount DECIMAL(15, 2) DEFAULT 0,
  balance DECIMAL(15, 2) NOT NULL,
  status VARCHAR(20) DEFAULT 'Active',
  created_at TIMESTAMP DEFAULT NOW()
);

-- Credit Notes
CREATE TABLE IF NOT EXISTS credit_notes (
  id SERIAL PRIMARY KEY,
  credit_note_number VARCHAR(50) UNIQUE NOT NULL,
  customer VARCHAR(255) NOT NULL,
  invoice_id INTEGER,
  date DATE NOT NULL,
  amount DECIMAL(15, 2) NOT NULL,
  reason TEXT,
  status VARCHAR(20) DEFAULT 'Issued',
  created_at TIMESTAMP DEFAULT NOW()
);

-- Debit Notes
CREATE TABLE IF NOT EXISTS debit_notes (
  id SERIAL PRIMARY KEY,
  debit_note_number VARCHAR(50) UNIQUE NOT NULL,
  supplier VARCHAR(255) NOT NULL,
  bill_id INTEGER,
  date DATE NOT NULL,
  amount DECIMAL(15, 2) NOT NULL,
  reason TEXT,
  status VARCHAR(20) DEFAULT 'Issued',
  created_at TIMESTAMP DEFAULT NOW()
);

-- Recurring Transactions
CREATE TABLE IF NOT EXISTS recurring_transactions (
  id SERIAL PRIMARY KEY,
  transaction_type VARCHAR(50) NOT NULL,
  frequency VARCHAR(20) NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE,
  amount DECIMAL(15, 2) NOT NULL,
  account_code VARCHAR(20) NOT NULL,
  description TEXT,
  status VARCHAR(20) DEFAULT 'Active',
  last_run_date DATE,
  next_run_date DATE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Fixed Assets
CREATE TABLE IF NOT EXISTS fixed_assets (
  id SERIAL PRIMARY KEY,
  asset_code VARCHAR(50) UNIQUE NOT NULL,
  asset_name VARCHAR(255) NOT NULL,
  category VARCHAR(100) NOT NULL,
  purchase_date DATE NOT NULL,
  purchase_cost DECIMAL(15, 2) NOT NULL,
  salvage_value DECIMAL(15, 2) DEFAULT 0,
  useful_life_years INTEGER NOT NULL,
  depreciation_method VARCHAR(50) DEFAULT 'Straight Line',
  accumulated_depreciation DECIMAL(15, 2) DEFAULT 0,
  book_value DECIMAL(15, 2) NOT NULL,
  status VARCHAR(20) DEFAULT 'Active',
  created_at TIMESTAMP DEFAULT NOW()
);

-- Cost Centers
CREATE TABLE IF NOT EXISTS cost_centers (
  id SERIAL PRIMARY KEY,
  code VARCHAR(20) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  budget DECIMAL(15, 2) DEFAULT 0,
  actual_spend DECIMAL(15, 2) DEFAULT 0,
  manager VARCHAR(255),
  status VARCHAR(20) DEFAULT 'Active',
  created_at TIMESTAMP DEFAULT NOW()
);

-- Budget Alerts
CREATE TABLE IF NOT EXISTS budget_alerts (
  id SERIAL PRIMARY KEY,
  cost_center_code VARCHAR(20) NOT NULL,
  alert_type VARCHAR(50) NOT NULL,
  threshold_percentage INTEGER NOT NULL,
  alert_date TIMESTAMP DEFAULT NOW(),
  notified BOOLEAN DEFAULT FALSE
);

-- Audit Trail
CREATE TABLE IF NOT EXISTS finance_audit_trail (
  id SERIAL PRIMARY KEY,
  transaction_type VARCHAR(50) NOT NULL,
  transaction_id INTEGER NOT NULL,
  action VARCHAR(50) NOT NULL,
  old_value TEXT,
  new_value TEXT,
  user_id INTEGER,
  user_name VARCHAR(255),
  ip_address VARCHAR(50),
  timestamp TIMESTAMP DEFAULT NOW()
);

-- Sample Data
INSERT INTO financial_periods (period_name, start_date, end_date, status) VALUES
('Jan 2024', '2024-01-01', '2024-01-31', 'Closed'),
('Feb 2024', '2024-02-01', '2024-02-29', 'Open'),
('Mar 2024', '2024-03-01', '2024-03-31', 'Open');

INSERT INTO cost_centers (code, name, budget, actual_spend, manager) VALUES
('CC001', 'Sales Department', 50000, 35000, 'John Doe'),
('CC002', 'Marketing', 30000, 34500, 'Jane Smith'),
('CC003', 'IT Department', 40000, 28000, 'Mike Johnson');

INSERT INTO fixed_assets (asset_code, asset_name, category, purchase_date, purchase_cost, useful_life_years, book_value) VALUES
('FA001', 'Office Building', 'Property', '2020-01-01', 500000, 20, 475000),
('FA002', 'Company Vehicle', 'Vehicle', '2022-06-15', 35000, 5, 28000),
('FA003', 'Computer Equipment', 'IT Equipment', '2023-01-10', 15000, 3, 12500);
