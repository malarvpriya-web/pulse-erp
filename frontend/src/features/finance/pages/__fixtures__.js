// Sample data for Finance pages — used as fallbacks in development only.
// Each component imports what it needs and guards with import.meta.env.DEV.

// ── BankAccounts ──────────────────────────────────────────────────────────────
export const SAMPLE_ACCOUNTS = [
  {
    id:1, account_name:'HDFC Current Account', bank:'HDFC Bank',
    account_number:'50200012345678', ifsc:'HDFC0001234',
    account_type:'current', currency:'INR',
    balance:125000, book_balance:122800,
    unreconciled:3, last_reconciled:'2026-02-28',
    is_active:true, color:'#2563eb',
    transactions:[
      {id:1,  date:'2026-03-14', desc:'Payment to Vendor',       ref:'NEFT001', debit:28000,  credit:0,      balance:125000, type:'debit',  matched:true},
      {id:2,  date:'2026-03-13', desc:'Client Receipt',          ref:'RTGS002', debit:0,      credit:85000,  balance:153000, type:'credit', matched:true},
      {id:3,  date:'2026-03-12', desc:'Salary Transfer',         ref:'NEFT003', debit:110000, credit:0,      balance:68000,  type:'debit',  matched:true},
      {id:4,  date:'2026-03-11', desc:'Cloud Services Payment',  ref:'UPI004',  debit:28000,  credit:0,      balance:178000, type:'debit',  matched:false},
      {id:5,  date:'2026-03-10', desc:'Invoice Payment Received',ref:'RTGS005', debit:0,      credit:45000,  balance:206000, type:'credit', matched:false},
      {id:6,  date:'2026-03-09', desc:'Office Rent',             ref:'CHQ006',  debit:22000,  credit:0,      balance:161000, type:'debit',  matched:false},
      {id:7,  date:'2026-03-08', desc:'TDS Refund',              ref:'NEFT007', debit:0,      credit:12000,  balance:183000, type:'credit', matched:true},
    ]
  },
  {
    id:2, account_name:'ICICI Current Account', bank:'ICICI Bank',
    account_number:'001234567890', ifsc:'ICIC0000123',
    account_type:'current', currency:'INR',
    balance:87000, book_balance:87000,
    unreconciled:0, last_reconciled:'2026-03-10',
    is_active:true, color:'#6B3FDB',
    transactions:[
      {id:8,  date:'2026-03-12', desc:'Marketing Campaign',     ref:'NEFT008', debit:35000, credit:0,      balance:87000,  type:'debit',  matched:true},
      {id:9,  date:'2026-03-10', desc:'Project Advance',        ref:'RTGS009', debit:0,     credit:120000, balance:122000, type:'credit', matched:true},
      {id:10, date:'2026-03-08', desc:'Software License',       ref:'UPI010',  debit:15000, credit:0,      balance:2000,   type:'debit',  matched:true},
    ]
  },
  {
    id:3, account_name:'SBI Savings Account', bank:'State Bank of India',
    account_number:'31234567890123', ifsc:'SBIN0001234',
    account_type:'savings', currency:'INR',
    balance:42000, book_balance:41500,
    unreconciled:1, last_reconciled:'2026-03-01',
    is_active:true, color:'#059669',
    transactions:[
      {id:11, date:'2026-03-05', desc:'Interest Credit',       ref:'INT001',  debit:0,    credit:500,   balance:42000, type:'credit', matched:false},
      {id:12, date:'2026-03-01', desc:'Expense Reimbursement', ref:'NEFT011', debit:3000, credit:0,     balance:41500, type:'debit',  matched:true},
    ]
  },
  {
    id:4, account_name:'Petty Cash', bank:'Internal',
    account_number:'CASH-001', ifsc:'—',
    account_type:'cash', currency:'INR',
    balance:8500, book_balance:8500,
    unreconciled:0, last_reconciled:'2026-03-15',
    is_active:true, color:'#d97706',
    transactions:[
      {id:13, date:'2026-03-15', desc:'Stationery Purchase', ref:'PC001', debit:1200, credit:0,    balance:8500, type:'debit',  matched:true},
      {id:14, date:'2026-03-14', desc:'Cash Top-up',         ref:'PC002', debit:0,    credit:5000, balance:9700, type:'credit', matched:true},
    ]
  },
];

