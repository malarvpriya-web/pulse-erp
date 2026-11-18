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
        // Payroll is calculated monthly; weekly and fortnightly pay are not built.
        options: ['Monthly'],
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
        helpText: 'Attendance must be synced to payroll on or after this day: approval is refused for a draft whose attendance was synced earlier. It must fall BEFORE the pay day when salary is paid in the same month.',
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
        helpText: 'Used only when no attendance is synced. Otherwise a day of loss of pay is valued against the working days attendance counted for the employee.',
        placeholder: '26',
      },
      {
        key: 'night_shift_rate',
        label: 'Night Shift Allowance (₹ per night)',
        type: 'number',
        default: 200,
        helpText: 'Paid for each night shift attendance counts in the month. 0 pays no night-shift allowance. Applies from the next payroll generated.',
        placeholder: '200',
      },
    ],
  },
  {
    title: 'Attendance',
    description: 'Where loss of pay comes from',
    fields: [
      {
        key: 'require_attendance_sync',
        label: 'Payroll uses attendance',
        type: 'toggle',
        default: true,
        helpText: 'On: a month can be approved only after attendance is synced (Attendance → Payroll Sync), so absence reduces pay. Absence after the cutoff day is counted by the next month\'s sync and deducted then. Turn off only if the company keeps no attendance in Pulse — then nobody loses pay for absence.',
      },
    ],
  },
  {
    title: 'Reminders & payslip email',
    description: 'What Pulse does on its own each morning',
    fields: [
      {
        key: 'payroll_reminders',
        label: 'Send payroll reminders',
        type: 'toggle',
        default: true,
        helpText: 'Each morning, a notification to the people who run and approve payroll: attendance cutoff day reached, payroll not yet approved or paid as the pay date nears, and PF / ESI / PT / LWF / TDS due within 3 days or overdue.',
      },
      {
        key: 'email_payslips_on_payment',
        label: 'Email payslips once paid',
        type: 'toggle',
        default: false,
        helpText: 'On: each employee is emailed their payslip (PDF attached) the morning after their salary is marked paid. Needs the company email (SMTP) set up. A payslip already emailed is not sent again.',
      },
    ],
  },
  {
    title: 'Statutory rule changes',
    description: 'Who may change a rate, slab or ceiling',
    fields: [
      {
        key: 'rules_two_person',
        label: 'A rule change needs a second person',
        type: 'toggle',
        default: true,
        helpText: 'On: a change saved in Settings → Statutory rules is a proposal until a different authorised person confirms it. Recording the value already in force is a confirmation and applies at once.',
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
        helpText: 'Off removes HRA from every structure; pay is NOT moved to another allowance, so gross falls. Change the structure instead if HRA should be paid another way.',
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
        key: 'hra_metro_city',
        label: 'Office is in a metro city (HRA exemption 50%)',
        type: 'toggle',
        default: false,
        helpText: 'Old regime only: the HRA exemption is the least of HRA received, rent paid above 10% of Basic, and 40% of Basic (50% in a metro). Each employee\'s tax regime is set in Salary Structures → Tax regime & opening balances, or by the employee in Self-Service. An employee can also tick "metro city" on their own HRA declaration.',
      },
      {
        key: 'declaration_proof_cutoff_month',
        label: 'IT declaration proof cut-off',
        type: 'select',
        options: [
          { value: '1', label: 'January payroll (recommended)' },
          { value: '12', label: 'December payroll' },
          { value: '2', label: 'February payroll' },
          { value: '4', label: 'Approved declarations only, all year' },
          { value: '0', label: 'Never — unreviewed declarations count all year' },
        ],
        default: '1',
        helpText: 'Old regime only. Until this payroll month, declarations waiting for HR review reduce TDS as well as approved ones; from it on, only approved ones do (decision paper C7, option C). Year-end figures always use approved declarations only. Payroll readiness warns while declarations are still waiting.',
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
