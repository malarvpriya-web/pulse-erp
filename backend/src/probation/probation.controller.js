import * as service from "./probation.service.js";

/**
 * Every handler resolves the caller's company first (service.requireCompany):
 * a caller with no company context gets a 403 before any query runs. A
 * ProbationError carries its own status (400/403/404); anything else is a
 * real failure and is reported as a 500 with its message — never swallowed.
 */
const handle = (fn) => async (req, res) => {
  try {
    const companyId = service.requireCompany(req);
    res.json(await fn(companyId, req));
  } catch (err) {
    if (err instanceof service.ProbationError) return res.status(err.status).json({ error: err.message });
    console.error('[Probation]', err);
    res.status(500).json({ error: err.message });
  }
};

export const getPolicy          = handle((cid) => service.getPolicy(cid));
export const updatePolicy       = handle((cid, req) => service.updatePolicy(cid, req.body));
export const calculate          = handle((cid, req) => service.calculate(cid, req.query));
export const getNotifications   = handle((cid) => service.getNotifications(cid));
export const createNotification = handle((cid, req) => service.createNotification(cid, req.body));
export const updateNotification = handle((cid, req) => service.updateNotification(cid, req.params.id, req.body));

export const updateByEmployee = handle(async (cid, req) => {
  const row = await service.updateByEmployee(cid, req.params.employee_id, req.body);
  if (!row) throw new service.ProbationError(404, 'No pending probation record found for this employee');
  return row;
});
