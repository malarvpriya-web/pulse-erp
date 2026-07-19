import React from 'react';
import { IndianRupee } from 'lucide-react';
import ModuleSettingsPanel from '@/components/core/ModuleSettingsPanel';

const SECTIONS = [
  {
    title: 'Pay Cycle',
    description: 'Configure how and when payroll is processed',
    fields: [
      {
        key: 'pay_frequency',
        label: 'Pay Frequency',
        type: 'select',
        options: ['Monthly', 'Biweekly', 'Weekly'],
        default: 'Monthly',
      },
      {
        key: 'pay_day_of_month',
        label: 'Pay Day of Month',
        type: 'number',
        default: 25,
        helpText: 'Day of month on which salaries are disbursed (1–31)',
        placeholder: '25',
      },
      {
        key: 'payroll_cutoff_day',
        label: 'Payroll Cutoff Day',
        type: 'number',
        default: 20,
        helpText: 'Last day to submit attendance / leaves before payroll runs',
        placeholder: '20',
      },
      {
        key: 'working_days',
        label: 'Working Days per Month',
        type: 'number',
        default: 26,
        helpText: 'Used for LOP and per-day salary calculations (typically 26)',
        placeholder: '26',
      },
    ],
  },
  {
    title: 'Salary Components',
    description: 'Toggle which allowance components are included in the CTC structure',
    fields: [
      {
        key: 'enable_hra',
        label: 'House Rent Allowance (HRA)',
        type: 'toggle',
        default: true,
        helpText: 'Typically 40–50% of basic salary',
      },
      {
        key: 'enable_conveyance',
        label: 'Conveyance Allowance',
        type: 'toggle',
        default: true,
      },
      {
        key: 'enable_medical_allowance',
        label: 'Medical Allowance',
        type: 'toggle',
        default: true,
      },
      {
        key: 'enable_special_allowance',
        label: 'Special Allowance',
        type: 'toggle',
        default: true,
        helpText: 'Balancing allowance to meet total CTC',
      },
    ],
  },
  {
    title: 'Statutory',
    description: 'Government-mandated deductions and tax settings',
    fields: [
      {
        key: 'pf_enabled',
        label: 'Provident Fund (PF)',
        type: 'toggle',
        default: true,
        helpText: '12% of basic salary, matched by employer',
      },
      {
        key: 'esi_enabled',
        label: 'Employee State Insurance (ESI)',
        type: 'toggle',
        default: true,
        helpText: 'Applicable for employees earning ≤ ₹21,000/month',
      },
      {
        key: 'professional_tax',
        label: 'Professional Tax',
        type: 'toggle',
        default: false,
        helpText: 'State-level tax; varies by state and salary slab',
      },
      {
        key: 'tds_auto_calculate',
        label: 'Auto-Calculate TDS',
        type: 'toggle',
        default: true,
        helpText: 'Automatically compute monthly TDS based on projected annual income',
      },
      {
        key: 'regime',
        label: 'Income Tax Regime',
        type: 'select',
        options: [
          { value: 'new', label: 'New Regime (Default — FY 2025-26)' },
          { value: 'old', label: 'Old Regime (80C / HRA exemptions)' },
        ],
        default: 'new',
        helpText: 'New regime: standard deduction ₹75,000. Old regime: 80C + HRA exemptions apply.',
      },
    ],
  },
  {
    title: 'Rounding',
    description: 'How net pay is rounded before disbursement',
    fields: [
      {
        key: 'round_net_pay',
        label: 'Round Net Pay to Nearest',
        type: 'select',
        options: [
          { value: '1',   label: '₹1 (no rounding)' },
          { value: '10',  label: '₹10' },
          { value: '100', label: '₹100' },
        ],
        default: '1',
      },
    ],
  },
];

export default function PayrollSettings({ setPage }) {
  return (
    <ModuleSettingsPanel
      moduleName="Payroll"
      moduleIcon={IndianRupee}
      apiEndpoint="/settings/payroll"
      setPage={setPage}
      sections={SECTIONS}
    />
  );
}
