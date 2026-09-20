import { ChevronLeft, ChevronRight, Laptop, RefreshCw } from 'lucide-react'
import { useRef, useState } from 'react'
import { PAIRING_CODE_ALPHABET } from '../../../../src/shared/remote-pairing-code.js'
import type { ConnectFlow, ConnectPhase, MachineView } from '../../connect/connect-flow.js'
import { type TranslationKey, useI18n } from '../../i18n.js'
import type { PairingFailureCode, PairingPhase } from '../../transport/pairing-client.js'

const pairingFailureKey = (code: PairingFailureCode | null | undefined): TranslationKey | null => {
  switch (code) {
    case 'rejected':
    case 'cancelled':
      return 'pairing.failed.rejected'
    case 'expired':
      return 'pairing.failed.expired'
    case 'mint_forbidden':
      return 'pairing.failed.mintForbidden'
    case 'protocol_version':
      return 'pairing.failed.version'
    case 'socket_closed':
    case 'pair_ack_invalid':
    case 'mint_failed':
      return 'pairing.failed.socket'
    default:
      return null
  }
}

const pairingStatusKey = (
  phase: PairingPhase | null,
  failureCode: PairingFailureCode | null | undefined
): TranslationKey | null => {
  const failure = pairingFailureKey(failureCode)
  if (failure) return failure
  switch (phase) {
    case 'connecting':
      return 'pairing.connecting'
    case 'handshaking':
    case 'minting':
      return 'pairing.handshaking'
    case 'awaiting_confirm':
      return null // SAS screen shows its own instruction — no redundant status line
    case 'paired':
      return 'pairing.paired'
    case 'rejected':
      return 'pairing.failed.rejected'
    case 'expired':
      return 'pairing.failed.expired'
    case 'error':
      return 'pairing.failed.socket'
    default:
      return null
  }
}

// Pre-pairing connect failures the entry surfaces on the machines/selecting screens (distinct from
// pairing-ceremony failures, which render on the SAS screen). 'select_failed' = a reconnect that
// should have worked didn't; 'invalid_code' = the pasted pairing code didn't parse.
// 'relay_revoked' = 403 from relay-token; the daemon revoked the device (stored record was cleared).
export type ConnectErrorCode = 'select_failed' | 'invalid_code' | 'relay_revoked'

const connectErrorKey = (code: ConnectErrorCode | null | undefined): TranslationKey | null => {
  if (code === 'select_failed') return 'connect.error.selectFailed'
  if (code === 'invalid_code') return 'connect.error.invalidCode'
  if (code === 'relay_revoked') return 'connect.machines.revokedHint'
  return null
}

// Small inline relative-time formatter — avoids adding a dependency just for this.
// Returns null for under-a-minute so callers can special-case it with 'activeNow'-style keys.
const relativeTime = (ts: number): string | null => {
  const seconds = Math.floor((Date.now() - ts) / 1000)
  if (seconds < 60) return null
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  return `${days}d`
}

// Normalisation map: chars that normalize to valid alphabet equivalents (per normalizePairingCode).
const NORMALISE: Record<string, string> = { O: '0', I: '1', L: '1' }

// Live-format code as the user types: inject dashes at groups of 4. normalizePairingCode strips them
// back out before submission, so this is purely cosmetic / a typing aid.
// Only characters in PAIRING_CODE_ALPHABET (after normalisation) are kept — J7.
const liveFormatCode = (raw: string): string => {
  const upper = raw.toUpperCase()
  let stripped = ''
  for (const ch of upper) {
    const norm = NORMALISE[ch] ?? ch
    if (PAIRING_CODE_ALPHABET.includes(norm)) {
      stripped += norm
      if (stripped.length === 12) break
    }
  }
  const groups: string[] = []
  for (let i = 0; i < stripped.length; i += 4) {
    groups.push(stripped.slice(i, i + 4))
  }
  return groups.join('-')
}

