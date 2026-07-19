import { useState, useEffect, useRef, useCallback } from 'react';
import { Search, X, ArrowRight, Zap } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { canRoleAccessAdminOnlyPage, canEmployeeAccessPage } from '@/config/menuCatalog';

const SEARCHABLE_PAGES = [
  // Core
  { page: 'Home',                label: 'Home',                       category: 'Dashboard' },
  { page: 'AdminDashboard',      label: 'Operations Dashboard',       category: 'Dashboard' },
  { page: 'AdminDashboard',      label: 'Team Ops',                   category: 'Dashboard' },
  { page: 'EmployeeDashboard',   label: 'My Dashboard',               category: 'Dashboard' },
  // Analytics & AI
  { page: 'CeoDashboard',        label: 'CEO Dashboard',              category: 'Analytics' },
  { page: 'HRDashboard',          label: 'HR Analytics',               category: 'Analytics' },
  { page: 'SystemHealth',        label: 'System Health',              category: 'Admin' },
  { page: 'EngineeringDev',      label: 'Engineering Development',    category: 'Engineering' },
  // Employees
  { page: 'EmployeesDashboard',  label: 'Employees Dashboard',        category: 'Employees' },
  { page: 'EmployeesData',       label: 'Employees Data',             category: 'Employees' },
  { page: 'AddEmployee',         label: 'Add Employee',               category: 'Employees' },
  { page: 'EmployeeProfile',     label: 'Employee Profile',           category: 'Employees' },
  { page: 'ExEmployees',         label: 'Ex-Employees',               category: 'Employees' },
  // HR
  { page: 'Announcements',       label: 'Announcements',              category: 'HR' },
  { page: 'Payroll',             label: 'Payroll',                    category: 'HR' },
  { page: 'PayslipViewer',       label: 'Payslip Viewer',             category: 'HR' },
  { page: 'Probation',           label: 'Probation',                  category: 'HR' },
  { page: 'HolidayCalendar',     label: 'Holiday Calendar',           category: 'HR' },
  { page: 'Policies',            label: 'Policies',                   category: 'HR' },
  { page: 'Downloads',           label: 'Downloads',                  category: 'HR' },
  { page: 'Shifts',              label: 'Shifts',                     category: 'HR' },
  { page: 'Offboarding',         label: 'Offboarding',                category: 'HR' },
  { page: 'EmployeeDirectory',   label: 'Employee Directory',         category: 'HR' },
  // Attendance
  { page: 'AttendanceDashboard', label: 'My Attendance',              category: 'Attendance' },
  { page: 'TeamAttendance',      label: 'Team Attendance',            category: 'Attendance' },
  { page: 'LateArrivals',        label: 'Late Arrivals',              category: 'Attendance' },
  // Leaves
  { page: 'MyLeaves',            label: 'My Leaves',                  category: 'Leaves' },
  { page: 'AllLeaves',           label: 'All Leaves',                 category: 'Leaves' },
  { page: 'ApplyLeave',          label: 'Apply Leave',                category: 'Leaves' },
  { page: 'LeaveApprovals',      label: 'Leave Approvals',            category: 'Leaves' },
  { page: 'LeaveCalendar',       label: 'Leave Calendar',             category: 'Leaves' },
  { page: 'LeaveSettings',       label: 'Leave Settings',             category: 'Leaves' },
  { page: 'TeamLeaves',          label: 'Team Leaves',                category: 'Leaves' },
  // Finance
  { page: 'FinanceDashboardNew', label: 'Finance Dashboard',          category: 'Finance' },
  { page: 'CFODashboard',        label: 'CFO Dashboard',              category: 'Finance' },
  { page: 'ChartOfAccounts',     label: 'Chart of Accounts',          category: 'Finance' },
  { page: 'AccountingEngine',    label: 'Accounting Engine',          category: 'Finance' },
  { page: 'BudgetManagement',    label: 'Budget Management',          category: 'Finance' },
  { page: 'TDSManagement',       label: 'TDS Management',             category: 'Finance' },
  { page: 'TCSManagement',       label: 'TCS Management',             category: 'Finance' },
  { page: 'JournalEntry',        label: 'Journal Entry',              category: 'Finance' },
  { page: 'Parties',             label: 'Customers & Suppliers',      category: 'Finance' },
  { page: 'InvoicesNew',         label: 'Invoices',                   category: 'Finance' },
  { page: 'SupplierBills',       label: 'Supplier Bills',             category: 'Finance' },
  { page: 'PaymentBatch',        label: 'Payment Batches',            category: 'Finance' },
  { page: 'BankAccounts',        label: 'Bank Accounts',              category: 'Finance' },
  { page: 'FinancialRatios',     label: 'Financial Ratios',           category: 'Finance' },
  { page: 'GSTModule',           label: 'GST & Tax',                  category: 'Finance' },
  { page: 'BudgetVsActuals',     label: 'Budget vs Actuals',          category: 'Finance' },
  { page: 'FinanceReports',      label: 'Finance Reports',            category: 'Finance' },
  // CRM
  { page: 'SalesDashboard',      label: 'CRM Dashboard',              category: 'CRM' },
  { page: 'Leads',               label: 'Leads',                      category: 'CRM' },
  { page: 'Accounts',            label: 'Accounts',                   category: 'CRM' },
  { page: 'Contacts',            label: 'Contacts',                   category: 'CRM' },
  { page: 'OpportunitiesKanban', label: 'Opportunities',              category: 'CRM' },
  // Sales
  { page: 'Quotations',          label: 'Quotations',                 category: 'Sales' },
  { page: 'SalesOrders',         label: 'Sales Orders',               category: 'Sales' },
  { page: 'SalesTargets',        label: 'Sales Targets',              category: 'Sales' },
  { page: 'SalesForecasts',      label: 'Sales Forecasts',            category: 'Sales' },
  { page: 'SalesCalendar',       label: 'Sales Calendar',             category: 'Sales' },
  { page: 'Competitors',         label: 'Competitors',                category: 'Sales' },
  // Inventory
  { page: 'InventoryDashboard',  label: 'Inventory Dashboard',        category: 'Inventory' },
  { page: 'ItemMaster',          label: 'Item Master',                category: 'Inventory' },
  { page: 'StockSummary',        label: 'Stock Summary',              category: 'Inventory' },
  { page: 'StockMovements',      label: 'Stock Movements',            category: 'Inventory' },
  { page: 'BatchTracking',       label: 'Batch Tracking',             category: 'Inventory' },
  { page: 'StockAlertsAndSuggestions', label: 'Stock Alerts',        category: 'Inventory' },
  // Procurement
  { page: 'PurchaseRequestDashboard', label: 'Purchase Requests',    category: 'Procurement' },
  { page: 'VendorManagement',    label: 'Vendor Management',          category: 'Procurement' },
  { page: 'PurchaseOrders',      label: 'Purchase Orders',            category: 'Procurement' },
  { page: 'GoodsReceipt',        label: 'Goods Receipt',              category: 'Procurement' },
  // Projects
  { page: 'ProjectsDashboard',   label: 'Projects Dashboard',         category: 'Projects' },
  { page: 'Projects',            label: 'Projects',                   category: 'Projects' },
  { page: 'KanbanBoard',         label: 'Task Board (Kanban)',         category: 'Projects' },
  { page: 'ProjectCosting',      label: 'Project Costing',            category: 'Projects' },
  // Timesheets
  { page: 'MyTimesheet',         label: 'My Timesheet',               category: 'Timesheets' },
  { page: 'Timesheets',          label: 'All Timesheets',             category: 'Timesheets' },
  { page: 'TimesheetApprovals',  label: 'Timesheet Approvals',        category: 'Timesheets' },
  { page: 'UtilizationReport',   label: 'Utilization Report',         category: 'Timesheets' },
  { page: 'WeeklyProductionReport', label: 'Weekly Production Report',category: 'Timesheets' },
  // Performance
  { page: 'PerformanceReviews',  label: 'Performance Reviews',        category: 'Performance' },
  { page: 'Goals',               label: 'Goals & KPIs',               category: 'Performance' },
  { page: 'TeamPerformance',     label: 'Team Performance',           category: 'Performance' },
  // Recruitment
  { page: 'RecruitmentDashboard',label: 'Recruitment Dashboard',      category: 'Recruitment' },
  { page: 'JobOpenings',         label: 'Job Openings',               category: 'Recruitment' },
  { page: 'CandidatePipeline',   label: 'Candidate Pipeline',         category: 'Recruitment' },
  { page: 'InterviewScheduler',  label: 'Interview Scheduler',        category: 'Recruitment' },
  { page: 'OfferManagement',     label: 'Offer Management',           category: 'Recruitment' },
  { page: 'OnboardingChecklist', label: 'Onboarding Checklist',       category: 'Recruitment' },
  { page: 'AllCandidates',       label: 'All Candidates',             category: 'Recruitment' },
  // Travel
  { page: 'TravelDashboard',     label: 'Travel Dashboard',           category: 'Travel' },
  { page: 'TravelRequests',      label: 'Travel Requests',            category: 'Travel' },
  { page: 'TravelBookings',      label: 'Travel Bookings',            category: 'Travel' },
  { page: 'TravelExpenses',      label: 'Travel Expenses',            category: 'Travel' },
  { page: 'TravelApprovals',     label: 'Travel Approvals',           category: 'Travel' },
  { page: 'TravelAnalytics',     label: 'Travel Analytics',           category: 'Travel' },
  // Service Desk
  { page: 'SupportDashboard',    label: 'Service Desk Dashboard',     category: 'Service Desk' },
  { page: 'AllTickets',          label: 'All Tickets',                category: 'Service Desk' },
  { page: 'MyTickets',           label: 'My Tickets',                 category: 'Service Desk' },
  { page: 'FieldService',        label: 'Field Service',              category: 'Service Desk' },
  { page: 'KnowledgeBase',       label: 'Knowledge Base',             category: 'Service Desk' },
  // Operations
  { page: 'WorkflowConfiguration', label: 'Workflow Configuration',  category: 'Operations' },
  { page: 'DepartmentWorkload',  label: 'Department Workload',        category: 'Operations' },
  { page: 'BottleneckAnalytics', label: 'Bottleneck Analytics',       category: 'Operations' },
  // Reports & Admin
  { page: 'Reports',             label: 'Report Builder',             category: 'Reports' },
  { page: 'SavedReports',        label: 'Saved Reports',              category: 'Reports' },
  { page: 'OrgChart',            label: 'Org Chart',                  category: 'Org' },
  { page: 'AuditLogs',           label: 'Audit Logs',                 category: 'Admin' },
  { page: 'ApprovalCenter',      label: 'Approval Center',            category: 'Approvals' },
  { page: 'NotificationCenter',  label: 'Notification Center',        category: 'Notifications' },
  { page: 'ComplaintsDashboard',    label: 'Complaints Dashboard',       category: 'Complaints' },
  // AllComplaints / NewComplaint retired 2026-07-17 — the IPCS register replaces
  // both (the create form is a drawer on the grid). Old labels kept as aliases so
  // muscle memory ("all complaints", "new complaint") still lands somewhere real.
  { page: 'CustomerComplaintsIPCS', label: 'Customer Complaints (IPCS)', category: 'Complaints' },
  { page: 'CustomerComplaintsIPCS', label: 'All Complaints',             category: 'Complaints' },
  { page: 'CustomerComplaintsIPCS', label: 'New Complaint',              category: 'Complaints' },
  { page: 'RolesSetup',          label: 'Roles Setup',                category: 'Admin' },
  { page: 'UserSetup',           label: 'User Setup',                 category: 'Admin' },
  { page: 'DocumentSigning',     label: 'Document Signing',           category: 'Documents' },
  { page: 'Marketing',           label: 'Marketing Dashboard',        category: 'Marketing' },
  { page: 'Campaigns',           label: 'Campaigns',                  category: 'Marketing' },
];

