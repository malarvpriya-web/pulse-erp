import { useState, useEffect, useCallback, useRef } from 'react';
import api from '@/services/api/client';

/**
 * usePunchMode — how the signed-in employee is allowed to record attendance.
 *
 * Mirrors the server rule in shared/punchMode.js so the clock UI renders the
 * right control instead of offering a button that /attendance/clock will 403:
 *
 *   mode 'camera'  field employee  → in-app punch with a selfie + GPS
 *   mode 'device'  everyone else   → office face / biometric terminal only
 *
 * Fails CLOSED: a failed request leaves `canPunch` false, so a network blip
 * shows the device-only message rather than a button that cannot work. The
 * `loading` flag lets callers hold the control back until the answer arrives.
 */
const DEVICE_FALLBACK = {
  mode: 'device',
  is_field_employee: false,
  can_punch_in_app: false,
  selfie_required: false,
  location_required: false,
  reason: 'unavailable',
  message: 'Could not check your attendance setup. Reload, or punch at the office device.',
};

export default function usePunchMode(employeeId) {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const reqId = useRef(0);

  const load = useCallback(async () => {
    const mine = ++reqId.current;
    setLoading(true);
    try {
      const { data: res } = await api.get('/attendance/punch-mode');
      if (mine === reqId.current) setData(res || DEVICE_FALLBACK);
    } catch (err) {
      // An aborted request is not a failure — axios reports cancellation as
      // CanceledError / ERR_CANCELED, never AbortError. Leave the last good
      // answer in place instead of downgrading the user to device-only.
      const canceled = err?.code === 'ERR_CANCELED' || err?.name === 'CanceledError';
      if (mine === reqId.current && !canceled) setData(DEVICE_FALLBACK);
    } finally {
      if (mine === reqId.current) setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load, employeeId]);

  const mode = data?.mode || 'device';
  return {
    loading,
    mode,
    isField:        !!data?.is_field_employee,
    canPunch:       !!data?.can_punch_in_app,
    selfieRequired: !!data?.selfie_required,
    locationRequired: !!data?.location_required,
    reason:  data?.reason || null,
    message: data?.message || null,
    reload: load,
  };
}