// ── Parties ───────────────────────────────────────────────────────────────────
export const SAMPLE_PARTIES = [
  {
    id:1, party_code:'C-001', party_type:'Customer', name:'TechCorp Solutions Ltd',
    contact_person:'Rajesh Kumar', email:'rajesh@techcorp.com', phone:'+91 98765 43210',
    address:'123 MG Road, Bangalore 560001', gstin:'29AABCT1332L1ZX',
    pan:'AABCT1332L', credit_limit:500000, payment_terms:30,
    outstanding_balance:112000, total_invoiced:680000, total_paid:568000,
    is_active:true, created_at:'2024-01-15',
    transactions:[
      {date:'2026-03-01',ref:'INV-012',type:'Invoice', amount:125000,balance:125000},
      {date:'2026-02-28',ref:'REC-089',type:'Receipt', amount:-90000, balance:35000},
      {date:'2026-02-15',ref:'INV-008',type:'Invoice', amount:87000, balance:122000},
    ]
  },
  {
    id:2, party_code:'C-002', party_type:'Customer', name:'Alpha Manufacturing Co',
    contact_person:'Priya Sharma', email:'priya@alphamfg.com', phone:'+91 87654 32109',
    address:'456 Industrial Area, Pune 411001', gstin:'27AACCA5736A1ZK',
    pan:'AACCA5736A', credit_limit:300000, payment_terms:45,
    outstanding_balance:68000, total_invoiced:420000, total_paid:352000,
    is_active:true, created_at:'2024-03-20',
    transactions:[
      {date:'2026-03-05',ref:'INV-014',type:'Invoice', amount:68000,balance:68000},
      {date:'2026-02-20',ref:'REC-091',type:'Receipt', amount:-75000,balance:0},
    ]
  },
  {
    id:3, party_code:'S-001', party_type:'Supplier', name:'Office Supplies Pvt Ltd',
    contact_person:'Mohan Das', email:'mohan@officesupplies.com', phone:'+91 76543 21098',
    address:'789 Nehru Street, Chennai 600001', gstin:'33AABCO1234M1ZP',
    pan:'AABCO1234M', credit_limit:0, payment_terms:30,
    outstanding_balance:28000, total_invoiced:0, total_paid:0,
    total_billed:165000, total_paid_out:137000,
    is_active:true, created_at:'2024-02-10',
    transactions:[
      {date:'2026-03-10',ref:'BILL-023',type:'Bill',   amount:28000, balance:28000},
      {date:'2026-02-28',ref:'PAY-056', type:'Payment',amount:-45000,balance:0},
    ]
  },
  {
    id:4, party_code:'S-002', party_type:'Supplier', name:'Cloud Services Ltd',
    contact_person:'Anita Reddy', email:'anita@cloudserv.com', phone:'+91 65432 10987',
    address:'321 IT Park, Hyderabad 500001', gstin:'36AACCC5431B1Z9',
    pan:'AACCC5431B', credit_limit:0, payment_terms:15,
    outstanding_balance:56000, total_billed:280000, total_paid_out:224000,
    is_active:true, created_at:'2024-04-05',
    transactions:[
      {date:'2026-03-01',ref:'BILL-019',type:'Bill',   amount:28000,balance:28000},
      {date:'2026-02-01',ref:'BILL-015',type:'Bill',   amount:28000,balance:56000},
      {date:'2026-01-31',ref:'PAY-051', type:'Payment',amount:-28000,balance:0},
    ]
  },
  {
    id:5, party_code:'B-001', party_type:'Both', name:'Global Trade Partners',
    contact_person:'Vijay Nair', email:'vijay@globaltrade.com', phone:'+91 54321 09876',
    address:'654 Bandra Complex, Mumbai 400001', gstin:'27AABCG4521K1ZQ',
    pan:'AABCG4521K', credit_limit:200000, payment_terms:30,
    outstanding_balance:45000, total_invoiced:320000, total_paid:275000,
    total_billed:140000, total_paid_out:95000,
    is_active:true, created_at:'2023-11-20',
    transactions:[]
  },
];

// ── PaymentBatch ──────────────────────────────────────────────────────────────
export const SAMPLE_BATCHES = [
  {
    id:1, batch_number:'PB-2026-1001', batch_date:'2026-03-12',
    status:'processed', total_amount:84000, payment_count:3,
    bank_account:'HDFC Current A/c ••4521',
    processed_by:'Finance Manager', processed_at:'2026-03-12',
    items:[
      {supplier:'Office Supplies Pvt Ltd', bill_ref:'BILL-2026-020', amount:22000, method:'neft', utr:'HDFC26031200001'},
      {supplier:'Cloud Services Ltd',      bill_ref:'BILL-2026-015', amount:28000, method:'rtgs', utr:'HDFC26031200002'},
      {supplier:'IT Equipment Suppliers',  bill_ref:'BILL-2026-019', amount:34000, method:'rtgs', utr:'HDFC26031200003'},
    ]
  },
  {
    id:2, batch_number:'PB-2026-1002', batch_date:'2026-03-08',
    status:'approved', total_amount:45000, payment_count:1,
    bank_account:'ICICI Current A/c ••7823',
    items:[
      {supplier:'Marketing Agency Co', bill_ref:'BILL-2026-021', amount:45000, method:'neft', utr:''},
    ]
  },
  {
    id:3, batch_number:'PB-2026-1003', batch_date:'2026-03-05',
    status:'pending_approval', total_amount:56000, payment_count:2,
    bank_account:'HDFC Current A/c ••4521',
    items:[
      {supplier:'Cloud Services Ltd',  bill_ref:'BILL-2026-022', amount:28000, method:'neft',  utr:''},
      {supplier:'Legal Associates LLP',bill_ref:'BILL-2026-018', amount:28000, method:'cheque',utr:'CHQ-001234'},
    ]
  },
  {
    id:4, batch_number:'PB-2026-1004', batch_date:'2026-03-15',
    status:'draft', total_amount:28000, payment_count:1,
    bank_account:'HDFC Current A/c ••4521',
    items:[
      {supplier:'Office Supplies Pvt Ltd', bill_ref:'BILL-2026-023', amount:28000, method:'upi', utr:''},
    ]
  },
];

