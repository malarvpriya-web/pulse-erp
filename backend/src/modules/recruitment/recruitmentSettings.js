/**
 * Saving company_settings(module='recruitment') — review 2026-11-18.
 *
 * This one blob is written by TWO screens:
 *   • Recruitment → Reports & Setup → Settings (offer validity, offer-letter
 *     wording, sourcing channels, candidate data retention), and
 *   • HR → Probation (probation_months, probation_review_reminder_days —
 *     shared/probationDates.js saveProbationPolicy).
 * The POST used to REPLACE the blob with whatever the screen sent, so a
 * Settings tab left open could put back an old probation policy. The request is
 * now merged onto what is stored: a key the request does not send is kept.
 *
 * Keys no code reads (auto_send_offer, interview_stages, offer_letter_template —
 * see RecruitmentSettings.jsx) are dropped on save so they stop looking set.
 *
 * Numbers are checked here; an out-of-range value is refused (400) instead of
 * being stored and then silently replaced by the default when it is read.
 */

export const DEAD_RECRUITMENT_KEYS = ['auto_send_offer', 'interview_stages', 'offer_letter_template'];

const INT_RULES = {
  offer_validity_days:           { min: 1, max: 90,  label: 'Default offer validity (days)' },
  candidate_retention_months:    { min: 1, max: 240, label: 'Keep candidate data for (months)' },
  probation_months:              { min: 1, max: 24,  label: 'Probation (months)' },
  probation_review_reminder_days:{ min: 0, max: 90,  label: 'Probation review reminder (days)' },
};

const TEXT_MAX = {
  offer_letter_conditions: 4000, offer_letter_closing: 300, offer_letter_signatory_title: 120,
  appointment_letter_terms: 6000, appointment_letter_closing: 300,
  confidentiality_letter_terms: 6000, confidentiality_letter_closing: 300,
};

export function normalizeRecruitmentSettings(body, oldSettings) {
  const errors = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { settings: null, errors: ['Settings must be an object.'] };
  }
  const merged = { ...(oldSettings || {}), ...body };
  for (const k of DEAD_RECRUITMENT_KEYS) delete merged[k];

  for (const [k, r] of Object.entries(INT_RULES)) {
    if (!(k in body)) continue;
    const s = String(body[k] ?? '').trim();
    const n = Number(s);
    if (!/^\d+$/.test(s) || n < r.min || n > r.max) {
      errors.push(`${r.label} must be a whole number from ${r.min} to ${r.max}.`);
    } else {
      merged[k] = n;
    }
  }
  for (const [k, max] of Object.entries(TEXT_MAX)) {
    if (!(k in body)) continue;
    const v = body[k] == null ? '' : String(body[k]);
    if (v.length > max) errors.push(`${k.replace(/_/g, ' ')} is longer than ${max} characters.`);
    merged[k] = v;
  }
  return { settings: merged, errors };
}
