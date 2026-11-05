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
        helpText: 'Day salaries reach employees. Payroll is "overdue" once this date passes without approval/payment.',
        placeholder: '25',
      },
      {
        key: 'payroll_cutoff_day',
        label: 'Payroll Cutoff Day',
        type: 'number',
        default: 20,
        helpText: 'Attendance and leave for the month are frozen on this day. It must fall BEFORE the pay day when salary is paid in the same month.',
        placeholder: '20',
      },
      {
        key: 'pay_in_following_month',
        label: 'Pay in Following Month',
        type: 'toggle',
        default: false,
        helpText: 'On: the month is paid on the pay day of the NEXT month (must be by the 7th — Code on Wages s.17), so the cutoff can be month-end.',
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
    description: 'Toggle which allowance components the salary structure pays (part of monthly gross)',
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
        helpText: 'Balancing allowance that tops earnings up to the structure\'s monthly gross target',
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
        helpText: '12% employee + 12% employer on PF wages (Basic, raised to 50% of pay under the Code on Social Security). Employer share is employer cost, never deducted from pay. Ceiling comes from the statutory rules in force for the month.',
      },
      {
        key: 'pf_restrict_to_ceiling',
        label: 'Restrict PF to Wage Ceiling',
        type: 'toggle',
        default: true,
        helpText: 'On: contribute on PF wages up to the statutory ceiling (₹15,000; ₹25,000 from 17-Sep-2026). Off: contribute on full PF wages (EPS stays capped).',
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
        // Must match the server default (payrollSettings.js): with no saved
        // value the payroll deducted PT while this screen showed it OFF.
        default: true,
        helpText: 'State slab of the employee\'s branch (else company) state. This switch is the ONLY source — the PT line in a salary structure is not used.',
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
          { value: 'new', label: 'New Regime (default)' },
          { value: 'old', label: 'Old Regime (80C / HRA exemptions)' },
        ],
        default: 'new',
        helpText: 'New regime: standard deduction ₹75,000. Old regime: 80C + HRA exemptions apply.',
      },
    ],
  },
  {
    title: 'Statutory jurisdiction',
    description: 'Which state\'s professional tax and labour welfare fund rules apply — payroll approval is blocked until this is recorded',
    fields: [
      {
        key: 'statutory_state',
        label: 'Statutory state',
        type: 'select',
        options: [
          { value: '', label: '— Not recorded —' },
          'Tamil Nadu', 'Karnataka', 'Maharashtra', 'Telangana', 'Andhra Pradesh', 'Kerala', 'Gujarat', 'West Bengal',
        ],
        default: '',
        helpText: 'Every employee in a payroll must resolve to this state (from their branch, else the company record). If they do not, approval is blocked until the company or branch state is corrected.',
      },
      {
        key: 'pt_local_body',
        label: 'PT local body type',
        type: 'select',
        options: [
          { value: '', label: '— Not recorded —' },
          { value: 'municipal_corporation', label: 'Municipal corporation' },
          { value: 'municipality', label: 'Municipality' },
          { value: 'town_panchayat', label: 'Town panchayat' },
          { value: 'village_panchayat', label: 'Village panchayat' },
        ],
        default: '',
        helpText: 'Tamil Nadu levies professional tax through the local body where the office or factory is. Pulse holds the Urban Local Bodies Rules 2023 table; a village panchayat publishes its own rates.',
      },
      {
        key: 'pt_local_body_name',
        label: 'PT local body name',
        type: 'text',
        default: '',
        placeholder: 'e.g. Srivilliputhur Municipality',
      },
    ],
  },
  {
    title: 'CTC-driven salary entry',
    description: 'Pilot: enter salaries as annual CTC with a full breakdown and an approval step',
    fields: [
      {
        key: 'ctc_mode',
        label: 'CTC-driven salary entry',
        type: 'toggle',
        default: false,
        helpText: 'Off: salaries are entered as monthly Basic (current behaviour). On: HR can prepare salary proposals from an annual CTC, offers and increments become proposals, and an approver finalises them. Finalising also needs the company CTC definition recorded and the statutory rules it uses confirmed.',
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

export default function PayrollSettings({ setPage, embedded = false }) {
  return (
    <ModuleSettingsPanel
      moduleName="Payroll"
      moduleIcon={IndianRupee}
      apiEndpoint="/settings/payroll"
      setPage={setPage}
      sections={SECTIONS}
      embedded={embedded}
    />
  );
}
