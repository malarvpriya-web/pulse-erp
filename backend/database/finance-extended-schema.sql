-- =====================================================
-- EXTENDED FINANCE MODULE - COMPLIANCE & TREASURY
-- =====================================================

-- =====================================================
-- EXPENSE CATEGORIES & POLICIES
-- =====================================================
CREATE TABLE expense_categories (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(100) NOT NULL,
  code VARCHAR(20) UNIQUE NOT NULL,
  bill_required BOOLEAN DEFAULT false,
  max_amount_without_bill DECIMAL(15,2) DEFAULT 0,
  requires_additional_approval BOOLEAN DEFAULT false,
  approval_threshold DECIMAL(15,2),
  is_gst_claimable BOOLEAN DEFAULT true,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_expense_cat_active ON expense_categories(is_active);

INSERT INTO expense_categories (name, code, bill_required, max_amount_without_bill, is_gst_claimable) VALUES
('Travel', 'TRV', true, 500, true),
('Petty Cash', 'PTY', false, 200, false),
('Local Purchase', 'LCP', true, 1000, true),
('RM Purchase', 'RMP', true, 0, true),
('Entertainment', 'ENT', true, 300, false),
('Office Supplies', 'OFS', true, 500, true);

-- =====================================================
-- BILL COMPLIANCE TRACKING
-- =====================================================
ALTER TABLE expense_claim_items ADD COLUMN category_id UUID REFERENCES expense_categories(id);
ALTER TABLE expense_claim_items ADD COLUMN bill_status VARCHAR(20) DEFAULT 'with_bill'; -- with_bill, without_bill, bill_pending
ALTER TABLE expense_claim_items ADD COLUMN bill_number VARCHAR(100);
ALTER TABLE expense_claim_items ADD COLUMN gst_amount DECIMAL(15,2) DEFAULT 0;
ALTER TABLE expense_claim_items ADD COLUMN is_gst_claimable BOOLEAN DEFAULT false;

ALTER TABLE bill_items ADD COLUMN gst_amount DECIMAL(15,2) DEFAULT 0;
ALTER TABLE bills ADD COLUMN gst_total DECIMAL(15,2) DEFAULT 0;

-- =====================================================
-- BANK ACCOUNTS
-- =====================================================
CREATE TABLE bank_accounts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_name VARCHAR(255) NOT NULL,
  account_number VARCHAR(50) NOT NULL,
  bank_name VARCHAR(255) NOT NULL,
  branch VARCHAR(255),
  ifsc_code VARCHAR(20),
  account_type VARCHAR(50), -- Savings, Current, OD
  currency VARCHAR(10) DEFAULT 'INR',
  opening_balance DECIMAL(15,2) DEFAULT 0,
  current_balance DECIMAL(15,2) DEFAULT 0,
  chart_account_id UUID REFERENCES chart_of_accounts(id),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP
);

CREATE INDEX idx_bank_accounts_active ON bank_accounts(is_active);

-- =====================================================
-- BANK TRANSACTIONS
-- =====================================================
CREATE TABLE bank_transactions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  bank_account_id UUID NOT NULL REFERENCES bank_accounts(id),
  transaction_date DATE NOT NULL,
  transaction_type VARCHAR(20) NOT NULL, -- Debit, Credit
  amount DECIMAL(15,2) NOT NULL,
  balance_after DECIMAL(15,2) NOT NULL,
  reference_number VARCHAR(100),
  description TEXT,
  reconciled BOOLEAN DEFAULT false,
  reconciled_at TIMESTAMP,
  journal_entry_id UUID REFERENCES journal_entries(id),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_bank_trans_account ON bank_transactions(bank_account_id);
CREATE INDEX idx_bank_trans_date ON bank_transactions(transaction_date);
CREATE INDEX idx_bank_trans_reconciled ON bank_transactions(reconciled);

