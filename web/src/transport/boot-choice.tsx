// The pure boot-choice seam, extracted from main.tsx so it's unit-testable (main.tsx itself only does
// DOM mount + createRoot, which is awkward to test). Given the BootResult, pick what React mounts:
//   - direct (desktop): <App/>, byte-identical to today — no MobileEntry, no tunnel code in the tree.
//   - tunnel (mobile bundle): <MobileEntry connectTransport={…}><App/></MobileEntry>, so the app only
//     reveals once the connect-flow has swapped in a TunnelTransport.
// App provides I18nProvider internally, so we never double-wrap here.

import type { ComponentType, ReactElement } from 'react'
import type { BootResult, ConnectTransport } from './boot-transport.js'

type AppComponent = ComponentType
type MobileEntryComponent = ComponentType<{
  connectTransport: ConnectTransport
  children: ReactElement
}>

export const chooseRoot = (
  boot: BootResult,
  App: AppComponent,
  MobileEntry: MobileEntryComponent
): ReactElement => {
  if (boot.mode === 'tunnel') {
    return (
      <MobileEntry connectTransport={boot.connectTransport}>
        <App />
      </MobileEntry>
    )
  }
  return <App />
}
