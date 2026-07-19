# CEO Traceability Map — Project 360°

## CEO Test: MT-HVDC-001 (50W)

All answers available from a single Project 360° screen without opening any other module:

| Question                        | Tab             | Data Source                  |
|---------------------------------|-----------------|------------------------------|
| Who sold it?                    | Sales           | quotations.salesperson       |
| Which quotation was approved?   | Sales           | quotations (status=Approved) |
| Which PO was received?          | Sales           | sales_orders.order_number    |
| Which BOM revision used?        | Engineering     | boms.revision                |
| Which vendors supplied?         | Procurement     | purchase_orders.vendor_name  |
| Which batches consumed?         | Inventory       | rm_issues.batch_number       |
| Which serial numbers delivered? | Logistics       | shipments.tracking_number    |
| Which FAT passed?               | Quality         | fat_trackers (status=passed) |
| Who commissioned it?            | Commissioning   | lifecycle_events.notes       |
| What travel cost incurred?      | Travel + Cost   | travel_requests + cost tab   |
| What service tickets exist?     | Service         | service_tickets              |
| Which AMC covers it?            | AMC             | amc_contracts                |
| How much profit made?           | Profitability   | finance.actual_profit        |

## Lifecycle Flow Visibility

```
Lead → Opportunity → Quotation → PO → Project
  Sales tab shows: opportunity, quotations, sales orders

Project → Engineering → Procurement → Inventory
  Engineering tab: BOM + drawings
  Procurement tab: PR → PO → GRN
  Inventory tab: RM issues + batch traceability

Production → Quality → FAT
  Manufacturing tab: production orders + timesheets
  Quality tab: inspections + NCR/CAPA + FAT

Dispatch → Installation → Commissioning → SAT
  Logistics tab: shipments + tracking
  Installation tab: lifecycle + punch points
  Commissioning tab: commissioning events + SAT

Service → AMC
  Service tab: tickets + warranty
  AMC tab: contracts + renewals

Financial Overview
  Cost tab: full cost waterfall by category
  Profitability tab: P&L with margin
  Travel tab: all employee travel costs by type
  Timeline tab: chronological event history
  War Room: critical alerts requiring action
  AI Copilot: instant NL answers about any dimension
```
