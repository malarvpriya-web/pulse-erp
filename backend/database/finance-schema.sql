-- =====================================================
-- FINANCE MODULE DATABASE SCHEMA
-- Double-Entry Accounting System
-- =====================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =====================================================
-- CHART OF ACCOUNTS
-- =====================================================
CREATE TABLE chart_of_accounts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  code VARCHAR(20) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  account_type VARCHAR(50) NOT NULL, -- Asset, Liability, Equity, Revenue, Expense
  parent_id UUID REFERENCES chart_of_accounts(id),
  is_active BOOLEAN DEFAULT true,
  description TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP
);

CREATE INDEX idx_coa_parent ON chart_of_accounts(parent_id);
CREATE INDEX idx_coa_type ON chart_of_accounts(account_type);
CREATE INDEX idx_coa_active ON chart_of_accounts(is_active);

-- =====================================================
-- PARTIES (Customers & Suppliers)
-- =====================================================
CREATE TABLE parties (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  party_code VARCHAR(20) UNIQUE NOT NULL,
  party_type VARCHAR(20) NOT NULL, -- Customer, Supplier, Both
  name VARCHAR(255) NOT NULL,
  contact_person VARCHAR(255),
  email VARCHAR(255),
  phone VARCHAR(50),
  address TEXT,
  tax_id VARCHAR(50),
  credit_limit DECIMAL(15,2) DEFAULT 0,
  payment_terms INTEGER DEFAULT 30, -- days
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP
);

CREATE INDEX idx_parties_type ON parties(party_type);
CREATE INDEX idx_parties_active ON parties(is_active);

