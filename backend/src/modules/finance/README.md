# Finance Module Documentation

## Overview
Complete double-entry accounting system with modern scalable architecture designed for 10+ years maintainability.

## Architecture

### Backend Structure
```
backend/src/modules/finance/
├── routes/           # REST API endpoints
├── controllers/      # Request handlers
├── services/         # Business logic layer
├── repositories/     # Data access layer
├── validators/       # Input validation
├── dtos/            # Data transfer objects
└── db.js            # Database connection
```

### Database Design
- **UUID Primary Keys**: All business tables use UUID for scalability
- **Soft Deletes**: deleted_at column for data retention
- **Audit Trail**: created_at, updated_at timestamps
- **Double-Entry**: Every transaction creates balanced journal entries
- **Indexing**: Optimized queries with proper indexes

## Database Tables

### Core Tables
1. **chart_of_accounts** - Account hierarchy (Asset, Liability, Equity, Revenue, Expense)
2. **parties** - Unified customers and suppliers
3. **journal_entries** - Transaction headers
4. **journal_entry_lines** - Transaction details (debit/credit)
5. **invoices** - Customer invoices
6. **invoice_items** - Invoice line items
7. **bills** - Supplier bills
8. **bill_items** - Bill line items
9. **payments** - Supplier payments
10. **payment_allocations** - Payment to bill mapping
11. **receipts** - Customer receipts
12. **receipt_allocations** - Receipt to invoice mapping
13. **expense_claims** - Employee expense claims
14. **expense_claim_items** - Expense details
15. **financial_periods** - Period locking
16. **finance_audit_log** - Complete audit trail

## API Endpoints

### Chart of Accounts
- `POST /api/finance/accounts` - Create account
- `GET /api/finance/accounts` - List all accounts
- `GET /api/finance/accounts/tree` - Get account hierarchy
- `PUT /api/finance/accounts/:id` - Update account
- `DELETE /api/finance/accounts/:id` - Soft delete account

### Parties (Customers & Suppliers)
- `POST /api/finance/parties` - Create party
- `GET /api/finance/parties` - List parties (filter by type)
- `GET /api/finance/parties/:id` - Get party details
- `GET /api/finance/parties/:id/outstanding` - Get outstanding balance
- `PUT /api/finance/parties/:id` - Update party

### Invoices
- `POST /api/finance/invoices` - Create invoice (auto-creates journal entry)
- `GET /api/finance/invoices` - List invoices (with filters)
- `GET /api/finance/invoices/:id` - Get invoice with items
- `GET /api/finance/invoices/overdue` - Get overdue invoices
- `GET /api/finance/invoices/due-soon?days=7` - Get invoices due soon

### Bills
- `POST /api/finance/bills` - Create bill
- `GET /api/finance/bills` - List bills (with filters)
- `GET /api/finance/bills/:id` - Get bill with items
- `POST /api/finance/bills/:id/approve` - Approve bill (creates journal entry)
- `GET /api/finance/bills/due-soon?days=7` - Get bills due soon

### Payments & Receipts
- `POST /api/finance/payments` - Record payment (creates journal entry)
- `GET /api/finance/payments` - List payments
- `POST /api/finance/receipts` - Record receipt (creates journal entry)
- `GET /api/finance/receipts` - List receipts

### Expense Claims
- `POST /api/finance/expenses` - Create expense claim
- `GET /api/finance/expenses` - List expense claims
- `GET /api/finance/expenses/:id` - Get expense with items
- `POST /api/finance/expenses/:id/approve` - Approve expense
- `POST /api/finance/expenses/:id/reject` - Reject expense

### Journal & Ledger
- `GET /api/finance/journal/general-ledger?account_id=&start_date=&end_date=` - General ledger
- `GET /api/finance/journal/trial-balance?start_date=&end_date=` - Trial balance

### Reports
- `GET /api/finance/reports/profit-loss?start_date=&end_date=` - P&L Statement
- `GET /api/finance/reports/balance-sheet?as_of_date=` - Balance Sheet
- `GET /api/finance/reports/cash-flow?start_date=&end_date=` - Cash Flow
- `GET /api/finance/reports/customer-outstanding` - Customer outstanding
- `GET /api/finance/reports/supplier-outstanding` - Supplier outstanding
- `GET /api/finance/dashboard` - Finance dashboard with KPIs and alerts

## Frontend Pages

### 1. Finance Dashboard
- Monthly revenue/expenses KPIs
- Net profit calculation
- Overdue invoices alert
- Due soon notifications (7 days advance)
- Pending approvals count
- Real-time alerts with color coding

