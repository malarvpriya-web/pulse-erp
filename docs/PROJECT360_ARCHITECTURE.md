# Project 360° Command Center — Architecture

## Overview

Single-screen Project Intelligence Platform. One project → one screen → complete visibility across every lifecycle stage from Lead to AMC.

## Route

- **Frontend:** `Project360` component (registered in `config/routes.jsx`)
- **Backend API:** `GET /api/project-360/:id` — aggregates all project data in one call
- **AI Copilot:** `POST /api/project-360/:id/ask` — rule-based natural language answers

## File Structure

```
frontend/src/features/projects/pages/
  Project360.jsx              ← Main command center (20 tabs)

backend/src/modules/projects/routes/
  project360.routes.js        ← Aggregation API + AI Copilot endpoint
```

## 20-Tab Structure

| # | Tab ID         | Section  | Data Source                           |
|---|----------------|----------|---------------------------------------|
| 1 | overview       | 50C      | finance, milestones, issues, tasks    |
| 2 | sales          | 50D      | opportunities, quotations, sales_orders|
| 3 | engineering    | 50E      | boms, project_documents               |
| 4 | procurement    | 50F      | purchase_requests, purchase_orders, GRN|
| 5 | inventory      | 50G      | rm_issues                             |
| 6 | manufacturing  | 50H      | production_orders, timesheets         |
| 7 | quality        | 50I      | ncr_reports, capa_actions, fat/sat    |
| 8 | logistics      | 50J      | shipments                             |
| 9 | installation   | 50K      | lifecycle_events (installation), issues|
|10 | commissioning  | 50L      | lifecycle_events (commissioning), SAT |
|11 | service        | 50M      | service_tickets, project_warranties   |
|12 | amc            | 50N      | amc_contracts                         |
|13 | cost           | 50O      | project_cost_summary (all categories) |
|14 | profitability  | 50P      | finance computed P&L                  |
|15 | travel         | 50Q      | travel_requests                       |
|16 | documents      | 50R      | project_documents + Drive folder tree |
|17 | timeline       | 50S      | computed from all milestone/lifecycle |
|18 | risks          | 50T      | computed risk engine output           |
|19 | warroom        | 50U      | computed alert engine output          |
|20 | ai             | 50V      | POST /project-360/:id/ask             |

## Data Flow

```
GET /api/project-360/:id
  ├── 28x Promise.allSettled queries
  ├── calcHealthScores()  → 7 dimension scores + overall
  ├── calcRisks()         → risk register items
  ├── buildTimeline()     → chronological event list
  └── JSON response (single payload)
```

## Components

- `HealthWidget` — floating health score badge with drill-down
- `SectionCard` — collapsible section container
- `MiniTable` — compact data table
- `ScoreBar` — animated score bar
- `TabXxx` — one component per tab, all co-located in Project360.jsx
