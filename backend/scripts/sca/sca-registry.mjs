// backend/scripts/sca/sca-registry.mjs
/**
 * The 198 supply-chain components, each bound to probes that can fail.
 *
 * The component list and the group structure are the 2026-09-11 SCA audit's,
 * kept verbatim so the before/after is comparable. What changed is how a row is
 * scored: the audit read code and judged; this file executes a probe.
 *
 * Reading a row: `p:` is the list of probes. All must pass for FULL. A row that
 * passes some is PARTIAL and names which probe failed; a row that passes none is
 * MISSING.
 *
 * THE RULE THAT MAKES THIS HARDER THAN THE AUDIT
 * ----------------------------------------------
 * A capability is not full until a user can reach it. Several capabilities the
 * audit marked "full" were backend-only: the engine ran, the endpoint was
 * mounted, and no screen in Pulse called it. Those score PARTIAL here until a
 * page exists in ROUTES *and* is reachable from NAV_ITEMS - which is why this
 * scorecard reads lower than the report that preceded it.
 */
import { be, ep, fe, page, sql } from './sca-probe.mjs';

export const COMPONENTS = [

// ─── 1 · Demand planning ─────────────────────────────────────────────────────
{ g: 1, n: 'Demand planning', p: [
  ep('GET /inventory/planning/forecast'), page('DemandPlanning'),
  sql('a forecast run exists', 'select count(*)::int n from demand_forecast_runs', r => r[0].n > 0) ] },

{ g: 1, n: 'Demand forecasting', p: [
  be(/export async function runDemandForecast/), ep('POST /inventory/planning/forecast/run'),
  sql('forecast rows carry a method', 'select count(*)::int n from demand_forecasts where method is not null', r => r[0].n > 0) ] },

{ g: 1, n: 'Historical demand analysis', p: [
  be(/demand_periods_observed/),
  sql('items carry observed demand periods', 'select count(*)::int n from inventory_items where demand_periods_observed > 0', r => r[0].n > 0) ] },

{ g: 1, n: 'Time-series forecasting', p: [
  be(/export function holt/),
  sql('at least three methods were scored against history',
    'select count(distinct method)::int n from demand_forecast_method_scores', r => r[0].n >= 3) ] },

{ g: 1, n: 'Moving average', p: [
  be(/export function movingAverage/),
  sql('moving average was scored', "select count(*)::int n from demand_forecast_method_scores where method = 'moving_average'", r => r[0].n > 0) ] },

{ g: 1, n: 'Exponential smoothing', p: [
  be(/export function expSmoothing/),
  sql('smoothing was scored', "select count(*)::int n from demand_forecast_method_scores where method = 'exp_smoothing'", r => r[0].n > 0) ] },

{ g: 1, n: 'Causal forecasting', p: [
  be(/export function fitCausal/), ep('GET /inventory/planning/drivers/fits'),
  sql('drivers carry values', 'select count(*)::int n from forecast_driver_values', r => r[0].n > 0) ] },

{ g: 1, n: 'Judgmental forecasting', p: [
  be(/is_manual_override/), ep('PUT /inventory/planning/forecast/:id'),
  sql('a judgmental override exists', 'select count(*)::int n from demand_forecasts where is_manual_override = true', r => r[0].n > 0) ] },

{ g: 1, n: 'Forecast accuracy measurement', p: [
  be(/export async function measureForecastAccuracy/), ep('POST /inventory/planning/forecast/measure-accuracy'),
  sql('accuracy has been measured', 'select count(*)::int n from demand_forecast_accuracy', r => r[0].n > 0) ] },

{ g: 1, n: 'Rolling forecasts', p: [
  be(/rolling/i, 'a rolling-horizon mechanism'),
  sql('the horizon spans several periods', 'select count(distinct period_start)::int n from demand_forecasts', r => r[0].n >= 3) ] },

{ g: 1, n: 'Seasonality & trend analysis', p: [
  be(/export function seasonalIndices/),
  sql('seasonal and trend methods were scored',
    "select count(*)::int n from demand_forecast_method_scores where method in ('seasonal','holt')", r => r[0].n > 0) ] },

{ g: 1, n: 'Demand variability', p: [
  sql('sigma and CV are persisted', 'select count(*)::int n from inventory_items where demand_stddev is not null and demand_cv is not null', r => r[0].n > 0) ] },

{ g: 1, n: 'Demand planning dashboards', p: [ page('DemandPlanning'), fe(/planning\/forecast/) ] },

{ g: 1, n: 'Forecast vs actual', p: [
  ep('GET /inventory/planning/forecast/accuracy'), fe(/planning\/forecast\/accuracy/),
  sql('an actual has been posted against a forecast', 'select count(*)::int n from demand_forecasts where actual_qty is not null', r => r[0].n > 0) ] },

{ g: 1, n: 'Forecast revision & approval', p: [
  ep('POST /inventory/planning/forecast/approve'),
  sql('a forecast has been approved', 'select count(*)::int n from demand_forecasts where approved_at is not null', r => r[0].n > 0) ] },

{ g: 1, n: 'Safety stock from variability', p: [
  be(/export function calculateSafetyStock/),
  sql('statistical safety stock is persisted', 'select count(*)::int n from inventory_items where safety_stock_calculated > 0', r => r[0].n > 0) ] },

// ─── 2 · Master production schedule ──────────────────────────────────────────
{ g: 2, n: 'Master production schedule', p: [
  ep('GET /mrp/mps'), fe(/\/mrp\/mps/),
  sql('the MPS carries rows with real demand', 'select count(*)::int n from master_production_schedule where quantity > 0', r => r[0].n > 0) ] },

{ g: 2, n: 'What-to-produce planning', p: [
  ep('POST /mrp/mps/generate'),
  sql('MPS rows are traceable to a demand source', 'select count(*)::int n from master_production_schedule where source_forecast_id is not null or source_order_id is not null', r => r[0].n > 0) ] },

{ g: 2, n: 'Quantity planning', p: [
  sql('MPS quantities are netted, not typed', 'select count(*)::int n from master_production_schedule where generated_by_run_id is not null', r => r[0].n > 0) ] },

{ g: 2, n: 'Production-date planning', p: [
  sql('MPS rows carry due dates', 'select count(*)::int n from master_production_schedule where due_date is not null', r => r[0].n > 0) ] },

{ g: 2, n: 'Demand-to-production linkage', p: [
  be(/generateMPSFromDemand/), ep('POST /mrp/mps/generate') ] },

{ g: 2, n: 'Production scheduling', p: [
  be(/sequenceWorkCentre|finiteSchedule/), ep('POST /production/schedule/sequence'),
  sql('operations carry a finite sequence', 'select count(*)::int n from production_operations where scheduled_seq is not null', r => r[0].n > 0) ] },

{ g: 2, n: 'Planned production orders', p: [
  ep('POST /mrp/planned-orders/:id/convert'),
  sql('planned orders exist to convert', 'select count(*)::int n from mrp_planned_orders', r => r[0].n > 0) ] },

{ g: 2, n: 'Capacity constraints in scheduling', p: [
  be(/capacity_overload/),
  sql('a capacity exception has been raised', "select count(*)::int n from mrp_exceptions where exception_type = 'capacity_overload'", r => r[0].n > 0) ] },

{ g: 2, n: 'Rescheduling', p: [
  be(/reschedule_in|reschedule_out/),
  sql('a reschedule message has been raised', "select count(*)::int n from mrp_planned_orders where reschedule_action is not null", r => r[0].n > 0) ] },

{ g: 2, n: 'Schedule adherence', p: [
  be(/days_delayed|schedule_adherence/), ep('GET /mrp/dashboard') ] },

{ g: 2, n: 'MPS vs actual production', p: [
  be(/reportProductionToMPS|quantity_produced\s*=\s*\w*\s*quantity_produced/, 'production completion writes back to the MPS'),
  ep('GET /mrp/mps') ] },

// ─── 3 · Capacity planning ───────────────────────────────────────────────────
{ g: 3, n: 'Machine capacity', p: [
  sql('work centres carry machine capacity', 'select count(*)::int n from work_centres where num_machines is not null and capacity_hours_per_day > 0', r => r[0].n > 0) ] },

{ g: 3, n: 'Labour capacity', p: [
  be(/labour_hours_per_operator/),
  sql('labour capacity is modelled', 'select count(*)::int n from work_centres where num_operators > 0', r => r[0].n > 0) ] },

{ g: 3, n: 'Work-centre capacity', p: [ ep('GET /crp/work-centre-capacity'), page('CRPWorkbench') ] },

{ g: 3, n: 'Available hours', p: [
  sql('CRP load rows carry available hours', 'select count(*)::int n from crp_load where available_hours > 0', r => r[0].n > 0) ] },

{ g: 3, n: 'Planned hours', p: [
  sql('CRP load rows carry required hours', 'select count(*)::int n from crp_load where required_hours > 0', r => r[0].n > 0) ] },

{ g: 3, n: 'Utilisation %', p: [
  sql('load % is persisted', 'select count(*)::int n from crp_load where load_pct is not null', r => r[0].n > 0) ] },

{ g: 3, n: 'Capacity constraints', p: [
  be(/capacity_infeasible_count/),
  sql('an MRP run has been capacity-checked', 'select count(*)::int n from mrp_runs where capacity_checked = true', r => r[0].n > 0) ] },

{ g: 3, n: 'Bottleneck identification', p: [
  be(/is_bottleneck/),
  sql('a bottleneck is flagged from load', 'select count(*)::int n from work_centres where is_bottleneck = true', r => r[0].n > 0) ] },

{ g: 3, n: 'Over-capacity alerts', p: [
  be(/CAPACITY_OVERLOAD_ALERT/, 'an overload raises a notification'), ep('GET /crp/dashboard') ] },

{ g: 3, n: 'Under-utilisation identification', p: [
  be(/under_utilised|underUtilised/), ep('GET /crp/dashboard') ] },

{ g: 3, n: 'Capacity expansion / scenarios', p: [
  ep('POST /scm/scenarios/run'), page('ScenarioPlanning'),
  sql('a capacity scenario has been run', "select count(*)::int n from planning_scenarios where adjustments::text ilike '%capacity%'", r => r[0].n > 0) ] },

{ g: 3, n: 'Capacity-constrained planning', p: [
  be(/crp_run_id/),
  sql('MRP linked a CRP run', 'select count(*)::int n from mrp_runs where crp_run_id is not null', r => r[0].n > 0) ] },

// ─── 4 · Inventory planning ──────────────────────────────────────────────────
{ g: 4, n: 'Inventory planning', p: [
  ep('POST /inventory/planning/recompute'), page('InventoryPlanningParameters'),
  sql('a planning run has persisted parameters', 'select count(*)::int n from inventory_planning_run_items', r => r[0].n > 0) ] },

{ g: 4, n: 'Multi-location inventory', p: [
  be(/warehouseNetting|netByWarehouse/, 'MRP nets per warehouse'),
  sql('stock is held in more than one location', 'select count(distinct warehouse_id)::int n from stock_ledger where warehouse_id is not null', r => r[0].n > 1) ] },

{ g: 4, n: 'Warehouse / store-wise inventory', p: [ page('WarehouseManagement'), ep('GET /inventory/warehouses') ] },

{ g: 4, n: 'On-hand inventory', p: [
  sql('current_stock equals the ledger for every item',
    'select count(*)::int n from inventory_items i where coalesce(i.current_stock,0) <> coalesce((select sum(coalesce(l.quantity_in,0) - coalesce(l.quantity_out,0)) from stock_ledger l where l.item_id = i.id),0)',
    r => r[0].n === 0) ] },

{ g: 4, n: 'Reserved inventory', p: [
  ep('GET /inventory/advanced/reservations'), page('StockReservations'),
  sql('reservations exist', 'select count(*)::int n from inventory_reservations', r => r[0].n > 0) ] },

{ g: 4, n: 'Available inventory', p: [
  be(/quantity_reserved|reservedQty/, 'available nets reservations'), ep('GET /inventory/stock/summary') ] },

{ g: 4, n: 'On-order inventory', p: [
  sql('open supply is dated', "select count(*)::int n from purchase_orders where status not in ('received','cancelled','closed') and expected_delivery_date is not null", r => r[0].n > 0) ] },

{ g: 4, n: 'In-transit inventory', p: [
  ep('GET /inventory/scm/in-transit'), page('InventoryHealth') ] },

{ g: 4, n: 'Safety stock', p: [
  sql('safety stock is non-zero somewhere', 'select count(*)::int n from inventory_items where coalesce(safety_stock,0) > 0', r => r[0].n > 0) ] },

{ g: 4, n: 'Reorder point', p: [
  sql('ROP is computed, not typed', 'select count(*)::int n from inventory_items where reorder_point_calculated > 0', r => r[0].n > 0) ] },

{ g: 4, n: 'Dynamic reorder point', p: [
  be(/export function calculateDynamicROP/),
  sql('ROP is sourced as calculated', "select count(*)::int n from inventory_items where reorder_point_source = 'calculated'", r => r[0].n > 0) ] },

{ g: 4, n: 'EOQ', p: [
  be(/export function calculateEOQ/),
  sql('EOQ is persisted', 'select count(*)::int n from inventory_items where eoq > 0', r => r[0].n > 0) ] },

{ g: 4, n: 'Min / max stock levels', p: [
  sql('min/max are populated', 'select count(*)::int n from inventory_items where min_order_qty is not null and max_order_qty is not null', r => r[0].n > 0) ] },

{ g: 4, n: 'Lead-time consideration', p: [
  sql('lead times differ by item', 'select count(distinct lead_time_days)::int n from inventory_items where lead_time_days is not null', r => r[0].n > 1) ] },

{ g: 4, n: 'ABC analysis', p: [
  be(/export function classifyABCPareto/), ep('GET /inventory/planning/abc'),
  sql('ABC is written to the item master', 'select count(*)::int n from inventory_items where abc_class_calculated is not null', r => r[0].n > 0) ] },

{ g: 4, n: 'Inventory classification', p: [
  sql('XYZ and FSN are classified too', 'select count(*)::int n from inventory_items where xyz_class is not null and fsn_class is not null', r => r[0].n > 0) ] },

{ g: 4, n: 'Inventory turnover', p: [
  be(/turnover/i), ep('GET /inventory/scm/excess-obsolete'), page('InventoryHealth') ] },

{ g: 4, n: 'Stock ageing', p: [
  be(/ageing|aging/i), ep('GET /inventory/scm/near-expiry'), page('InventoryHealth') ] },

{ g: 4, n: 'Slow-moving inventory', p: [
  ep('GET /inventory/scm/excess-obsolete'), page('InventoryHealth'),
  sql('FSN marks slow movers', 'select count(*)::int n from inventory_items where fsn_class is not null', r => r[0].n > 0) ] },

{ g: 4, n: 'Excess inventory', p: [ ep('GET /inventory/scm/excess-obsolete'), page('InventoryHealth') ] },
{ g: 4, n: 'Obsolete inventory', p: [ ep('GET /inventory/scm/policy'), page('InventoryHealth') ] },

{ g: 4, n: 'Stockout monitoring', p: [
  ep('GET /service-level/summary'), page('ServiceLevelDashboard') ] },

{ g: 4, n: 'Inventory optimisation', p: [
  be(/suggestedOrderQuantity/), be(/echelon/i, 'echelon-aware optimisation'),
  ep('GET /inventory/planning/optimisation') ] },

{ g: 4, n: 'JIT functionality', p: [
  ep('POST /inventory/scm/kanban/cards/:id/signal'), page('KanbanLoops'),
  sql('a kanban loop is circulating', 'select count(*)::int n from kanban_cards', r => r[0].n > 0) ] },

{ g: 4, n: 'Inventory forecasting', p: [
  be(/projectedOnHand/), ep('GET /inventory/planning/projected-stock'), page('InventoryPlanningParameters') ] },

// ─── 5 · MRP ─────────────────────────────────────────────────────────────────
{ g: 5, n: 'MRP', p: [
  ep('POST /mrp/run'), page('MRPWorkbench'),
  sql('the latest completed run produced planned orders',
    "select coalesce(max(planned_order_count),0)::int n from mrp_runs where status = 'completed'", r => r[0].n > 0) ] },

{ g: 5, n: 'Multi-level BOM', p: [
  sql('a BOM explodes more than one level', 'select coalesce(max(low_level_code),0)::int n from mrp_planned_orders', r => r[0].n >= 2) ] },

{ g: 5, n: 'BOM explosion', p: [
  be(/childrenOf/),
  sql('planned orders exist at a child level', 'select count(*)::int n from mrp_planned_orders where low_level_code > 0', r => r[0].n > 0) ] },

{ g: 5, n: 'Component requirements', p: [
  sql('time-phased rows exist for components', 'select count(*)::int n from mrp_time_phased where gross_requirements > 0', r => r[0].n > 0) ] },

{ g: 5, n: 'Gross requirements', p: [
  sql('gross requirements are bucketed', 'select count(distinct bucket_start)::int n from mrp_time_phased', r => r[0].n > 1) ] },

{ g: 5, n: 'On-hand in netting', p: [
  sql('netting carried a projected balance', 'select count(*)::int n from mrp_time_phased where projected_available is not null', r => r[0].n > 0) ] },

{ g: 5, n: 'On-order in netting', p: [
  sql('scheduled receipts reached the grid', 'select count(*)::int n from mrp_time_phased where scheduled_receipts > 0', r => r[0].n > 0) ] },

{ g: 5, n: 'Allocated / reserved in netting', p: [
  be(/const committedQty = committed\.get/, 'MRP nets committed stock out of on-hand'),
  sql('something is actually committed against stock',
    'select (select count(*) from inventory_allocations) + (select count(*) from inventory_reservations) as n',
    r => Number(r[0].n) > 0) ] },

{ g: 5, n: 'Net requirements', p: [
  sql('net requirements are computed', 'select count(*)::int n from mrp_time_phased where net_requirements > 0', r => r[0].n > 0) ] },

{ g: 5, n: 'Safety stock in netting', p: [
  sql('a planned item carries safety stock', 'select count(*)::int n from mrp_planned_orders where coalesce(safety_stock,0) > 0', r => r[0].n > 0) ] },

{ g: 5, n: 'Lead time offsetting', p: [
  sql('start precedes need on some order', 'select count(*)::int n from mrp_planned_orders where start_date < need_date', r => r[0].n > 0) ] },

{ g: 5, n: 'Planned receipts', p: [
  sql('lot sizing produced a receipt', 'select count(*)::int n from mrp_planned_orders where quantity > 0', r => r[0].n > 0) ] },

{ g: 5, n: 'Planned order releases', p: [
  sql('planned orders carry a start date', 'select count(*)::int n from mrp_planned_orders where start_date is not null', r => r[0].n > 0) ] },

{ g: 5, n: 'Purchase requisitions', p: [ ep('POST /mrp/planned-orders/convert-all'), be(/purchase_requests/) ] },
{ g: 5, n: 'Production orders', p: [ ep('POST /mrp/planned-orders/:id/convert'), be(/production_orders/) ] },

{ g: 5, n: 'Exception messages', p: [
  sql('exceptions are emitted', 'select count(*)::int n from mrp_exceptions', r => r[0].n > 0) ] },

{ g: 5, n: 'Shortage identification', p: [ ep('GET /mrp/shortages'), fe(/mrp\/shortages/) ] },

{ g: 5, n: 'Rescheduling', p: [
  be(/reschedule_in/),
  sql('a reschedule action was written', 'select count(*)::int n from mrp_planned_orders where reschedule_action is not null', r => r[0].n > 0) ] },

{ g: 5, n: 'MRP regeneration', p: [
  sql('runs are regenerative and persisted', "select count(*)::int n from mrp_runs where status = 'completed'", r => r[0].n > 1) ] },

{ g: 5, n: 'MRP dashboards / reports', p: [ ep('GET /mrp/dashboard'), page('MRPWorkbench') ] },

// ─── 6 · Procurement & supplier planning ─────────────────────────────────────
{ g: 6, n: 'Purchase requisitions', p: [ ep('GET /procurement/purchase-requests'), page('PurchaseRequestDashboard') ] },
{ g: 6, n: 'Purchase orders', p: [ ep('GET /procurement/purchase-orders'), page('PurchaseOrders') ] },
{ g: 6, n: 'Supplier selection', p: [ ep('GET /rfx/events'), page('RfxEvaluation') ] },

{ g: 6, n: 'Supplier lead time', p: [
  be(/measureSupplierLeadTimes/, 'measured lead time feeds item planning'),
  sql('an item lead time is vendor-derived', "select count(*)::int n from inventory_items where lead_time_source = 'measured'", r => r[0].n > 0) ] },

{ g: 6, n: 'Supplier capacity', p: [
  ep('GET /scm/supplier-capacity/check'), page('SupplierCapacity'),
  sql('capacity is declared', 'select count(*)::int n from supplier_capacity', r => r[0].n > 0) ] },

{ g: 6, n: 'Supplier performance', p: [ ep('GET /vendor-health/:vendorId'), page('SupplierPerformanceIndex') ] },

{ g: 6, n: 'Delivery tracking', p: [
  ep('GET /inventory/scm/in-transit'), page('InventoryHealth'),
  sql('an inbound shipment is tracked', "select count(*)::int n from shipments where direction = 'inbound'", r => r[0].n > 0) ] },

{ g: 6, n: 'Purchase-order status', p: [ ep('GET /procurement/purchase-orders/:id'), be(/received_qty/) ] },
{ g: 6, n: 'Material receipt', p: [ ep('POST /procurement/grn'), be(/idempotency/i) ] },
{ g: 6, n: 'Incoming inspection', p: [ be(/require_iqc_before_stock/), page('InspectionCenter') ] },
{ g: 6, n: 'Supplier quality', p: [ page('SupplierQuality'), be(/vendor_ncr|supplier_quality/) ] },

{ g: 6, n: 'Supplier delays', p: [
  be(/supplierDelayRisk|vendor_delay/, 'measured delay drives replanning'),
  sql('a supplier-driven reschedule exists', "select count(*)::int n from mrp_planned_orders where reschedule_reason ilike '%supplier%' or reschedule_reason ilike '%vendor%'", r => r[0].n > 0) ] },

// ─── 7 · Demand fulfilment ───────────────────────────────────────────────────
{ g: 7, n: 'Order management', p: [ ep('GET /sales/orders'), page('SalesOrders') ] },
{ g: 7, n: 'Order validation', p: [ be(/export async function promiseOrder/), be(/credit_limit/) ] },
{ g: 7, n: 'Available-to-promise', p: [ ep('GET /mrp/atp'), fe(/\/mrp\/atp/) ] },

{ g: 7, n: 'Inventory allocation', p: [
  be(/inventory_allocations/),
  sql('an allocation has been made', 'select count(*)::int n from inventory_allocations', r => r[0].n > 0) ] },

{ g: 7, n: 'Backorders', p: [
  be(/releaseBackorders/), ep('POST /sales/backorders/release') ] },

{ g: 7, n: 'Order prioritisation', p: [
  be(/pick_lists[\s\S]{0,400}?priority/, 'orders carry a fulfilment priority'),
  sql('pick lists carry a priority', 'select count(*)::int n from pick_lists where priority is not null', r => r[0].n > 0) ] },

{ g: 7, n: 'Picking', p: [ ep('POST /warehouse/pick-lists'), page('WarehouseManagement') ] },

{ g: 7, n: 'Packing', p: [
  ep('POST /warehouse/pack'),
  sql('a carton records its lots', 'select count(*)::int n from package_lines', r => r[0].n > 0) ] },

{ g: 7, n: 'Dispatch', p: [
  sql('dispatch created a shipment with a reference', 'select count(*)::int n from shipments where dispatch_ref is not null', r => r[0].n > 0) ] },

{ g: 7, n: 'Shipment creation', p: [
  sql('shipments link to their order', 'select count(*)::int n from shipments where sales_order_id is not null', r => r[0].n > 0) ] },

{ g: 7, n: 'Shipment tracking', p: [ ep('GET /logistics/shipments'), page('LogisticsShipping') ] },

{ g: 7, n: 'Delivery confirmation', p: [
  sql('a delivery has been confirmed', 'select count(*)::int n from shipments where actual_delivery is not null', r => r[0].n > 0) ] },

{ g: 7, n: 'Returns', p: [
  ep('POST /scm/returns'), page('ReturnsRMA'),
  sql('a return exists', 'select count(*)::int n from sales_returns', r => r[0].n > 0) ] },

{ g: 7, n: 'Customer complaints', p: [ ep('GET /complaints'), page('ComplaintsDashboard') ] },

{ g: 7, n: 'After-sales support', p: [
  page('SupportDashboard'),
  sql('the dead tickets duplicate is gone',
    "select count(*)::int n from information_schema.tables where table_schema='public' and table_name='tickets'", r => r[0].n === 0) ] },

{ g: 7, n: 'Order status visibility', p: [ ep('GET /sales/orders/:id'), page('SalesOrders') ] },
{ g: 7, n: 'Delivery notes', p: [ be(/delivery_note/), page('LogisticsShipping') ] },

// ─── 8 · Warehouse & material handling ───────────────────────────────────────
{ g: 8, n: 'Warehouse management', p: [ page('WarehouseManagement'), ep('GET /inventory/warehouses') ] },
{ g: 8, n: 'Store / location / bin management', p: [ ep('GET /warehouse/bins'), be(/warehouse_bins/) ] },
{ g: 8, n: 'Goods receipt', p: [ ep('POST /procurement/grn'), page('GoodsReceipt') ] },

{ g: 8, n: 'Put-away', p: [
  ep('POST /warehouse/put-away'), page('WarehouseOperations'),
  sql('a put-away has been recorded', 'select count(*)::int n from put_away_tasks', r => r[0].n > 0) ] },

{ g: 8, n: 'Internal material movement', p: [ ep('POST /inventory/warehouse-transfers'), page('StockMovements') ] },
{ g: 8, n: 'Picking', p: [ ep('POST /warehouse/pick-lists'), be(/pick_list_lines/) ] },
{ g: 8, n: 'Packing', p: [ ep('POST /warehouse/pack'), be(/package_lines/) ] },
{ g: 8, n: 'Dispatch', p: [ ep('POST /warehouse/dispatch'), be(/dispatch_ref/) ] },
{ g: 8, n: 'Cycle counting', p: [ ep('POST /warehouse/cycle-count'), page('StockSummary') ] },
{ g: 8, n: 'Stock transfer', p: [ ep('POST /inventory/warehouse-transfers'), be(/stock_transfer_items/) ] },
{ g: 8, n: 'Multi-store visibility', p: [ page('StoresDashboard'), ep('GET /inventory/warehouses') ] },

{ g: 8, n: 'Unit-load handling', p: [
  ep('POST /inventory/scm/unit-loads'), page('WarehouseOperations'),
  sql('a unit load exists', 'select count(*)::int n from unit_loads', r => r[0].n > 0) ] },

{ g: 8, n: 'Batch / lot tracking', p: [ page('BatchTracking'), be(/inventory_batches/) ] },

{ g: 8, n: 'FIFO', p: [
  be(/inventory_fifo_layers/),
  sql('FIFO layers are being consumed', 'select count(*)::int n from inventory_fifo_consumption', r => r[0].n > 0) ] },

{ g: 8, n: 'FEFO', p: [
  be(/FEFO|fefo/),
  sql('a near-expiry policy exists', 'select count(*)::int n from inventory_policy_settings where near_expiry_days > 0', r => r[0].n > 0) ] },

{ g: 8, n: 'Barcode / RFID', p: [
  ep('POST /inventory/scm/rfid/scan'), page('WarehouseOperations'),
  sql('a scan has been recorded', 'select count(*)::int n from rfid_scans', r => r[0].n > 0) ] },

{ g: 8, n: 'Material-handling equipment', p: [
  ep('POST /inventory/scm/mhe/:id/assign'), page('WarehouseOperations'),
  sql('equipment has been assigned', 'select count(*)::int n from mhe_assignments', r => r[0].n > 0) ] },

// ─── 9 · Traceability ────────────────────────────────────────────────────────
{ g: 9, n: 'Component ID', p: [ page('ItemMaster'), be(/item_code/) ] },

{ g: 9, n: 'Batch / lot / serial number', p: [
  sql('material issues carry lot identity', 'select count(*)::int n from material_issue_logs where batch_id is not null', r => r[0].n > 0) ] },

{ g: 9, n: 'Supplier on the trace', p: [
  sql('every received batch resolves to a supplier',
    'select count(*)::int n from inventory_batches where supplier_id is null and grn_id is not null', r => r[0].n === 0) ] },

{ g: 9, n: 'Purchase order on the trace', p: [
  sql('batches reach a PO through their GRN',
    'select count(*)::int n from inventory_batches b join goods_receipt_notes g on g.id = b.grn_id where g.po_id is not null', r => r[0].n > 0) ] },

{ g: 9, n: 'GRN on the trace', p: [
  sql('a batch carries its GRN', 'select count(*)::int n from inventory_batches where grn_id is not null', r => r[0].n > 0) ] },

{ g: 9, n: 'Store / location', p: [
  sql('batches carry a bin, not just a warehouse', 'select count(*)::int n from inventory_batches where bin_id is not null', r => r[0].n > 0) ] },

{ g: 9, n: 'Quantity received', p: [ be(/quantity_received/), page('BatchTracking') ] },
{ g: 9, n: 'Quantity issued', p: [ be(/material_issue_logs/), page('MaterialConsumption') ] },

{ g: 9, n: 'Production order', p: [
  sql('issues carry their production order', 'select count(*)::int n from material_issue_logs where production_order_id is not null', r => r[0].n > 0) ] },

{ g: 9, n: 'Assembly operation', p: [
  sql('issues carry the operation they fed', 'select count(*)::int n from material_issue_logs where operation_id is not null', r => r[0].n > 0) ] },

{ g: 9, n: 'Operator / person responsible', p: [
  sql('issues carry their operator', 'select count(*)::int n from material_issue_logs where issued_by is not null', r => r[0].n > 0) ] },

{ g: 9, n: 'Machine / work centre', p: [
  sql('issues carry the work centre', 'select count(*)::int n from material_issue_logs where work_centre_id is not null', r => r[0].n > 0) ] },

{ g: 9, n: 'QC inspection', p: [ ep('GET /genealogy/qc-history/:id'), page('GenealogyTrace') ] },
{ g: 9, n: 'QC result', p: [ be(/qc_verdict|inspection_result/), ep('GET /genealogy/trace') ] },

{ g: 9, n: 'Rework / rejection', p: [
  be(/rework_records/), ep('GET /production/rework'),
  sql('a rework record exists', 'select count(*)::int n from rework_records', r => r[0].n > 0) ] },

{ g: 9, n: 'Where consumed', p: [ ep('GET /genealogy/where-used/:id'), page('GenealogyTrace') ] },
{ g: 9, n: 'Which sub-assembly', p: [ be(/WITH RECURSIVE/i), ep('GET /genealogy/as-built/:id') ] },

{ g: 9, n: 'Which panel / module', p: [
  sql('as-built attributes per serial', 'select count(*)::int n from material_issue_logs where serial_id is not null', r => r[0].n > 0) ] },

{ g: 9, n: 'Which finished product', p: [
  sql('serials link to their production order', 'select count(*)::int n from serial_numbers where production_order_id is not null', r => r[0].n > 0) ] },

{ g: 9, n: 'Final customer / order', p: [
  sql('a packed lot reaches a sales order',
    'select count(*)::int n from package_lines pl join packages p on p.id = pl.package_id where p.sales_order_id is not null', r => r[0].n > 0) ] },

{ g: 9, n: 'Forward traceability', p: [ ep('GET /genealogy/where-used/:id') ] },
{ g: 9, n: 'Backward traceability', p: [ ep('GET /genealogy/as-built/:id') ] },

// ─── 10 · Quality integration ────────────────────────────────────────────────
{ g: 10, n: 'Incoming QC', p: [ page('InspectionCenter'), be(/require_iqc_before_stock/) ] },
{ g: 10, n: 'In-process QC', p: [ be(/ipqc|in_process/i), page('InspectionCenter') ] },
{ g: 10, n: 'Final QC', p: [ be(/fqc|final_inspection/i), page('FATManagement') ] },
{ g: 10, n: 'Inspection plans', p: [ be(/inspection_checklists/), ep('GET /quality/checklists') ] },
{ g: 10, n: 'Quality holds', p: [ be(/quarantine/i), be(/quality_status/) ] },
{ g: 10, n: 'Rejection', p: [ be(/'rejected'/), page('NCRManagement') ] },

{ g: 10, n: 'Rework', p: [
  be(/rework_records/), ep('POST /production/orders/:id/rework'),
  sql('a rework record exists', 'select count(*)::int n from rework_records', r => r[0].n > 0) ] },

{ g: 10, n: 'NCR', p: [ page('NCRManagement'), ep('GET /quality/ncr') ] },
{ g: 10, n: 'Batch / lot traceability', p: [ page('GenealogyTrace'), ep('GET /genealogy/trace') ] },
{ g: 10, n: 'Supplier quality', p: [ page('SupplierQuality') ] },
{ g: 10, n: 'QC affecting inventory availability', p: [
  be(/require_iqc_before_stock/), page('InspectionCenter'),
  sql('lots carry a quality state, not just an availability one',
    'select count(*)::int n from inventory_batches where quality_status is not null or status is not null',
    r => r[0].n > 0) ] },

{ g: 10, n: 'QC affecting production', p: [
  be(/\['rejected', 'quarantine', 'hold', 'blocked'\]/, 'rejected lots refused at issue'),
  ep('POST /production/orders/:id/issue-material') ] },

{ g: 10, n: 'QC affecting shipment', p: [
  be(/FAT_GATE/, 'FAT gate blocks dispatch'), ep('POST /warehouse/dispatch') ] },

// ─── 11 · Shipping & logistics ───────────────────────────────────────────────
{ g: 11, n: 'Shipment planning', p: [ ep('GET /scm/routes/plan/candidates'), page('RoutePlanning') ] },
{ g: 11, n: 'Carrier management', p: [ be(/carrier_id/), ep('GET /logistics/carriers') ] },
{ g: 11, n: 'Dispatch planning', p: [ ep('POST /scm/routes'), page('RoutePlanning') ] },

{ g: 11, n: 'Delivery scheduling', p: [
  sql('shipments carry the promise they are measured against', 'select count(*)::int n from shipments where promised_date is not null', r => r[0].n > 0) ] },

{ g: 11, n: 'Shipment tracking', p: [ page('LogisticsShipping'), ep('GET /logistics/shipments') ] },

{ g: 11, n: 'Route planning', p: [
  ep('POST /scm/routes/:id/optimise'), page('RoutePlanning'),
  sql('a route has been optimised', 'select count(*)::int n from delivery_routes where optimised_at is not null', r => r[0].n > 0) ] },

{ g: 11, n: 'Freight information', p: [
  sql('freight cost is captured', 'select count(*)::int n from shipments where freight_cost is not null', r => r[0].n > 0) ] },

{ g: 11, n: 'Delivery status', p: [ ep('GET /logistics/shipments'), be(/actual_delivery/) ] },
{ g: 11, n: 'Proof of delivery', p: [ be(/pod_image_url/), page('LogisticsShipping') ] },
{ g: 11, n: 'Returns', p: [ ep('POST /scm/returns/:id/receive'), page('ReturnsRMA') ] },

{ g: 11, n: 'Customer delivery visibility', p: [
  be(/customerPortalShipments/, 'the customer portal exposes shipments'),
  ep('GET /customer-portal/portal/shipments') ] },

// ─── 12 · Customer satisfaction & service level ──────────────────────────────
{ g: 12, n: 'On-time delivery (customer)', p: [ ep('GET /service-level/summary'), page('ServiceLevelDashboard') ] },
{ g: 12, n: 'Order fulfilment rate', p: [ be(/fulfilment_rate|fulfillment_rate/), page('ServiceLevelDashboard') ] },
{ g: 12, n: 'Fill rate', p: [ be(/fill_rate/), page('ServiceLevelDashboard') ] },
{ g: 12, n: 'Stockout rate', p: [ be(/stockout_rate/), page('ServiceLevelDashboard') ] },
{ g: 12, n: 'Order accuracy', p: [ be(/order_accuracy/), page('ServiceLevelDashboard') ] },
{ g: 12, n: 'Customer complaints', p: [ page('ComplaintsDashboard'), ep('GET /complaints') ] },
{ g: 12, n: 'Returns', p: [ ep('GET /scm/returns'), page('ReturnsRMA') ] },
{ g: 12, n: 'Delivery delays', p: [ ep('GET /service-level/late-orders'), page('ServiceLevelDashboard') ] },

{ g: 12, n: 'Customer satisfaction', p: [
  be(/sentiment/),
  sql('feedback carries sentiment', 'select count(*)::int n from voc_responses where sentiment is not null', r => r[0].n > 0) ] },

{ g: 12, n: 'Service level', p: [ ep('GET /service-level/trend'), page('ServiceLevelDashboard') ] },

// ─── 13 · Predictive analytics ───────────────────────────────────────────────
{ g: 13, n: 'Demand prediction', p: [ be(/export async function runDemandForecast/), page('DemandPlanning') ] },
{ g: 13, n: 'Inventory prediction', p: [ be(/projectedOnHand/), ep('GET /inventory/planning/projected-stock') ] },
{ g: 13, n: 'Stockout prediction', p: [ be(/stockout_risk/), ep('GET /inventory/planning/projected-stock') ] },
{ g: 13, n: 'Excess inventory prediction', p: [ ep('GET /inventory/scm/excess-obsolete'), page('InventoryHealth') ] },
{ g: 13, n: 'Supplier-delay prediction', p: [ be(/supplierDelayRisk/), ep('GET /scm/supplier-capacity/check') ] },
{ g: 13, n: 'Capacity prediction', p: [ ep('POST /scm/scenarios/run'), page('ScenarioPlanning') ] },
{ g: 13, n: 'Production-delay prediction', p: [ be(/days_delayed/), ep('GET /mrp/dashboard') ] },

{ g: 13, n: 'Predictive maintenance -> capacity', p: [
  ep('POST /scm/downtime'), page('ScenarioPlanning'),
  sql('downtime is booked against a work centre', 'select count(*)::int n from work_centre_downtime', r => r[0].n > 0) ] },

{ g: 13, n: 'Forecast accuracy analytics', p: [ ep('GET /inventory/planning/forecast/accuracy'), page('DemandPlanning') ] },
{ g: 13, n: 'What-if analysis', p: [ ep('POST /scm/scenarios/run'), page('ScenarioPlanning') ] },
{ g: 13, n: 'Scenario planning', p: [ ep('GET /scm/scenarios'), page('ScenarioPlanning') ] },
{ g: 13, n: 'AI / ML recommendations', p: [ be(/export function olsFit/), page('DemandPlanning') ] },

];

export const GROUP_NAMES = {
  1: 'Demand planning', 2: 'Master production schedule', 3: 'Capacity planning',
  4: 'Inventory planning', 5: 'MRP', 6: 'Procurement & supplier planning',
  7: 'Demand fulfilment', 8: 'Warehouse & material handling', 9: 'Traceability',
  10: 'Quality integration', 11: 'Shipping & logistics',
  12: 'Customer satisfaction & service level', 13: 'Predictive analytics',
};
