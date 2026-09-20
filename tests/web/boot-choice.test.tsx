// @vitest-environment jsdom
//
// chooseRoot — the pure boot-choice seam main.tsx mounts. Desktop (mode 'direct') must mount <App/>
// alone (byte-identical to today, no MobileEntry in the tree); the gateway bundle (mode 'tunnel') must
// mount <MobileEntry connectTransport={…}><App/></MobileEntry>, threading the boot's connectTransport.
// Asserts fail if reversed: a direct boot that wraps in MobileEntry, or a tunnel boot that drops it /
// loses the connectTransport / doesn't nest App inside.

import { cleanup, render } from '@testing-library/react'
import type { ReactElement } from 'react'
import { afterEach, describe, expect, test } from 'vitest'
import { chooseRoot } from '../../web/src/transport/boot-choice.js'
import type { BootResult, ConnectTransport } from '../../web/src/transport/boot-transport.js'

const App = () => <div data-testid="app">app-content</div>

let lastConnectTransport: ConnectTransport | null = null
const MobileEntry = ({
  connectTransport,
  children,
}: {
  connectTransport: ConnectTransport
  children: ReactElement
}) => {
  lastConnectTransport = connectTransport
  return <div data-testid="mobile-entry">{children}</div>
}

const noopConnect: ConnectTransport = async () => ({ ok: true })

afterEach(cleanup)

describe('chooseRoot', () => {
  test('mode direct mounts App alone — no MobileEntry wrapper', () => {
    lastConnectTransport = null
    const boot: BootResult = { mode: 'direct' }
    // scope queries to this render's own container so a sibling test's tree can't leak in.
    const { container } = render(chooseRoot(boot, App, MobileEntry))

    expect(container.querySelector('[data-testid="app"]')?.textContent).toBe('app-content')
    expect(container.querySelector('[data-testid="mobile-entry"]')).toBeNull()
    expect(lastConnectTransport).toBeNull() // MobileEntry never rendered
  })

  test('mode tunnel wraps App in MobileEntry and threads the boot connectTransport', () => {
    lastConnectTransport = null
    const boot: BootResult = { mode: 'tunnel', connectTransport: noopConnect }
    const { container } = render(chooseRoot(boot, App, MobileEntry))

    // MobileEntry is present and App is nested INSIDE it (not a sibling).
    const entry = container.querySelector('[data-testid="mobile-entry"]')
    expect(entry).not.toBeNull()
    expect(container.querySelector('[data-testid="app"]')).not.toBeNull()
    expect(entry?.querySelector('[data-testid="app"]')?.textContent).toBe('app-content')
    // the exact connectTransport from the boot result was handed to MobileEntry.
    expect(lastConnectTransport).toBe(noopConnect)
  })
})
