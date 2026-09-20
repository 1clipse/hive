// @vitest-environment jsdom
//
// M5a STAGE 6 — i18n coverage for the connect-machines keys (repo law: en source of truth, zh covers
// every new key). The compile-time Record<TranslationKey,string> forces zh to define each key; this
// test makes the en + zh coverage explicit and catches an accidental placeholder (a key left as its
// own value, an empty string, or zh copied verbatim from en).

import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'

import { I18nProvider, type TranslationKey, useI18n } from '../../web/src/i18n.js'

const CONNECT_KEYS: TranslationKey[] = [
  'connect.machines.heading',
  'connect.machines.empty',
  'connect.machines.offline',
  'connect.machines.select',
]

const Probe = () => {
  const { t, setLanguage } = useI18n()
  return (
    <div>
      <button type="button" data-testid="to-zh" onClick={() => setLanguage('zh')}>
        zh
      </button>
      <ul>
        {CONNECT_KEYS.map((key) => (
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
  for (const key of CONNECT_KEYS) {
    const node = document.querySelector(`[data-key="${key}"]`)
    const text = node?.textContent ?? ''
    expect(text.length, `missing copy for ${key}`).toBeGreaterThan(0)
    expect(text, `untranslated key ${key}`).not.toBe(key)
    seen[key] = text
  }
  return seen
}

test('every connect.machines.* key resolves in en', () => {
  render(
    <I18nProvider>
      <Probe />
    </I18nProvider>
  )
  assertAllResolve()
})

test('every connect.machines.* key resolves in zh and differs from en', () => {
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
  for (const key of CONNECT_KEYS) {
    expect(zh[key], `zh copy for ${key} equals en`).not.toBe(en[key])
  }
})
