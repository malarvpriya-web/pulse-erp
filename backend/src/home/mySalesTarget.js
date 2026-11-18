// GET /home/my-sales-target — the signed-in person's OWN yearly sales target for
// HR > My Dashboard: the year split into months, what was achieved (from their
// sales orders), the days left, and the incentive on the sales so far. Only ever
// the caller's own figures; no sales permission is needed to read them.
// { has_target: false } when the person has no target this financial year.
import { companyOf } from '../shared/scope.js';
import { ownEmployeeId } from '../modules/payroll/payrollAccess.js';
import { targetView } from '../modules/sales/services/salesIncentive.service.js';

export async function getMySalesTargetHandler(req, res) {
  try {
    const empId = await ownEmployeeId(req);
    const cid = companyOf(req);
    if (empId == null || cid == null) return res.json({ has_target: false });
    const fy = req.query.fy != null ? Number(req.query.fy) : null;
    if (fy != null && !(fy >= 2000 && fy <= 2100)) return res.status(400).json({ error: 'fy must be a year' });
    const view = await targetView({ companyId: cid, employeeId: empId, fy });
    res.json(view ? { has_target: true, ...view } : { has_target: false });
  } catch (err) {
    console.error('[my-sales-target]', err.message);
    res.status(500).json({ error: 'Could not load your sales target' });
  }
}
