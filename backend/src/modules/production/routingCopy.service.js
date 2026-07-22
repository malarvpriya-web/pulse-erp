// backend/src/modules/production/routingCopy.service.js
//
// Copies a BOM's routing_steps into production_operations for a production
// order. Every path that creates a production_orders row with a known bom_id
// must run this, or the shop floor has nothing to execute against.

export async function copyRoutingToProductionOperations(client, bomId, productionOrderId) {
  if (!bomId || !productionOrderId) return 0;
  const steps = await client.query(
    `SELECT r.id, r.step_no, r.operation, r.work_centre_id, r.std_time_hrs, w.name AS work_centre_name
     FROM routing_steps r
     LEFT JOIN work_centres w ON w.id = r.work_centre_id
     WHERE r.bom_id = $1
     ORDER BY r.step_no, r.id`,
    [bomId]
  );
  for (const s of steps.rows) {
    await client.query(
      `INSERT INTO production_operations
        (production_order_id, routing_step_id, step_no, operation, work_centre_id, work_centre_name, std_time_hrs, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'pending')`,
      [productionOrderId, s.id, s.step_no, s.operation, s.work_centre_id || null, s.work_centre_name || null, s.std_time_hrs || 0]
    );
  }
  return steps.rows.length;
}
