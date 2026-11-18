// ownOrPermission(module, action, idOf) — let a caller READ their own employee
// record's data without holding the module grant (2026-11-11).
//
// HR > Self Service > My Details is the View Employee page in self mode: the
// employee sees their own Assets and salary History there. Those routes were
// gated on assets:view / payroll:view, which employees do not (and must not)
// hold for everyone else's records. This middleware passes the grant holder
// through unchanged, and otherwise admits the caller ONLY when the employee id
// the request names (`idOf(req)`) is their own login's employee
// (token, else users.employee_id). Anything else is the usual 403.
//
// Read routes only — writes keep their grants.
import { can } from '../middlewares/auth.middleware.js';
import { ownEmployeeId } from '../modules/payroll/payrollAccess.js';

export function ownOrPermission(module, action, idOf) {
  return async (req, res, next) => {
    try {
      if (await can(req, module, action)) return next();
      const requested = idOf(req);
      const own = await ownEmployeeId(req);
      if (own != null && requested != null && /^\d+$/.test(String(requested)) && String(own) === String(requested)) {
        req.ownRecordOnly = true;
        return next();
      }
      return res.status(403).json({ error: 'Forbidden', code: 'PERMISSION_DENIED', module, action: `can_${action}`,
        message: 'You do not have permission to perform this action.' });
    } catch (err) { next(err); }
  };
}
