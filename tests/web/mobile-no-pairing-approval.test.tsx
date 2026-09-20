// @vitest-environment jsdom
//
// M5b impl:adapt-b — new-device pairing approval ❌ is the desktop trust root
// (Authority Model). A phone must NEVER be able to approve/mint a new device.
// The transport already keeps `pending` null over the tunnel (daemon-only 403),
// but the mobile UI adds defense-in-depth: RemotePairingConfirm does not
// surface its approve dialog on mobile even if a pending pairing is present.
//
// Positive control: the SAME pending DOES show the confirm on the desktop trust
// root — the difference is intentional, not a missing feature.

import { cleanup, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import type { PendingPairing } from '../../web/src/api.js'
import { I18nProvider } from '../../web/src/i18n.js'
import { RemotePairingConfirm } from '../../web/src/remote/RemotePairingConfirm.js'
import { ToastProvider } from '../../web/src/ui/useToast.js'
import { renderMobile, renderWide } from './helpers/mobile-render.js'

const PENDING: PendingPairing = {
  pairingId: 'pair-1',
  deviceName: 'Someone’s phone',
  sas: '123456',
  expiresAt: Date.now() + 60_000,
}

// Force a pending pairing through the feature hook so the confirm WOULD render
// if it were layout-agnostic. This is the adversarial setup — without the
// mobile gate, the mobile branch would surface an approval dialog.
vi.mock('../../web/src/remote/useRemoteFeature.js', () => ({
  useRemoteFeature: () => ({
    status: { enabled: true, loggedIn: true, gatewayUrl: 'https://gw', connected: true },
    loading: false,
    setEnabled: vi.fn(),
    pending: PENDING,
    refresh: vi.fn(async () => {}),
  }),
  RemoteFeatureProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

afterEach(() => cleanup())

const tree = (
  <I18nProvider>
    <ToastProvider>
      <RemotePairingConfirm />
    </ToastProvider>
  </I18nProvider>
)

describe('new-device approval is desktop-only (trust root)', () => {
  test('mobile: a pending pairing does NOT surface the confirm/approve dialog', () => {
    renderMobile(tree)
    expect(screen.queryByTestId('remote-pairing-confirm')).toBeNull()
    expect(screen.queryByTestId('remote-pairing-confirm-action')).toBeNull()
    expect(screen.queryByTestId('remote-pairing-sas')).toBeNull()
  })

  test('desktop: the SAME pending DOES surface the confirm dialog (intentional difference)', () => {
    renderWide(tree)
    expect(screen.getByTestId('remote-pairing-confirm')).toBeTruthy()
    expect(screen.getByTestId('remote-pairing-confirm-action')).toBeTruthy()
  })
})