// Whether the pairing phase is past awaiting_confirm (desktop confirmed, minting/connecting in
// progress or done). Used for J1: swap instruction → finalizing message and hide Cancel.
const isPostConfirm = (phase: PairingPhase | null): boolean =>
  phase === 'minting' || phase === 'paired'

export interface ConnectViewProps {
  /** The headless flow; the view holds NO orchestration logic, it only drives + reads this. */
  flow: Pick<ConnectFlow, 'loadMachines' | 'selectDaemon' | 'pairingClient'>
  /** Current high-level phase (mirrors flow.phase; held by the entry so React re-renders on change). */
  phase: ConnectPhase
  machines: MachineView[]
  selfDeviceId: string | null
  /** Set once the user picks a daemon that needs pairing. */
  selectedMachineId?: string
  /** Pairing sub-state surfaced from the pairing client (null outside a ceremony). */
  pairingPhase: PairingPhase | null
  /** Terminal failure code surfaced from the pairing client, when available. */
  pairingFailureCode?: PairingFailureCode | null
  /** Pre-pairing connect failure (reconnect failed / bad code) shown on the machines & selecting screens. */
  connectError?: ConnectErrorCode | null
  /** The 6-digit SAS to compare against the desktop (null until awaiting_confirm). */
  sas: string | null
  /** True while OAuth + loadMachines() is in-flight — prevents double-tap and shows a spinner. */
  isSigningIn?: boolean
  /** Machine id currently being connected — that row shows a spinner and all rows are disabled. */
  pendingMachineId?: string | null
  /** Inline error surfaced on the login screen for non-401 failures (J3). */
  loginError?: boolean
  /** True when running on the gateway origin (enables gateway-only UI like Manage devices link). */
  isGatewayBundle?: boolean
  /** Refresh machines list (J4). */
  onRefreshMachines?: () => void
  /** Chosen at login; the entry maps it to the gateway OAuth provider, then loads machines. */
  onSelectProvider: (provider: 'github' | 'google') => void
  onSelectMachine: (daemonId: string) => void
  onSubmitCode: (daemonId: string, code: string) => void
  onCancelPairing?: () => void
  /** Returns from the selecting/pairing code screen back to the machine list. */
  onGoBack?: () => void
}

// Shared full-height wrapper: each phase fills the viewport so content isn't stranded at the top.
const Screen = ({
  children,
  className = '',
  testId,
}: {
  children: React.ReactNode
  className?: string
  testId?: string
}) => (
  <div data-testid={testId} className={`connect-screen flex min-h-full flex-col p-6 ${className}`}>
    {children}
  </div>
)

// Full-width tap-target button (≥44px) used across all connect screens.
const BigButton = ({
  primary,
  children,
  disabled,
  onClick,
  testId,
  type = 'button',
}: {
  primary?: boolean
  children: React.ReactNode
  disabled?: boolean
  onClick?: () => void
  testId?: string
  type?: 'button' | 'submit'
}) => (
  <button
    type={type}
    data-testid={testId}
    disabled={disabled}
    onClick={onClick}
    className="flex w-full items-center justify-center rounded-lg px-4 text-sm font-semibold transition-colors"
    style={{
      minHeight: '44px',
      background: primary ? 'var(--accent)' : 'var(--bg-2)',
      color: primary ? '#ffffff' : 'var(--text-secondary)',
      border: `1px solid ${primary ? 'var(--accent)' : 'var(--border-bright)'}`,
      opacity: disabled ? 0.4 : 1,
      cursor: disabled ? 'not-allowed' : 'pointer',
    }}
  >
    {children}
  </button>
)

/**
 * The visual skin over the M5a connect-flow state machine. Five screens keyed off ConnectPhase:
 *   login → machines → selecting (pair guide + code entry) → pairing (SAS) → connected (unmounts).
 * No crypto, no fetch — every transition is driven through the injected callbacks / flow methods.
 */
