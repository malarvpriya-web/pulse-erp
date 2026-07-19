import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getLocationString } from '../FaceClockModal';

// getLocationString routes through @/mobile/native getPosition(). With no
// window.Capacitor present (web), getPosition falls back to navigator.geolocation.
describe('getLocationString (native bridge → web fallback)', () => {
  beforeEach(() => { delete window.Capacitor; });

  it('formats native/web position as "lat,lng" with 6 decimals', async () => {
    navigator.geolocation = {
      getCurrentPosition: (ok) => ok({ coords: { latitude: 13.0827, longitude: 80.2707, accuracy: 12 } }),
    };
    expect(await getLocationString()).toBe('13.082700,80.270700');
  });

  it('returns null when geolocation fails (server decides if mandatory)', async () => {
    navigator.geolocation = { getCurrentPosition: (_ok, err) => err(new Error('denied')) };
    expect(await getLocationString()).toBeNull();
  });
});
