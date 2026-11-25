/**
 * Recruitment settings save rule (review 2026-11-18, recruitment/recruitmentSettings.js):
 * merged onto the stored blob (HR → Probation writes into it too), dead keys
 * dropped, numbers range-checked.
 */
import { describe, it, expect } from 'vitest';
import { normalizeRecruitmentSettings, DEAD_RECRUITMENT_KEYS } from '../modules/recruitment/recruitmentSettings.js';

describe('normalizeRecruitmentSettings', () => {
  const stored = { probation_months: 3, probation_review_reminder_days: 7, offer_validity_days: 7,
    auto_send_offer: false, interview_stages: 'A,B', offer_letter_template: '' };

  it('keeps keys the request did not send (the Probation policy)', () => {
    const { settings, errors } = normalizeRecruitmentSettings({ offer_validity_days: 10 }, stored);
    expect(errors).toEqual([]);
    expect(settings).toMatchObject({ probation_months: 3, probation_review_reminder_days: 7, offer_validity_days: 10 });
  });

  it('drops keys nothing reads', () => {
    const { settings } = normalizeRecruitmentSettings({}, stored);
    for (const k of DEAD_RECRUITMENT_KEYS) expect(settings).not.toHaveProperty(k);
  });

  it.each([
    ['offer_validity_days', 0], ['offer_validity_days', 91], ['offer_validity_days', 2.5], ['offer_validity_days', ''],
    ['candidate_retention_months', 0], ['candidate_retention_months', 241], ['probation_months', 25],
  ])('refuses %s = %p', (k, v) => {
    expect(normalizeRecruitmentSettings({ [k]: v }, stored).errors).toHaveLength(1);
  });

  it('stores numbers as numbers and accepts the range ends', () => {
    const { settings, errors } = normalizeRecruitmentSettings({ offer_validity_days: '90', candidate_retention_months: 1 }, {});
    expect(errors).toEqual([]);
    expect(settings.offer_validity_days).toBe(90);
    expect(settings.candidate_retention_months).toBe(1);
  });

  it('refuses over-long letter wording and a non-object body', () => {
    expect(normalizeRecruitmentSettings({ offer_letter_closing: 'x'.repeat(301) }, {}).errors).toHaveLength(1);
    expect(normalizeRecruitmentSettings([], {}).errors).toHaveLength(1);
  });
});
