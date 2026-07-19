import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './styles/theme.css'   /* Brand CSS variables — must be first */
import './styles/global-overrides.css'
import './index.css'
import App from './App.jsx'

// In dev mode, unregister any stale service workers so Vite always serves fresh JS
if (import.meta.env.DEV && 'serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then((regs) => {
    regs.forEach((reg) => reg.unregister());
  });
}
import { AuthProvider } from '@/context/AuthContext'
import { ToastProvider } from './context/ToastContext'
import { FYProvider } from './context/FYContext'
import { FilterProvider } from './context/FilterContext'
import { initNative } from './mobile/native'

// Native shell setup (status bar, splash) — a no-op in the browser.
initNative();

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <ToastProvider>
          <FYProvider>
            <FilterProvider>
              <App />
            </FilterProvider>
          </FYProvider>
        </ToastProvider>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
)