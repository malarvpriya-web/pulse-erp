# CEO Intelligence Dashboard — Architecture
## Phase 49H | Pulse ERP

---

## Overview

The CEO Intelligence Dashboard is a single-screen strategic executive view delivering company-wide
visibility across Revenue, Profitability, Customers, Suppliers, Risk, Forecast, and Growth.

It is accessible via: **Analytics & AI → CEO Intelligence** in the sidebar.

---

## Frontend Architecture

### Entry Point
```
frontend/src/features/analytics/pages/CEOIntelligenceDashboard.jsx
```

### Tab Structure (8 Tabs)

| Tab | Sections Covered | Primary Data Source |
|-----|-----------------|---------------------|
| Executive Summary | Section 1 (KPIs + Traffic Lights) | `/ceo-intelligence/executive-summary` |
| Customer Intelligence | Sections 2, 3, 4 (Health + Risk + Growth) | `/ceo-intelligence/customers` |
| Sales Command | Section 5 (Pipeline + Forecast) | `/sales-command-center/*` |
| Vendor Intelligence | Sections 6, 7 (Health + Risk) | `/ceo-intelligence/vendors` |
| Projects & P&L | Sections 9, 10 (Health + Profitability) | `/ceo-intelligence/projects` |
| Collections & AMC | Sections 11, 12 (Aging + AMC) | `/ceo-intelligence/collections` + `/service-amc` |
| War Room | Sections 14, 15, 16 (Alerts + AI + Critical) | `/ceo-intelligence/strategic-alerts` + `/ai-insights` |
| Business Lines | Manifest (HVDC/STATCOM/SST etc.) | `/ceo-intelligence/manifest` |

### Component Tree

```
CEOIntelligenceDashboard.jsx          ← Main 8-tab container
├── ExecutiveSummaryTab               ← Inline (KPIs, traffic lights, trend chart)
├── CustomerIntelligenceTab           ← Inline (health cards, table, sub-nav)
│   ├── CustomerTable                 ← Inline (top 20)
│   ├── CustomerRiskPanel.jsx         ← Customer Risk Center (Section 3)
│   └── CustomerGrowthView            ← Inline (growth leaders, upsell)
├── RevenueForecastPanel.jsx          ← Sales Command Center (Section 5)
├── VendorIntelligenceTab             ← Inline (vendor health, table)
│   ├── VendorTable                   ← Inline (top vendors by spend)
│   ├── VendorRiskPanel.jsx           ← Supply Chain Risk Center (Section 7)
│   └── SupplyChainRiskPanel.jsx      ← Supply Chain Exposure (Section 8)
├── ProjectProfitabilityPanel.jsx     ← Project Intelligence + P&L (Sections 9, 10)
├── CollectionRiskPanel.jsx           ← Collections Center + AMC (Sections 11, 12)
├── StrategicAlertsPanel.jsx          ← War Room + Strategic Alerts (Sections 14, 16)
├── AIInsightsPanel.jsx               ← AI Insights (Section 15)
└── ManifestTab                       ← Business Line Intelligence (Manifest)
```

---

## Backend Architecture

### Route File
```
backend/src/modules/intelligence/ceo-intelligence.routes.js
```

### Route Registration (server.js)
```js
v1Router.use("/ceo-intelligence", verifyToken, ceoIntelligenceRoutes);
```

### API Endpoints

| Method | Endpoint | Permission | Description |
|--------|----------|------------|-------------|
| GET | `/api/v1/ceo-intelligence/executive-summary` | crm.view | Revenue KPIs, traffic lights, 6-month trend |
| GET | `/api/v1/ceo-intelligence/customers` | crm.view | Customer health, risk, growth, top 50 |
| GET | `/api/v1/ceo-intelligence/vendors` | procurement.view | Vendor health, spend, risk, single-source |
| GET | `/api/v1/ceo-intelligence/projects` | projects.view | Project profitability, health, delayed, loss |
| GET | `/api/v1/ceo-intelligence/collections` | finance.view | Aging buckets (30/60/90/120+ days) |
| GET | `/api/v1/ceo-intelligence/service-amc` | crm.view | Open tickets, AMC contracts, expiring list |
| GET | `/api/v1/ceo-intelligence/strategic-alerts` | crm.view | Red/amber alerts by category |
| GET | `/api/v1/ceo-intelligence/ai-insights` | crm.view | Rule-based AI insights from live data |
| GET | `/api/v1/ceo-intelligence/manifest` | projects.view | Revenue by business line (HVDC/STATCOM/etc.) |

---

## Data Loading Strategy

- **Single fetch burst on mount**: All 8 API calls fire in parallel via `Promise.all`
- **AbortController**: Prevents stale data if user refreshes mid-flight
- **Error isolation**: Each API call wrapped in `.catch(() => ({ data: null }))` — one failure doesn't break the rest
- **Manual refresh**: Refresh button re-fires the full load cycle

---

## Security

- All endpoints behind `verifyToken` middleware (JWT required)
- All queries scoped to `company_id` from `req.user.company_id`
- Permission checks on each route via `requirePermission(module, action)`

---

## Route Registration

```
config/routes.jsx:
  CEOIntelligenceDashboard: lazy(() => import('@/features/analytics/pages/CEOIntelligenceDashboard'))

NAV_ITEMS (config/routes.jsx):
  Analytics & AI → CEO Intelligence → CEOIntelligenceDashboard
```
