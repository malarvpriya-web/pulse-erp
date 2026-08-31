/**
 * Core action discovery types, classifier, and page-evaluation script.
 * Used by all action audit phases (09–14).
 */

export type ActionType =
  | 'create-button'
  | 'edit-button'
  | 'delete-button'
  | 'view-button'
  | 'approve-button'
  | 'reject-button'
  | 'forward-button'
  | 'export-button'
  | 'import-button'
  | 'download-button'
  | 'filter-button'
  | 'search-button'
  | 'refresh-button'
  | 'submit-button'
  | 'save-button'
  | 'tab'
  | 'nav-link'
  | 'dashboard-card'
  | 'dropdown-trigger'
  | 'icon-button'
  | 'toggle-button'
  | 'close-button'
  | 'copy-button'
  | 'print-button'
  | 'upload-button'
  | 'pagination'
  | 'other-button';

export type SafetyCategory = 'SAFE' | 'FORM' | 'APPROVAL' | 'DANGEROUS' | 'UNKNOWN';

export type SelectorStrategy = 'testid' | 'id' | 'arialabel' | 'role-text' | 'text' | 'href' | 'title' | 'css';

export interface DiscoveredAction {
  route: string;
  module: string;
  actionType: ActionType;
  actionLabel: string;
  safetyCategory: SafetyCategory;
  selectorStrategy: SelectorStrategy;
  selector: string;
  selectorText?: string;
  elementTag: string;
  elementClass: string;
}

export interface ActionTestResult extends DiscoveredAction {
  status: 'PASS' | 'FAIL' | 'SKIP' | 'WARN';
  errorType?: string;
  errorMessage?: string;
  consoleErrors: string[];
  networkErrors: string[];
  screenshotPath?: string;
  durationMs: number;
}

export interface RawElement {
  tag: string;
  text: string;
  ariaLabel: string;
  label: string;
  id: string;
  className: string;
  type: string;
  href: string;
  dataTestId: string;
  title: string;
  role: string;
}

/** Classify an element into action type and safety category */
export function classifyAction(el: RawElement): { actionType: ActionType; safetyCategory: SafetyCategory } {
  const all = [el.label, el.ariaLabel, el.text, el.className, el.title].join(' ').toLowerCase();

  // DANGEROUS — must check first
  if (/\b(delete|remove|purge|erase|destroy|wipe|deactivate|terminate|archive\s|clear\s*all|reset\s*database|drop\s+table)\b/.test(all)) {
    return { actionType: 'delete-button', safetyCategory: 'DANGEROUS' };
  }

  // APPROVAL
  if (/\b(approve|sanction|grant\s+access|accept\s+request)\b/.test(all)) {
    return { actionType: 'approve-button', safetyCategory: 'APPROVAL' };
  }
  if (/\b(reject|decline|deny|refuse)\b/.test(all)) {
    return { actionType: 'reject-button', safetyCategory: 'APPROVAL' };
  }
  if (/\b(forward|escalate|delegate\s+to)\b/.test(all)) {
    return { actionType: 'forward-button', safetyCategory: 'APPROVAL' };
  }

  // FORM — creates or edits data
  if (/\b(add\s|create|new\s|register|enroll|raise|invite|hire|onboard|request)\b/.test(all)
      && !/\b(view|created|new-tab|news)\b/.test(all)) {
    return { actionType: 'create-button', safetyCategory: 'FORM' };
  }
  if (/\b(edit|update|modify|change|amend)\b/.test(all)) {
    return { actionType: 'edit-button', safetyCategory: 'FORM' };
  }
  if (/\b(save|apply\s+changes)\b/.test(all) && el.type !== 'reset') {
    return { actionType: 'save-button', safetyCategory: 'FORM' };
  }
  if (/\b(submit|apply\s+leave|raise\s+|file\s+)\b/.test(all)) {
    return { actionType: 'submit-button', safetyCategory: 'FORM' };
  }
  if (/\b(upload|import)\b/.test(all)) {
    return { actionType: 'import-button', safetyCategory: 'FORM' };
  }

  // SAFE — no data mutation
  if (/\b(export|download|pdf|excel|csv|xls|xlsx|generate\s+report)\b/.test(all)) {
    return { actionType: 'export-button', safetyCategory: 'SAFE' };
  }
  if (/\b(filter|search|find|query|lookup)\b/.test(all)) {
    return { actionType: 'filter-button', safetyCategory: 'SAFE' };
  }
  if (/\b(refresh|reload|sync|resync)\b/.test(all)) {
    return { actionType: 'refresh-button', safetyCategory: 'SAFE' };
  }
  if (/\b(view\s|detail|open|preview|show|expand)\b/.test(all)) {
    return { actionType: 'view-button', safetyCategory: 'SAFE' };
  }
  if (/\b(print)\b/.test(all)) {
    return { actionType: 'print-button', safetyCategory: 'SAFE' };
  }
  if (/\b(copy|duplicate|clone)\b/.test(all)) {
    return { actionType: 'copy-button', safetyCategory: 'SAFE' };
  }
  if (/\b(close|cancel|dismiss|go\s*back)\b/.test(all)) {
    return { actionType: 'close-button', safetyCategory: 'SAFE' };
  }
  if (el.tag === 'a' && el.href && !el.href.startsWith('javascript') && !el.href.startsWith('#')) {
    return { actionType: 'nav-link', safetyCategory: 'SAFE' };
  }
  if (/tab/.test(el.role) || /\btab\b/.test(el.className)) {
    return { actionType: 'tab', safetyCategory: 'SAFE' };
  }
  if (/\b(next|previous|prev|page\s*\d)\b/.test(all)) {
    return { actionType: 'pagination', safetyCategory: 'SAFE' };
  }
  if (/\b(toggle|collapse|expand)\b/.test(all)) {
    return { actionType: 'toggle-button', safetyCategory: 'SAFE' };
  }
  if (/\b(dropdown|menu|more\s+options|actions|\.\.\.)\b/.test(all)) {
    return { actionType: 'dropdown-trigger', safetyCategory: 'SAFE' };
  }

  if (el.tag === 'button' || el.role === 'button') {
    return { actionType: 'other-button', safetyCategory: 'UNKNOWN' };
  }

  return { actionType: 'icon-button', safetyCategory: 'UNKNOWN' };
}

