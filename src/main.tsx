import 'core-js/actual/array/at'
import { lazy, StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import AccessGate from './components/AccessGate'
import 'streamdown/styles.css'
import './index.css'
import { installMobileViewportGuards } from './lib/viewport'
import { requestPersistentBrowserStorage } from './lib/apiCredentialStorage'

const App = lazy(() => import('./App'))

document.documentElement.classList.add('dark')
installMobileViewportGuards()
requestPersistentBrowserStorage()

if ('serviceWorker' in navigator) {
  if (import.meta.env.PROD) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch((error) => {
        console.error('Service worker registration failed:', error)
      })
    })
  } else {
    navigator.serviceWorker.getRegistrations().then((registrations) => {
      registrations.forEach((registration) => registration.unregister())
    })
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AccessGate>
      <Suspense fallback={<div className="min-h-[100dvh] bg-[#080a0f]" />}>
        <App />
      </Suspense>
    </AccessGate>
  </StrictMode>,
)
