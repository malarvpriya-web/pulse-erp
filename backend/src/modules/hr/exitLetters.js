/**
 * exitLetters.js — relieving and experience letters for a leaver (§276).
 *
 * Content only; utils/probationLetterPdf.js (a plain company letter) lays it
 * out. Read from the records as they are now: the latest exit that was not
 * cancelled, the employee, the company, and the issuing HR user as signatory.
 *
 *   relieving   — to the employee: relieved at the close of the last working
 *                 day; mentions the resignation date for a resignation, and the
 *                 settlement only when F&F is paid. Not issued for absconding.
 *   experience  — "to whom it may concern": employed from joining to last
 *                 working day, last designation and department. Neutral: it
 *                 says nothing about conduct or performance.
 *
 * Both are available once the employee has left (the exit job sets the exit
 * status the morning after the last working day, or F&F payment does).
 */
import { EXITED_STATUSES } from '../../shared/employeeStatus.js';

const SEPARATION_TEXT = {
  termination: 'termination', retrenchment: 'retrenchment', retirement: 'retirement', death: 'death',
  disablement: 'disablement', absconding: 'absconding', contract_expiry: 'end of contract', resignation: 'resignation',
};
const separationLabelText = (t) => SEPARATION_TEXT[t] || String(t || 'separation').replace(/_/g, ' ');

export class ExitLetterError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

export const EXIT_LETTER_KINDS = ['relieving', 'experience'];

const longDate = (iso) => {
  if (!iso) return '-';
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'UTC' });
};
const fileSafe = (s) => String(s).replace(/[^A-Za-z0-9_-]+/g, '_');

/**
 * @param db         pool or client
 * @param companyId  caller's company (null = super admin, global)
 * @param todayIso   the letter date
 */
export async function exitLetterContent(db, { companyId, employeeId, kind, signatoryUserId, todayIso }) {
  if (!EXIT_LETTER_KINDS.includes(kind)) throw new ExitLetterError(400, 'LETTER_KIND_INVALID', `Letter must be one of: ${EXIT_LETTER_KINDS.join(', ')}.`);
  const { rows: [r] } = await db.query(
    `SELECT e.id, e.office_id, COALESCE(e.name, e.first_name || ' ' || e.last_name) AS name, e.status, e.designation, e.department,
            to_char(e.joining_date, 'YYYY-MM-DD') AS joining_date,
            er.id AS exit_id, er.separation_type, er.fnf_status,
            to_char(er.last_working_date, 'YYYY-MM-DD') AS lwd, to_char(er.resignation_date, 'YYYY-MM-DD') AS resignation_date,
            c.name AS company_name, c.address, c.city, c.state, c.pincode
       FROM employees e
       JOIN companies c ON c.id = e.company_id
       JOIN LATERAL (SELECT * FROM exit_requests x WHERE x.employee_id = e.id AND x.status NOT IN ('cancelled', 'rejected')
                      ORDER BY x.created_at DESC, x.id DESC LIMIT 1) er ON true
      WHERE e.id = $1 AND e.deleted_at IS NULL AND ($2::int IS NULL OR e.company_id = $2::int)`, [employeeId, companyId]);
  if (!r) throw new ExitLetterError(404, 'EXIT_NOT_FOUND', 'No exit is recorded for this employee.');
  if (!EXITED_STATUSES.includes(String(r.status ?? '').trim().toLowerCase())) {
    throw new ExitLetterError(409, 'NOT_LEFT_YET',
      `Letters are issued once the employee has left. ${r.name} is still ${r.status || 'employed'}; the last working day is ${longDate(r.lwd)}.`);
  }
  if (!r.lwd) throw new ExitLetterError(409, 'LWD_MISSING', 'The exit has no last working day. Enter it in Exit Management first.');
  if (kind === 'relieving' && r.separation_type === 'absconding') {
    throw new ExitLetterError(409, 'ABSCONDED', 'An employee who absconded is not relieved, so no relieving letter is issued. An experience letter can still be given.');
  }
  const { rows: [signer] } = await db.query(`SELECT name FROM users WHERE id = $1`, [signatoryUserId ?? null]);

  const common = {
    companyName: r.company_name,
    companyAddress: [r.address, [r.city, r.state, r.pincode].filter(Boolean).join(', ')].filter(Boolean).join('\n'),
    letterDate: longDate(todayIso),
    signatoryName: signer?.name || '',
    signatoryTitle: 'Human Resources',
  };
  const role = [r.designation, r.department ? `in the ${r.department} department` : null].filter(Boolean).join(' ');

  if (kind === 'relieving') {
    const opening = r.separation_type === 'resignation'
      ? `This refers to your resignation${r.resignation_date ? ` dated ${longDate(r.resignation_date)}` : ''}.`
      : `This refers to your separation from the company (${separationLabelText(r.separation_type)}).`;
    return {
      ...common,
      kind,
      reference: `REL/${r.office_id || r.id}/${r.exit_id}`,
      recipient: [r.name, r.office_id ? `Employee ID: ${r.office_id}` : null, r.designation, r.department].filter(Boolean),
      subject: 'Relieving Letter',
      filename: `Relieving_Letter_${fileSafe(r.office_id || r.name)}.pdf`,
      body: [
        `Dear ${r.name},`,
        opening,
        `We confirm that you have been relieved from the services of ${r.company_name} with effect from the close of working hours on ${longDate(r.lwd)}.`,
        r.fnf_status === 'paid' ? 'Your full and final settlement has been completed.' : null,
        'We thank you for your contribution and wish you success in the future.',
      ].filter(Boolean).join('\n\n'),
    };
  }
  return {
    ...common,
    kind,
    reference: `EXP/${r.office_id || r.id}/${r.exit_id}`,
    toLabel: null,
    recipient: ['TO WHOM IT MAY CONCERN'],
    subject: 'Experience Certificate',
    filename: `Experience_Letter_${fileSafe(r.office_id || r.name)}.pdf`,
    body: [
      `This is to certify that ${r.name}${r.office_id ? ` (Employee ID ${r.office_id})` : ''} was employed with ${r.company_name} from ${longDate(r.joining_date)} to ${longDate(r.lwd)}.`,
      role ? `At the time of leaving, ${r.name} held the position of ${role}.` : null,
      `We wish ${r.name} success in the future.`,
    ].filter(Boolean).join('\n\n'),
  };
}