/** CSS-escape an id for use in a selector (CSS.escape not available in Node.js) */
function cssEscapeId(id: string): string {
  return id.replace(/[!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~]/g, '\\$&');
}

/** Generate the best Playwright selector for an element */
export function buildSelector(el: RawElement): { strategy: SelectorStrategy; selector: string; text?: string } {
  if (el.dataTestId) {
    return { strategy: 'testid', selector: `[data-testid="${el.dataTestId}"]` };
  }
  if (el.id && el.id.length > 0 && el.id.length < 60) {
    return { strategy: 'id', selector: `#${cssEscapeId(el.id)}` };
  }
  if (el.ariaLabel && el.ariaLabel.length < 80) {
    return { strategy: 'arialabel', selector: `[aria-label="${el.ariaLabel}"]` };
  }
  if ((el.tag === 'button' || el.role === 'button') && el.text && el.text.length < 60) {
    return { strategy: 'role-text', selector: 'button', text: el.text };
  }
  if (el.tag === 'a' && el.href && el.href.length < 100) {
    return { strategy: 'href', selector: `a[href="${el.href}"]` };
  }
  if (el.title && el.title.length < 80) {
    return { strategy: 'title', selector: `[title="${el.title}"]` };
  }
  if (el.text && el.text.length < 60) {
    return { strategy: 'text', selector: el.text };
  }
  return { strategy: 'css', selector: `${el.tag}` };
}

