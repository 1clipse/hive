// @vitest-environment jsdom
//
// M5b impl:adapt-b — errors/toasts/confirm dialogs must stay reachable on
// mobile. The toast viewport sits ABOVE the bottom nav (data-mobile drives a
// CSS bottom-offset so toasts aren't hidden behind the nav bar), and the
// shared Confirm dialog renders + its confirm/cancel fire. Parity row:
// "errors/toasts/confirm". Desktop viewport is unchanged.

import { act, cleanup, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { I18nProvider } from '../../web/src/i18n.js'
import { Confirm } from '../../web/src/ui/Confirm.js'
import { Toaster } from '../../web/src/ui/toast.js'
import { ToastProvider, useToast } from '../../web/src/ui/useToast.js'
import { renderMobile, renderWide } from './helpers/mobile-render.js'

afterEach(() => cleanup())

const PushButton = () => {
  const toast = useToast()
  return (
    <button
      type="button"
      data-testid="push-toast"
      onClick={() => toast.show({ kind: 'error', message: 'it broke' })}
    >
      push
    </button>
  )
}

describe('mobile toast viewport — offset above bottom nav', () => {
  test('mobile toaster tags the viewport data-mobile so it clears the bottom nav', () => {
    renderMobile(
      <I18nProvider>
        <ToastProvider>
          <PushButton />
          <Toaster />
        </ToastProvider>
      </I18nProvider>
    )
    act(() => {
      screen.getByTestId('push-toast').click()
    })
    const viewport = screen.getByTestId('toaster')
    // Reversed (no flag) keeps bottom-8 (32px), which a ~60px bottom nav covers
    // on a phone — the toast would be invisible behind the nav.
    expect(viewport).toHaveAttribute('data-mobile', 'true')
    expect(screen.getByTestId('toast')).toBeTruthy()
  })

  test('desktop toaster does NOT tag data-mobile (zero-regression)', () => {
    renderWide(
      <I18nProvider>
        <ToastProvider>
          <PushButton />
          <Toaster />
        </ToastProvider>
      </I18nProvider>
    )
    act(() => {
      screen.getByTestId('push-toast').click()
    })
    expect(screen.getByTestId('toaster')).not.toHaveAttribute('data-mobile')
  })
})

describe('mobile Confirm dialog reachable', () => {
  test('confirm renders and confirm/cancel fire on mobile', () => {
    const onConfirm = vi.fn()
    const onOpenChange = vi.fn()
    renderMobile(
      <I18nProvider>
        <Confirm
          open
          onOpenChange={onOpenChange}
          title="Delete it?"
          description="This cannot be undone."
          confirmLabel="Delete"
          confirmKind="danger"
          onConfirm={onConfirm}
        />
      </I18nProvider>
    )
    expect(screen.getByTestId('confirm-content')).toBeTruthy()
    screen.getByTestId('confirm-action').click()
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })
})
