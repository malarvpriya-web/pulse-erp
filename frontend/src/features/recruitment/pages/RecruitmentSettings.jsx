import React from 'react';
import { Briefcase } from 'lucide-react';
import ModuleSettingsPanel from '@/components/core/ModuleSettingsPanel';
import ScreeningQuestionsEditor from '../shared/components/ScreeningQuestionsEditor';

/**
 * Recruitment settings.
 *
 * Five fields were removed here rather than left on the page. An audit found
 * that eight of the nine keys this panel wrote were read by no code anywhere in
 * the repository — a settings screen that persists into a void is worse than no
 * settings screen, because it tells an administrator they have configured
 * something. Each removal is deliberate:
 *
 *   interview_stages      — the pipeline stages are fixed by the
 *                           candidates_current_stage_check CHECK constraint.
 *                           A free-text override could only ever produce values
 *                           Postgres rejects.
 *   auto_send_offer       — PUT /recruitment/offers/:id explicitly refuses a
 *                           direct move to 'sent': offers go through the
 *                           Approval Center. A toggle promising to bypass that
 *                           gate contradicts the API by design.
 *   offer_letter_template — nothing in the offer path reads a template id.
 *   probation_months,
 *   probation_review_…    — these ARE used (shared/probationDates.js) and are
 *                           stored in this same blob, but they are edited on
 *                           HR → Probation (policy card). Not repeated here.
 *
 * What remains is read by something. offer_validity_days is consumed by
 * recruitment/offerValidity.js, and the three channel toggles now drive
 * sourceOptions() in the shared constants — see SOURCE_SETTING_KEYS.
 *
 * Review 2026-11-18: candidate_retention_months (read by careers.routes.js when
 * a website applicant consents) had no editor anywhere — added. Saving sends
 * only this page's fields and the server merges them onto the stored blob, so
 * the Probation policy is never overwritten from here; the server also range-
 * checks the numbers (recruitment/recruitmentSettings.js). The 120px empty band
 * above "Save Changes" is gone and the screening questions now sit above the
 * Save bar (they save one question at a time — Save Changes does not cover them).
 */
