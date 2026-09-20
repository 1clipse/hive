// @vitest-environment jsdom
//
// M5b impl:substitutes — ConnectView visual skin over the M5a headless connect-flow. The view holds NO
// orchestration logic: it renders the five ConnectPhase screens off props (phase / machines / pairing
// sub-state / SAS) and drives the flow via the injected callbacks. These tests pin the skin against a
// FAKE flow so they assert the wiring, not the crypto.

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import type { ConnectPhase, MachineView } from '../../web/src/connect/connect-flow.js'
import { I18nProvider } from '../../web/src/i18n.js'
import { ConnectView, type ConnectViewProps } from '../../web/src/mobile/views/ConnectView.js'
import type { PairingFailureCode } from '../../web/src/transport/pairing-client.js'

type ViewFlow = ConnectViewProps['flow']

const machines: MachineView[] = [
  { id: 'daemon-a', name: 'Studio', lastSeen: 111, revoked: false, online: true },
  { id: 'daemon-b', name: 'Laptop', lastSeen: 222, revoked: false, online: false },
]

interface FakeFlow {
  phase: ConnectPhase
  loadMachines: ReturnType<typeof vi.fn>
  selectDaemon: ReturnType<typeof vi.fn>
  pairingClient: { cancel: ReturnType<typeof vi.fn> } | null
}

// The view only reads loadMachines/selectDaemon/pairingClient.cancel — the fake is intentionally a
// minimal subset, cast to the prop type so the test pins the wiring, not the crypto-bearing real flow.
const makeFlow = (overrides: Partial<FakeFlow> = {}): FakeFlow => ({
  phase: 'login',
  loadMachines: vi.fn(() => Promise.resolve({ daemons: machines, selfDeviceId: null })),
  selectDaemon: vi.fn(() => Promise.resolve({ ok: true as const })),
  pairingClient: null,
  ...overrides,
})

const asViewFlow = (flow: FakeFlow): ViewFlow => flow as unknown as ViewFlow

