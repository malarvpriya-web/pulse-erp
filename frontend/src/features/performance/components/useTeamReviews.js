import { useState, useEffect, useCallback } from 'react';
import api from '@/services/api/client';

/** The latest review of each person who reports to the caller (GET /performance/team-reviews). */
export function useTeamReviews() {
  const [team, setTeam] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const load = useCallback(() => api.get('/performance/team-reviews')
    .then(r => setTeam(Array.isArray(r.data) ? r.data : []))
    .catch(() => setTeam([]))
    .finally(() => setLoaded(true)), []);
  useEffect(() => { load(); }, [load]);
  return { team, loaded, reload: load };
}
