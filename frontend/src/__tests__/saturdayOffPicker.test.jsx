import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import SaturdayOffPicker, { isWeeklyOff, saturdayText } from '../features/leaves/components/SaturdayOffPicker.jsx';

const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];

describe('isWeeklyOff — 2nd / 4th Saturday', () => {
  const cfg = { weekend_days: ['sunday'], saturday_off_weeks: [2, 4] };
  it('only the chosen Saturdays are off (March 2027: 6, 13, 20, 27)', () => {
    expect(isWeeklyOff('2027-03-06', cfg)).toBe(false);
    expect(isWeeklyOff('2027-03-13', cfg)).toBe(true);
    expect(isWeeklyOff('2027-03-20', cfg)).toBe(false);
    expect(isWeeklyOff('2027-03-27', cfg)).toBe(true);
    expect(isWeeklyOff('2027-03-07', cfg)).toBe(true);   // Sunday
    expect(isWeeklyOff('2027-03-08', cfg)).toBe(false);  // Monday
  });
  it('without settings it falls back to Saturday + Sunday', () => {
    expect(isWeeklyOff('2027-03-06', null)).toBe(true);
  });
});

describe('SaturdayOffPicker', () => {
  it('ticking the 2nd and 4th makes Saturday a working day with those two off', () => {
    const onChange = vi.fn();
    const { rerender } = render(<SaturdayOffPicker workingDays={WEEKDAYS} weeks={[]} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText('2nd'));
    expect(onChange).toHaveBeenLastCalledWith({ working_days: [...WEEKDAYS, 'saturday'], saturday_off_weeks: [2] });
    rerender(<SaturdayOffPicker workingDays={[...WEEKDAYS, 'saturday']} weeks={[2]} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText('4th'));
    expect(onChange).toHaveBeenLastCalledWith({ working_days: [...WEEKDAYS, 'saturday'], saturday_off_weeks: [2, 4] });
  });
  it('"Every Saturday off" clears the week choice', () => {
    const onChange = vi.fn();
    render(<SaturdayOffPicker workingDays={[...WEEKDAYS, 'saturday']} weeks={[2, 4]} onChange={onChange} />);
    fireEvent.click(screen.getByText('Every Saturday off'));
    expect(onChange).toHaveBeenLastCalledWith({ working_days: WEEKDAYS, saturday_off_weeks: [] });
  });
  it('describes the choice', () => {
    expect(saturdayText([...WEEKDAYS, 'saturday'], [2, 4])).toBe('2nd & 4th Saturday off');
    expect(saturdayText(WEEKDAYS, [])).toBe('Every Saturday off');
  });
});
