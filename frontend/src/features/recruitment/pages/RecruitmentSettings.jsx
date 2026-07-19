import React, { useState, useEffect } from 'react';
import { Briefcase } from 'lucide-react';
import api from '@/services/api/client';
import ModuleSettingsPanel from '@/components/core/ModuleSettingsPanel';

function buildSections(templateOptions) {
  return [
    {
      title: 'Pipeline',
      description: 'Interview stage configuration and offer validity',
      fields: [
        {
          key: 'interview_stages',
          label: 'Interview Stages',
          type: 'text',
          default: 'Screening,Technical Round 1,Technical Round 2,HR Round,Offer',
          placeholder: 'Screening,Technical,HR,Offer',
          helpText: 'Comma-separated list of interview pipeline stages',
        },
        {
          key: 'offer_validity_days',
          label: 'Default Offer Validity (days)',
          type: 'number',
          default: 7,
          placeholder: '7',
          helpText: 'Candidates must accept the offer within this many days',
        },
      ],
    },
    {
      title: 'Sourcing',
      description: 'Job portal integrations (UI configuration only)',
      fields: [
        {
          key: 'integrate_linkedin',
          label: 'LinkedIn Integration',
          type: 'toggle',
          default: false,
          helpText: 'Show LinkedIn as a sourcing channel in candidate records',
        },
        {
          key: 'integrate_naukri',
          label: 'Naukri Integration',
          type: 'toggle',
          default: false,
          helpText: 'Show Naukri as a sourcing channel in candidate records',
        },
        {
          key: 'integrate_indeed',
          label: 'Indeed Integration',
          type: 'toggle',
          default: false,
          helpText: 'Show Indeed as a sourcing channel in candidate records',
        },
      ],
    },
    {
      title: 'Offer',
      description: 'Offer letter template and automation',
      fields: [
        {
          key: 'offer_letter_template',
          label: 'Offer Letter Template',
          type: 'select',
          options: templateOptions.length
            ? templateOptions
            : [{ value: '', label: 'No templates found' }],
          default: '',
          helpText: 'Template pre-filled when generating an offer letter',
        },
        {
          key: 'auto_send_offer',
          label: 'Auto-Send Offer Letter',
          type: 'toggle',
          default: false,
          helpText: 'Automatically email the offer letter when status moves to Offered',
        },
      ],
    },
    {
      title: 'Probation',
      description: 'Default probation period settings for new hires',
      fields: [
        {
          key: 'probation_months',
          label: 'Default Probation Period (months)',
          type: 'number',
          default: 3,
          placeholder: '3',
        },
        {
          key: 'probation_review_reminder_days',
          label: 'Probation Review Reminder (days before end)',
          type: 'number',
          default: 14,
          placeholder: '14',
          helpText: 'Send a reminder to HR this many days before the probation end date',
        },
      ],
    },
  ];
}

export default function RecruitmentSettings({ setPage }) {
  const [templateOptions, setTemplateOptions] = useState([]);

  useEffect(() => {
    api.get('/hr/document-templates')
      .then(res => {
        const list = Array.isArray(res.data) ? res.data : (res.data?.templates || []);
        setTemplateOptions(list.map(t => ({ value: String(t.id), label: t.name || t.template_name })));
      })
      .catch(() => {});
  }, []);

  return (
    <ModuleSettingsPanel
      moduleName="Recruitment"
      moduleIcon={Briefcase}
      apiEndpoint="/settings/recruitment"
      setPage={setPage}
      sections={buildSections(templateOptions)}
    />
  );
}
