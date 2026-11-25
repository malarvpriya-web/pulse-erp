/**
 * Own leave works for everyone (owner, 2026-11-25): a login linked to an
 * employee opens My Leaves / Apply Leave / Holiday Calendar whatever its
 * roles; nothing else in Leaves opens for it, and an unlinked login gains
 * nothing.
 */
import { describe, it, expect } from 'vitest';
import { canRenderPage, canRoleOpenPage, OWN_LEAVE_PAGES } from '@/config/menuCatalog';

const route = { module: 'leaves' };
const noGrant = () => false;

describe('own leave pages', () => {
  it('a linked store keeper with no leaves grant opens the three own-leave pages', () => {
    for (const page of OWN_LEAVE_PAGES) {
      expect(canRenderPage('store_keeper', page, { route, hasPermission: noGrant, employeeLinked: true })).toBe(true);
      expect(canRoleOpenPage('store_keeper', page, { employeeLinked: true })).toBe(true);
    }
  });

  it('… but no other Leaves page', () => {
    for (const page of ['LeaveApprovals', 'AllLeaves', 'LeaveSettings', 'LeaveCalendar']) {
      expect(canRenderPage('store_keeper', page, { route, hasPermission: noGrant, employeeLinked: true })).toBe(false);
    }
  });

  it('an unlinked login gains nothing', () => {
    expect(canRenderPage('store_keeper', 'MyLeaves', { route, hasPermission: noGrant, employeeLinked: false })).toBe(false);
  });

  it('a Page Access "hidden" on Leaves still wins', () => {
    expect(canRenderPage('store_keeper', 'MyLeaves', { route, hasPermission: noGrant, employeeLinked: true, menuAccess: () => 'hidden' })).toBe(false);
  });
});
