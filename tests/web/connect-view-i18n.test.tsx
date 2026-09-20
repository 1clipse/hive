// @vitest-environment jsdom
//
// M5b impl:substitutes — i18n coverage for the ConnectView skin keys + the open-in-editor result toast
// + the mobile add-workspace hint. zh must be complete AND differ from en (the compile-time
// Record<TranslationKey,string> only forces a key to exist, not that it is non-empty or translated).

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'

import { I18nProvider, type TranslationKey, useI18n } from '../../web/src/i18n.js'

const KEYS: TranslationKey[] = [
  'connect.login.heading',
  'connect.login.subtitle',
  'connect.login.github',
  'connect.login.google',
  'connect.pair.guideHeading',
  'connect.pair.guideStep1',
  'connect.pair.guideStep2',
  'connect.pair.guideStep3',
  'connect.pair.qrLabel',
  'connect.pair.sasPrompt',
  'connect.error.selectFailed',
  'connect.error.invalidCode',
  'openWorkspace.opened',
  'workspace.add.manualHint',
]

const Probe = () => {
  const { t } = useI18n()
  return (
    <ul>
      {KEYS.map((key) => (
        <li key={key} data-key={key}>
          {t(key, { app: 'VS Code', workspace: 'Alpha' })}
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
  for (const key of KEYS) {
    const text = document.querySelector(`[data-key="${key}"]`)?.textContent ?? ''
    expect(text.length, `missing copy for ${key}`).toBeGreaterThan(0)
    expect(text, `untranslated key ${key}`).not.toBe(key)
    seen[key] = text
  }
  return seen
}

test('every connect-view / substitute key resolves in en and zh, zh differs from en', () => {
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
  for (const key of KEYS) {
    expect(zh[key], `zh copy for ${key} equals en`).not.toBe(en[key])
  }
})
