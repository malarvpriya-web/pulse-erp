import { useState, useEffect } from 'react';
import api from '@/services/api/client';

/**
 * Recruitment module settings, for the handful of places that act on them.
 *
 * Kept deliberately small: it returns the raw settings object and never throws.
 * A settings call that fails must not stop a recruiter adding a candidate, so
 * the failure case is an empty object and every consumer treats "not configured"
 * as the permissive default.
 */
export default function useRecruitmentSettings() {
  const [settings, setSettings] = useState(null);

  useEffect(() => {
    let alive = true;
    api.get('/settings/recruitment')
      .then((r) => { if (alive) setSettings(r?.data?.settings ?? r?.data ?? {}); })
      .catch(() => { if (alive) setSettings({}); });
    return () => { alive = false; };
  }, []);

  return settings;
}