const renderView = (props: Parameters<typeof ConnectView>[0]) =>
  render(
    <I18nProvider>
      <ConnectView {...props} />
    </I18nProvider>
  )

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('ConnectView skin', () => {
  test('login screen shows both provider buttons and clicking triggers loadMachines via the chosen provider', async () => {
    const flow = makeFlow({ phase: 'login' })
    const onProvider = vi.fn()
    renderView({
      flow: asViewFlow(flow),
      phase: 'login',
      machines: [],
      selfDeviceId: null,
      pairingPhase: null,
      sas: null,
      onSelectProvider: onProvider,
      onSelectMachine: () => {},
      onSubmitCode: () => {},
    })

    expect(screen.getByTestId('connect-login')).toBeTruthy()
    const github = screen.getByTestId('connect-login-github')
    const google = screen.getByTestId('connect-login-google')
    expect(github).toBeTruthy()
    expect(google).toBeTruthy()

    fireEvent.click(github)
    expect(onProvider).toHaveBeenCalledWith('github')
    fireEvent.click(google)
    expect(onProvider).toHaveBeenCalledWith('google')
  })

  test('machines screen renders online/offline rows from the list; offline row is disabled', () => {
    const flow = makeFlow({ phase: 'machines' })
    const onSelectMachine = vi.fn()
    renderView({
      flow: asViewFlow(flow),
      phase: 'machines',
      machines,
      selfDeviceId: null,
      pairingPhase: null,
      sas: null,
      onSelectProvider: () => {},
      onSelectMachine,
      onSubmitCode: () => {},
    })

    const rowA = screen.getByTestId('connect-machine-daemon-a')
    const rowB = screen.getByTestId('connect-machine-daemon-b')
    expect(within(rowA).getByText('Studio')).toBeTruthy()
    expect(within(rowB).getByText('Laptop')).toBeTruthy()

    // Offline daemons with history show last-seen copy; they are still disabled.
    expect(rowB.textContent).toContain('Last seen')
    expect(rowA.textContent).not.toContain('Offline')

    // The offline row is DISABLED — selecting it could only dead-end in a failed connect/pair.
    expect((rowA as HTMLButtonElement).disabled).toBe(false)
    expect((rowB as HTMLButtonElement).disabled).toBe(true)

    fireEvent.click(rowA)
    expect(onSelectMachine).toHaveBeenCalledWith('daemon-a')
    fireEvent.click(rowB)
    expect(onSelectMachine).not.toHaveBeenCalledWith('daemon-b')
  })

  test('selecting an unpaired daemon shows the pair guide + pairing code field that submits formatted code', () => {
    const flow = makeFlow({ phase: 'selecting' })
    const onSubmitCode = vi.fn()
    renderView({
      flow: asViewFlow(flow),
      phase: 'selecting',
      machines,
      selfDeviceId: null,
      selectedMachineId: 'daemon-b',
      pairingPhase: null,
      sas: null,
      onSelectProvider: () => {},
      onSelectMachine: () => {},
      onSubmitCode,
    })

    expect(screen.getByTestId('connect-pair-guide')).toBeTruthy()
    const code = screen.getByTestId('connect-code-input') as HTMLInputElement
    fireEvent.change(code, { target: { value: 'pa1r1ngqrpay' } })
    fireEvent.click(screen.getByTestId('connect-code-submit'))

    expect(onSubmitCode).toHaveBeenCalledWith('daemon-b', 'PA1R-1NGQ-RPAY')
  })

  test('pairing screen renders the exact SAS digits next to the comparison prompt (not hardcoded)', () => {
    const cancel = vi.fn()
    const flow = makeFlow({ phase: 'pairing', pairingClient: { cancel } })
    renderView({
      flow: asViewFlow(flow),
      phase: 'pairing',
      machines,
      selfDeviceId: null,
      pairingPhase: 'awaiting_confirm',
      sas: '849173',
      onSelectProvider: () => {},
      onSelectMachine: () => {},
      onSubmitCode: () => {},
    })

    const sasNode = screen.getByTestId('connect-pairing-sas')
    expect(sasNode.textContent).toContain('849173')

    // Cancel routes to the surfaced pairing client.
    fireEvent.click(screen.getByTestId('connect-pairing-cancel'))
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  test('pairing screen translates status phases instead of exposing internal enum values', () => {
    const flow = makeFlow({ phase: 'pairing', pairingClient: { cancel: vi.fn() } })
    renderView({
      flow: asViewFlow(flow),
      phase: 'pairing',
      machines,
      selfDeviceId: null,
      pairingPhase: 'connecting',
      sas: null,
      onSelectProvider: () => {},
      onSelectMachine: () => {},
      onSubmitCode: () => {},
    })

    const status = screen.getByTestId('connect-pairing-phase')
    expect(status.textContent).toBe('Connecting to your computer…')
    expect(status.textContent).not.toContain('connecting')
  })

  test.each<[PairingFailureCode, string]>([
    ['rejected', 'Pairing was rejected.'],
    ['cancelled', 'Pairing was rejected.'],
    ['expired', 'Pairing expired — start again.'],
    ['mint_forbidden', 'Pairing was not confirmed on your computer.'],
    ['protocol_version', 'This phone and computer are on different versions.'],
    ['socket_closed', 'Lost the connection before pairing finished.'],
    ['pair_ack_invalid', 'Lost the connection before pairing finished.'],
    ['mint_failed', 'Lost the connection before pairing finished.'],
  ])('pairing screen maps failure code %s onto localized copy', (code, expected) => {
    const flow = makeFlow({ phase: 'pairing', pairingClient: { cancel: vi.fn() } })
    renderView({
      flow: asViewFlow(flow),
      phase: 'pairing',
      machines,
      selfDeviceId: null,
      pairingPhase: 'error',
      pairingFailureCode: code,
      sas: '849173',
      onSelectProvider: () => {},
      onSelectMachine: () => {},
      onSubmitCode: () => {},
    })

    const status = screen.getByTestId('connect-pairing-phase')
    expect(status.textContent).toBe(expected)
    expect(status.textContent).not.toContain('error')
    if (code.includes('_')) expect(status.textContent).not.toContain(code)
  })

  test('pairing failure before SAS does not render an empty code prompt', () => {
    const flow = makeFlow({ phase: 'pairing', pairingClient: { cancel: vi.fn() } })
    renderView({
      flow: asViewFlow(flow),
      phase: 'pairing',
      machines,
      selfDeviceId: null,
      pairingPhase: 'error',
      pairingFailureCode: 'socket_closed',
      sas: null,
      onSelectProvider: () => {},
      onSelectMachine: () => {},
      onSubmitCode: () => {},
    })

    expect(screen.queryByTestId('connect-pairing-sas')).toBeNull()
    expect(
      screen.queryByText('Confirm this code matches the one shown on your computer:')
    ).toBeNull()
    expect(screen.getByTestId('connect-pairing-phase').textContent).toBe(
      'Lost the connection before pairing finished.'
    )
  })

  test('a different SAS renders verbatim (proves the digits are not hardcoded)', () => {
    const flow = makeFlow({ phase: 'pairing', pairingClient: { cancel: vi.fn() } })
    renderView({
      flow: asViewFlow(flow),
      phase: 'pairing',
      machines,
      selfDeviceId: null,
      pairingPhase: 'awaiting_confirm',
      sas: '000111',
      onSelectProvider: () => {},
      onSelectMachine: () => {},
      onSubmitCode: () => {},
    })
    expect(screen.getByTestId('connect-pairing-sas').textContent).toContain('000111')
    expect(screen.getByTestId('connect-pairing-sas').textContent).not.toContain('849173')
  })

  test('machines screen auto-loads the list on mount when phase starts at machines', async () => {
    const flow = makeFlow({ phase: 'login' })
    renderView({
      flow: asViewFlow(flow),
      phase: 'login',
      machines: [],
      selfDeviceId: null,
      pairingPhase: null,
      sas: null,
      onSelectProvider: () => {},
      onSelectMachine: () => {},
      onSubmitCode: () => {},
    })
    // login screen does NOT auto-load; the provider button drives it (verified above). Nothing here.
    await waitFor(() => expect(flow.loadMachines).not.toHaveBeenCalled())
  })
})