-- =====================================================
-- FINANCIAL PERIODS
-- =====================================================
CREATE TABLE financial_periods (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  period_name VARCHAR(50) NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  is_locked BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- =====================================================
-- JOURNAL ENTRIES (Header)
-- =====================================================
CREATE TABLE journal_entries (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  entry_number VARCHAR(50) UNIQUE NOT NULL,
  entry_date DATE NOT NULL,
  entry_type VARCHAR(50) NOT NULL, -- Invoice, Bill, Payment, Receipt, Expense, Manual
  reference_type VARCHAR(50), -- invoice, bill, payment, receipt, expense
  reference_id UUID,
  description TEXT,
  total_debit DECIMAL(15,2) NOT NULL DEFAULT 0,
  total_credit DECIMAL(15,2) NOT NULL DEFAULT 0,
  is_posted BOOLEAN DEFAULT false,
  posted_at TIMESTAMP,
  created_by INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP
);

CREATE INDEX idx_je_date ON journal_entries(entry_date);
CREATE INDEX idx_je_type ON journal_entries(entry_type);
CREATE INDEX idx_je_reference ON journal_entries(reference_type, reference_id);

-- =====================================================
-- JOURNAL ENTRY LINES
-- =====================================================
CREATE TABLE journal_entry_lines (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  journal_entry_id UUID NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES chart_of_accounts(id),
  description TEXT,
  debit DECIMAL(15,2) DEFAULT 0,
  credit DECIMAL(15,2) DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_jel_entry ON journal_entry_lines(journal_entry_id);
CREATE INDEX idx_jel_account ON journal_entry_lines(account_id);

-- =====================================================
-- CUSTOMER INVOICES
-- =====================================================
CREATE TABLE invoices (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  invoice_number VARCHAR(50) UNIQUE NOT NULL,
  customer_id UUID NOT NULL REFERENCES parties(id),
  invoice_date DATE NOT NULL,
  due_date DATE NOT NULL,
  subtotal DECIMAL(15,2) NOT NULL DEFAULT 0,
  tax_amount DECIMAL(15,2) DEFAULT 0,
  total_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
  paid_amount DECIMAL(15,2) DEFAULT 0,
  balance DECIMAL(15,2) NOT NULL DEFAULT 0,
  status VARCHAR(20) DEFAULT 'Draft', -- Draft, Sent, Paid, Overdue, Cancelled
  notes TEXT,
  journal_entry_id UUID REFERENCES journal_entries(id),
  created_by INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP
);

CREATE INDEX idx_invoices_customer ON invoices(customer_id);
CREATE INDEX idx_invoices_date ON invoices(invoice_date);
CREATE INDEX idx_invoices_due ON invoices(due_date);
CREATE INDEX idx_invoices_status ON invoices(status);

-- =====================================================
-- INVOICE ITEMS
-- =====================================================
CREATE TABLE invoice_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  quantity DECIMAL(10,2) NOT NULL DEFAULT 1,
  unit_price DECIMAL(15,2) NOT NULL,
  tax_rate DECIMAL(5,2) DEFAULT 0,
  amount DECIMAL(15,2) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_invoice_items_invoice ON invoice_items(invoice_id);

-- =====================================================
-- SUPPLIER BILLS
-- =====================================================
CREATE TABLE bills (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  bill_number VARCHAR(50) UNIQUE NOT NULL,
  supplier_id UUID NOT NULL REFERENCES parties(id),
  bill_date DATE NOT NULL,
  due_date DATE NOT NULL,
  subtotal DECIMAL(15,2) NOT NULL DEFAULT 0,
  tax_amount DECIMAL(15,2) DEFAULT 0,
  total_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
  paid_amount DECIMAL(15,2) DEFAULT 0,
  balance DECIMAL(15,2) NOT NULL DEFAULT 0,
  status VARCHAR(20) DEFAULT 'Draft', -- Draft, Approved, Paid, Overdue, Cancelled
  approval_status VARCHAR(20) DEFAULT 'Pending', -- Pending, Approved, Rejected
  approved_by INTEGER,
  approved_at TIMESTAMP,
  notes TEXT,
  journal_entry_id UUID REFERENCES journal_entries(id),
  created_by INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP
);

CREATE INDEX idx_bills_supplier ON bills(supplier_id);
CREATE INDEX idx_bills_date ON bills(bill_date);
CREATE INDEX idx_bills_due ON bills(due_date);
CREATE INDEX idx_bills_status ON bills(status);

-- =====================================================
-- BILL ITEMS
-- =====================================================
CREATE TABLE bill_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  bill_id UUID NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  quantity DECIMAL(10,2) NOT NULL DEFAULT 1,
  unit_price DECIMAL(15,2) NOT NULL,
  tax_rate DECIMAL(5,2) DEFAULT 0,
  amount DECIMAL(15,2) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_bill_items_bill ON bill_items(bill_id);

-- =====================================================
-- PAYMENTS
-- =====================================================
CREATE TABLE payments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  payment_number VARCHAR(50) UNIQUE NOT NULL,
  payment_date DATE NOT NULL,
  payment_type VARCHAR(20) NOT NULL, -- Supplier, Expense
  party_id UUID REFERENCES parties(id),
  amount DECIMAL(15,2) NOT NULL,
  payment_method VARCHAR(50), -- Cash, Bank Transfer, Cheque, Card
  reference_number VARCHAR(100),
  notes TEXT,
  journal_entry_id UUID REFERENCES journal_entries(id),
  created_by INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP
);

CREATE INDEX idx_payments_date ON payments(payment_date);
CREATE INDEX idx_payments_party ON payments(party_id);

-- =====================================================
-- PAYMENT ALLOCATIONS
-- =====================================================
CREATE TABLE payment_allocations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  payment_id UUID NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  bill_id UUID REFERENCES bills(id),
  allocated_amount DECIMAL(15,2) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_payment_alloc_payment ON payment_allocations(payment_id);
CREATE INDEX idx_payment_alloc_bill ON payment_allocations(bill_id);

-- =====================================================
-- RECEIPTS
-- =====================================================
CREATE TABLE receipts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  receipt_number VARCHAR(50) UNIQUE NOT NULL,
  receipt_date DATE NOT NULL,
  customer_id UUID NOT NULL REFERENCES parties(id),
  amount DECIMAL(15,2) NOT NULL,
  payment_method VARCHAR(50), -- Cash, Bank Transfer, Cheque, Card
  reference_number VARCHAR(100),
  notes TEXT,
  journal_entry_id UUID REFERENCES journal_entries(id),
  created_by INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP
);

CREATE INDEX idx_receipts_date ON receipts(receipt_date);
CREATE INDEX idx_receipts_customer ON receipts(customer_id);