function buildSections() {
  return [
    {
      title: 'Offer',
      description: 'How long a candidate has to respond to an offer',
      fields: [
        {
          key: 'offer_validity_days',
          label: 'Default Offer Validity (days)',
          type: 'number',
          // Must match DEFAULT_OFFER_VALIDITY_DAYS in backend recruitment/offerValidity.js
          // (it said 7 here while the server applied 14 when nothing was saved).
          default: 14,
          min: 1,
          max: 90,
          integer: true,
          placeholder: '14',
          helpText: 'Counted from the day the offer is sent (after approval). A single offer can still be given its own "valid until" date, and a sent offer can be extended.',
        },
      ],
    },
    {
      title: 'Offer letter',
      description: 'Your wording on the offer letter PDF. The candidate gets the offer by e-mail only; the letter is issued at onboarding (Offer & Onboarding → Onboarding → Joining letters) and filed on the employee record. Position, CTC, joining date and the reply-by date are filled in from the offer.',
      fields: [
        {
          key: 'offer_letter_conditions',
          label: 'Conditions of the offer',
          type: 'textarea',
          // Keep in step with OFFER_LETTER_DEFAULTS in backend recruitment/offerLetter.js.
          default: 'This offer is subject to satisfactory verification of your documents, references and background, and to the terms of the appointment letter you will receive on joining.',
          helpText: 'For example probation, notice period, documents to bring. Leave a blank line between paragraphs.',
        },
        {
          key: 'offer_letter_closing',
          label: 'Closing line',
          type: 'text',
          default: 'We look forward to welcoming you to the team.',
        },
        {
          key: 'offer_letter_signatory_title',
          label: 'Signed as',
          type: 'text',
          default: 'Human Resources',
          helpText: 'Printed under the name of the person who approved the offer.',
        },
      ],
    },
    {
      title: 'Appointment letter',
      description: 'Issued at onboarding and filed on the employee record. Designation, department, joining date, employee code, manager, CTC, probation and notice period are filled in from the employee record and the accepted offer; your terms follow.',
      fields: [
        {
          key: 'appointment_letter_terms',
          label: 'Terms of appointment',
          type: 'textarea',
          // Keep in step with JOINING_LETTER_DEFAULTS in backend recruitment/joiningLetters.js.
          default: "Your working hours, weekly offs, holidays and leave will be as per the company policies in force from time to time.\n\nYou will follow the company rules, policies and code of conduct, as they are amended from time to time.\n\nYou may be transferred or deputed to any location, department or associated company of the organisation as business needs require.\n\nYou will keep all company information confidential during and after your employment, as set out in the confidentiality letter given to you.\n\nEither side may end this employment by giving the notice period that applies to you, or salary in lieu of notice, as per company policy.",
          helpText: 'One paragraph per term; leave a blank line between them. Have these checked by your HR / legal adviser.',
        },
        { key: 'appointment_letter_closing', label: 'Closing line', type: 'text', default: "Please sign and return a copy of this letter as your acceptance of these terms." },
      ],
    },
    {
      title: 'Confidentiality letter',
      description: 'Issued at onboarding with the appointment letter; the employee signs and returns it. Name, designation and department are filled in.',
      fields: [
        {
          key: 'confidentiality_letter_terms',
          label: 'Confidentiality terms',
          type: 'textarea',
          // Keep in step with JOINING_LETTER_DEFAULTS in backend recruitment/joiningLetters.js.
          default: "During your employment you will have access to confidential information of the company, its customers and suppliers, including designs, drawings, software, prices, customer lists, business plans and employee data.\n\nYou will use this information only for your work for the company, and will not disclose it to anyone outside the company, or to colleagues who do not need it, without written permission.\n\nAnything you design, write or develop as part of your work belongs to the company.\n\nWhen you leave, or whenever the company asks, you will return all documents, devices and copies of company information in your possession.\n\nThese obligations continue after your employment ends.",
          helpText: 'One paragraph per term; leave a blank line between them. Have these checked by your HR / legal adviser.',
        },
        { key: 'confidentiality_letter_closing', label: 'Closing line', type: 'text', default: "Please sign below to confirm that you have read, understood and accept these terms." },
      ],
    },
    {
      title: 'Candidate data',
      description: "How long a website applicant's details are kept under the consent they give when applying",
      fields: [
        {
          key: 'candidate_retention_months',
          label: 'Keep candidate data for (months)',
          type: 'number',
          // Must match DEFAULT_RETENTION_MONTHS in backend recruitment/routes/careers.routes.js.
          default: 24,
          min: 1,
          max: 240,
          integer: true,
          placeholder: '24',
          helpText: 'Stamped on each new website application as its "keep until" date. Applications already received keep the date they were given.',
        },
      ],
    },
    {
      title: 'Sourcing channels',
      description: 'Which channels appear in the Source list when adding a candidate',
      fields: [
        {
          key: 'integrate_linkedin',
          label: 'LinkedIn',
          type: 'toggle',
          default: true,
          helpText: 'Offer LinkedIn as a source on candidate records. This is a label for reporting — Manifest does not connect to the LinkedIn API.',
        },
        {
          key: 'integrate_naukri',
          label: 'Naukri',
          type: 'toggle',
          default: true,
          helpText: 'Offer Naukri as a source on candidate records. Manual entry — there is no Naukri API integration.',
        },
        {
          key: 'integrate_indeed',
          label: 'Indeed',
          type: 'toggle',
          default: true,
          helpText: 'Offer Indeed as a source on candidate records. Manual entry — there is no Indeed API integration.',
        },
      ],
    },
  ];
}

// Built once: ModuleSettingsPanel re-syncs its defaults whenever the sections
// array changes identity, so a fresh array on every render did needless work.
const SECTIONS = buildSections();

export default function RecruitmentSettings({ setPage, embedded = false }) {
  return (
    <>
      <ModuleSettingsPanel
        moduleName="Recruitment"
        moduleIcon={Briefcase}
        apiEndpoint="/settings/recruitment"
        setPage={setPage}
        embedded={embedded}
        sections={SECTIONS}
        sendOnlyFields
      >
        <ScreeningQuestionsEditor />
      </ModuleSettingsPanel>
    </>
  );
}