/** The script injected via page.evaluate() to discover all interactive elements */
export const DISCOVERY_SCRIPT = `
(function() {
  const INTERACTIVE_SELECTORS = [
    'button:not([disabled])',
    '[role="button"]:not([disabled])',
    '[role="tab"]',
    '[role="menuitem"]',
    'a[href]',
    'input[type="submit"]:not([disabled])',
    'input[type="button"]:not([disabled])',
    '[class*="btn"]:not([disabled])',
    '[class*="action-btn"]',
    '[class*="fab"]',
    '[class*="icon-btn"]',
    '[data-action]',
    '[onclick]',
  ];

  const seen = new Set();
  const results = [];

  for (const sel of INTERACTIVE_SELECTORS) {
    let elements;
    try {
      elements = document.querySelectorAll(sel);
    } catch(e) { continue; }

    for (const el of elements) {
      const rect = el.getBoundingClientRect();
      // Include off-screen but not zero-size hidden elements
      if (rect.width === 0 && rect.height === 0) continue;

      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;

      const rawText = (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
      const ariaLabel = (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || '').slice(0, 80);
      const title = (el.getAttribute('title') || '').slice(0, 80);
      const label = (ariaLabel || rawText || title || '').slice(0, 80);

      if (!label && !el.getAttribute('data-testid')) continue; // skip unlabeled unless testid

      const dedupeKey = label.slice(0, 30) + '::' + (el.id || el.getAttribute('data-testid') || '');
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      results.push({
        tag: el.tagName.toLowerCase(),
        text: rawText,
        ariaLabel: ariaLabel,
        label: label,
        id: el.id || '',
        className: (el.className && typeof el.className === 'string') ? el.className.slice(0, 120) : '',
        type: el.getAttribute('type') || '',
        href: el.getAttribute('href') || '',
        dataTestId: el.getAttribute('data-testid') || '',
        title: title,
        role: el.getAttribute('role') || '',
      });

      if (results.length >= 200) break; // cap per page
    }
    if (results.length >= 200) break;
  }

  return results;
})()
`;

// Unique suffix per test session to avoid duplicate-key errors on re-runs
const _SESSION_SUFFIX = Date.now().toString(36);

/** Smart test data generator for form fields */
export function generateFieldValue(label: string, placeholder: string, inputType: string): string {
  const hint = (label + ' ' + placeholder).toLowerCase();

  if (inputType === 'email' || hint.includes('email')) return `qa.${_SESSION_SUFFIX}@pulse.erp`;
  if (inputType === 'tel' || hint.includes('phone') || hint.includes('mobile')) return '9876543210';
  if (inputType === 'date' || hint.includes('date')) return new Date().toISOString().split('T')[0];
  if (inputType === 'number' || hint.includes('amount') || hint.includes('price') || hint.includes('cost') || hint.includes('salary')) return '10000';
  if (hint.includes('quantity') || hint.includes('qty') || hint.includes('units')) return '1';
  if (hint.includes('percentage') || hint.includes('rate') || hint.includes('%')) return '10';
  if (hint.includes('year') || hint.includes('duration') || hint.includes('days') || hint.includes('hours') || hint.includes('count') || hint.includes('notice period')) return '1';
  if (hint.includes('url') || hint.includes('website') || hint.includes('link')) return 'https://example.com';
  if (hint.includes('zip') || hint.includes('postal') || hint.includes('pincode')) return '600001';
  if (hint.includes('pan') || hint.includes('gstin') || hint.includes('cin')) return 'AAAAA0000A';
  if (hint.includes('ifsc')) return 'SBIN0000001';
  if (hint.includes('account') && hint.includes('number')) return '00112233445566';
  if (hint.includes('name')) return `Test Record ${_SESSION_SUFFIX}`;
  if (hint.includes('title')) return `Test Entry ${_SESSION_SUFFIX}`;
  if (hint.includes('description') || hint.includes('note') || hint.includes('remark') || hint.includes('comment')) {
    return 'Created by Pulse automated test suite — safe to delete';
  }
  if (hint.includes('address') || hint.includes('street') || hint.includes('location')) return '123 Test Lane, Chennai';
  if (hint.includes('city')) return 'Chennai';
  if (hint.includes('state')) return 'Tamil Nadu';
  if (hint.includes('country')) return 'India';
  if (hint.includes('company') || hint.includes('organisation') || hint.includes('organization')) return 'Pulse Test Org';
  if (hint.includes('code')) return `TST${_SESSION_SUFFIX}`;
  if (hint.includes('reason') || hint.includes('purpose')) return 'Automated test — quality assurance';

  // Default for unknown text fields
  return `QA Value ${_SESSION_SUFFIX}`;
}

/** Routes to skip during form creation (could affect production config) */
export const FORM_SKIP_ROUTES = new Set([
  '/AccessControl',
  '/WorkflowBuilder',
  '/SystemSettings',
  '/SetupCenter',
  '/DocumentSetup',
  '/ProductSetup',
  '/MasterSetup',
  '/OrderPolicy',
  '/OrganizationSetup',
  '/RolesSetup',
  '/IntegrationsHub',
  '/SettingsCenter',
  '/UserPreferences',
  '/CompanyProfile',
  '/BranchManagement',
  '/PayrollCenter',  // payroll runs are irreversible
]);