-- =====================================================
-- RECEIPT ALLOCATIONS
-- =====================================================
CREATE TABLE receipt_allocations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  receipt_id UUID NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
  invoice_id UUID NOT NULL REFERENCES invoices(id),
  allocated_amount DECIMAL(15,2) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_receipt_alloc_receipt ON receipt_allocations(receipt_id);
CREATE INDEX idx_receipt_alloc_invoice ON receipt_allocations(invoice_id);

-- =====================================================
-- EXPENSE CLAIMS
-- =====================================================
CREATE TABLE expense_claims (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  claim_number VARCHAR(50) UNIQUE NOT NULL,
  employee_id INTEGER NOT NULL,
  claim_date DATE NOT NULL,
  total_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
  status VARCHAR(20) DEFAULT 'Pending', -- Pending, Approved, Rejected, Paid
  approved_by INTEGER,
  approved_at TIMESTAMP,
  rejection_reason TEXT,
  payment_id UUID REFERENCES payments(id),
  notes TEXT,
  journal_entry_id UUID REFERENCES journal_entries(id),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP
);

CREATE INDEX idx_expense_employee ON expense_claims(employee_id);
CREATE INDEX idx_expense_status ON expense_claims(status);
CREATE INDEX idx_expense_date ON expense_claims(claim_date);

-- =====================================================
-- EXPENSE CLAIM ITEMS
-- =====================================================
CREATE TABLE expense_claim_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  expense_claim_id UUID NOT NULL REFERENCES expense_claims(id) ON DELETE CASCADE,
  expense_date DATE NOT NULL,
  category VARCHAR(100) NOT NULL,
  description TEXT NOT NULL,
  amount DECIMAL(15,2) NOT NULL,
  receipt_path VARCHAR(500),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_expense_items_claim ON expense_claim_items(expense_claim_id);

-- =====================================================
-- AUDIT LOG
-- =====================================================
CREATE TABLE finance_audit_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  table_name VARCHAR(100) NOT NULL,
  record_id UUID NOT NULL,
  action VARCHAR(20) NOT NULL, -- CREATE, UPDATE, DELETE
  old_values JSONB,
  new_values JSONB,
  user_id INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_audit_table ON finance_audit_log(table_name, record_id);
CREATE INDEX idx_audit_date ON finance_audit_log(created_at);

-- =====================================================
-- DEFAULT CHART OF ACCOUNTS
-- =====================================================
INSERT INTO chart_of_accounts (code, name, account_type, description) VALUES
-- Assets
('1000', 'Assets', 'Asset', 'All Assets'),
('1100', 'Current Assets', 'Asset', 'Current Assets'),
('1110', 'Cash', 'Asset', 'Cash on Hand'),
('1120', 'Bank Account', 'Asset', 'Bank Accounts'),
('1130', 'Accounts Receivable', 'Asset', 'Customer Receivables'),
('1200', 'Fixed Assets', 'Asset', 'Fixed Assets'),

-- Liabilities
('2000', 'Liabilities', 'Liability', 'All Liabilities'),
('2100', 'Current Liabilities', 'Liability', 'Current Liabilities'),
('2110', 'Accounts Payable', 'Liability', 'Supplier Payables'),
('2120', 'Tax Payable', 'Liability', 'Tax Liabilities'),

-- Equity
('3000', 'Equity', 'Equity', 'Owner Equity'),
('3100', 'Retained Earnings', 'Equity', 'Retained Earnings'),

-- Revenue
('4000', 'Revenue', 'Revenue', 'All Revenue'),
('4100', 'Sales Revenue', 'Revenue', 'Sales Income'),
('4200', 'Service Revenue', 'Revenue', 'Service Income'),

-- Expenses
('5000', 'Expenses', 'Expense', 'All Expenses'),
('5100', 'Operating Expenses', 'Expense', 'Operating Expenses'),
('5110', 'Salaries & Wages', 'Expense', 'Employee Salaries'),
('5120', 'Rent Expense', 'Expense', 'Rent Payments'),
('5130', 'Utilities', 'Expense', 'Utility Bills'),
('5140', 'Office Supplies', 'Expense', 'Office Supplies'),
('5150', 'Travel & Entertainment', 'Expense', 'Travel Expenses');
