import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import './styles/globals.css'
import { App } from './app.js'
import { MobileEntry } from './mobile/entry-mobile.js'
import { registerServiceWorker } from './pwa/register-service-worker.js'
import { chooseRoot } from './transport/boot-choice.js'
import { bootTransport } from './transport/boot-transport.js'
import { setConnectionStatus } from './transport/connection-status-store.js'
import { mobileResolveSession } from './transport/mobile-resolve-session.js'

const container = document.getElementById('root')

if (!container) {
  throw new Error('Root element not found')
}

// Desktop (loopback / no gateway flag) -> mode 'direct' -> <App/>, byte-identical to today. Gateway
// bundle -> mode 'tunnel' -> <MobileEntry> over <App/>, with the relay-token-backed resolveSession.
const boot = bootTransport({ resolveSession: mobileResolveSession, onStatus: setConnectionStatus })

createRoot(container).render(<StrictMode>{chooseRoot(boot, App, MobileEntry)}</StrictMode>)

void registerServiceWorker()
