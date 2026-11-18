// Unit test for the probation state shown on HR > My Dashboard (no DB).
import { describe, it, expect, vi } from 'vitest';

vi.mock('../config/db.js', () => ({ default: { query: vi.fn() } }));

import { probationStateOf } from '../home/myEmployment.js';
const today = '2026-11-11';

describe('probationStateOf', () => {
  it('no dates → not_set', () => {
    expect(probationStateOf({}, today).state).toBe('not_set');
  });
  it('confirmation on or before today → confirmed', () => {
    expect(probationStateOf({ probation_end_date: '2026-05-26', confirmation_date: '2026-11-11' }, today).state).toBe('confirmed');
  });
  it('end date today or later, not yet confirmed → on_probation with days left', () => {
    const p = probationStateOf({ probation_end_date: '2026-11-11', confirmation_date: null, probation_days_left: 0 }, today);
    expect(p).toMatchObject({ state: 'on_probation', days_left: 0 });
  });
  it('planned confirmation in the future still reads on_probation', () => {
    expect(probationStateOf({ probation_end_date: '2026-12-01', confirmation_date: '2026-12-01', probation_days_left: 20 }, today).state).toBe('on_probation');
  });
  it('end date passed with no confirmation → decision_pending', () => {
    expect(probationStateOf({ probation_end_date: '2026-10-01', confirmation_date: null }, today).state).toBe('decision_pending');
  });
});
