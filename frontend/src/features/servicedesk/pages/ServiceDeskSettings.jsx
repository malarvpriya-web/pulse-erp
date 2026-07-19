import React from 'react';
import { Headphones } from 'lucide-react';
import ModuleSettingsPanel from '@/components/core/ModuleSettingsPanel';

const SECTIONS = [
  {
    title: 'SLA Defaults',
    description: 'Default response and resolution times by ticket priority',
    fields: [
      {
        key: 'sla_response_critical',
        label: 'Critical — Response Time (hours)',
        type: 'number',
        default: 1,
        placeholder: '1',
      },
      {
        key: 'sla_response_high',
        label: 'High — Response Time (hours)',
        type: 'number',
        default: 4,
        placeholder: '4',
      },
      {
        key: 'sla_response_medium',
        label: 'Medium — Response Time (hours)',
        type: 'number',
        default: 8,
        placeholder: '8',
      },
      {
        key: 'sla_response_low',
        label: 'Low — Response Time (hours)',
        type: 'number',
        default: 24,
        placeholder: '24',
      },
      {
        key: 'sla_resolution_critical',
        label: 'Critical — Resolution Time (hours)',
        type: 'number',
        default: 4,
        placeholder: '4',
      },
      {
        key: 'sla_resolution_high',
        label: 'High — Resolution Time (hours)',
        type: 'number',
        default: 24,
        placeholder: '24',
      },
      {
        key: 'sla_resolution_medium',
        label: 'Medium — Resolution Time (hours)',
        type: 'number',
        default: 72,
        placeholder: '72',
      },
      {
        key: 'sla_resolution_low',
        label: 'Low — Resolution Time (hours)',
        type: 'number',
        default: 168,
        placeholder: '168',
        helpText: '168 hours = 7 days',
      },
    ],
  },
  {
    title: 'Categories',
    description: 'Default ticket categorisation and assignment',
    fields: [
      {
        key: 'default_categories',
        label: 'Default Ticket Categories',
        type: 'textarea',
        default: 'Access,Finance,Payroll,HR,Attendance,CRM,System,Performance,Procurement,Documents,General',
        placeholder: 'Access,Finance,Payroll,HR,...',
        helpText: 'Comma-separated list of ticket category options shown in the New Ticket form',
      },
      {
        key: 'default_assignment_rule',
        label: 'Default Assignment Rule',
        type: 'select',
        options: ['Round Robin', 'Manual', 'Skill-based'],
        default: 'Round Robin',
        helpText: 'How incoming tickets are assigned to agents',
      },
    ],
  },
  {
    title: 'Escalation',
    description: 'Automatic escalation when SLA is at risk',
    fields: [
      {
        key: 'escalate_at_sla_pct',
        label: 'Auto-Escalate at SLA % Elapsed',
        type: 'number',
        default: 75,
        placeholder: '75',
        helpText: 'Trigger escalation when this percentage of the SLA window has elapsed',
      },
      {
        key: 'escalation_notify',
        label: 'Escalation Notify',
        type: 'select',
        options: ['Manager', 'HOD', 'Both'],
        default: 'Manager',
        helpText: 'Who receives the escalation notification',
      },
    ],
  },
  {
    title: 'Customer Portal',
    description: 'External customer-facing ticket submission settings',
    fields: [
      {
        key: 'enable_customer_portal',
        label: 'Enable Customer Portal',
        type: 'toggle',
        default: false,
        helpText: 'Customers can log in and view/submit their own tickets',
      },
      {
        key: 'allow_anonymous_tickets',
        label: 'Allow Anonymous Ticket Submission',
        type: 'toggle',
        default: false,
        helpText: 'Allow ticket submission without login (public form)',
      },
    ],
  },
];

export default function ServiceDeskSettings({ setPage }) {
  return (
    <ModuleSettingsPanel
      moduleName="Service Desk"
      moduleIcon={Headphones}
      apiEndpoint="/settings/servicedesk"
      setPage={setPage}
      sections={SECTIONS}
    />
  );
}
