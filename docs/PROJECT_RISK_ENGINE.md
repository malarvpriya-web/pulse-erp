# Project Risk Engine

## Risk Categories

| Category       | Trigger                                          | Level           |
|----------------|--------------------------------------------------|-----------------|
| Schedule       | Overdue milestones                               | High / Critical |
| Cost           | Cost > 85% of revenue                           | High / Critical |
| Procurement    | > 3 POs pending confirmation                    | High            |
| Quality        | Open NCRs                                        | Medium / Critical|
| Service        | Open service tickets                             | Medium          |
| Commissioning  | Not started, project end approaching             | High            |
| Customer       | Overdue invoices                                 | Medium / Critical|

## Risk Levels

| Level    | Color  |
|----------|--------|
| Critical | Red    |
| High     | Orange |
| Medium   | Amber  |
| Low      | Green  |

## War Room Alerts (50U)

Alerts are generated from:
1. Overdue milestones → Schedule alert
2. Pending POs > 2 → Procurement alert
3. Open NCRs → Quality alert
4. Cost > 90% of revenue → Budget alert
5. Overdue invoices → Collections alert
6. Critical/High open service tickets → Service alert

Each alert shows a list of affected items for immediate action.
