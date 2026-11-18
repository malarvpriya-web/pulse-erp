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
 *   probation_review_…    — the probation service computes no date window, so
 *                           there is nothing for either value to apply to.
 *                           Probation lives in its own module; these belong
 *                           there, with the code that would use them.
 *
 * What remains is read by something. offer_validity_days is consumed by
 * recruitment/offerValidity.js, and the three channel toggles now drive
 * sourceOptions() in the shared constants — see SOURCE_SETTING_KEYS.
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
          placeholder: '14',
          helpText: 'Counted from the day the offer is sent (after approval). A single offer can still be given its own "valid until" date, and a sent offer can be extended.',
        },
      ],
    },
    {
      title: 'Offer letter',
      description: 'Your wording on the offer letter PDF (sent with the offer e-mail). Position, CTC, joining date and the reply-by date are filled in from the offer.',
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

export default function RecruitmentSettings({ setPage, embedded = false }) {
  return (
    <>
      <ModuleSettingsPanel
        moduleName="Recruitment"
        moduleIcon={Briefcase}
        apiEndpoint="/settings/recruitment"
        setPage={setPage}
        embedded={embedded}
        sections={buildSections()}
      />
      <ScreeningQuestionsEditor />
    </>
  );
}