-- =====================================================
-- POST DATED CHEQUES (PDC)
-- =====================================================
CREATE TABLE pdc_register (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  cheque_type VARCHAR(20) NOT NULL, -- Received, Issued
  cheque_number VARCHAR(50) NOT NULL,
  cheque_date DATE NOT NULL,
  amount DECIMAL(15,2) NOT NULL,
  party_id UUID REFERENCES parties(id),
  bank_account_id UUID REFERENCES bank_accounts(id),
  status VARCHAR(20) DEFAULT 'Pending', -- Pending, Cleared, Bounced, Cancelled
  cleared_date DATE,
  bounce_reason TEXT,
  bounce_charges DECIMAL(15,2) DEFAULT 0,
  reference_type VARCHAR(50), -- invoice, bill, payment, receipt
  reference_id UUID,
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_pdc_type ON pdc_register(cheque_type);
CREATE INDEX idx_pdc_status ON pdc_register(status);
CREATE INDEX idx_pdc_date ON pdc_register(cheque_date);

-- =====================================================
-- PAYMENT BATCHES
-- =====================================================
CREATE TABLE payment_batches (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  batch_number VARCHAR(50) UNIQUE NOT NULL,
  batch_date DATE NOT NULL,
  total_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
  payment_count INTEGER DEFAULT 0,
  status VARCHAR(20) DEFAULT 'Draft', -- Draft, Awaiting_Approval, Approved, Processing, Completed, Rejected
  bank_account_id UUID REFERENCES bank_accounts(id),
  approved_by INTEGER,
  approved_at TIMESTAMP,
  processed_at TIMESTAMP,
  completed_at TIMESTAMP,
  rejection_reason TEXT,
  notes TEXT,
  created_by INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_payment_batch_status ON payment_batches(status);
CREATE INDEX idx_payment_batch_date ON payment_batches(batch_date);

-- =====================================================
-- PAYMENT BATCH ITEMS
-- =====================================================
CREATE TABLE payment_batch_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  batch_id UUID NOT NULL REFERENCES payment_batches(id) ON DELETE CASCADE,
  party_id UUID NOT NULL REFERENCES parties(id),
  bill_id UUID REFERENCES bills(id),
  amount DECIMAL(15,2) NOT NULL,
  payment_method VARCHAR(50),
  reference_number VARCHAR(100),
  notes TEXT,
  payment_id UUID REFERENCES payments(id),
  status VARCHAR(20) DEFAULT 'Pending', -- Pending, Processed, Failed
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_batch_items_batch ON payment_batch_items(batch_id);
CREATE INDEX idx_batch_items_status ON payment_batch_items(status);

-- =====================================================
-- BANK RECONCILIATION
-- =====================================================
CREATE TABLE bank_reconciliation (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  bank_account_id UUID NOT NULL REFERENCES bank_accounts(id),
  statement_date DATE NOT NULL,
  statement_balance DECIMAL(15,2) NOT NULL,
  book_balance DECIMAL(15,2) NOT NULL,
  reconciled_balance DECIMAL(15,2),
  status VARCHAR(20) DEFAULT 'In_Progress', -- In_Progress, Completed
  reconciled_by INTEGER,
  reconciled_at TIMESTAMP,
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_bank_recon_account ON bank_reconciliation(bank_account_id);
CREATE INDEX idx_bank_recon_date ON bank_reconciliation(statement_date);

-- =====================================================
-- BANK STATEMENT IMPORTS
-- =====================================================
CREATE TABLE bank_statement_lines (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  reconciliation_id UUID REFERENCES bank_reconciliation(id),
  bank_account_id UUID NOT NULL REFERENCES bank_accounts(id),
  transaction_date DATE NOT NULL,
  description TEXT,
  reference_number VARCHAR(100),
  debit DECIMAL(15,2) DEFAULT 0,
  credit DECIMAL(15,2) DEFAULT 0,
  balance DECIMAL(15,2),
  matched_transaction_id UUID REFERENCES bank_transactions(id),
  is_matched BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_statement_recon ON bank_statement_lines(reconciliation_id);
CREATE INDEX idx_statement_matched ON bank_statement_lines(is_matched);

-- =====================================================
-- BUDGETS
-- =====================================================
CREATE TABLE budgets (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  budget_name VARCHAR(255) NOT NULL,
  fiscal_year INTEGER NOT NULL,
  account_id UUID NOT NULL REFERENCES chart_of_accounts(id),
  period_type VARCHAR(20) NOT NULL, -- Monthly, Quarterly, Yearly
  jan_amount DECIMAL(15,2) DEFAULT 0,
  feb_amount DECIMAL(15,2) DEFAULT 0,
  mar_amount DECIMAL(15,2) DEFAULT 0,
  apr_amount DECIMAL(15,2) DEFAULT 0,
  may_amount DECIMAL(15,2) DEFAULT 0,
  jun_amount DECIMAL(15,2) DEFAULT 0,
  jul_amount DECIMAL(15,2) DEFAULT 0,
  aug_amount DECIMAL(15,2) DEFAULT 0,
  sep_amount DECIMAL(15,2) DEFAULT 0,
  oct_amount DECIMAL(15,2) DEFAULT 0,
  nov_amount DECIMAL(15,2) DEFAULT 0,
  dec_amount DECIMAL(15,2) DEFAULT 0,
  total_amount DECIMAL(15,2) NOT NULL,
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_budgets_year ON budgets(fiscal_year);
CREATE INDEX idx_budgets_account ON budgets(account_id);

-- =====================================================
-- TICKETING SYSTEM
-- =====================================================
CREATE TABLE ticket_categories (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(100) NOT NULL,
  description TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO ticket_categories (name, description) VALUES
('Technical Support', 'IT and technical issues'),
('HR Query', 'HR related questions'),
('Finance', 'Finance and accounting queries'),
('Facilities', 'Office facilities and maintenance'),
('General', 'General inquiries');

-- =====================================================
-- SLA POLICIES
-- =====================================================
CREATE TABLE sla_policies (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(100) NOT NULL,
  priority VARCHAR(20) NOT NULL, -- Low, Medium, High, Critical
  response_time_hours INTEGER NOT NULL,
  resolution_time_hours INTEGER NOT NULL,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO sla_policies (name, priority, response_time_hours, resolution_time_hours) VALUES
('Critical SLA', 'Critical', 1, 4),
('High Priority SLA', 'High', 4, 24),
('Medium Priority SLA', 'Medium', 8, 48),
('Low Priority SLA', 'Low', 24, 120);

-- =====================================================
-- TICKETS
-- =====================================================
CREATE TABLE tickets (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  ticket_number VARCHAR(50) UNIQUE NOT NULL,
  subject VARCHAR(255) NOT NULL,
  description TEXT NOT NULL,
  category_id UUID REFERENCES ticket_categories(id),
  priority VARCHAR(20) DEFAULT 'Medium', -- Low, Medium, High, Critical
  status VARCHAR(20) DEFAULT 'Open', -- Open, In_Progress, Waiting, Resolved, Closed
  requester_type VARCHAR(20) NOT NULL, -- Employee, Customer
  requester_id INTEGER, -- employee_id or customer_id
  requester_name VARCHAR(255),
  requester_email VARCHAR(255),
  assigned_to INTEGER,
  sla_policy_id UUID REFERENCES sla_policies(id),
  response_due_at TIMESTAMP,
  resolution_due_at TIMESTAMP,
  first_response_at TIMESTAMP,
  resolved_at TIMESTAMP,
  closed_at TIMESTAMP,
  is_sla_breached BOOLEAN DEFAULT false,
  tags TEXT[],
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_tickets_status ON tickets(status);
CREATE INDEX idx_tickets_priority ON tickets(priority);
CREATE INDEX idx_tickets_assigned ON tickets(assigned_to);
CREATE INDEX idx_tickets_requester ON tickets(requester_type, requester_id);
CREATE INDEX idx_tickets_sla_breach ON tickets(is_sla_breached);

-- =====================================================
-- TICKET CONVERSATIONS
-- =====================================================
CREATE TABLE ticket_conversations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  ticket_id UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  is_internal BOOLEAN DEFAULT false,
  created_by INTEGER NOT NULL,
  created_by_name VARCHAR(255),
  attachments JSONB,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_ticket_conv_ticket ON ticket_conversations(ticket_id);
CREATE INDEX idx_ticket_conv_internal ON ticket_conversations(is_internal);

-- =====================================================
-- TICKET ATTACHMENTS
-- =====================================================
CREATE TABLE ticket_attachments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  ticket_id UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES ticket_conversations(id),
  file_name VARCHAR(255) NOT NULL,
  file_path VARCHAR(500) NOT NULL,
  file_size INTEGER,
  mime_type VARCHAR(100),
  uploaded_by INTEGER NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_ticket_attach_ticket ON ticket_attachments(ticket_id);
