import React from 'react';
import { Briefcase } from 'lucide-react';
import ModuleSettingsPanel from '@/components/core/ModuleSettingsPanel';

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
          default: 7,
          placeholder: '7',
          helpText: 'Applied when an offer is sent. A single offer can still be given its own expiry date.',
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

export default function RecruitmentSettings({ setPage }) {
  return (
    <ModuleSettingsPanel
      moduleName="Recruitment"
      moduleIcon={Briefcase}
      apiEndpoint="/settings/recruitment"
      setPage={setPage}
      sections={buildSections()}
    />
  );
}
