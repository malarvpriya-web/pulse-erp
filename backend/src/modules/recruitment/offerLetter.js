/**
 * Offer letter PDF (audit 2026-11-17: "no offer letter document exists").
 *
 * Content is built here from the offer_letters row; layout is the shared letter
 * builder used by probation and exit letters (utils/probationLetterPdf.js), so
 * every HR letter carries the same letterhead. The PDF is generated on demand —
 * nothing is stored — so a corrected draft always prints its current terms.
 */
import { buildProbationLetterPdf } from '../../utils/probationLetterPdf.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Date / 'YYYY-MM-DD' → "17 Nov 2026". */
export function letterDate(d) {
  if (!d) return '';
  const iso = d instanceof Date
    ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    : String(d).slice(0, 10);
  const [y, m, day] = iso.split('-').map(Number);
  return y && m && day ? `${day} ${MONTHS[m - 1]} ${y}` : String(d);
}

/** 750000 → "Rs. 7,50,000". pdfkit's WinAnsi fonts have no ₹ glyph. */
export function rupees(n) {
  const v = Number(n);
  return Number.isFinite(v) ? `Rs. ${Math.round(v).toLocaleString('en-IN')}` : '';
}

const EMPLOYMENT = {
  full_time: 'full-time', part_time: 'part-time', contract: 'contract', intern: 'internship', internship: 'internship',
};

/** Everything the letter and the offer e-mail need, scoped to the company. */
export async function offerLetterData(db, { companyId, offerId }) {
  const { rows: [r] } = await db.query(
    `SELECT ol.id, ol.offer_no, ol.offered_salary, ol.joining_date, ol.offer_expiry_date, ol.offer_status,
            ol.designation, ol.notes, ol.created_at, ol.offer_sent_date,
            c.full_name, c.email, c.phone, c.current_city, c.location,
            COALESCE(jo.job_title, jr.job_title) AS job_title,
            COALESCE(jo.department, jr.department) AS department,
            COALESCE(jo.location, jr.location) AS job_location,
            COALESCE(jo.employment_type, jr.employment_type) AS employment_type,
            co.name AS company_name, co.address, co.city, co.state, co.pincode
       FROM offer_letters ol
       JOIN candidates c ON c.id = ol.candidate_id
       JOIN companies co ON co.id = ol.company_id
       LEFT JOIN job_openings jo ON jo.id = ol.job_opening_id
       LEFT JOIN job_requisitions jr ON jr.id = jo.requisition_id
      WHERE ol.id::text = $1 AND ol.deleted_at IS NULL AND ($2::int IS NULL OR ol.company_id = $2::int)`,
    [String(offerId), companyId ?? null]);
  return r || null;
}

// The company's own wording (Reports & Setup → Settings → Offer letter). Each
// falls back to the text the letter always had, so an unset field changes
// nothing. Added 2026-11-18: the conditions were hard-coded, so a company could
// not state its probation, notice or document terms on the letter.
export const OFFER_LETTER_DEFAULTS = {
  offer_letter_conditions: 'This offer is subject to satisfactory verification of your documents, references and background, and to the terms of the appointment letter you will receive on joining.',
  offer_letter_closing: 'We look forward to welcoming you to the team.',
  offer_letter_signatory_title: 'Human Resources',
};

async function letterWording(db, companyId) {
  const { rows: [s] } = await db.query(
    `SELECT settings FROM company_settings WHERE module = 'recruitment' AND company_id = $1 LIMIT 1`, [companyId ?? null])
    .catch(() => ({ rows: [] }));
  const out = { ...OFFER_LETTER_DEFAULTS };
  for (const k of Object.keys(out)) {
    const v = s?.settings?.[k];
    if (typeof v === 'string' && v.trim()) out[k] = v.trim();
  }
  return out;
}

export async function buildOfferLetterPdf(db, { companyId, offerId, signatoryUserId }) {
  const r = await offerLetterData(db, { companyId, offerId });
  if (!r) return null;
  const wording = await letterWording(db, r.company_id ?? companyId);
  const { rows: [signer] } = await db.query(`SELECT name FROM users WHERE id = $1`, [signatoryUserId ?? null]);
  const role = r.designation || r.job_title || 'the role discussed with you';
  const type = EMPLOYMENT[r.employment_type] || 'full-time';
  const draft = !['sent', 'accepted'].includes(r.offer_status);

  const paras = [
    `Dear ${r.full_name},`,
    `We are pleased to offer you the position of ${role}${r.department ? ` in the ${r.department} department` : ''} at ${r.company_name}, on a ${type} basis${r.job_location ? `, based at ${r.job_location}` : ''}.`,
    `Your annual cost to company (CTC) will be ${rupees(r.offered_salary)}. The break-up of your salary will be shared with your appointment letter.`,
    r.joining_date
      ? `We would like you to join us on ${letterDate(r.joining_date)}.`
      : 'Your joining date will be confirmed with you separately.',
    r.offer_expiry_date
      ? `Please confirm your acceptance of this offer by ${letterDate(r.offer_expiry_date)}, after which it will lapse.`
      : 'Please confirm your acceptance of this offer at the earliest.',
    // Several paragraphs may be typed, separated by a blank line.
    ...wording.offer_letter_conditions.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean),
    wording.offer_letter_closing,
  ];
  if (draft) paras.unshift('DRAFT - this offer has not been approved and is not valid until it is sent.');

  const pdf = await buildProbationLetterPdf({
    companyName: r.company_name,
    companyAddress: [r.address, [r.city, r.state, r.pincode].filter(Boolean).join(', ')].filter(Boolean).join('\n'),
    reference: r.offer_no || `OFFER-${String(r.id).slice(0, 8).toUpperCase()}`,
    letterDate: letterDate(r.offer_sent_date || new Date()),
    recipient: [r.full_name, r.current_city || r.location, r.email].filter(Boolean),
    subject: `Offer of employment - ${role}`,
    body: paras.join('\n\n'),
    signatoryName: signer?.name || '',
    signatoryTitle: wording.offer_letter_signatory_title,
  });
  const safeName = String(r.full_name || 'candidate').replace(/[^A-Za-z0-9]+/g, '_');
  return { pdf, filename: `Offer_${r.offer_no || 'letter'}_${safeName}.pdf`, data: r, body: paras.join('\n\n'), signatoryTitle: wording.offer_letter_signatory_title };
}
