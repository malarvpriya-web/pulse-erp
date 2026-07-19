import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor config — packages the existing Vite/React build (dist/) into native
 * iOS + Android shells. Chosen over React Native because Pulse is already a
 * responsive, role-aware React app: Capacitor reuses 100% of that UI + the
 * existing API/auth, and exposes native capabilities (geolocation, camera, push,
 * secure storage) through plugins — so all 7 role experiences ship at once
 * rather than being rebuilt screen by screen.
 *
 * Dev live-reload: set CAP_SERVER_URL to your machine's LAN address, e.g.
 *   CAP_SERVER_URL=http://192.168.1.20:5173 npx cap run android
 * Leave it unset for a production build that loads the bundled dist/.
 */
const config: CapacitorConfig = {
  appId: 'com.manifest.pulse',
  appName: 'Pulse',
  webDir: 'dist',
  server: process.env.CAP_SERVER_URL
    ? { url: process.env.CAP_SERVER_URL, cleartext: true }
    : { androidScheme: 'https' },
  plugins: {
    SplashScreen: { launchShowDuration: 1200, backgroundColor: '#6B3FDB', showSpinner: false },
    PushNotifications: { presentationOptions: ['badge', 'sound', 'alert'] },
  },
};

export default config;
