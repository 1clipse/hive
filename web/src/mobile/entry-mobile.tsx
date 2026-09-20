import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  type ConnectFlow,
  type ConnectFlowDeps,
  type ConnectPhase,
  createConnectFlow,
  type MachineView,
} from '../connect/connect-flow.js'
import { buildPairingPayloadFromCode } from '../connect/pair-code.js'
import { createDeviceSessionStore } from '../transport/device-session-store.js'
import type { PairingFailureCode, PairingPhase } from '../transport/pairing-client.js'
import { isGatewayServedBundle } from '../transport/select-transport.js'
import { type ConnectErrorCode, ConnectView } from './views/ConnectView.js'

// Derive a friendly, ASCII-safe device name from navigator.userAgent/platform (≤48 chars).
// Examples: 'iPhone · Safari', 'Android · Chrome', 'iPad · Safari', fallback 'Phone'.
const deriveDeviceName = (): string => {
  if (typeof navigator === 'undefined') return 'Phone'
  const ua = navigator.userAgent ?? ''
  let device = 'Phone'
  if (/iPad/.test(ua)) device = 'iPad'
  else if (/iPhone/.test(ua)) device = 'iPhone'
  else if (/Android/.test(ua)) device = 'Android'
  let browser = 'Browser'
  if (/EdgA?\//.test(ua)) browser = 'Edge'
  else if (/SamsungBrowser\//.test(ua)) browser = 'Samsung'
  else if (/OPR\/|OPT\//.test(ua)) browser = 'Opera'
  else if (/Firefox\//.test(ua)) browser = 'Firefox'
  else if (/Chrome\//.test(ua)) browser = 'Chrome'
  else if (/Safari\//.test(ua)) browser = 'Safari'
  const name = `${device} \xB7 ${browser}`
  return name.slice(0, 48)
}

export interface MobileEntryProps {
  /** The live app to reveal once a tunnel is connected (the gateway bundle's <App/>). */
  children: ReactNode
  /** Builds the TunnelTransport for a selected/paired daemon and swaps it in (boot-transport seam). */
  connectTransport: ConnectFlowDeps['connectTransport']
  /** Injected for tests; defaults to the real createConnectFlow. */
  createFlow?: (deps: ConnectFlowDeps) => ConnectFlow
  /** Injected for tests; defaults to a localStorage-backed device session store. */
  store?: ConnectFlowDeps['store']
  gatewayBaseUrl?: string
  /** Injected for tests; defaults to isGatewayServedBundle. */
  isGateway?: () => boolean
}

/**
 * The gateway-bundle mobile entry. It mounts the ConnectView over the headless connect-flow and only
 * reveals the app `children` once the flow reports the 'connected' phase (the transport is swapped in
 * by then). The desktop entry never imports this — main.tsx mounts <App/> directly on the loopback
 * origin. All orchestration is the flow's; this component just relays callbacks into view state.
 */
export const MobileEntry = ({
  children,
  connectTransport,
  createFlow = createConnectFlow,
  store,
  gatewayBaseUrl,
  isGateway = isGatewayServedBundle,
}: MobileEntryProps) => {
  const isGatewayBundle = isGateway()
  const [phase, setPhase] = useState<ConnectPhase>('login')
  const [machines, setMachines] = useState<MachineView[]>([])
  const [selfDeviceId, setSelfDeviceId] = useState<string | null>(null)
  const [selectedMachineId, setSelectedMachineId] = useState<string | undefined>(undefined)
  const [pairingPhase, setPairingPhase] = useState<PairingPhase | null>(null)
  const [pairingFailureCode, setPairingFailureCode] = useState<PairingFailureCode | null>(null)
  // Pre-pairing connect failure (reconnect failed / bad pairing code) shown on the machines & selecting
  // screens — previously these were swallowed (a void selectDaemon / a silent return on a bad code).
  const [connectError, setConnectError] = useState<ConnectErrorCode | null>(null)
  const [sas, setSas] = useState<string | null>(null)
  // Loading / busy flags to prevent double-taps and give the user feedback during async transitions.
  const [isSigningIn, setIsSigningIn] = useState(false)
  const [pendingMachineId, setPendingMachineId] = useState<string | null>(null)
  // J3: inline error for non-401 failures on the login screen.
  const [loginError, setLoginError] = useState(false)
  // J2: on mount, attempt to detect an existing session before showing the login screen.
  const [checkingSession, setCheckingSession] = useState(true)

  const flow = useMemo(
    () =>
      createFlow({
        store: store ?? createDeviceSessionStore(),
        connectTransport,
        ...(gatewayBaseUrl ? { gatewayBaseUrl } : {}),
        proposedName: deriveDeviceName(),
        onPhase: setPhase,
        onPairingPhase: (next) => {
          setPairingPhase(next)
          if (next !== 'error' && next !== 'expired' && next !== 'rejected') {
            setPairingFailureCode(null)
          }
        },
        onPairingSas: setSas,
        onPairingFailure: (failure) => setPairingFailureCode(failure.code),
      }),
    [createFlow, store, connectTransport, gatewayBaseUrl]
  )
  const flowRef = useRef(flow)
  flowRef.current = flow
  const actionSeqRef = useRef(0)

  const clearPairingState = useCallback((): void => {
    setPairingPhase(null)
    setPairingFailureCode(null)
    setSas(null)
  }, [])
  const nextActionSeq = useCallback((): number => {
    actionSeqRef.current += 1
    return actionSeqRef.current
  }, [])
  const isCurrentAction = useCallback((seq: number): boolean => actionSeqRef.current === seq, [])

  // J2: on mount, probe for an existing session; if machines load, advance automatically.
  useEffect(() => {
    let cancelled = false
    void flowRef.current
      .loadMachines()
      .then(({ daemons, selfDeviceId: self }) => {
        if (cancelled) return
        // loadMachines sets phase to 'machines' on success (or 'login' on 401 which triggers redirect).
        // Either way we just let the normal phase state drive the view.
        setMachines(daemons)
        setSelfDeviceId(self)
      })
      .catch(() => {
        // Non-401 error on the session probe — stay on login, no error shown (it's a probe).
      })
      .finally(() => {
        if (!cancelled) setCheckingSession(false)
      })
    return () => {
      cancelled = true
    }
    // run once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onRefreshMachines = useCallback((): void => {
    const seq = nextActionSeq()
    setConnectError(null)
    clearPairingState()
    setIsSigningIn(true)
    void flowRef.current
      .loadMachines()
      .then(({ daemons, selfDeviceId: self }) => {
        if (!isCurrentAction(seq)) return
        setMachines(daemons)
        setSelfDeviceId(self)
      })
      .finally(() => {
        if (isCurrentAction(seq)) setIsSigningIn(false)
      })
  }, [clearPairingState, isCurrentAction, nextActionSeq])

  const onSelectProvider = useCallback(
    (provider: 'github' | 'google') => {
      const seq = nextActionSeq()
      // Pass the CHOSEN provider through to loadMachines — the OAuth bounce uses /auth/<provider>. Without
      // this the flow stayed on its default ('github') and "Continue with Google" silently used GitHub.
      setConnectError(null)
      clearPairingState()
      setLoginError(false)
      setIsSigningIn(true)
      void flowRef.current
        .loadMachines(provider)
        .then(({ daemons, selfDeviceId: self }) => {
          if (!isCurrentAction(seq)) return
          setMachines(daemons)
          setSelfDeviceId(self)
        })
        .catch(() => {
          if (!isCurrentAction(seq)) return
          // J3: non-401 failure (401 already redirects via the flow) — show inline error.
          setLoginError(true)
        })
        .finally(() => {
          if (isCurrentAction(seq)) setIsSigningIn(false)
        })
    },
    [clearPairingState, isCurrentAction, nextActionSeq]
  )

  const onSelectMachine = useCallback(
    (daemonId: string): void => {
      const seq = nextActionSeq()
      setSelectedMachineId(daemonId)
      setConnectError(null)
      clearPairingState()
      setPendingMachineId(daemonId)
      void (async () => {
        const result = await flowRef.current.selectDaemon(daemonId)
        if (!isCurrentAction(seq)) return
        setPendingMachineId(null)
        // 'needs_pairing' just moved us to the QR guide (benign). 'select_failed' = a reconnect that
        // should have worked didn't (stale session / daemon offline / tunnel-ready timeout) — surface it
        // instead of dumping the user on the pairing page with no explanation.
        // 'relay_revoked' = 403 from relay-token; stored record already cleared, show revoked copy.
        if (!result.ok && result.failure.code === 'select_failed') setConnectError('select_failed')
        if (!result.ok && result.failure.code === 'relay_revoked') setConnectError('relay_revoked')
      })()
    },
    [clearPairingState, isCurrentAction, nextActionSeq]
  )

  const onSubmitCode = useCallback(
    (daemonId: string, code: string): void => {
      const seq = nextActionSeq()
      // Code-only pairing: the user picked a machine row, then types the short code shown on that
      // computer. The code derives the pairing secret (SHA-256), and the daemon is the SELECTED row —
      // there's no QR/deeplink carrying a daemon id, so no payload-vs-row mismatch to guard against.
      setConnectError(null)
      clearPairingState()
      void (async () => {
        const payload = await buildPairingPayloadFromCode({
          code,
          daemonId,
          gatewayUrl: gatewayBaseUrl ?? window.location.origin,
        })
        if (!isCurrentAction(seq)) return
        if (!payload) {
          // A malformed / short code used to make the button look dead (silent return). Tell the user.
          setConnectError('invalid_code')
          return
        }
        const result = await flowRef.current.selectDaemon(daemonId, payload)
        if (!isCurrentAction(seq)) return
        if (!result.ok && result.failure.code === 'select_failed') setConnectError('select_failed')
        if (!result.ok && result.failure.code === 'relay_revoked') setConnectError('relay_revoked')
      })()
    },
    [clearPairingState, gatewayBaseUrl, isCurrentAction, nextActionSeq]
  )

  const onCancelPairing = useCallback((): void => {
    nextActionSeq()
    flowRef.current.pairingClient?.cancel()
    clearPairingState()
    setConnectError(null)
    setPhase(selectedMachineId ? 'selecting' : 'machines')
  }, [clearPairingState, nextActionSeq, selectedMachineId])

  const onGoBack = useCallback((): void => {
    nextActionSeq()
    setConnectError(null)
    clearPairingState()
    // J8: clear stale code when going back — the ConnectView holds its own 'code' state;
    // we can't clear it from here directly, but we also need to reset the phase so a fresh
    // instance of the selecting screen mounts (clearing useState('') naturally).
    setPhase('machines')
  }, [clearPairingState, nextActionSeq])

  // S3: collapse intermediate pairing-step entries from the history stack so the back button
  // doesn't dump the user back onto the gateway's /pair page from the connected app.
  if (phase === 'connected') {
    if (typeof history !== 'undefined') {
      history.replaceState(null, '', '/app')
    }
    return <>{children}</>
  }

  // J2: while probing for an existing session, show a branded pulse instead of
  // the login screen — this is the first frame of every cold open, it should
  // look like Hive, not a stray ellipsis.
  if (checkingSession) {
    return (
      <div className="connect-screen flex min-h-full flex-col items-center justify-center gap-3 p-6">
        <img
          src={isGatewayBundle ? '/brand/icon-192.png' : '/logo.png'}
          width={56}
          height={56}
          alt=""
          className="animate-pulse"
        />
        <span className="sr-only" aria-live="polite">
          …
        </span>
      </div>
    )
  }

  return (
    <ConnectView
      flow={flow}
      phase={phase}
      machines={machines}
      selfDeviceId={selfDeviceId}
      {...(selectedMachineId ? { selectedMachineId } : {})}
      pairingPhase={pairingPhase}
      pairingFailureCode={pairingFailureCode}
      connectError={connectError}
      sas={sas}
      isSigningIn={isSigningIn}
      pendingMachineId={pendingMachineId}
      loginError={loginError}
      isGatewayBundle={isGatewayBundle}
      onRefreshMachines={onRefreshMachines}
      onSelectProvider={onSelectProvider}
      onSelectMachine={onSelectMachine}
      onSubmitCode={onSubmitCode}
      onCancelPairing={onCancelPairing}
      onGoBack={onGoBack}
    />
  )
}
