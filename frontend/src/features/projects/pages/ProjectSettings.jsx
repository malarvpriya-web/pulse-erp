import React from 'react';
import { FolderKanban } from 'lucide-react';
import ModuleSettingsPanel from '@/components/core/ModuleSettingsPanel';

const SECTIONS = [
  {
    title: 'Project Numbering',
    description: 'Auto-generate project codes and control numbering series',
    fields: [
      {
        key: 'project_number_prefix',
        label: 'Project Code Prefix',
        type: 'text',
        default: 'PRJ',
        placeholder: 'PRJ',
        helpText: 'Prefix for auto-generated project codes (e.g. PRJ-2026-001)',
      },
      {
        key: 'project_number_start',
        label: 'Starting Sequence Number',
        type: 'number',
        default: 1001,
        placeholder: '1001',
        helpText: 'First number in the auto-generated sequence',
      },
      {
        key: 'project_number_include_year',
        label: 'Include Year in Code',
        type: 'toggle',
        default: true,
        helpText: 'Appends the current FY year — e.g. PRJ-26-001',
      },
    ],
  },
  {
    title: 'Lifecycle Stages',
    description: 'Project lifecycle and task status labels',
    fields: [
      {
        key: 'default_project_stages',
        label: 'Project Lifecycle Stages',
        type: 'textarea',
        default: 'order,design,procurement,production,testing,dispatch,installation,commissioning,sat,service,amc',
        placeholder: 'order,design,procurement…',
        helpText: 'Comma-separated EPC lifecycle stages (SAT & commissioning are gated)',
      },
      {
        key: 'default_task_statuses',
        label: 'Task Statuses',
        type: 'textarea',
        default: 'todo,in_progress,review,done,blocked',
        placeholder: 'todo,in_progress,done',
        helpText: 'Comma-separated Kanban column statuses — consumed by the Task Board as column definitions',
      },
    ],
  },
  {
    title: 'Billing & Invoicing',
    description: 'How projects are billed to clients',
    fields: [
      {
        key: 'default_billing_type',
        label: 'Default Billing Type',
        type: 'select',
        options: ['Fixed', 'T&M', 'Retainer', 'Milestone'],
        default: 'Milestone',
        helpText: 'Milestone billing auto-creates invoice on milestone completion',
      },
      {
        key: 'invoice_trigger',
        label: 'Invoice Generation Trigger',
        type: 'select',
        options: ['Milestone', 'Monthly', 'Completion'],
        default: 'Milestone',
        helpText: 'Milestone = auto-invoice on completion; Monthly = recurring draft',
      },
      {
        key: 'gst_on_project_invoices',
        label: 'Default GST on Project Invoices (%)',
        type: 'number',
        default: 18,
        placeholder: '18',
        helpText: 'GST rate applied to auto-generated milestone invoices',
      },
    ],
  },
  {
    title: 'Labour Rate Configuration',
    description: 'Default billing and cost rates for resource planning',
    fields: [
      {
        key: 'default_billing_rate_inr',
        label: 'Default Billing Rate (₹/hr)',
        type: 'number',
        default: 1500,
        placeholder: '1500',
        helpText: 'Used when project_members.billing_rate is not set',
      },
      {
        key: 'default_cost_rate_inr',
        label: 'Default Cost Rate (₹/hr)',
        type: 'number',
        default: 800,
        placeholder: '800',
        helpText: 'Internal cost for EVM labour cost calculations',
      },
      {
        key: 'overtime_multiplier',
        label: 'Overtime Rate Multiplier',
        type: 'number',
        default: 1.5,
        placeholder: '1.5',
        helpText: 'Multiply base rate for hours logged beyond 8hr/day',
      },
    ],
  },
  {
    title: 'Timesheets',
    description: 'Timesheet logging rules for project tasks',
    fields: [
      {
        key: 'require_timesheet_approval',
        label: 'Require Timesheet Approval',
        type: 'toggle',
        default: true,
        helpText: 'Entries must be approved before feeding into EVM cost calculations',
      },
      {
        key: 'timesheet_granularity',
        label: 'Timesheet Granularity',
        type: 'select',
        options: ['15min', '30min', '1hr'],
        default: '30min',
        helpText: 'Minimum time increment that can be logged',
      },
      {
        key: 'auto_link_timesheets_to_project',
        label: 'Auto-link Timesheets to Project',
        type: 'toggle',
        default: true,
        helpText: 'Automatically associate timesheet entries with the task\'s project',
      },
    ],
  },
  {
    title: 'Risk Management',
    description: 'Risk matrix configuration and escalation thresholds',
    fields: [
      {
        key: 'risk_score_high_threshold',
        label: 'High Risk Score Threshold',
        type: 'number',
        default: 15,
        placeholder: '15',
        helpText: 'Risk scores ≥ this value are flagged as HIGH (max = 5×5 = 25)',
      },
      {
        key: 'risk_score_medium_threshold',
        label: 'Medium Risk Score Threshold',
        type: 'number',
        default: 6,
        placeholder: '6',
        helpText: 'Risk scores ≥ this value are flagged as MEDIUM',
      },
      {
        key: 'risk_escalation_notify',
        label: 'Notify PM on High Risk',
        type: 'toggle',
        default: true,
        helpText: 'Send in-app notification to project manager when a HIGH risk is registered',
      },
    ],
  },
  {
    title: 'FAT / SAT Configuration',
    description: 'Factory and Site Acceptance Test default settings',
    fields: [
      {
        key: 'fat_required_before_dispatch',
        label: 'FAT Required Before Dispatch',
        type: 'toggle',
        default: true,
        helpText: 'Block lifecycle dispatch gate until FAT status = passed',
      },
      {
        key: 'sat_required_before_commissioning',
        label: 'SAT Required for SAT Stage Completion',
        type: 'toggle',
        default: true,
        helpText: 'Block sat→service lifecycle transition until SAT status = passed',
      },
      {
        key: 'client_signoff_required_on_sat',
        label: 'Client Sign-off Mandatory on SAT',
        type: 'toggle',
        default: true,
        helpText: 'SAT cannot be marked passed unless client_signed_off = true',
      },
    ],
  },
  {
    title: 'AMC & Warranty',
    description: 'Post-delivery service and warranty automation',
    fields: [
      {
        key: 'amc_default_sla_hours',
        label: 'Default AMC SLA Response (hours)',
        type: 'number',
        default: 4,
        placeholder: '4',
        helpText: 'Default response time SLA for new AMC contracts',
      },
      {
        key: 'warranty_expiry_alert_days',
        label: 'Warranty Expiry Alert (days before)',
        type: 'number',
        default: 90,
        placeholder: '90',
        helpText: 'Show expiry alert banner when warranty is within this many days',
      },
      {
        key: 'amc_auto_renew_default',
        label: 'Auto-Renew AMC by Default',
        type: 'toggle',
        default: false,
        helpText: 'New AMC contracts will have auto_renew enabled by default',
      },
    ],
  },
  {
    title: 'Resources',
    description: 'Resource planning and utilisation settings',
    fields: [
      {
        key: 'over_allocation_warning',
        label: 'Over-Allocation Warning',
        type: 'toggle',
        default: true,
        helpText: 'Warn when a resource exceeds 100% capacity in any week',
      },
      {
        key: 'utilization_target_pct',
        label: 'Target Utilisation (%)',
        type: 'number',
        default: 80,
        placeholder: '80',
        helpText: 'Billable utilisation target shown in Resource Management',
      },
    ],
  },
];

export default function ProjectSettings({ setPage }) {
  return (
    <ModuleSettingsPanel
      moduleName="Projects"
      moduleIcon={FolderKanban}
      apiEndpoint="/settings/projects"
      setPage={setPage}
      sections={SECTIONS}
    />
  );
}
