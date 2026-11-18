import { useEffect, useState } from 'react';
import { getPosition } from '@/mobile/native';

/**
 * Location name + current temperature for the Home hero, next to the date.
 *
 * Device position (native GPS in the app, browser Geolocation on web) →
 *   - temperature: Open-Meteo forecast API (free, no key)
 *   - place name:  BigDataCloud client reverse-geocode (free, no key)
 * Cached in sessionStorage for 30 min so navigating back to Home doesn't
 * refetch. Any failure (permission denied, offline, API down) returns null and
 * the hero simply shows the date alone — this is decoration, never an error.
 */
const CACHE_KEY = 'pulse.home.weather';
const TTL_MS = 30 * 60 * 1000;

function readCache() {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw);
    return Date.now() - c.at < TTL_MS ? c.data : null;
  } catch { return null; }
}
function writeCache(data) {
  try { sessionStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), data })); } catch { /* ignore */ }
}

export default function useLocalWeather() {
  const [weather, setWeather] = useState(() => readCache());

  useEffect(() => {
    if (weather) return undefined;
    const ctrl = new AbortController();
    (async () => {
      try {
        const { latitude, longitude } = await getPosition({ highAccuracy: false, timeout: 8000 });
        const lat = latitude.toFixed(3), lon = longitude.toFixed(3);
        const [wx, place] = await Promise.allSettled([
          fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m`, { signal: ctrl.signal }).then(r => r.ok ? r.json() : Promise.reject(r.status)),
          fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`, { signal: ctrl.signal }).then(r => r.ok ? r.json() : Promise.reject(r.status)),
        ]);
        if (ctrl.signal.aborted) return;
        const t = wx.status === 'fulfilled' ? wx.value?.current?.temperature_2m : null;
        const p = place.status === 'fulfilled' ? place.value : null;
        const city = p ? (p.city || p.locality || p.principalSubdivision || '') : '';
        if (t == null && !city) return;
        const data = { city, temp: t == null ? null : Math.round(t) };
        writeCache(data);
        setWeather(data);
      } catch { /* denied / offline — show date only */ }
    })();
    return () => ctrl.abort();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return weather;
}
