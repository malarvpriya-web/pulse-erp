# CRM, SALES & MARKETING MODULE

Complete enterprise-grade system for lead management, sales pipeline, and marketing campaigns.

---

## 📋 TABLE OF CONTENTS

1. [Architecture Overview](#architecture-overview)
2. [Database Schema](#database-schema)
3. [API Endpoints](#api-endpoints)
4. [Frontend Pages](#frontend-pages)
5. [Workflows](#workflows)
6. [Integration Points](#integration-points)
7. [Usage Examples](#usage-examples)

---

## 🏗 ARCHITECTURE OVERVIEW

### Module Structure

```
backend/src/modules/
├── crm/
│   ├── repositories/
│   │   ├── leads.repository.js
│   │   └── opportunities.repository.js
│   └── routes/
│       └── crm.routes.js
├── sales/
│   ├── repositories/
│   │   ├── quotations.repository.js
│   │   ├── salesOrders.repository.js
│   │   └── salesTargets.repository.js
│   └── routes/
│       └── sales.routes.js
└── marketing/
    ├── repositories/
    │   └── campaigns.repository.js
    └── routes/
        └── marketing.routes.js

frontend/src/features/
├── crm/pages/
│   ├── Leads.jsx
│   └── OpportunitiesKanban.jsx
├── sales/pages/
│   └── Quotations.jsx
└── marketing/pages/
    └── Campaigns.jsx
```

---

## 🗄 DATABASE SCHEMA

### CRM Module

#### leads
- `id` (UUID, PK)
- `lead_source` (website, linkedin, referral, campaign, manual, cold_call, event)
- `company_name` (VARCHAR) *
- `contact_person` (VARCHAR) *
- `email`, `phone` (VARCHAR)
- `industry`, `location` (VARCHAR)
- `assigned_to` (UUID, FK → employees)
- `status` (new, contacted, qualified, unqualified, converted)
- `notes` (TEXT)
- Audit: `created_at`, `updated_at`, `created_by`, `deleted_at`

#### lead_activities
- `id` (UUID, PK)
- `lead_id` (UUID, FK → leads)
- `activity_type` (call, meeting, email, demo, proposal, followup)
- `activity_date` (TIMESTAMP)
- `notes` (TEXT)
- `next_followup_date` (DATE)
- `created_by` (UUID, FK → employees)
- Audit: `created_at`, `deleted_at`

#### opportunities
- `id` (UUID, PK)
- `lead_id` (UUID, FK → leads)
- `opportunity_name` (VARCHAR) *
- `expected_value` (DECIMAL) *
- `probability_percentage` (DECIMAL 0-100)
- `expected_closing_date` (DATE)
- `stage` (qualification, proposal, negotiation, won, lost)
- `lost_reason` (TEXT)
- `assigned_to` (UUID, FK → employees)
- Audit: `created_at`, `updated_at`, `created_by`, `deleted_at`

### Sales Module

#### quotations
- `id` (UUID, PK)
- `quotation_number` (VARCHAR, UNIQUE) - Auto-generated QT-0001
- `customer_id` (UUID, FK → parties)
- `opportunity_id` (UUID, FK → opportunities)
- `quotation_date`, `validity_date` (DATE)
- `status` (draft, sent, accepted, rejected, expired)
- `subtotal`, `tax_amount`, `total_amount` (DECIMAL)
- `notes` (TEXT)
- Audit: `created_at`, `updated_at`, `created_by`, `deleted_at`

#### quotation_items
- `id` (UUID, PK)
- `quotation_id` (UUID, FK → quotations)
- `item_description` (TEXT)
- `quantity`, `rate` (DECIMAL)
- `tax_percentage`, `tax_amount`, `total` (DECIMAL)

#### sales_orders
- `id` (UUID, PK)
- `order_number` (VARCHAR, UNIQUE) - Auto-generated SO-0001
- `quotation_id` (UUID, FK → quotations)
- `customer_id` (UUID, FK → parties)
- `order_date`, `delivery_date` (DATE)
- `order_status` (pending, processing, completed, cancelled)
- `subtotal`, `tax_amount`, `total_amount` (DECIMAL)
- `notes` (TEXT)
- Audit: `created_at`, `updated_at`, `created_by`, `deleted_at`

#### sales_order_items
- `id` (UUID, PK)
- `order_id` (UUID, FK → sales_orders)
- `item_description` (TEXT)
- `quantity`, `rate` (DECIMAL)
- `tax_percentage`, `tax_amount`, `total` (DECIMAL)

#### deal_results
- `id` (UUID, PK)
- `opportunity_id` (UUID, FK → opportunities)
- `result` (won, lost)
- `reason_category` (VARCHAR)
- `competitor_name` (VARCHAR)
- `remarks` (TEXT)
- `created_by` (UUID)

#### sales_targets
- `id` (UUID, PK)
- `employee_id` (UUID, FK → employees)
- `month` (DATE)
- `target_amount` (DECIMAL)
- `achieved_amount` (DECIMAL)
- Audit: `created_at`, `updated_at`, `deleted_at`
- UNIQUE(employee_id, month)

### Marketing Module

#### campaigns
- `id` (UUID, PK)
- `campaign_name` (VARCHAR) *
- `campaign_type` (email, linkedin, google_ads, facebook, event, webinar, content)
- `start_date`, `end_date` (DATE)
- `budget`, `actual_spend` (DECIMAL)
- `expected_leads`, `actual_leads` (INTEGER)
- `status` (planned, active, paused, completed, cancelled)
- `description` (TEXT)
- Audit: `created_at`, `updated_at`, `created_by`, `deleted_at`

#### campaign_leads
- `id` (UUID, PK)
- `campaign_id` (UUID, FK → campaigns)
- `lead_id` (UUID, FK → leads)
- `created_at` (TIMESTAMP)
- UNIQUE(campaign_id, lead_id)

---

## 🔌 API ENDPOINTS

### CRM API (`/api/crm`)

#### Leads
- `GET /leads` - List all leads (filters: status, lead_source, assigned_to)
- `GET /leads/:id` - Get lead details
- `POST /leads` - Create lead
- `PUT /leads/:id` - Update lead
- `DELETE /leads/:id` - Soft delete lead
- `GET /leads/:id/activities` - Get lead activities
- `POST /leads/:id/activities` - Add activity to lead

#### Opportunities
- `GET /opportunities` - List opportunities (filters: stage, assigned_to)
- `GET /opportunities/kanban` - Get Kanban board data
- `GET /opportunities/:id` - Get opportunity details
- `POST /opportunities` - Create opportunity (auto-converts lead)
- `PUT /opportunities/:id` - Update opportunity
- `DELETE /opportunities/:id` - Soft delete opportunity

#### Analytics
- `GET /analytics/leads-by-source` - Leads grouped by source
- `GET /analytics/conversion-rate` - Lead conversion metrics
- `GET /analytics/pipeline-value` - Sales pipeline value by stage
- `GET /analytics/avg-deal-size` - Average deal size

### Sales API (`/api/sales`)

#### Quotations
- `GET /quotations` - List quotations (filters: status, customer_id)
- `GET /quotations/next-number` - Get next quotation number
- `GET /quotations/:id` - Get quotation details
- `POST /quotations` - Create quotation
- `PUT /quotations/:id` - Update quotation
- `DELETE /quotations/:id` - Soft delete quotation
- `GET /quotations/:id/items` - Get quotation items
- `POST /quotations/:id/items` - Add item to quotation (auto-updates totals)

#### Sales Orders
- `GET /orders` - List orders (filters: order_status, customer_id)
- `GET /orders/next-number` - Get next order number
- `GET /orders/:id` - Get order details
- `POST /orders` - Create order (auto-updates quotation status)
- `PUT /orders/:id` - Update order
- `DELETE /orders/:id` - Soft delete order
- `GET /orders/:id/items` - Get order items
- `POST /orders/:id/items` - Add item to order (auto-updates totals)

#### Sales Targets
- `GET /targets` - List targets (filters: employee_id, month)
- `POST /targets` - Upsert target

#### Analytics
- `GET /analytics/monthly-revenue` - Monthly revenue (last 12 months)
- `GET /analytics/top-customers` - Top customers by revenue
- `GET /analytics/sales-vs-target` - Sales achievement vs targets

### Marketing API (`/api/marketing`)

#### Campaigns
- `GET /campaigns` - List campaigns (filters: status, campaign_type)
- `GET /campaigns/:id` - Get campaign details
- `POST /campaigns` - Create campaign
- `PUT /campaigns/:id` - Update campaign
- `DELETE /campaigns/:id` - Soft delete campaign
- `POST /campaigns/:id/link-lead` - Link lead to campaign
- `GET /campaigns/:id/leads` - Get campaign leads
- `GET /campaigns/:id/metrics` - Get campaign metrics (cost per lead, conversion rate)

#### Analytics
- `GET /analytics/leads-by-campaign` - Leads grouped by campaign
- `GET /analytics/campaign-roi` - Campaign ROI analysis

---

## 🎨 FRONTEND PAGES

### CRM Module

#### Leads.jsx
- **Features:**
  - Table view of all leads
  - Create lead form
  - Lead source badges (website, linkedin, referral, campaign, manual)
  - Status badges (new, contacted, qualified, unqualified, converted)
  - Assign to employee
  - Industry and location tracking
- **Styling:** Table layout with form modal

#### OpportunitiesKanban.jsx
- **Features:**
  - 5-column Kanban board (Qualification, Proposal, Negotiation, Won, Lost)
  - Drag-and-drop stage updates
  - Expected value display
  - Probability percentage
  - Expected closing date
  - Assignee display
  - Create opportunity from qualified leads
- **Styling:** Column-based Kanban layout

### Sales Module

#### Quotations.jsx
- **Features:**
  - Table view of quotations
  - Auto-generated quotation numbers (QT-0001)
  - Customer selection
  - Quotation and validity dates
  - Status tracking (draft, sent, accepted, rejected, expired)
  - Total amount display
- **Styling:** Table layout with form modal

### Marketing Module

#### Campaigns.jsx
- **Features:**
  - Table view of campaigns
  - Campaign type badges (email, linkedin, google_ads, facebook, event, webinar)
  - Status tracking (planned, active, paused, completed, cancelled)
  - Budget tracking
  - Expected vs actual leads
  - Start and end dates
- **Styling:** Table layout with form modal

---

## 🔄 WORKFLOWS

### Lead to Opportunity Workflow

1. **Lead Creation**
   - Capture lead from various sources
   - Assign to sales rep
   - Status: "new"

2. **Lead Qualification**
   - Sales rep contacts lead
   - Log activities (calls, meetings, emails)
   - Update status to "contacted"
   - Qualify or disqualify lead

3. **Opportunity Creation**
   - Convert qualified lead to opportunity
   - Set expected value and probability
   - Set expected closing date
   - Lead status auto-updates to "converted"
   - Stage: "qualification"

4. **Sales Pipeline**
   - Move through stages: qualification → proposal → negotiation
   - Update probability as deal progresses
   - Log activities and notes

5. **Deal Closure**
   - Mark as "won" or "lost"
   - If won: Create quotation
   - If lost: Record reason and competitor

### Quotation to Order Workflow

1. **Quotation Creation**
   - Create from opportunity
   - Add line items
   - System calculates totals
   - Status: "draft"

2. **Send Quotation**
   - Update status to "sent"
   - Set validity date

3. **Customer Response**
   - If accepted: Create sales order
   - If rejected: Update status, record reason
   - If expired: Auto-update status

4. **Sales Order**
   - Created from accepted quotation
   - Quotation status auto-updates to "accepted"
   - Set delivery date
   - Process order

### Campaign to Lead Workflow

1. **Campaign Planning**
   - Create campaign
   - Set budget and expected leads
   - Status: "planned"

2. **Campaign Execution**
   - Update status to "active"
   - Track actual spend

3. **Lead Generation**
   - Create leads from campaign
   - Link leads to campaign
   - System auto-updates actual_leads count

4. **Campaign Analysis**
   - Calculate cost per lead
   - Track conversion rate
   - Calculate ROI
   - Identify top performing channels

---

## 🔗 INTEGRATION POINTS

### CRM → Sales
- Qualified leads convert to opportunities
- Opportunities generate quotations
- Won deals create sales orders

### Sales → Finance
- Sales orders generate invoices
- Revenue recognition
- Customer payment tracking

### Sales → Inventory
- Sales orders trigger delivery notes
- Stock allocation
- Inventory reduction

### Sales → Projects
- Won deals can create projects
- Project costing linked to sales value

### Marketing → CRM
- Campaigns generate leads
- Lead source tracking
- Campaign attribution

### CRM → Finance
- Customer master data sync
- Credit limit management

---

## 📊 USAGE EXAMPLES

### Create Lead and Convert to Opportunity

```javascript
// 1. Create Lead
POST /api/crm/leads
{
  "lead_source": "linkedin",
  "company_name": "Tech Corp",
  "contact_person": "John Doe",
  "email": "john@techcorp.com",
  "phone": "+91-9876543210",
  "industry": "IT Services",
  "location": "Mumbai",
  "assigned_to": "employee_uuid",
  "status": "new"
}

// 2. Add Activity
POST /api/crm/leads/:lead_id/activities
{
  "activity_type": "call",
  "activity_date": "2024-01-15T10:00:00Z",
  "notes": "Initial discovery call. Interested in our services.",
  "next_followup_date": "2024-01-20"
}

// 3. Qualify Lead
PUT /api/crm/leads/:lead_id
{
  "status": "qualified"
}

// 4. Create Opportunity
POST /api/crm/opportunities
{
  "lead_id": "lead_uuid",
  "opportunity_name": "Tech Corp - ERP Implementation",
  "expected_value": 5000000,
  "probability_percentage": 60,
  "expected_closing_date": "2024-03-31",
  "stage": "qualification",
  "assigned_to": "employee_uuid"
}
// Lead status auto-updates to "converted"
```

### Quotation to Sales Order

```javascript
// 1. Create Quotation
POST /api/sales/quotations
{
  "quotation_number": "QT-0001",
  "customer_id": "customer_uuid",
  "opportunity_id": "opportunity_uuid",
  "quotation_date": "2024-01-15",
  "validity_date": "2024-02-15",
  "status": "draft"
}

// 2. Add Items
POST /api/sales/quotations/:quotation_id/items
{
  "item_description": "ERP Software License",
  "quantity": 10,
  "rate": 50000,
  "tax_percentage": 18
}
// System auto-calculates: tax_amount = 90000, total = 590000
// Updates quotation totals

// 3. Send Quotation
PUT /api/sales/quotations/:quotation_id
{
  "status": "sent"
}

// 4. Create Sales Order (when accepted)
POST /api/sales/orders
{
  "order_number": "SO-0001",
  "quotation_id": "quotation_uuid",
  "customer_id": "customer_uuid",
  "order_date": "2024-01-20",
  "delivery_date": "2024-02-28",
  "order_status": "pending"
}
// Quotation status auto-updates to "accepted"
```

### Campaign with Lead Tracking

```javascript
// 1. Create Campaign
POST /api/marketing/campaigns
{
  "campaign_name": "LinkedIn Lead Gen Q1 2024",
  "campaign_type": "linkedin",
  "start_date": "2024-01-01",
  "end_date": "2024-03-31",
  "budget": 100000,
  "expected_leads": 50,
  "status": "active"
}

// 2. Create Lead from Campaign
POST /api/crm/leads
{
  "lead_source": "campaign",
  "company_name": "ABC Ltd",
  "contact_person": "Jane Smith",
  "email": "jane@abc.com",
  ...
}

// 3. Link Lead to Campaign
POST /api/marketing/campaigns/:campaign_id/link-lead
{
  "lead_id": "lead_uuid"
}
// System auto-updates actual_leads count

// 4. Get Campaign Metrics
GET /api/marketing/campaigns/:campaign_id/metrics
// Returns:
{
  "budget": 100000,
  "actual_spend": 75000,
  "expected_leads": 50,
  "actual_leads": 45,
  "cost_per_lead": 1666.67,
  "converted_leads": 12,
  "conversion_rate": 26.67
}
```

### Sales Analytics

```javascript
// Monthly Revenue
GET /api/sales/analytics/monthly-revenue
// Returns last 12 months revenue

// Top Customers
GET /api/sales/analytics/top-customers?limit=10
// Returns top 10 customers by revenue

// Sales vs Target
GET /api/sales/analytics/sales-vs-target
// Returns achievement percentage by employee

// Pipeline Value
GET /api/crm/analytics/pipeline-value
// Returns total value by stage

// Campaign ROI
GET /api/marketing/analytics/campaign-roi
// Returns ROI % by campaign
```

---

## 🎯 KEY FEATURES

### CRM
✅ Multi-source lead capture  
✅ Lead activity tracking  
✅ Lead qualification workflow  
✅ Opportunity pipeline management  
✅ 5-stage Kanban board  
✅ Conversion rate tracking  
✅ Sales funnel analytics  

### Sales
✅ Auto-generated quotation numbers  
✅ Multi-item quotations  
✅ Quotation to order conversion  
✅ Sales order management  
✅ Sales targets tracking  
✅ Monthly revenue reports  
✅ Top customers analysis  
✅ Deal win/loss tracking  

### Marketing
✅ Multi-channel campaigns  
✅ Budget tracking  
✅ Lead attribution  
✅ Cost per lead calculation  
✅ Conversion rate tracking  
✅ Campaign ROI analysis  
✅ Performance comparison  

---

## 🚀 PRODUCTION READY

- ✅ UUID primary keys
- ✅ Soft delete with audit trail
- ✅ Comprehensive indexing
- ✅ Auto-numbering (QT-0001, SO-0001)
- ✅ Auto-calculations (totals, metrics)
- ✅ Status workflows
- ✅ RESTful API design
- ✅ Responsive UI
- ✅ Consistent styling
- ✅ Integration ready

---

## 📝 NOTES

- All monetary values use DECIMAL(15,2)
- Lead source tracking enables campaign attribution
- Opportunity probability helps forecast revenue
- Quotation validity dates enable auto-expiry
- Sales targets tracked monthly per employee
- Campaign metrics calculated in real-time
- Cost per lead = actual_spend / actual_leads
- Conversion rate = converted_leads / total_leads
- ROI = ((revenue - spend) / spend) × 100
- All status changes logged in audit trail

---

**Module Status:** ✅ Production Ready  
**Last Updated:** 2024  
**Version:** 1.0.0
