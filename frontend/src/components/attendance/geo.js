import { getPosition } from '@/mobile/native';

/**
 * Resolve the device GPS position as a "lat,lng" string, or null when
 * unavailable/denied. Routes through the native bridge — native GPS + OS
 * permission inside the Capacitor app, browser Geolocation on web. The server
 * decides whether location is mandatory (it is, for a field clock-in).
 *
 * Lives here rather than in a modal so both the camera clock-in and the plain
 * clock-out path can use it without importing a component.
 */
export async function getLocationString(timeoutMs = 8000) {
  try {
    const { latitude, longitude } = await getPosition({ highAccuracy: true, timeout: timeoutMs });
    return `${latitude.toFixed(6)},${longitude.toFixed(6)}`;
  } catch {
    return null;
  }
}
