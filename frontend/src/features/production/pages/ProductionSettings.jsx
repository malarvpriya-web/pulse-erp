import React, { useState, useEffect } from 'react';
import { Factory } from 'lucide-react';
import api from '@/services/api/client';
import ModuleSettingsPanel from '@/components/core/ModuleSettingsPanel';

function buildSections(workCentreOptions, wcLoading) {
  return [
    {
      title: 'Work Centres',
      description: 'Default work centre and shift hours for production planning',
      fields: [
        {
          key: 'default_work_centre',
          label: 'Default Work Centre',
          type: 'select',
          options: workCentreOptions.length
            ? workCentreOptions
            : [{ value: '', label: wcLoading ? 'Loading…' : 'No work centres configured' }],
          default: '',
          helpText: 'Pre-selected work centre when creating production orders',
        },
        {
          key: 'shift_hours_per_day',
          label: 'Shift Hours per Day',
          type: 'number',
          default: 8,
          placeholder: '8',
          helpText: 'Standard productive hours per shift used for scheduling',
        },
      ],
    },
    {
      title: 'BOM',
      description: 'Bill of Materials control settings',
      fields: [
        {
          key: 'bom_version_control',
          label: 'BOM Version Control',
          type: 'toggle',
          default: true,
          helpText: 'Track BOM revisions; production orders reference a specific BOM version',
        },
        {
          key: 'allow_partial_issue',
          label: 'Allow Partial Material Issue',
          type: 'toggle',
          default: false,
          helpText: 'Allow production to start even if full material quantity is not yet issued',
        },
      ],
    },
    {
      title: 'Quality',
      description: 'Quality control checkpoints during production',
      fields: [
        {
          key: 'qc_checkpoint_required',
          label: 'QC Checkpoint Required',
          type: 'toggle',
          default: true,
          helpText: 'Production orders must pass a QC gate before moving to the next stage',
        },
        {
          key: 'rejection_auto_quarantine',
          label: 'Auto-Quarantine Rejected Items',
          type: 'toggle',
          default: true,
          helpText: 'Rejected items are automatically moved to a quarantine bin',
        },
      ],
    },
    {
      title: 'Delay & Alerts',
      description: 'Thresholds that drive the Production Dashboard delay banner and Critical KPI',
      fields: [
        {
          key: 'delay_warning_days',
          label: 'Delay Warning Threshold (days)',
          type: 'number',
          default: 3,
          placeholder: '3',
          helpText: 'A production order overdue by this many days is flagged as delayed (amber).',
        },
        {
          key: 'delay_critical_days',
          label: 'Critical Delay Threshold (days)',
          type: 'number',
          default: 7,
          placeholder: '7',
          helpText: 'A production order overdue by more than this many days is escalated to Critical (red) on the dashboard.',
        },
      ],
    },
    {
      title: 'Scheduling',
      description: 'Production scheduling method and buffer settings',
      fields: [
        {
          key: 'scheduling_method',
          label: 'Scheduling Method',
          type: 'select',
          options: ['Forward', 'Backward'],
          default: 'Forward',
          helpText: 'Forward: schedule from start date; Backward: schedule from due date',
        },
        {
          key: 'buffer_time_minutes',
          label: 'Buffer Time Between Operations (minutes)',
          type: 'number',
          default: 30,
          placeholder: '30',
          helpText: 'Idle time added between consecutive operations for setup / teardown',
        },
      ],
    },
  ];
}

export default function ProductionSettings({ setPage }) {
  const [workCentreOptions, setWorkCentreOptions] = useState([]);
  const [wcLoading, setWcLoading] = useState(true);

  useEffect(() => {
    setWcLoading(true);
    api.get('/bom/work-centres')
      .then(res => {
        const list = Array.isArray(res.data) ? res.data : [];
        setWorkCentreOptions(list.map(w => ({ value: String(w.id), label: w.name })));
      })
      .catch(() => {
        setWorkCentreOptions([]);
      })
      .finally(() => setWcLoading(false));
  }, []);

  return (
    <ModuleSettingsPanel
      moduleName="Production"
      moduleIcon={Factory}
      apiEndpoint="/settings/production"
      setPage={setPage}
      sections={buildSections(workCentreOptions, wcLoading)}
    />
  );
}
