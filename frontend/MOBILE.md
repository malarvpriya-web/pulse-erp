# Pulse Mobile (Capacitor)

Native iOS + Android apps that wrap the existing Pulse React web app. Because
Pulse is already responsive and role-aware, Capacitor ships **all seven role
experiences** (Employee, Manager, Sales, Service Engineer, Dealer, Customer,
Vendor) from the one codebase, and adds native capabilities — geolocation,
camera, secure token storage, and push — through the bridge in
[`src/mobile/native.js`](src/mobile/native.js).

## How it fits together

- The web build (`vite build` → `dist/`) is the app; Capacitor loads it in a
  native WebView.
- `src/mobile/native.js` is the only mobile-aware code. It talks to the native
  runtime via the injected `window.Capacitor` global, and **falls back to the
  browser API on web** — so the same build runs in a browser unchanged. Nothing
  imports `@capacitor/*` at module scope, so the web build never depends on the
  native packages being installed.
- `capacitor.config.ts` sets the app id (`com.manifest.pulse`), the web dir, and
  plugin options.

## First-time setup

The native projects are **already generated** (`android/` and `ios/` exist, with
camera/location/push permissions pre-added to AndroidManifest.xml and Info.plist).
Just install deps:

```bash
cd Pulse/frontend
npm install                       # @capacitor/* deps
# On macOS only, finish the iOS pods (skipped on Windows/Linux):
cd ios/App && pod install && cd ../..
```

To regenerate a platform from scratch (rarely needed): delete the folder and
`npx cap add android` / `npx cap add ios`.

## Build & run

```bash
npm run mobile:android            # vite build → cap sync → open Android Studio
npm run mobile:ios                # vite build → cap sync → open Xcode
```

Then Run from Android Studio / Xcode onto an emulator or a connected device.

### Live-reload against the dev server (fast inner loop)

```bash
# find your machine's LAN IP, run the Vite dev server, then:
CAP_SERVER_URL=http://<your-lan-ip>:5173 npx cap run android
```

The app now hot-loads from Vite instead of the bundled `dist/`.

## Using native capabilities from any screen

```js
import { isNative, getPosition, capturePhoto, secureGet, registerPush } from '@/mobile/native';

const pos = await getPosition();        // native GPS on device, browser geo on web
const photo = await capturePhoto();     // native camera on device, file input on web
```

The clock-in / geo-fence and face-attendance flows already call the browser
equivalents; point them at these helpers to get native accuracy and the OS
camera on device with no other change.

## Notes

- Store the auth JWT via `secureSet/secureGet` (OS Keychain / EncryptedSharedPreferences
  on device; localStorage on web) rather than raw localStorage.
- Push tokens (`registerPush`) should be POSTed to a backend endpoint that maps
  device → user for approvals, breakdown-call assignment, and tender-deadline
  alerts. That endpoint is the next backend task.
- `android/` and `ios/` are generated native projects — commit them once created,
  or `.gitignore` them and regenerate in CI with `npx cap add`.
