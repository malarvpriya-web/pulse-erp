// backend/src/docs/swagger.js
export const swaggerSpec = {
  openapi: '3.0.3',
  info: {
    title: 'Pulse ERP API',
    version: '1.0.0',
    description: 'Complete REST API for Pulse ERP — Manifest Technologies, India. All monetary values in INR (₹). Dates in ISO 8601.',
    contact: { name: 'Manifest Technologies', email: 'dev@manifesttech.in' },
  },
  servers: [
    { url: 'http://localhost:5000/api', description: 'Local Development' },
    { url: 'https://pulse-erp.up.railway.app/api', description: 'Production' },
  ],
  components: {
    securitySchemes: {
      BearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'JWT token from POST /auth/login' },
    },
    schemas: {
      Employee: {
        type: 'object', properties: {
          id:           { type: 'integer' },
          name:         { type: 'string', example: 'Arjun Mehta' },
          email:        { type: 'string', format: 'email' },
          department:   { type: 'string', example: 'Engineering' },
          designation:  { type: 'string', example: 'Senior Developer' },
          date_of_joining: { type: 'string', format: 'date' },
          status:       { type: 'string', enum: ['active','inactive','on_leave'] },
          salary:       { type: 'number', example: 85000 },
        },
      },
      Invoice: {
        type: 'object', properties: {
          id:             { type: 'integer' },
          invoice_number: { type: 'string', example: 'INV-2026-001' },
          client_name:    { type: 'string' },
          total_amount:   { type: 'number', example: 250000 },
          status:         { type: 'string', enum: ['draft','sent','paid','overdue','cancelled'] },
          invoice_date:   { type: 'string', format: 'date' },
          due_date:       { type: 'string', format: 'date' },
        },
      },
      LeaveRequest: {
        type: 'object', properties: {
          id:          { type: 'integer' },
          employee_id: { type: 'integer' },
          leave_type:  { type: 'string', enum: ['Sick','Casual','Annual','Maternity','Paternity','LWP'] },
          start_date:  { type: 'string', format: 'date' },
          end_date:    { type: 'string', format: 'date' },
          status:      { type: 'string', enum: ['pending','approved','rejected','cancelled'] },
          reason:      { type: 'string' },
        },
      },
      Project: {
        type: 'object', properties: {
          id:           { type: 'integer' },
          project_code: { type: 'string', example: 'PRJ001' },
          project_name: { type: 'string' },
          customer_name:{ type: 'string' },
          manager_name: { type: 'string' },
          status:       { type: 'string', enum: ['planning','in_progress','at_risk','completed','on_hold'] },
          budget_amount:{ type: 'number' },
          start_date:   { type: 'string', format: 'date' },
          end_date:     { type: 'string', format: 'date' },
        },
      },
      Lead: {
        type: 'object', properties: {
          id:           { type: 'integer' },
          company_name: { type: 'string' },
          contact_name: { type: 'string' },
          email:        { type: 'string', format: 'email' },
          phone:        { type: 'string' },
          deal_value:   { type: 'number' },
          stage:        { type: 'string', enum: ['New','Qualified','Demo Done','Proposal Sent','Negotiation','Won','Lost'] },
          source:       { type: 'string' },
        },
      },
      PurchaseOrder: {
        type: 'object', properties: {
          id:           { type: 'integer' },
          po_number:    { type: 'string', example: 'PO-2026-001' },
          vendor_name:  { type: 'string' },
          total_amount: { type: 'number' },
          status:       { type: 'string', enum: ['draft','approved','sent','received','cancelled'] },
          order_date:   { type: 'string', format: 'date' },
        },
      },
      ErrorResponse: {
        type: 'object', properties: {
          error:   { type: 'string' },
          status:  { type: 'integer' },
          path:    { type: 'string' },
          timestamp: { type: 'string', format: 'date-time' },
        },
      },
    },
  },
  security: [{ BearerAuth: [] }],
  tags: [
    { name: 'Auth',        description: 'Authentication & session management' },
    { name: 'Employees',   description: 'Employee CRUD, profile, documents' },
    { name: 'HR',          description: 'HR policies, org chart, talent' },
    { name: 'Finance',     description: 'Invoices, bills, payments, journals' },
    { name: 'Payroll',     description: 'Payroll runs, payslips, TDS' },
    { name: 'Inventory',   description: 'Stock management, items, movements' },
    { name: 'Projects',    description: 'Projects, tasks, Gantt' },
    { name: 'CRM',         description: 'Leads, pipeline, email sequences' },
    { name: 'Sales',       description: 'Quotations, orders, customers' },
    { name: 'Procurement', description: 'Purchase orders, vendors, RFQ' },
    { name: 'Leaves',      description: 'Leave requests, balances, policies' },
    { name: 'Attendance',  description: 'Attendance records, shifts' },
    { name: 'Timesheets',  description: 'Timesheet entries, approvals' },
    { name: 'Reports',     description: 'Standard and custom reports' },
    { name: 'AI',          description: 'AI chat, anomaly detection, predictions' },
  ],
  paths: {
    /* ── Auth ── */
    '/auth/login': {
      post: {
        tags: ['Auth'], summary: 'Login and receive JWT',
        security: [],
        requestBody: { required: true, content: { 'application/json': { schema: { type:'object', required:['email','password'], properties: { email:{ type:'string', format:'email', example:'admin@pulse.com' }, password:{ type:'string', example:'password123' } } } } } },
        responses: {
          200: { description:'Login success', content:{ 'application/json':{ schema:{ type:'object', properties:{ token:{type:'string'}, user:{type:'object'}, role:{type:'string'} } } } } },
          401: { description:'Invalid credentials', content:{ 'application/json':{ schema:{ $ref:'#/components/schemas/ErrorResponse' } } } },
        },
      },
    },
    '/auth/refresh': {
      post: {
        tags: ['Auth'], summary: 'Refresh JWT token',
        responses: { 200: { description:'New token issued' }, 401: { description:'Token invalid or expired' } },
      },
    },
    '/auth/logout': {
      post: { tags: ['Auth'], summary: 'Invalidate current session', responses: { 200: { description:'Logged out' } } },
    },

    /* ── Employees ── */
    '/employees': {
      get: {
        tags: ['Employees'], summary: 'List all employees',
        parameters: [
          { name:'department', in:'query', schema:{ type:'string' } },
          { name:'status',     in:'query', schema:{ type:'string', enum:['active','inactive'] } },
          { name:'page',       in:'query', schema:{ type:'integer', default:1 } },
          { name:'limit',      in:'query', schema:{ type:'integer', default:50 } },
        ],
        responses: { 200: { description:'Employee list', content:{ 'application/json':{ schema:{ type:'array', items:{ $ref:'#/components/schemas/Employee' } } } } } },
      },
      post: {
        tags: ['Employees'], summary: 'Create new employee',
        requestBody: { required:true, content:{ 'application/json':{ schema:{ $ref:'#/components/schemas/Employee' } } } },
        responses: { 201: { description:'Employee created' }, 400: { description:'Validation error' } },
      },
    },
    '/employees/{id}': {
      get: { tags:['Employees'], summary:'Get employee by ID', parameters:[{ name:'id',in:'path',required:true,schema:{type:'integer'} }], responses:{ 200:{description:'Employee data'}, 404:{description:'Not found'} } },
      put: { tags:['Employees'], summary:'Update employee', parameters:[{ name:'id',in:'path',required:true,schema:{type:'integer'} }], requestBody:{required:true,content:{'application/json':{schema:{$ref:'#/components/schemas/Employee'}}}}, responses:{ 200:{description:'Updated'}, 404:{description:'Not found'} } },
      delete: { tags:['Employees'], summary:'Delete/deactivate employee', parameters:[{ name:'id',in:'path',required:true,schema:{type:'integer'} }], responses:{ 200:{description:'Deleted'} } },
    },

    /* ── Leaves ── */
    '/leaves': {
      get: { tags:['Leaves'], summary:'List leave requests', parameters:[{name:'employee_id',in:'query',schema:{type:'integer'}},{name:'status',in:'query',schema:{type:'string'}},{name:'month',in:'query',schema:{type:'string',example:'2026-03'}}], responses:{ 200:{description:'Leave list',content:{'application/json':{schema:{type:'array',items:{$ref:'#/components/schemas/LeaveRequest'}}}}}} },
      post: { tags:['Leaves'], summary:'Submit leave request', requestBody:{required:true,content:{'application/json':{schema:{$ref:'#/components/schemas/LeaveRequest'}}}}, responses:{ 201:{description:'Leave submitted'}, 400:{description:'Insufficient balance'} } },
    },
    '/leaves/{id}/approve': {
      put: { tags:['Leaves'], summary:'Approve leave request', parameters:[{name:'id',in:'path',required:true,schema:{type:'integer'}}], responses:{ 200:{description:'Approved'} } },
    },
    '/leaves/{id}/reject': {
      put: { tags:['Leaves'], summary:'Reject leave request', parameters:[{name:'id',in:'path',required:true,schema:{type:'integer'}}], requestBody:{content:{'application/json':{schema:{type:'object',properties:{reason:{type:'string'}}}}}}, responses:{ 200:{description:'Rejected'} } },
    },
    '/leaves/balance/{employeeId}': {
      get: { tags:['Leaves'], summary:'Get leave balance for employee', parameters:[{name:'employeeId',in:'path',required:true,schema:{type:'integer'}}], responses:{ 200:{description:'Leave balances by type'} } },
    },

    /* ── Finance ── */
    '/finance/invoices': {
      get: { tags:['Finance'], summary:'List invoices', parameters:[{name:'status',in:'query',schema:{type:'string'}},{name:'client',in:'query',schema:{type:'string'}},{name:'from',in:'query',schema:{type:'string',format:'date'}},{name:'to',in:'query',schema:{type:'string',format:'date'}}], responses:{ 200:{description:'Invoice list',content:{'application/json':{schema:{type:'array',items:{$ref:'#/components/schemas/Invoice'}}}}}} },
      post: { tags:['Finance'], summary:'Create invoice', requestBody:{required:true,content:{'application/json':{schema:{$ref:'#/components/schemas/Invoice'}}}}, responses:{ 201:{description:'Invoice created'} } },
    },
    '/finance/invoices/{id}': {
      get:    { tags:['Finance'], summary:'Get invoice',    parameters:[{name:'id',in:'path',required:true,schema:{type:'integer'}}], responses:{ 200:{description:'Invoice'} } },
      put:    { tags:['Finance'], summary:'Update invoice', parameters:[{name:'id',in:'path',required:true,schema:{type:'integer'}}], requestBody:{content:{'application/json':{schema:{$ref:'#/components/schemas/Invoice'}}}}, responses:{ 200:{description:'Updated'} } },
      delete: { tags:['Finance'], summary:'Cancel invoice', parameters:[{name:'id',in:'path',required:true,schema:{type:'integer'}}], responses:{ 200:{description:'Cancelled'} } },
    },
    '/finance/bills': {
      get:  { tags:['Finance'], summary:'List supplier bills', responses:{ 200:{description:'Bills list'} } },
      post: { tags:['Finance'], summary:'Create supplier bill', requestBody:{content:{'application/json':{schema:{type:'object',properties:{vendor_name:{type:'string'},amount:{type:'number'},due_date:{type:'string',format:'date'}}}}}}, responses:{ 201:{description:'Bill created'} } },
    },

    /* ── Payroll ── */
    '/payroll/run': {
      post: { tags:['Payroll'], summary:'Run payroll for a month', requestBody:{content:{'application/json':{schema:{type:'object',required:['month_year'],properties:{month_year:{type:'string',example:'2026-03'},department:{type:'string'} }}}}}, responses:{ 200:{description:'Payroll processed',content:{'application/json':{schema:{type:'object',properties:{processed:{type:'integer'},total_gross:{type:'number'},total_net:{type:'number'}}}}}} } },
    },
    '/payroll/payslip/{employeeId}/{monthYear}': {
      get: { tags:['Payroll'], summary:'Get payslip for employee', parameters:[{name:'employeeId',in:'path',required:true,schema:{type:'integer'}},{name:'monthYear',in:'path',required:true,schema:{type:'string',example:'2026-03'}}], responses:{ 200:{description:'Payslip data'} } },
    },

    /* ── Inventory ── */
    '/inventory/items': {
      get:  { tags:['Inventory'], summary:'List inventory items', parameters:[{name:'category',in:'query',schema:{type:'string'}},{name:'low_stock',in:'query',schema:{type:'boolean'}}], responses:{ 200:{description:'Items list'} } },
      post: { tags:['Inventory'], summary:'Create inventory item', requestBody:{content:{'application/json':{schema:{type:'object',properties:{name:{type:'string'},category:{type:'string'},current_stock:{type:'number'},reorder_point:{type:'number'},unit:{type:'string'}}}}}}, responses:{ 201:{description:'Item created'} } },
    },
    '/inventory/items/{id}/movement': {
      post: { tags:['Inventory'], summary:'Record stock movement (IN/OUT)', parameters:[{name:'id',in:'path',required:true,schema:{type:'integer'}}], requestBody:{content:{'application/json':{schema:{type:'object',required:['type','quantity'],properties:{type:{type:'string',enum:['IN','OUT','ADJUSTMENT']},quantity:{type:'number'},reference:{type:'string'} }}}}}, responses:{ 200:{description:'Movement recorded'} } },
    },

    /* ── Projects ── */
    '/projects': {
      get:  { tags:['Projects'], summary:'List projects', parameters:[{name:'status',in:'query',schema:{type:'string'}},{name:'manager',in:'query',schema:{type:'string'}}], responses:{ 200:{description:'Projects list',content:{'application/json':{schema:{type:'array',items:{$ref:'#/components/schemas/Project'}}}}}} },
      post: { tags:['Projects'], summary:'Create project', requestBody:{content:{'application/json':{schema:{$ref:'#/components/schemas/Project'}}}}, responses:{ 201:{description:'Project created'} } },
    },
    '/projects/tasks': {
      get:  { tags:['Projects'], summary:'List Gantt tasks', parameters:[{name:'project',in:'query',schema:{type:'string'}}], responses:{ 200:{description:'Task list'} } },
      post: { tags:['Projects'], summary:'Create Gantt task', requestBody:{content:{'application/json':{schema:{type:'object',properties:{name:{type:'string'},project:{type:'string'},start_date:{type:'string',format:'date'},end_date:{type:'string',format:'date'},assignee:{type:'string'},status:{type:'string'},progress:{type:'integer',minimum:0,maximum:100},is_milestone:{type:'boolean'},dependencies:{type:'array',items:{type:'integer'}}}}}}}, responses:{ 201:{description:'Task created'} } },
    },

    /* ── CRM ── */
    '/crm/leads': {
      get:  { tags:['CRM'], summary:'List leads', parameters:[{name:'stage',in:'query',schema:{type:'string'}},{name:'assigned_to',in:'query',schema:{type:'integer'}}], responses:{ 200:{description:'Leads list',content:{'application/json':{schema:{type:'array',items:{$ref:'#/components/schemas/Lead'}}}}}} },
      post: { tags:['CRM'], summary:'Create lead', requestBody:{content:{'application/json':{schema:{$ref:'#/components/schemas/Lead'}}}}, responses:{ 201:{description:'Lead created'} } },
    },

    /* ── Procurement ── */
    '/procurement/purchase-orders': {
      get:  { tags:['Procurement'], summary:'List purchase orders', responses:{ 200:{description:'PO list',content:{'application/json':{schema:{type:'array',items:{$ref:'#/components/schemas/PurchaseOrder'}}}}}} },
      post: { tags:['Procurement'], summary:'Create purchase order', requestBody:{content:{'application/json':{schema:{$ref:'#/components/schemas/PurchaseOrder'}}}}, responses:{ 201:{description:'PO created'} } },
    },

    /* ── Attendance ── */
    '/attendance': {
      get:  { tags:['Attendance'], summary:'Get attendance records', parameters:[{name:'employee_id',in:'query',schema:{type:'integer'}},{name:'date',in:'query',schema:{type:'string',format:'date'}},{name:'month',in:'query',schema:{type:'string',example:'2026-03'}}], responses:{ 200:{description:'Attendance records'} } },
      post: { tags:['Attendance'], summary:'Mark attendance', requestBody:{content:{'application/json':{schema:{type:'object',required:['employee_id','date','status'],properties:{employee_id:{type:'integer'},date:{type:'string',format:'date'},status:{type:'string',enum:['present','absent','late','half_day']},check_in:{type:'string',format:'time'},check_out:{type:'string',format:'time'}}}}}}, responses:{ 201:{description:'Attendance marked'} } },
    },

    /* ── Timesheets ── */
    '/timesheets': {
      get:  { tags:['Timesheets'], summary:'Get timesheet entries', parameters:[{name:'employee_id',in:'query',schema:{type:'integer'}},{name:'week',in:'query',schema:{type:'string',example:'2026-W13'}}], responses:{ 200:{description:'Timesheet entries'} } },
      post: { tags:['Timesheets'], summary:'Submit timesheet entry', requestBody:{content:{'application/json':{schema:{type:'object',required:['employee_id','project_id','date','hours'],properties:{employee_id:{type:'integer'},project_id:{type:'integer'},task_id:{type:'integer'},date:{type:'string',format:'date'},hours:{type:'number',minimum:0.5,maximum:24},description:{type:'string'}}}}}}, responses:{ 201:{description:'Entry created'} } },
    },

    /* ── Reports ── */
    '/reports/profit-loss': {
      get: { tags:['Reports'], summary:'Profit & Loss report', parameters:[{name:'from',in:'query',schema:{type:'string',format:'date'}},{name:'to',in:'query',schema:{type:'string',format:'date'}}], responses:{ 200:{description:'P&L data'} } },
    },
    '/reports/balance-sheet': {
      get: { tags:['Reports'], summary:'Balance sheet snapshot', parameters:[{name:'as_of',in:'query',schema:{type:'string',format:'date'}}], responses:{ 200:{description:'Balance sheet'} } },
    },
    '/reports/gst-return': {
      get: { tags:['Reports'], summary:'GST return data (GSTR-1 / GSTR-3B)', parameters:[{name:'month',in:'query',schema:{type:'string',example:'2026-03'}}], responses:{ 200:{description:'GST data'} } },
    },

    /* ── AI ── */
    '/ai/chat': {
      post: { tags:['AI'], summary:'AI chat with ERP data', security:[{BearerAuth:[]}], requestBody:{content:{'application/json':{schema:{type:'object',required:['message'],properties:{message:{type:'string',example:'Who is on leave today?'},context:{type:'object'}}}}}}, responses:{ 200:{description:'AI response',content:{'application/json':{schema:{type:'object',properties:{answer:{type:'string'},data:{type:'array'},chart_type:{type:'string',enum:['bar','line','table','number']},query_used:{type:'string'}}}}}} } },
    },
    '/ai/anomalies': {
      get: { tags:['AI'], summary:'Get detected anomalies', security:[{BearerAuth:[]}], responses:{ 200:{description:'Anomaly list'} } },
    },
    '/ai/predictions': {
      get: { tags:['AI'], summary:'Get predictive insights', security:[{BearerAuth:[]}], responses:{ 200:{description:'Predictions'} } },
    },
    '/ai/smart-search': {
      get: { tags:['AI'], summary:'Full-text search across all entities', security:[{BearerAuth:[]}], parameters:[{name:'q',in:'query',required:true,schema:{type:'string',example:'Arjun'}}], responses:{ 200:{description:'Search results grouped by entity'} } },
    },
  },
};

export default swaggerSpec;
