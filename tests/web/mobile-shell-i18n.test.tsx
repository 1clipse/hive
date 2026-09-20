// @vitest-environment jsdom
//
// M5b impl:shell — i18n coverage for the mobile shell / nav keys. The
// compile-time Record<TranslationKey,string> forces zh to define every key;
// this test makes en + zh coverage explicit and catches a placeholder (key
// left as its own value, empty string, or zh copied verbatim from en).

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'

import { I18nProvider, type TranslationKey, useI18n } from '../../web/src/i18n.js'

const SHELL_KEYS: TranslationKey[] = [
  'mobile.nav.team',
  'mobile.nav.tasks',
  'mobile.nav.more',
  'mobile.section.workspaces',
  'mobile.section.settings',
  'mobile.section.workflows',
  'mobile.section.devices',
  'mobile.section.about',
  'mobile.section.demo',
  'mobile.tasks.noWorkspaceTitle',
  'mobile.tasks.noWorkspaceDesc',
  'mobile.reconnect.reconnecting',
  'mobile.reconnect.disconnected',
  'mobile.reconnect.retry',
]

const Probe = () => {
  const { t, setLanguage } = useI18n()
  return (
    <div>
      <button type="button" data-testid="to-zh" onClick={() => setLanguage('zh')}>
        zh
      </button>
      <ul>
        {SHELL_KEYS.map((key) => (
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
  for (const key of SHELL_KEYS) {
    const node = document.querySelector(`[data-key="${key}"]`)
    const text = node?.textContent ?? ''
    expect(text.length, `missing copy for ${key}`).toBeGreaterThan(0)
    expect(text, `untranslated key ${key}`).not.toBe(key)
    seen[key] = text
  }
  return seen
}

test('every mobile shell key resolves in en', () => {
  render(
    <I18nProvider>
      <Probe />
    </I18nProvider>
  )
  assertAllResolve()
})

test('every mobile shell key resolves in zh and differs from en', () => {
  render(
    <I18nProvider>
      <Probe />
    </I18nProvider>
  )
  const en = assertAllResolve()
  act(() => {
    ;(document.querySelector('[data-testid="to-zh"]') as HTMLButtonElement).click()
  })
  const zh = assertAllResolve()
  for (const key of SHELL_KEYS) {
    expect(zh[key], `zh copy for ${key} equals en`).not.toBe(en[key])
  }
})
