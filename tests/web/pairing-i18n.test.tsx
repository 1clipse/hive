// @vitest-environment jsdom
//
// Coverage for the M5a pairing/connect banner i18n keys (repo law: en is the source of truth, zh must
// cover every new key). The compile-time Record<TranslationKey,string> already forces zh to define each
// key; this test makes the en + zh coverage explicit and catches an accidental placeholder (a key left
// as its own value, or an empty string).

import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'

import { I18nProvider, type TranslationKey, useI18n } from '../../web/src/i18n.js'

const PAIRING_KEYS: TranslationKey[] = [
  'pairing.connecting',
  'pairing.handshaking',
  'pairing.sasPrompt',
  'pairing.awaitingConfirm',
  'pairing.paired',
  'pairing.failed.rejected',
  'pairing.failed.expired',
  'pairing.failed.socket',
  'pairing.failed.mintForbidden',
  'pairing.failed.version',
  'pairing.cancel',
]

const Probe = () => {
  const { t, setLanguage } = useI18n()
  return (
    <div>
      <button type="button" data-testid="to-zh" onClick={() => setLanguage('zh')}>
        zh
      </button>
      <ul>
        {PAIRING_KEYS.map((key) => (
          <li key={key} data-key={key}>
            {t(key)}
          </li>
        ))}
      </ul>
    </div>
  )
}

afterEach(() => cleanup())

const assertAllResolve = (): Record<string, string> => {
  const seen: Record<string, string> = {}
  for (const key of PAIRING_KEYS) {
    const node = document.querySelector(`[data-key="${key}"]`)
    const text = node?.textContent ?? ''
    expect(text.length, `missing copy for ${key}`).toBeGreaterThan(0)
    expect(text, `untranslated key ${key}`).not.toBe(key)
    seen[key] = text
  }
  return seen
}

test('every pairing.* key resolves in en', () => {
  render(
    <I18nProvider>
      <Probe />
    </I18nProvider>
  )
  assertAllResolve()
})

test('every pairing.* key resolves in zh and differs from en', () => {
  render(
    <I18nProvider>
      <Probe />
    </I18nProvider>
  )
  const en = assertAllResolve()
  act(() => {
    screen.getByTestId('to-zh').click()
  })
  const zh = assertAllResolve()
  // zh must be a real translation, not the en string copied across.
  for (const key of PAIRING_KEYS) {
    expect(zh[key], `zh copy for ${key} equals en`).not.toBe(en[key])
  }
})
