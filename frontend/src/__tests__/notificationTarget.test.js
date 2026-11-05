import { describe, it, expect } from 'vitest';
import { MERGED_ROUTES } from '@/config/autoRouter';
import {
  notificationTarget, notificationHref, TARGET_PAGES,
} from '@/features/notifications/notificationTarget';

// Clicking a notification navigates to the module the record lives in. The
// destination is derived from module_name/notification_type, which means a page
// rename anywhere in the app can silently orphan a mapping — the click then
// just stops navigating, with nothing failing. These tests close that loop.

describe('notificationTarget page map', () => {
  it('names only pages that exist as routes', () => {
    const missing = TARGET_PAGES.filter(p => !Object.prototype.hasOwnProperty.call(MERGED_ROUTES, p));
    expect(missing).toEqual([]);
  });
});

describe('notificationTarget', () => {
  it('routes a cron alert by its notification_type', () => {
    expect(notificationTarget({ module_name: 'finance', notification_type: 'ap_overdue', reference_id: 12 }))
      .toEqual({ page: 'PayablesPage', params: { ref: '12' } });
  });

  it('prefers the type over the module', () => {
    // module 'procurement' alone would land on PurchaseOrders.
    expect(notificationTarget({ module_name: 'procurement', notification_type: 'reorder_draft_prs' }).page)
      .toBe('PurchaseRequest');
  });

  it('matches generated type families by prefix', () => {
    expect(notificationTarget({ module_name: 'executive', notification_type: 'dept_kpi_digest:quality' }).page)
      .toBe('ExecutiveDashboard');
    expect(notificationTarget({ module_name: 'crm', notification_type: 'tender_deadline_overdue' }).page)
      .toBe('TenderWorkspace');
  });

  it('normalises the human module labels workflow events write', () => {
    expect(notificationTarget({ module_name: 'Purchase Request', notification_type: 'success' }).page)
      .toBe('PurchaseRequest');
    expect(notificationTarget({ module_name: 'Sales Order', notification_type: 'info' }).page)
      .toBe('SalesOrders');
  });

  it('sends an approver-facing notification to the queue and the submitter to their own list', () => {
    expect(notificationTarget({ module_name: 'Leave', notification_type: 'approval' }).page)
      .toBe('LeaveApprovals');
    expect(notificationTarget({ module_name: 'Leave', notification_type: 'success' }).page)
      .toBe('MyLeaves');
    // 'warning' is both a rejection (yours) and an overdue item (someone
    // else's) — the wording is what separates them.
    expect(notificationTarget({ module_name: 'Leave', notification_type: 'warning', title: 'Leave Rejected' }).page)
      .toBe('MyLeaves');
    expect(notificationTarget({
      module_name: 'Leave', notification_type: 'warning',
      title: 'Leave Overdue', message: 'is overdue and awaiting your action.',
    }).page).toBe('LeaveApprovals');
  });

  it('falls back to the other side when the role cannot open the first choice', () => {
    const employee = pg => pg !== 'LeaveApprovals';
    expect(notificationTarget({ module_name: 'Leave', notification_type: 'approval' }, employee).page)
      .toBe('MyLeaves');
  });

  it('returns null rather than navigating somewhere arbitrary', () => {
    expect(notificationTarget({ module_name: 'not_a_module', notification_type: 'info' })).toBeNull();
    expect(notificationTarget(null)).toBeNull();
    // Every candidate blocked for this role.
    expect(notificationTarget({ module_name: 'Leave', notification_type: 'approval' }, () => false)).toBeNull();
  });

  it('honours an explicit link, and ignores one the router cannot resolve', () => {
    expect(notificationTarget({ module_name: 'quality', notification_type: 'task', link: '/CAPAManagement' }).page)
      .toBe('CAPAManagement');
    // A multi-segment path is not a route here — fall back to the module map.
    expect(notificationTarget({ module_name: 'quality', notification_type: 'task', link: '/quality/capa' }).page)
      .toBe('QualityDashboard');
  });

  it('builds an href carrying the source record id', () => {
    expect(notificationHref({ module_name: 'sales', notification_type: 'quotation_expired', reference_id: 7 }))
      .toBe('/Quotations?ref=7');
    expect(notificationHref({ module_name: 'executive', notification_type: 'kpi_digest' }))
      .toBe('/ExecutiveDashboard');
    expect(notificationHref({ module_name: 'nope', notification_type: 'nope' })).toBeNull();
  });
});