### 2. Chart of Accounts
- Tree view of account hierarchy
- Create new accounts with parent selection
- Account type grouping (Asset, Liability, Equity, Revenue, Expense)
- Active/Inactive status management

### 3. Customers & Suppliers (Parties)
- Unified party management
- Auto-generated party codes (CUST001, SUPP001)
- Credit limit and payment terms
- Filter by party type
- Contact information management

### 4. Invoices
- Create invoices with multiple line items
- Auto-calculation of subtotal, tax, total
- Account mapping (AR, Revenue, Tax)
- Status tracking (Draft, Sent, Paid, Overdue)
- Filter by status and customer
- Due date tracking

### 5. Bills
- Create supplier bills
- Approval workflow
- Payment tracking
- Due date alerts

### 6. Payments & Receipts
- Record payments to suppliers
- Record receipts from customers
- Allocate to multiple invoices/bills
- Payment method tracking

### 7. Expense Claims
- Employee expense submission
- Multi-item expenses
- Receipt upload support
- Approval/rejection workflow

### 8. Reports
- Profit & Loss Statement
- Balance Sheet
- Customer Outstanding Report
- Supplier Outstanding Report
- Date range filtering
- Export capabilities

## Key Features

### Double-Entry Accounting
Every transaction automatically creates balanced journal entries:
- **Invoice**: DR Accounts Receivable, CR Revenue + Tax
- **Bill**: DR Expense + Tax, CR Accounts Payable
- **Payment**: DR Accounts Payable, CR Bank
- **Receipt**: DR Bank, CR Accounts Receivable

### Alerts System
- Overdue invoices (past due date)
- Due soon alerts (7 days advance warning)
- Bill payment reminders
- Pending approval notifications

### Security
- JWT authentication required for all endpoints
- Role-based access control ready
- Audit logging for all transactions
- Soft deletes for data retention

### Data Integrity
- Database transactions for multi-table operations
- Foreign key constraints
- Validation at service layer
- Automatic number generation (INV0001, BILL0001, etc.)

## Setup Instructions

### 1. Database Setup
```bash
# Run the schema creation script
psql -U postgres -d Pulse -f backend/database/finance-schema.sql
```

### 2. Backend Setup
```bash
cd backend
npm install
# Ensure .env has correct database credentials
npm start
```

### 3. Frontend Setup
```bash
cd frontend
npm install
npm run dev
```

## Usage Examples

### Create Invoice
```javascript
POST /api/finance/invoices
{
  "customer_id": "uuid",
  "invoice_date": "2024-01-15",
  "due_date": "2024-02-15",
  "items": [
    {
      "description": "Consulting Services",
      "quantity": 10,
      "unit_price": 100,
      "tax_rate": 10,
      "amount": 1100
    }
  ],
  "accounts_receivable_id": "uuid",
  "revenue_account_id": "uuid",
  "tax_account_id": "uuid",
  "notes": "Monthly consulting"
}
```

### Record Receipt
```javascript
POST /api/finance/receipts
{
  "customer_id": "uuid",
  "receipt_date": "2024-01-20",
  "amount": 1100,
  "payment_method": "Bank Transfer",
  "reference_number": "TXN123456",
  "allocations": [
    {
      "invoice_id": "uuid",
      "amount": 1100
    }
  ],
  "bank_account_id": "uuid",
  "accounts_receivable_id": "uuid"
}
```

## Best Practices

1. **Always use transactions** for operations that modify multiple tables
2. **Validate input** at service layer before database operations
3. **Use repository pattern** for all database queries
4. **Log all financial transactions** in audit table
5. **Lock financial periods** after month-end closing
6. **Regular backups** of financial data
7. **Test journal entries** balance before posting

## Future Enhancements

1. Multi-currency support
2. Bank reconciliation
3. Recurring invoices
4. Payment gateway integration
5. Advanced reporting with charts
6. Budget management
7. Fixed asset depreciation
8. Tax filing reports
9. Email notifications for due dates
10. Mobile app support

## Maintenance

### Database Maintenance
- Regular VACUUM and ANALYZE
- Index monitoring and optimization
- Archive old transactions annually
- Backup before period closing

### Code Maintenance
- Follow existing patterns for new features
- Update audit logs for new tables
- Maintain test coverage
- Document API changes

## Support

For issues or questions:
1. Check audit logs for transaction history
2. Verify journal entries balance
3. Review error logs in backend
4. Test with sample data first

## License
Proprietary - Internal Use Only
