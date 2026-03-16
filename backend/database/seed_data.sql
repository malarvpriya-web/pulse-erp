-- 1. Users & Roles
INSERT INTO users (id, name, email, password, role) VALUES
('u1', 'Admin User', 'admin@pulse.com', 'hashed_password', 'admin'),
('u2', 'HR Manager', 'hr@pulse.com', 'hashed_password', 'management'),
('u3', 'Finance Manager', 'finance@pulse.com', 'hashed_password', 'management'),
('u4', 'John Doe', 'john@pulse.com', 'hashed_password', 'employee'),
('u5', 'Jane Smith', 'jane@pulse.com', 'hashed_password', 'employee'),
('u6', 'Sales Lead', 'sales@pulse.com', 'hashed_password', 'employee'),
('u7', 'Service Eng', 'service@pulse.com', 'hashed_password', 'employee');

-- 2. Employees
INSERT INTO employees (id, user_id, first_name, last_name, company_email, designation, department, joining_date, status, reporting_manager_id) VALUES
('e1', 'u1', 'Admin', 'User', 'admin@pulse.com', 'CEO', 'Executive', '2020-01-01', 'Active', NULL),
('e2', 'u2', 'HR', 'Manager', 'hr@pulse.com', 'HR Director', 'HR', '2020-02-01', 'Active', 'e1'),
('e3', 'u3', 'Finance', 'Manager', 'finance@pulse.com', 'CFO', 'Finance', '2020-03-01', 'Active', 'e1'),
('e4', 'u4', 'John', 'Doe', 'john@pulse.com', 'Senior Developer', 'Engineering', '2021-05-15', 'Active', 'e1'),
('e5', 'u5', 'Jane', 'Smith', 'jane@pulse.com', 'Product Designer', 'Design', '2021-06-20', 'Active', 'e1'),
('e6', 'u6', 'Sales', 'Lead', 'sales@pulse.com', 'Sales Manager', 'Sales', '2021-01-10', 'Active', 'e1'),
('e7', 'u7', 'Service', 'Eng', 'service@pulse.com', 'Field Engineer', 'Service', '2022-03-15', 'Active', 'e4');

-- 3. Finance: Parties
INSERT INTO parties (id, name, type, email, phone) VALUES
('p1', 'Acme Corp', 'customer', 'contact@acme.com', '555-0101'),
('p2', 'Globex Inc', 'supplier', 'supply@globex.com', '555-0102'),
('p3', 'TechStart', 'customer', 'info@techstart.com', '555-0103');

-- 4. Finance: Invoices
INSERT INTO invoices (id, customer_id, invoice_date, due_date, total_amount, status) VALUES
('inv1', 'p1', CURRENT_DATE - INTERVAL '30 days', CURRENT_DATE, 5000.00, 'Paid'),
('inv2', 'p3', CURRENT_DATE - INTERVAL '15 days', CURRENT_DATE + INTERVAL '15 days', 2500.00, 'Unpaid'),
('inv3', 'p1', CURRENT_DATE - INTERVAL '45 days', CURRENT_DATE - INTERVAL '15 days', 7500.00, 'Overdue');

-- 5. Inventory: Items
INSERT INTO items (id, name, sku, category, stock_quantity, reorder_level, unit_price) VALUES
('i1', 'Laptop Dell XPS', 'DELL-XPS-15', 'Electronics', 15, 5, 1200.00),
('i2', 'Monitor 27"', 'MON-27-4K', 'Electronics', 8, 10, 350.00),
('i3', 'Ergonomic Chair', 'CHR-ERGO-01', 'Furniture', 50, 5, 250.00);

-- 6. Projects
INSERT INTO projects (id, name, client_id, start_date, end_date, status, manager_id) VALUES
('prj1', 'Website Redesign', 'p1', CURRENT_DATE - INTERVAL '30 days', CURRENT_DATE + INTERVAL '60 days', 'In Progress', 'e4'),
('prj2', 'Mobile App Dev', 'p3', CURRENT_DATE + INTERVAL '10 days', CURRENT_DATE + INTERVAL '120 days', 'Planning', 'e4');

-- 7. CRM: Leads
INSERT INTO leads (id, name, company, email, status, assigned_to) VALUES
('l1', 'Alice Wonderland', 'Wonder Corp', 'alice@wonder.com', 'New', 'e6'),
('l2', 'Bob Builder', 'BuildIt', 'bob@buildit.com', 'Qualified', 'e6');

