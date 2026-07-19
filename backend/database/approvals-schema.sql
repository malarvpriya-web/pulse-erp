-- Universal Approvals Table
CREATE TABLE IF NOT EXISTS approvals (
  id SERIAL PRIMARY KEY,
  -- Source module linkage
  module_name    VARCHAR(100),
  reference_id   INTEGER,
  reference_type VARCHAR(50),
  -- Display fields
  request_type   VARCHAR(50) NOT NULL,
  request_title  VARCHAR(255) NOT NULL,
  description    TEXT,
  requested_by   VARCHAR(255) NOT NULL,
  requester_name VARCHAR(255),
  requester_id   INTEGER,
  requester_email VARCHAR(255),
  department     VARCHAR(100),
  request_date   TIMESTAMP DEFAULT NOW(),
  amount         DECIMAL(15, 2),
  priority       VARCHAR(20) DEFAULT 'Medium',
  status         VARCHAR(20) DEFAULT 'Pending',
  approver_id    INTEGER,
  decision_date  TIMESTAMP,
  comments       TEXT,
  attachments    TEXT,
  metadata       JSONB,
  -- Multi-tenant
  company_id     INTEGER,
  branch_id      INTEGER,
  created_at     TIMESTAMP DEFAULT NOW(),
  updated_at     TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_approvals_approver  ON approvals(approver_id);
CREATE INDEX IF NOT EXISTS idx_approvals_status    ON approvals(status);
CREATE INDEX IF NOT EXISTS idx_approvals_type      ON approvals(request_type);
CREATE INDEX IF NOT EXISTS idx_approvals_date      ON approvals(request_date);
CREATE INDEX IF NOT EXISTS idx_approvals_company   ON approvals(company_id);
CREATE INDEX IF NOT EXISTS idx_approvals_module    ON approvals(module_name, reference_id);

-- Approval Chain: multi-step approval workflow steps per approval record
CREATE TABLE IF NOT EXISTS approval_chain (
  id           SERIAL PRIMARY KEY,
  approval_id  INTEGER NOT NULL REFERENCES approvals(id) ON DELETE CASCADE,
  step_order   INTEGER NOT NULL DEFAULT 1,
  approver_name VARCHAR(255),
  approver     VARCHAR(255),
  approver_id  INTEGER,
  status       VARCHAR(20) DEFAULT 'Pending',
  decision_date TIMESTAMP,
  comment      TEXT,
  created_at   TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_approval_chain_approval ON approval_chain(approval_id);

-- Sample data
INSERT INTO approvals (request_type, request_title, description, requested_by, requester_email, department, amount, priority) VALUES
('Leave', 'Annual Leave - 5 days', 'Family vacation', 'John Doe', 'john@company.com', 'IT', NULL, 'Medium'),
('Expense', 'Client Dinner Expense', 'Dinner with ABC Corp client', 'Jane Smith', 'jane@company.com', 'Sales', 450.00, 'High'),
('Purchase', 'New Laptops - 10 units', 'Replacement for old hardware', 'Mike Johnson', 'mike@company.com', 'IT', 15000.00, 'High'),
('Travel', 'Conference Travel - NYC', 'Tech conference attendance', 'Sarah Williams', 'sarah@company.com', 'Marketing', 2500.00, 'Medium'),
('Payment', 'Vendor Payment - ABC Supplies', 'Monthly supplies payment', 'Finance Team', 'finance@company.com', 'Finance', 8500.00, 'High'),
('Timesheet', 'Overtime Hours - Week 12', '15 hours overtime', 'Tom Brown', 'tom@company.com', 'Production', NULL, 'Low');
