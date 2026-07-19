import React from 'react';
import { Clock } from 'lucide-react';
import ModuleSettingsPanel from '@/components/core/ModuleSettingsPanel';

const SECTIONS = [
  {
    title: 'Capture',
    description: 'How and when timesheets are submitted',
    fields: [
      {
        key: 'timesheet_period',
        label: 'Timesheet Period',
        type: 'select',
        options: ['Daily', 'Weekly'],
        default: 'Weekly',
        helpText: 'Daily: each day is submitted separately; Weekly: one submission per week',
      },
      {
        key: 'submission_deadline_day',
        label: 'Weekly Submission Deadline (day of week)',
        type: 'select',
        options: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
        default: 'Monday',
        helpText: "Day by which the previous week's timesheet must be submitted",
      },
    ],
  },
  {
    title: 'Rounding',
    description: 'Time rounding and minimum billable duration',
    fields: [
      {
        key: 'time_rounding',
        label: 'Time Entry Rounding',
        type: 'select',
        options: ['None', '15min', '30min'],
        default: 'None',
        helpText: 'Automatically round logged durations to the nearest increment',
      },
      {
        key: 'min_billable_minutes',
        label: 'Minimum Billable Duration (minutes)',
        type: 'number',
        default: 15,
        placeholder: '15',
        helpText: 'Time entries shorter than this are not counted as billable',
      },
    ],
  },
  {
    title: 'Approval',
    description: 'Timesheet approval workflow configuration',
    fields: [
      {
        key: 'approval_required',
        label: 'Approval Required',
        type: 'toggle',
        default: true,
        helpText: 'Timesheets must be approved before they are locked for billing',
      },
      {
        key: 'approval_chain',
        label: 'Approval Chain',
        type: 'select',
        options: ['Manager', 'HR', 'Both'],
        default: 'Manager',
      },
      {
        key: 'auto_approve_after_days',
        label: 'Auto-Approve After (days)',
        type: 'number',
        default: 0,
        placeholder: '0',
        helpText: 'Auto-approve pending timesheets after N days of inaction (0 = disabled)',
      },
    ],
  },
  {
    title: 'Overtime',
    description: 'Overtime detection and compensation multiplier',
    fields: [
      {
        key: 'overtime_threshold_hours',
        label: 'Overtime Threshold (hours/day)',
        type: 'number',
        default: 8,
        placeholder: '8',
        helpText: 'Hours worked beyond this count as overtime',
      },
      {
        key: 'overtime_multiplier',
        label: 'Overtime Pay Multiplier',
        type: 'number',
        default: 1.5,
        placeholder: '1.5',
        helpText: 'e.g. 1.5 means overtime hours are paid at 1.5x the regular rate',
      },
    ],
  },
];

export default function TimesheetSettings({ setPage }) {
  return (
    <ModuleSettingsPanel
      moduleName="Timesheets"
      moduleIcon={Clock}
      apiEndpoint="/settings/timesheets"
      setPage={setPage}
      sections={SECTIONS}
    />
  );
}
