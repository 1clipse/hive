// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'

import { I18nProvider, type TranslationKey, useI18n } from '../../web/src/i18n.js'

// Every new M4 remote key. The en source-of-truth and zh translation must both
// resolve to non-empty, non-identical-to-key copy. The compile-time
// Record<TranslationKey,string> already forces zh to define each key; this
// test makes the en + zh COVERAGE explicit and catches an accidental
// placeholder ("remote.section" left as its own key, or an empty string).
const REMOTE_KEYS: TranslationKey[] = [
  'remote.section',
  'remote.enable.label',
  'remote.enable.description',
  'remote.status.linked',
  'remote.status.notLinked',
  'remote.status.connecting',
  'remote.status.reconnecting',
  'remote.status.revoked',
  'remote.status.connected',
  'remote.status.disconnected',
  'remote.addDevice',
  'remote.qr.title',
  'remote.qr.instructions',
  'remote.qr.expiresIn',
  'remote.qr.expired',
  'remote.qr.cancel',
  'remote.qr.regenerate',
  'remote.qr.startFailed',
  'remote.confirm.title',
  'remote.confirm.description',
  'remote.confirm.sasLabel',
  'remote.confirm.warning',
  'remote.confirm.confirm',
  'remote.confirm.reject',
  'remote.confirm.confirming',
  'remote.confirm.paired',
  'remote.confirm.rejected',
  'remote.confirm.expired',
  'remote.confirm.failed',
  'remote.devices.heading',
  'remote.devices.empty',
  'remote.devices.lastActive',
  'remote.devices.neverActive',
  'remote.devices.revoke',
  'remote.devices.revokeAria',
  'remote.devices.revokeConfirm',
  'remote.devices.revokeTitle',
  'remote.devices.revoked',
  'remote.devices.revokeFailed',
  'remote.devices.loadFailed',
  'remote.audit.show',
  'remote.audit.hide',
  'remote.audit.heading',
  'remote.audit.empty',
  'remote.audit.result.ok',
  'remote.audit.result.rejected',
  'remote.audit.result.error',
  'remote.audit.bytes',
  'remote.audit.loadFailed',
]

const Probe = () => {
  const { t, setLanguage } = useI18n()
  return (
    <div>
      <button type="button" data-testid="to-zh" onClick={() => setLanguage('zh')}>
        zh
      </button>
      <ul>
        {REMOTE_KEYS.map((key) => (
          <li key={key} data-key={key}>
            {t(key)}
          </li>
        ))}
      </ul>
    </div>
  )
}

afterEach(() => cleanup())

const assertAllResolve = () => {
  for (const key of REMOTE_KEYS) {
    const node = document.querySelector(`[data-key="${key}"]`)
    const text = node?.textContent ?? ''
    expect(text.length, `missing copy for ${key}`).toBeGreaterThan(0)
    // A resolved translation never equals its own key.
    expect(text, `untranslated key ${key}`).not.toBe(key)
  }
}

test('every remote.* key resolves in en', () => {
  render(
    <I18nProvider>
      <Probe />
    </I18nProvider>
  )
  assertAllResolve()
})

test('every remote.* key resolves in zh', () => {
  render(
    <I18nProvider>
      <Probe />
    </I18nProvider>
  )
  act(() => {
    screen.getByTestId('to-zh').click()
  })
  assertAllResolve()
})
