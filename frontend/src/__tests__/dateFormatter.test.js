import { describe, it, expect, vi, afterEach } from 'vitest';
import { fmtDate, formatDate, formatDateTime, formatTime, localDay, localDayOf } from '../utils/dateFormatter';

// The app-wide standard (§198): 05 Apr 26 for a date, "05 Apr 26, 14:30" for a
// date and time — the same everywhere, and a moment is shown in LOCAL time.

describe('dateFormatter', () => {
  afterEach(() => vi.useRealTimers());

  it('a bare date is printed as written, with no timezone shift', () => {
    expect(fmtDate('2026-04-05')).toBe('05 Apr 26');
    expect(formatDate('2026-12-31')).toBe('31 Dec 26');
    expect(fmtDate(null)).toBe('—');
    expect(formatDate('')).toBe('');
  });

  it('⚠ a timestamp is the LOCAL day — not the UTC day its string starts with', () => {
    // 20:00 UTC on the 19th is the 20th in any zone east of UTC+4 (IST: 01:30).
    const iso = '2026-09-19T20:00:00.000Z';
    const local = new Date(iso);
    const expected = `${String(local.getDate()).padStart(2, '0')} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][local.getMonth()]} 26`;
    expect(fmtDate(iso)).toBe(expected);
    if (local.getDate() !== 19) expect(fmtDate(iso), 'the old slice gave 19 Sep 26').not.toBe('19 Sep 26');
  });

  it('date + time uses the standard comma form and 24-hour time', () => {
    const d = new Date(2026, 3, 5, 14, 30);
    expect(formatDateTime(d)).toBe('05 Apr 26, 14:30');
    expect(formatDateTime(d.toISOString())).toBe('05 Apr 26, 14:30');
    expect(formatTime(new Date(2026, 3, 5, 9, 5))).toBe('09:05');
    expect(formatDateTime('not a date')).toBe('');
  });

  it('localDay is the local calendar day — toISOString() is a day behind IST before 05:30', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 28, 0, 30));      // 00:30 local
    expect(localDay()).toBe('2026-10-28');
    expect(localDay(-1)).toBe('2026-10-27');
    expect(localDayOf(new Date(2026, 0, 1))).toBe('2026-01-01');
  });
});
