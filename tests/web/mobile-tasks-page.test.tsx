// @vitest-environment jsdom
//
// M5b impl:adapt-b — the TaskGraphDrawer is a full-screen page on mobile
// (data-mobile on the dialog content drives the full-bleed CSS), while every
// edit/toggle/add/copy affordance still fires its callback. Parity row:
// "tasks graph". Desktop rendering is unchanged (no data-mobile).

import { cleanup, fireEvent, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { I18nProvider } from '../../web/src/i18n.js'
import { TaskGraphDrawer } from '../../web/src/tasks/TaskGraphDrawer.js'
import { renderMobile, renderWide } from './helpers/mobile-render.js'

afterEach(() => cleanup())

const CONTENT = ['# Plan', '', '- [ ] build the thing', '- [x] done already'].join('\n')

const baseProps = () => ({
  content: CONTENT,
  hasConflict: false,
  onClose: vi.fn(),
  onContentChange: vi.fn(),
  onKeepLocal: vi.fn(),
  onReload: vi.fn(),
  onSave: vi.fn(async () => {}),
  onToggleTaskLine: vi.fn(),
  onAppendTask: vi.fn(),
  onUpdateTaskText: vi.fn(),
  onDeleteTask: vi.fn(),
  open: true,
  workspacePath: '/repo',
})

const withI18n = (ui: React.ReactElement) => <I18nProvider>{ui}</I18nProvider>

describe('mobile TaskGraphDrawer — full-screen page', () => {
  test('mobile drawer tags the dialog content data-mobile (full-bleed)', () => {
    renderMobile(withI18n(<TaskGraphDrawer {...baseProps()} />))
    const content = screen.getByTestId('task-graph-drawer')
    // Reversed (no flag) leaves the min(1040px)/min(780px) centered card, which
    // on a 360px viewport clips its right edge + bottom off-screen.
    expect(content).toHaveAttribute('data-mobile', 'true')
  })

  test('desktop drawer does NOT tag data-mobile (zero-regression)', () => {
    renderWide(withI18n(<TaskGraphDrawer {...baseProps()} />))
    expect(screen.getByTestId('task-graph-drawer')).not.toHaveAttribute('data-mobile')
  })

  test('mobile drawer still fires toggle / add / edit callbacks', () => {
    const props = baseProps()
    renderMobile(withI18n(<TaskGraphDrawer {...props} />))
    // toggle the open task (line index 2)
    fireEvent.click(screen.getByTestId('task-checkbox-2'))
    expect(props.onToggleTaskLine).toHaveBeenCalledWith(2)
    // edit
    fireEvent.click(screen.getByTestId('task-edit-2'))
    const input = screen.getByTestId('task-inline-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'reworded' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(props.onUpdateTaskText).toHaveBeenCalledWith(2, 'reworded')
  })
})