export const SAMPLE_BANK_ACCOUNTS = [
  {id:1, account_name:'HDFC Current A/c',  account_number:'XXXX4521', balance:125000, bank:'HDFC Bank'},
  {id:2, account_name:'ICICI Current A/c', account_number:'XXXX7823', balance:87000,  bank:'ICICI Bank'},
  {id:3, account_name:'SBI Savings A/c',   account_number:'XXXX3190', balance:42000,  bank:'State Bank of India'},
];

export const SAMPLE_SUPPLIERS = [
  {id:1, name:'Office Supplies Pvt Ltd', outstanding:28000,
   bills:[{id:1,bill_number:'BILL-2026-023',balance:28000}]},
  {id:2, name:'Cloud Services Ltd',      outstanding:56000,
   bills:[{id:2,bill_number:'BILL-2026-022',balance:28000},{id:5,bill_number:'BILL-2026-016',balance:28000}]},
  {id:3, name:'Marketing Agency Co',     outstanding:45000,
   bills:[{id:3,bill_number:'BILL-2026-021',balance:45000}]},
  {id:4, name:'IT Equipment Suppliers',  outstanding:0,     bills:[]},
  {id:5, name:'Legal Associates LLP',    outstanding:28000,
   bills:[{id:4,bill_number:'BILL-2026-018',balance:28000}]},
];

// ── SupplierBills ─────────────────────────────────────────────────────────────
export const SAMPLE_BILLS = [
  {
    id:1, bill_number:'BILL-2026-023', supplier_name:'Office Supplies Pvt Ltd',
    bill_date:'2026-03-10', due_date:'2026-04-09', status:'pending',
    total_amount:28000, balance:28000, tax_amount:4272, subtotal:23728,
    payment_terms:30, items:[
      {description:'Office Stationery',quantity:50,unit_price:320,gst_rate:18,taxable_amount:16000,gst_amount:2880,amount:18880},
      {description:'Printer Paper A4', quantity:20,unit_price:448,gst_rate:12,taxable_amount:8960,gst_amount:1075,amount:10035},
    ]
  },
  {
    id:2, bill_number:'BILL-2026-022', supplier_name:'Cloud Services Ltd',
    bill_date:'2026-03-01', due_date:'2026-03-16', status:'overdue',
    total_amount:56000, balance:56000, tax_amount:8543, subtotal:47457,
    payment_terms:15, items:[
      {description:'Cloud Hosting — March',quantity:1,unit_price:28000,gst_rate:18,taxable_amount:28000,gst_amount:5040,amount:33040},
      {description:'Storage Subscription', quantity:1,unit_price:19457,gst_rate:18,taxable_amount:19457,gst_amount:3502,amount:22959},
    ]
  },
  {
    id:3, bill_number:'BILL-2026-021', supplier_name:'Marketing Agency Co',
    bill_date:'2026-02-28', due_date:'2026-03-29', status:'approved',
    total_amount:45000, balance:45000, tax_amount:6864, subtotal:38136,
    payment_terms:30, items:[
      {description:'Digital Marketing Campaign',quantity:1,unit_price:38136,gst_rate:18,taxable_amount:38136,gst_amount:6864,amount:45000},
    ]
  },
  {
    id:4, bill_number:'BILL-2026-020', supplier_name:'Office Supplies Pvt Ltd',
    bill_date:'2026-02-15', due_date:'2026-03-16', status:'paid',
    total_amount:22000, balance:0, tax_amount:3356, subtotal:18644,
    payment_terms:30, items:[
      {description:'Ergonomic Chairs x4', quantity:4,unit_price:4661,gst_rate:18,taxable_amount:18644,gst_amount:3356,amount:22000},
    ]
  },
  {
    id:5, bill_number:'BILL-2026-019', supplier_name:'IT Equipment Suppliers',
    bill_date:'2026-02-10', due_date:'2026-02-25', status:'paid',
    total_amount:88000, balance:0, tax_amount:13424, subtotal:74576,
    payment_terms:15, items:[
      {description:'Laptop Dell i7',quantity:2,unit_price:37288,gst_rate:18,taxable_amount:74576,gst_amount:13424,amount:88000},
    ]
  },
];