-- 8. Ticketing
INSERT INTO tickets (id, subject, description, status, priority, requester_id, assigned_to) VALUES
('t1', 'Laptop Overheating', 'My laptop shuts down randomly', 'Open', 'High', 'e5', 'e7'),
('t2', 'Software License', 'Need Adobe license', 'Resolved', 'Medium', 'e6', 'e1');

-- 9. Travel Requests
INSERT INTO travel_requests (id, employee_id, destination, start_date, end_date, status, estimated_cost) VALUES
('tr1', 'e6', 'New York, USA', CURRENT_DATE + INTERVAL '10 days', CURRENT_DATE + INTERVAL '15 days', 'Approved', 2500.00),
('tr2', 'e4', 'London, UK', CURRENT_DATE + INTERVAL '20 days', CURRENT_DATE + INTERVAL '25 days', 'Pending', 3000.00);

-- 10. Announcements
INSERT INTO announcements (id, title, message, from_date, to_date, is_active) VALUES
('a1', 'Office Renovation', 'The 2nd floor will be closed for renovation next week.', CURRENT_DATE, CURRENT_DATE + INTERVAL '7 days', true),
('a2', 'Holiday Party', 'Annual party coming up!', CURRENT_DATE + INTERVAL '5 days', CURRENT_DATE + INTERVAL '20 days', true);

-- 11. Events
-- Assuming table exists or created by backend
INSERT INTO events (id, title, description, event_date, event_type, department) VALUES
('ev1', 'Q4 Town Hall', 'All hands meeting for Q4 updates', CURRENT_DATE + INTERVAL '3 days', 'meeting', 'All'),
('ev2', 'Fire Safety Training', 'Mandatory training for all staff', CURRENT_DATE + INTERVAL '10 days', 'training', 'Operations'),
('ev3', 'Diwali Celebration', 'Office celebration and lunch', CURRENT_DATE + INTERVAL '15 days', 'holiday', 'All');

-- 12. Policies
INSERT INTO policies (id, name, version, category, updated_date, file_url, status) VALUES
('pol1', 'Leave Policy', 'v2.1', 'Leave', CURRENT_DATE - INTERVAL '60 days', '/files/leave_policy_v2.pdf', 'active'),
('pol2', 'IT Security Policy', 'v1.0', 'Attendance', CURRENT_DATE - INTERVAL '120 days', '/files/it_security.pdf', 'active'),
('pol3', 'Travel Guidelines', 'v1.2', 'Travel', CURRENT_DATE - INTERVAL '30 days', '/files/travel_policy.pdf', 'active'),
('pol4', 'Uniform Code', 'v3.0', 'Uniform', CURRENT_DATE - INTERVAL '10 days', '/files/uniform_code.pdf', 'active');

-- 13. Downloads
INSERT INTO downloads (id, name, category, file_url, updated_date, is_active) VALUES
('dl1', 'Organization Chart', 'org chart', '/files/org_chart_2023.pdf', CURRENT_DATE - INTERVAL '5 days', true),
('dl2', 'Salary Slip Template', 'template', '/files/salary_slip.xlsx', CURRENT_DATE - INTERVAL '200 days', true),
('dl3', 'Company Logo (High Res)', 'logo', '/files/logo_hd.png', CURRENT_DATE - INTERVAL '365 days', true),
('dl4', 'Expense Claim Form', 'template', '/files/expense_form.docx', CURRENT_DATE - INTERVAL '100 days', true),
('dl5', 'Holiday Calendar 2026', 'holiday calendar', '/files/holidays_2026.pdf', CURRENT_DATE - INTERVAL '60 days', true);

-- 14. Holidays
INSERT INTO holidays (id, name, date) VALUES
('h1', 'New Year', DATE_TRUNC('year', CURRENT_DATE) + INTERVAL '0 days'),
('h2', 'Republic Day', DATE_TRUNC('year', CURRENT_DATE) + INTERVAL '25 days'),
('h3', 'Holi', CURRENT_DATE + INTERVAL '15 days'),
('h4', 'Independence Day', DATE_TRUNC('year', CURRENT_DATE) + INTERVAL '226 days'),
('h5', 'Diwali', CURRENT_DATE + INTERVAL '200 days');

-- 14. Update Employees for Celebrations (Ensure dates match "today" for testing if needed)
-- Note: In a real app, dates are fixed. For demo, we might need dynamic dates or just rely on the logic.
UPDATE employees SET dob = CURRENT_DATE WHERE id = 'e4'; -- John Doe Birthday today
UPDATE employees SET joining_date = CURRENT_DATE - INTERVAL '2 years' WHERE id = 'e5'; -- Jane Smith Work Anniversary