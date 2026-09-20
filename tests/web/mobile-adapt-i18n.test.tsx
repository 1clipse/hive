// @vitest-environment jsdom
//
// M5b impl:adapt-a — i18n coverage for the new touch-adaptation keys (worker
// stop/restart, the workspace switcher). zh must be complete AND differ from en
// (the compile-time Record<TranslationKey,string> only forces a key to exist,
// not that it is non-empty or actually translated).

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'

import { I18nProvider, type TranslationKey, useI18n } from '../../web/src/i18n.js'

const ADAPT_KEYS: TranslationKey[] = [
  'common.stop',
  'common.restart',
  'worker.stopAria',
  'worker.restartAria',
  'mobile.workspaces.switch',
]

const Probe = () => {
  const { t } = useI18n()
  return (
    <ul>
      {ADAPT_KEYS.map((key) => (
        <li key={key} data-key={key}>
          {t(key, { name: 'x' })}
        </li>
      ))}
    </ul>
  )
}

const ToggleProbe = () => {
  const { setLanguage } = useI18n()
  return (
    <button type="button" data-testid="to-zh" onClick={() => setLanguage('zh')}>
      zh
    </button>
  )
}

afterEach(() => cleanup())

const collect = (): Record<string, string> => {
  const seen: Record<string, string> = {}
  for (const key of ADAPT_KEYS) {
    const text = document.querySelector(`[data-key="${key}"]`)?.textContent ?? ''
    expect(text.length, `missing copy for ${key}`).toBeGreaterThan(0)
    expect(text, `untranslated key ${key}`).not.toBe(key)
    seen[key] = text
  }
  return seen
}

test('every adapt key resolves in en and zh, zh differs from en', () => {
  render(
    <I18nProvider>
      <ToggleProbe />
      <Probe />
    </I18nProvider>
  )
  const en = collect()
  act(() => {
    ;(document.querySelector('[data-testid="to-zh"]') as HTMLButtonElement).click()
  })
  const zh = collect()
  for (const key of ADAPT_KEYS) {
    expect(zh[key], `zh copy for ${key} equals en`).not.toBe(en[key])
  }
})