export const ConnectView = ({
  flow,
  phase,
  machines,
  selectedMachineId,
  pairingPhase,
  pairingFailureCode,
  connectError,
  sas,
  isSigningIn = false,
  pendingMachineId,
  loginError = false,
  isGatewayBundle = false,
  onRefreshMachines,
  onSelectProvider,
  onSelectMachine,
  onSubmitCode,
  onCancelPairing,
  onGoBack,
}: ConnectViewProps) => {
  const { t } = useI18n()
  const [code, setCode] = useState('')
  const submitInFlight = useRef(false)
  const statusKey = pairingStatusKey(pairingPhase, pairingFailureCode)
  const connectErrorKeyResolved = connectErrorKey(connectError)
  const isFailure = pairingFailureKey(pairingFailureCode) != null
  // J1: once the desktop confirms, transition to a finalizing message and hide Cancel.
  const postConfirm = isPostConfirm(pairingPhase)
  const showSas =
    sas != null && sas.length > 0 && (pairingPhase === 'awaiting_confirm' || postConfirm)

  const handleCodeChange = (raw: string) => {
    const formatted = liveFormatCode(raw)
    setCode(formatted)
    // J6: auto-submit on the 12th valid char, guard double-submit.
    const bare = formatted.replace(/-/g, '')
    if (bare.length === 12 && selectedMachineId && !submitInFlight.current) {
      submitInFlight.current = true
      onSubmitCode(selectedMachineId, formatted.trim())
    }
  }

  // J6: button requires exactly 12 valid chars.
  const codeComplete = code.replace(/-/g, '').length === 12
  const canSubmit = !!selectedMachineId && codeComplete

  // The bird ships at different paths per origin: the gateway worker serves
  // /brand/* from baked bytes; the local daemon serves the vite public dir.
  const brandSrc = isGatewayBundle ? '/brand/icon-192.png' : '/logo.png'

  if (phase === 'login') {
    return (
      <Screen testId="connect-login" className="justify-center gap-6">
        {/* Brand hero — same composition as the gateway sign-in page. */}
        <div className="mb-2 flex flex-col items-center gap-3 text-center">
          <img
            src={brandSrc}
            width={72}
            height={72}
            alt=""
            style={{ filter: 'drop-shadow(0 8px 28px rgba(51,88,212,.38))' }}
          />
          <span
            className="text-2xl font-bold tracking-tight"
            style={{ color: 'var(--text-primary)' }}
          >
            Hive
          </span>
        </div>
        <div className="text-center">
          <h1 className="text-xl font-semibold text-pri">{t('connect.login.heading')}</h1>
          <p className="mt-2 text-sm text-ter">{t('connect.login.subtitle')}</p>
        </div>
        {/* J3: inline error for non-401 failures */}
        {loginError ? (
          <p
            data-testid="connect-login-error"
            className="rounded-lg px-3 py-2 text-center text-sm"
            style={{
              background: 'color-mix(in oklab, var(--status-red) 12%, transparent)',
              color: 'var(--status-red)',
            }}
          >
            {t('connect.login.failed')}
          </p>
        ) : null}
        <div className="flex flex-col gap-3">
          {isSigningIn ? (
            <div
              className="flex items-center justify-center text-sm text-ter"
              style={{ minHeight: '44px' }}
            >
              {t('connect.login.signingIn')}
            </div>
          ) : (
            <>
              <BigButton
                primary
                testId="connect-login-github"
                onClick={() => onSelectProvider('github')}
              >
                {t('connect.login.github')}
              </BigButton>
              <BigButton testId="connect-login-google" onClick={() => onSelectProvider('google')}>
                {t('connect.login.google')}
              </BigButton>
            </>
          )}
        </div>
      </Screen>
    )
  }

  if (phase === 'machines') {
    const isBusy = pendingMachineId != null
    return (
      <Screen testId="connect-machines" className="gap-4">
        {/* Brand strip + heading row. The refresh affordance lives here for
            EVERY state — a stale list was previously only refreshable when it
            was already empty. */}
        <div className="flex items-center gap-2">
          <img src={brandSrc} width={20} height={20} alt="" className="shrink-0" />
          <span className="text-sm font-semibold text-sec">Hive</span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <h1 className="text-xl font-semibold text-pri">{t('connect.machines.heading')}</h1>
          {onRefreshMachines ? (
            <button
              type="button"
              aria-label={t('common.refresh')}
              data-testid="connect-machines-refresh"
              onClick={onRefreshMachines}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-sec"
              style={{ background: 'var(--bg-2)', border: '1px solid var(--border-bright)' }}
            >
              <RefreshCw size={16} aria-hidden />
            </button>
          ) : null}
        </div>
        {connectErrorKeyResolved ? (
          <p
            data-testid="connect-error"
            className="rounded-lg px-3 py-2 text-sm"
            style={{
              background: 'color-mix(in oklab, var(--status-red) 12%, transparent)',
              color: 'var(--status-red)',
            }}
          >
            {t(connectErrorKeyResolved)}
          </p>
        ) : null}
        {machines.length === 0 ? (
          // J4: empty state — centered, with the way forward spelled out.
          <div className="flex flex-1 flex-col items-center justify-center gap-4 px-4 text-center">
            <span
              className="flex h-16 w-16 items-center justify-center rounded-2xl"
              style={{
                background: 'color-mix(in oklab, var(--accent) 12%, transparent)',
                color: 'var(--accent-hover, var(--accent))',
              }}
              aria-hidden
            >
              <Laptop size={28} />
            </span>
            <p data-testid="connect-machines-empty" className="max-w-[280px] text-sm text-ter">
              {t('connect.machines.empty')}
            </p>
            <div className="flex w-full max-w-[320px] flex-col gap-3 pt-2">
              <BigButton
                testId="connect-machines-back"
                {...(onGoBack ? { onClick: onGoBack } : {})}
              >
                {t('connect.machines.back')}
              </BigButton>
            </div>
          </div>
        ) : (
          <ul className="flex flex-col gap-2.5">
            {machines.map((m) => {
              const isPending = pendingMachineId === m.id
              // Revoked and offline machines can't establish a connection — disable both.
              const isDisabled = !m.online || m.revoked || isBusy

              let statusLabel: string
              let statusColor = 'var(--text-tertiary)'
              if (m.revoked) {
                statusLabel = t('connect.machines.revoked')
                statusColor = 'var(--status-red)'
              } else if (!m.online) {
                const ago = m.lastSeen != null ? relativeTime(m.lastSeen) : null
                statusLabel =
                  ago != null
                    ? t('connect.machines.lastSeen', { ago })
                    : t('connect.machines.offline')
              } else if (isPending) {
                statusLabel = t('connect.machines.connecting')
                statusColor = 'var(--text-secondary)'
              } else {
                statusLabel = t('connect.machines.online')
                statusColor = 'var(--status-green)'
              }

              const dotColor = m.revoked
                ? 'var(--status-red)'
                : m.online
                  ? 'var(--status-green)'
                  : 'var(--text-tertiary)'

              return (
                <li key={m.id}>
                  <button
                    type="button"
                    data-testid={`connect-machine-${m.id}`}
                    className="flex w-full items-center gap-3 rounded-xl border px-3.5 py-3 text-left transition-colors"
                    style={{
                      minHeight: '64px',
                      borderColor: 'var(--border-bright)',
                      background: isPending ? 'var(--bg-2)' : 'var(--bg-1)',
                      opacity: isDisabled && !isPending ? 0.55 : 1,
                      cursor: isDisabled ? 'not-allowed' : 'pointer',
                    }}
                    disabled={isDisabled}
                    aria-disabled={isDisabled}
                    onClick={() => onSelectMachine(m.id)}
                  >
                    {/* Identity tile + live dot pinned to its corner. */}
                    <span className="relative shrink-0" aria-hidden>
                      <span
                        className="flex h-10 w-10 items-center justify-center rounded-lg"
                        style={{
                          background: 'color-mix(in oklab, var(--accent) 12%, transparent)',
                          color: 'var(--accent-hover, var(--accent))',
                        }}
                      >
                        <Laptop size={20} />
                      </span>
                      <span
                        className="absolute -right-0.5 -bottom-0.5 h-3 w-3 rounded-full border-2"
                        style={{ background: dotColor, borderColor: 'var(--bg-1)' }}
                      />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[15px] font-medium text-pri">
                        {m.name}
                      </span>
                      <span className="mt-0.5 block text-xs" style={{ color: statusColor }}>
                        {statusLabel}
                      </span>
                    </span>
                    {isPending ? (
                      /* Simple CSS spinner — no extra dep */
                      <span
                        aria-hidden
                        className="h-4 w-4 shrink-0 animate-spin rounded-full border-2"
                        style={{
                          borderColor: 'var(--border-bright)',
                          borderTopColor: 'var(--accent)',
                        }}
                      />
                    ) : isDisabled ? null : (
                      <ChevronRight size={18} className="shrink-0 text-ter" aria-hidden />
                    )}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
        {isGatewayBundle ? (
          <div className="mt-auto pt-4 text-center">
            <a
              href="/machines"
              className="text-xs underline-offset-2 hover:underline"
              style={{ color: 'var(--text-tertiary)' }}
            >
              {t('connect.machines.manageDevices')}
            </a>
          </div>
        ) : null}
      </Screen>
    )
  }

  if (phase === 'selecting') {
    const selectedMachine = machines.find((m) => m.id === selectedMachineId)
    return (
      <Screen testId="connect-pair-guide" className="gap-4">
        {/* Back affordance */}
        <button
          type="button"
          className="-ml-2 flex items-center gap-1 self-start rounded-md px-2 text-sm text-sec"
          style={{ minHeight: '44px' }}
          onClick={onGoBack}
        >
          <ChevronLeft size={16} aria-hidden />
          {t('connect.pair.back')}
        </button>
        <div>
          <h1 className="text-xl font-semibold text-pri">{t('connect.pair.guideHeading')}</h1>
          {selectedMachine ? (
            <p className="mt-1 flex items-center gap-1.5 text-sm text-ter">
              <Laptop size={14} aria-hidden className="shrink-0" />
              <span className="truncate">{selectedMachine.name}</span>
            </p>
          ) : null}
        </div>
        {connectErrorKeyResolved ? (
          <p
            data-testid="connect-error"
            className="rounded-lg px-3 py-2 text-sm"
            style={{
              background: 'color-mix(in oklab, var(--status-red) 12%, transparent)',
              color: 'var(--status-red)',
            }}
          >
            {t(connectErrorKeyResolved)}
          </p>
        ) : null}
        {/* Numbered step badges — same treatment as the gateway /pair page. */}
        <ol className="flex flex-col gap-3">
          {(
            [
              'connect.pair.guideStep1',
              'connect.pair.guideStep2',
              'connect.pair.guideStep3',
            ] as const
          ).map((key, index) => (
            <li key={key} className="flex items-start gap-3 text-sm text-sec">
              <span
                aria-hidden
                className="mt-px flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-lg text-xs font-semibold"
                style={{
                  background: 'color-mix(in oklab, var(--accent) 13%, transparent)',
                  border: '1px solid color-mix(in oklab, var(--accent) 34%, transparent)',
                  color: 'var(--accent-hover)',
                }}
              >
                {index + 1}
              </span>
              <span className="min-w-0 leading-relaxed">{t(key)}</span>
            </li>
          ))}
        </ol>
        <label className="flex flex-col gap-2 text-xs uppercase tracking-wider text-ter">
          {t('connect.pair.qrLabel')}
          <input
            type="text"
            data-testid="connect-code-input"
            className="input mono text-center"
            inputMode="text"
            autoCapitalize="characters"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            placeholder="XXXX-XXXX-XXXX"
            maxLength={14} /* 12 chars + 2 dashes */
            value={code}
            onChange={(e) => {
              submitInFlight.current = false
              handleCodeChange(e.target.value)
            }}
            // The code is the screen's one job — give it presence. 16px+ also
            // keeps iOS from zoom-jumping the focused field.
            style={{ fontSize: '18px', letterSpacing: '0.12em', minHeight: '52px' }}
          />
        </label>
        <BigButton
          primary
          testId="connect-code-submit"
          disabled={!canSubmit}
          onClick={() => {
            if (selectedMachineId && !submitInFlight.current) {
              submitInFlight.current = true
              onSubmitCode(selectedMachineId, code.trim())
            }
          }}
        >
          {t('connect.pair.submit')}
        </BigButton>
      </Screen>
    )
  }

  if (phase === 'pairing') {
    const isFailed = isFailure
    return (
      <Screen testId="connect-pairing" className="justify-center gap-6">
        {/* J5: hide SAS block when there is a failure */}
        {showSas && !isFailed ? (
          <div className="flex flex-col items-center gap-4">
            {/* SAS is the focal point — large, centered, framed. */}
            <div
              data-testid="connect-pairing-sas"
              className="mono rounded-2xl border px-7 py-5 font-bold text-pri"
              aria-live="polite"
              style={{
                fontSize: '2.5rem',
                letterSpacing: '0.25em',
                // Optical centering: the tracking adds a phantom space after
                // the last digit — pull it back with padding asymmetry.
                paddingRight: 'calc(1.75rem - 0.25em)',
                background: 'var(--bg-1)',
                borderColor: 'var(--border-bright)',
              }}
            >
              {sas}
            </div>
            <p className="text-center text-sm text-ter" style={{ maxWidth: '280px' }}>
              {/* J1: once desktop confirmed, swap instruction to finalizing message */}
              {postConfirm ? t('connect.pair.finalizing') : t('connect.pair.sasInstruction')}
            </p>
            {postConfirm ? (
              <span
                aria-hidden
                className="h-5 w-5 animate-spin rounded-full border-2"
                style={{ borderColor: 'var(--border-bright)', borderTopColor: 'var(--accent)' }}
              />
            ) : null}
          </div>
        ) : null}
        {/* In-progress status line. Suppressed during awaiting_confirm (the SAS has its own
            instruction) and on failure (the red line below owns that). */}
        {statusKey && !showSas && !isFailed ? (
          <p data-testid="connect-pairing-phase" className="text-center text-sm text-ter">
            {t(statusKey)}
          </p>
        ) : null}
        {isFailed && statusKey ? (
          <p
            data-testid="connect-pairing-phase"
            className="text-center text-sm"
            style={{ color: 'var(--status-red)' }}
          >
            {t(statusKey)}
          </p>
        ) : null}
        {/* J1: hide Cancel once desktop has confirmed (post-confirm); show Start over on failure. */}
        {!postConfirm ? (
          <div className="flex flex-col gap-3">
            <BigButton
              primary={isFailed}
              testId="connect-pairing-cancel"
              onClick={() => {
                // J8: clear stale code before returning to the selecting screen.
                setCode('')
                submitInFlight.current = false
                if (onCancelPairing) {
                  onCancelPairing()
                } else {
                  flow.pairingClient?.cancel()
                }
              }}
            >
              {isFailed ? t('connect.pair.startOver') : t('common.cancel')}
            </BigButton>
          </div>
        ) : null}
      </Screen>
    )
  }

  // 'connected' — the entry unmounts the ConnectView once the transport is swapped in.
  return null
}
