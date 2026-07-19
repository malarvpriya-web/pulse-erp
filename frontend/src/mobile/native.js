/**
 * native.js — the bridge between the Pulse web app and the Capacitor native
 * shell. Every function degrades gracefully to a web implementation, so the
 * SAME code runs unchanged in a browser and in the native app.
 *
 * IMPORTANT: this file talks to Capacitor through the `window.Capacitor` runtime
 * that the native shell injects — it does NOT `import '@capacitor/...'`. That is
 * deliberate: the web build must not depend on the native packages being
 * installed. On a device, `window.Capacitor.Plugins.*` is present; on the web it
 * is undefined and each helper falls back to the standard browser API.
 */

const cap = () => (typeof window !== 'undefined' ? window.Capacitor : undefined);
const plugin = (name) => cap()?.Plugins?.[name];

/** True only inside the native iOS/Android shell. */
export function isNative() {
  return !!cap()?.isNativePlatform?.();
}

export function platform() {
  return cap()?.getPlatform?.() || 'web';
}

/** One-time native chrome setup: hide the splash, theme the status bar. No-op on web. */
export async function initNative() {
  if (!isNative()) return;
  try { await plugin('StatusBar')?.setBackgroundColor({ color: '#6B3FDB' }); } catch { /* plugin absent */ }
  try { await plugin('StatusBar')?.setStyle({ style: 'LIGHT' }); } catch { /* */ }
  try { await plugin('SplashScreen')?.hide(); } catch { /* */ }
}

/**
 * Auth token storage. On device, JWTs belong in the OS secure store
 * (@capacitor/preferences → Keychain / EncryptedSharedPreferences), not
 * localStorage. On web, falls back to localStorage so nothing changes there.
 */
export async function secureSet(key, value) {
  const p = plugin('Preferences');
  if (p) return p.set({ key, value });
  try { localStorage.setItem(key, value); } catch { /* */ }
}
export async function secureGet(key) {
  const p = plugin('Preferences');
  if (p) return (await p.get({ key })).value;
  try { return localStorage.getItem(key); } catch { return null; }
}
export async function secureRemove(key) {
  const p = plugin('Preferences');
  if (p) return p.remove({ key });
  try { localStorage.removeItem(key); } catch { /* */ }
}

/**
 * Geolocation for clock-in / geo-fencing and service-visit check-ins. Uses the
 * native plugin on device (better accuracy + permissions), the browser
 * Geolocation API otherwise. Resolves { latitude, longitude, accuracy }.
 */
export async function getPosition({ highAccuracy = true, timeout = 10000 } = {}) {
  const geo = plugin('Geolocation');
  if (geo) {
    const p = await geo.getCurrentPosition({ enableHighAccuracy: highAccuracy, timeout });
    return { latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: p.coords.accuracy };
  }
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('geolocation unavailable'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: p.coords.accuracy }),
      reject, { enableHighAccuracy: highAccuracy, timeout });
  });
}

/**
 * Capture a photo — face-attendance and service-engineer site photos. Returns a
 * data URL. Native uses the Camera plugin; web falls back to a file input.
 */
export async function capturePhoto({ quality = 80 } = {}) {
  const cam = plugin('Camera');
  if (cam) {
    const img = await cam.getPhoto({ quality, resultType: 'dataUrl', source: 'CAMERA' });
    return img.dataUrl;
  }
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'image/*'; input.capture = 'environment';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return reject(new Error('no image selected'));
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(file);
    };
    input.click();
  });
}

/**
 * Register for push notifications (approvals, breakdown-call assignment, tender
 * deadlines). Returns the device token, or null on web / if declined.
 */
export async function registerPush(onToken) {
  const push = plugin('PushNotifications');
  if (!push) return null;
  const perm = await push.requestPermissions();
  if (perm.receive !== 'granted') return null;
  push.addListener('registration', (t) => onToken?.(t.value));
  await push.register();
  return true;
}