const CAT_COLORS = {
  Dashboard: '#6366f1', Analytics: '#8b5cf6', Finance: '#10b981',
  HR: '#f59e0b', Employees: '#3b82f6', CRM: '#ef4444',
  Sales: '#f97316', Projects: '#14b8a6', Inventory: '#84cc16',
  Admin: '#6b7280', Recruitment: '#ec4899', Travel: '#06b6d4',
};

function highlight(text, query) {
  if (!query) return <span>{text}</span>;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return <span>{text}</span>;
  return (
    <span>
      {text.slice(0, idx)}
      <mark style={{ background: '#ede9fe', color: '#5b21b6', borderRadius: 2, padding: '0 1px' }}>
        {text.slice(idx, idx + query.length)}
      </mark>
      {text.slice(idx + query.length)}
    </span>
  );
}

export default function GlobalSearch({ setPage, onClose }) {
  const [query, setQuery]   = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef(null);
  const listRef  = useRef(null);
  const { role } = useAuth();

  useEffect(() => { inputRef.current?.focus(); }, []);

  // Hide pages the caller's role can never open (admin-only pages such as
  // Knowledge Base; management pages for the employee role).
  const accessiblePages = SEARCHABLE_PAGES.filter(p =>
    canRoleAccessAdminOnlyPage(role, p.page) &&
    (role !== 'employee' || canEmployeeAccessPage(p.page))
  );

  const results = query.trim().length === 0
    ? accessiblePages.slice(0, 8)
    : accessiblePages.filter(p =>
        p.label.toLowerCase().includes(query.toLowerCase()) ||
        p.category.toLowerCase().includes(query.toLowerCase()) ||
        p.page.toLowerCase().includes(query.toLowerCase())
      ).slice(0, 12);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setActive(0); }, [query]);

  const navigate = useCallback((page) => {
    setPage(page);
    onClose();
  }, [setPage, onClose]);

  const handleKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(a + 1, results.length - 1)); }
    if (e.key === 'ArrowUp')   { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); }
    if (e.key === 'Enter' && results[active]) navigate(results[active].page);
    if (e.key === 'Escape') onClose();
  };

  useEffect(() => {
    const el = listRef.current?.children[active];
    el?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  return (
    <div
      style={{ position:'fixed', inset:0, background:'rgba(30,20,60,0.45)', zIndex:2000, display:'flex', alignItems:'flex-start', justifyContent:'center', paddingTop: 80 }}
      onClick={onClose}
    >
      <div
        style={{ width:'100%', maxWidth:580, background:'#fff', borderRadius:14, boxShadow:'0 20px 60px rgba(109,87,220,0.2)', border:'1px solid #e9e4ff', overflow:'hidden' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Search input */}
        <div style={{ display:'flex', alignItems:'center', gap:10, padding:'12px 16px', borderBottom:'1px solid #f3f0ff' }}>
          <Search size={16} color="#7c3aed" style={{ flexShrink:0 }}/>
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKey}
            placeholder="Search pages, modules, features…"
            style={{ flex:1, border:'none', outline:'none', fontSize:15, color:'#1f1a3d', background:'transparent' }}
          />
          {query && (
            <button onClick={() => setQuery('')} style={{ background:'none', border:'none', cursor:'pointer', color:'#9ca3af', padding:2 }}>
              <X size={14}/>
            </button>
          )}
          <kbd style={{ fontSize:10, background:'#f5f3ff', color:'#6b5fa6', border:'1px solid #e9e4ff', borderRadius:4, padding:'2px 6px', fontFamily:'monospace', flexShrink:0 }}>Esc</kbd>
        </div>

        {/* Results */}
        <div ref={listRef} style={{ maxHeight:380, overflowY:'auto' }}>
          {results.length === 0 ? (
            <div style={{ textAlign:'center', padding:'32px 0', color:'#9ca3af', fontSize:13 }}>
              No pages found for "{query}"
            </div>
          ) : (
            results.map((r, i) => (
              <div
                key={r.page}
                onClick={() => navigate(r.page)}
                style={{
                  display:'flex', alignItems:'center', justifyContent:'space-between',
                  padding:'10px 16px', cursor:'pointer',
                  background: i === active ? '#f5f3ff' : 'transparent',
                  borderLeft: i === active ? '3px solid #7c3aed' : '3px solid transparent',
                  transition:'background .1s',
                }}
                onMouseEnter={() => setActive(i)}
              >
                <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                  <span style={{
                    fontSize:10, fontWeight:700, padding:'2px 7px', borderRadius:4,
                    background: (CAT_COLORS[r.category] || '#6b7280') + '18',
                    color: CAT_COLORS[r.category] || '#6b7280',
                    minWidth:64, textAlign:'center',
                  }}>
                    {r.category}
                  </span>
                  <span style={{ fontSize:13.5, color:'#1f1a3d', fontWeight: i === active ? 500 : 400 }}>
                    {highlight(r.label, query)}
                  </span>
                </div>
                {i === active && <ArrowRight size={14} color="#7c3aed"/>}
              </div>
            ))
          )}
        </div>

        {/* Footer hints */}
        <div style={{ padding:'8px 16px', borderTop:'1px solid #f3f0ff', display:'flex', gap:16, fontSize:11, color:'#9ca3af' }}>
          <span>↑↓ navigate</span>
          <span>↵ open</span>
          <span>Esc close</span>
          <span style={{ marginLeft:'auto' }}>{results.length} result{results.length !== 1 ? 's' : ''}</span>
        </div>
      </div>
    </div>
  );
}
