# Project Profitability Model

## P&L Structure

```
Revenue (Contract Value)
  − Material Cost          (from project_cost_summary.material_cost)
  − Labour Cost            (from project_cost_summary.labour_cost)
  − Engineering Cost       (from project_cost_summary.engineering_cost)
  − Travel Cost            (from project_cost_summary.travel_cost)
  − Production Cost        (from project_cost_summary.production_cost)
  − Quality Cost           (from project_cost_summary.quality_cost)
  − Transport Cost         (from project_cost_summary.transport_cost)
  − Installation Cost      (from project_cost_summary.installation_cost)
  − Commissioning Cost     (from project_cost_summary.commissioning_cost)
  − Service Cost           (from project_cost_summary.service_cost)
  − AMC Cost               (from project_cost_summary.amc_cost)
  − Overhead               (from project_cost_summary.procurement_overhead)
═════════════════════════════
= Gross Profit
  Margin % = Gross Profit / Revenue × 100
```

## Thresholds

| Margin % | Status      | Color |
|----------|-------------|-------|
| ≥ 20%    | Excellent   | Green |
| 15–19%   | Good        | Blue  |
| 10–14%   | Acceptable  | Amber |
| < 10%    | Below Target| Red   |

## Data Source

- `project_cost_summary` table (populated by `projectCostRollup.service.js`)
- `projects.contract_value` = revenue
- All costs computed at project close or on-demand via `POST /project-cost-engine/:id/recalculate`
