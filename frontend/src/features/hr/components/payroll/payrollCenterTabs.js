import {
  LayoutDashboard, PlayCircle, IndianRupee, FileText, Receipt, Settings2,
} from 'lucide-react';

/**
 * Payroll Center sections, in workflow order. Two sections hold two pages,
 * switched with `?view=`. See PayrollCenter.jsx.
 */
export const SECTIONS = [
  { id: 'overview',   label: 'Overview',                   icon: LayoutDashboard },
  { id: 'processing', label: 'Payroll Processing',         icon: PlayCircle },
  { id: 'structures', label: 'Salary Structures & Loans',  icon: IndianRupee },
  { id: 'payslips',   label: 'Payslips',                   icon: FileText,
    views: [
      { id: 'generator', label: 'Preview & distribute' },
      { id: 'viewer',    label: 'Payslip viewer' },
    ] },
  { id: 'statutory',  label: 'Tax & Statutory',            icon: Receipt,
    views: [
      { id: 'form16',  label: 'Form 16 / Form 130 (annual certificate)' },
      // Its API is payroll_tds_extract:export (PC-01 D6/Q4), which payroll_admin,
      // hr and hr_manager do not hold although they can open Payroll Center.
      { id: 'form138', label: 'Form 138 / Form 24Q (quarterly statement)', grant: ['payroll_tds_extract', 'export'] },
    ] },
  { id: 'settings',   label: 'Settings',                   icon: Settings2 },
];

// Tab ids used before the 2026-10-28 consolidation → [section, view].
export const LEGACY_TABS = {
  payroll:   ['processing'],
  structure: ['structures'],
  generate:  ['payslips', 'generator'],
  view:      ['payslips', 'viewer'],
  form16:    ['statutory', 'form16'],
  form24q:   ['statutory', 'form138'],
};

/** The views of a section the caller may open; `allowed(module, action)` checks a view's `grant`. */
export function visibleViews(section, allowed = () => true) {
  return (section?.views || []).filter(v => !v.grant || allowed(v.grant[0], v.grant[1]));
}

/** `?tab=&view=` → { section, view }. Unknown or not-permitted values fall back to the defaults. */
export function resolvePayrollTab(tab, view, allowed = () => true) {
  const [legacySection, legacyView] = LEGACY_TABS[tab] || [];
  const section = SECTIONS.find(s => s.id === (legacySection || tab)) || SECTIONS[0];
  const views = visibleViews(section, allowed);
  const v = views.find(x => x.id === (view || legacyView)) || views[0] || null;
  return { section: section.id, view: v?.id || null };
}
