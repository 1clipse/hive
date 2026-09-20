import { type RenderResult, render } from '@testing-library/react'
import type { ReactElement } from 'react'

import { LayoutModeProvider } from '../../../web/src/mobile/layout-mode.js'

/**
 * Render `ui` under the mobile layout mode without touching globals — the
 * provider value is synchronous and deterministic, so adapted components take
 * their `isMobile` branch immediately.
 */
export const renderMobile = (ui: ReactElement): RenderResult =>
  render(<LayoutModeProvider value={{ mode: 'mobile' }}>{ui}</LayoutModeProvider>)

/**
 * Render `ui` under the wide layout mode (the desktop branch). Used by the
 * zero-regression test to prove the existing 3-column tree still renders and
 * no mobile chrome leaks in.
 */
export const renderWide = (ui: ReactElement): RenderResult =>
  render(<LayoutModeProvider value={{ mode: 'wide' }}>{ui}</LayoutModeProvider>)
