import * as React from 'react';

export default function usePWA() {
  const [isInstalled, setIsInstalled]     = React.useState(false);
  const [isOnline, setIsOnline]           = React.useState(navigator.onLine);
  const [canInstall, setCanInstall]       = React.useState(false);
  const [updateAvailable, setUpdateAvailable] = React.useState(false);
  const deferredPrompt = React.useRef(null);
  const swRegistration = React.useRef(null);

  /* detect standalone (installed) mode */
  React.useEffect(() => {
    const standalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      window.navigator.standalone === true;
    setIsInstalled(standalone);
  }, []);

  /* online / offline events */
  React.useEffect(() => {
    const handleOnline  = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online',  handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online',  handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  /* beforeinstallprompt — capture install event */
  React.useEffect(() => {
    const handler = (e) => {
      e.preventDefault();
      deferredPrompt.current = e;
      setCanInstall(true);
    };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  /* detect successful install */
  React.useEffect(() => {
    const handler = () => { setIsInstalled(true); setCanInstall(false); };
    window.addEventListener('appinstalled', handler);
    return () => window.removeEventListener('appinstalled', handler);
  }, []);

  /* register service worker and listen for updates */
  React.useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    // In dev mode, skip SW to prevent Vite's JS modules from being cached stale
    if (import.meta.env.DEV) return;

    navigator.serviceWorker.register('/sw.js', { scope: '/' })
      .then((reg) => {
        swRegistration.current = reg;

        /* check for waiting SW on first load */
        if (reg.waiting) setUpdateAvailable(true);

        /* listen for future updates */
        reg.addEventListener('updatefound', () => {
          const newWorker = reg.installing;
          if (!newWorker) return;
          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              setUpdateAvailable(true);
            }
          });
        });
      })
      .catch((err) => {
        console.warn('[usePWA] SW registration failed:', err);
      });

    /* listen for controller change (after applyUpdate) */
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      setUpdateAvailable(false);
    });
  }, []);

  /* trigger install prompt */
  const installApp = async () => {
    if (!deferredPrompt.current) return;
    deferredPrompt.current.prompt();
    const { outcome } = await deferredPrompt.current.userChoice;
    if (outcome === 'accepted') {
      setIsInstalled(true);
      setCanInstall(false);
    }
    deferredPrompt.current = null;
  };

  /* skip waiting on the new SW and reload */
  const applyUpdate = () => {
    const reg = swRegistration.current;
    if (reg && reg.waiting) {
      reg.waiting.postMessage({ type: 'SKIP_WAITING' });
    }
    window.location.reload();
  };

  return { isInstalled, isOnline, canInstall, installApp, updateAvailable, applyUpdate };
}
