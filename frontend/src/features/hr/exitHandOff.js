// All Employees → Terminate hands an exit to Exit Management as
// ?initiate=<employee id>&lwd=YYYY-MM-DD&reason=&name= (containment C6 / MD-14,
// HR_P0_REMEDIATION_DESIGN_2026-11-03.md). Its reasons map to the separation
// types Initiate Exit offers; anything else is left for HR to choose.
const REASON_TO_TYPE = { Resignation: 'resignation', Termination: 'termination', Absconding: 'termination', Retirement: 'retirement' };

/** The Initiate Exit pre-fill a hand-off URL carries, or null when there is none. */
export function initiateHandOff(search) {
  const sp = new URLSearchParams(search || '');
  const id = sp.get('initiate');
  if (!id || !/^\d+$/.test(id)) return null;
  const reason = sp.get('reason') || '';
  const lwd = sp.get('lwd') || '';
  return {
    form: {
      employee_id: id,
      separation_type: REASON_TO_TYPE[reason] || 'resignation',
      last_working_date: /^\d{4}-\d{2}-\d{2}$/.test(lwd) ? lwd : '',
      reason,
    },
    name: sp.get('name') || '',
    typeMapped: !!REASON_TO_TYPE[reason],
  };
}
