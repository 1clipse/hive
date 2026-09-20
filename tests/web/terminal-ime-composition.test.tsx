// @vitest-environment jsdom
//
// M5b impl:terminal — IME (Chinese input) bridge over the xterm helper textarea.
// CJK composition is the classic mobile double-commit pitfall: the bridge must
// keep the composing flag TRUE across multi-keystroke updates, commit the final
// string EXACTLY ONCE on compositionend, clear the textarea synchronously so
// xterm's built-in deferred helper has nothing left to re-commit, and only
// release the flag in a later macrotask so any input fired between commit and
// release stays suppressed.

import { afterEach, describe, expect, test, vi } from 'vitest'

import { attachCompositionBridge } from '../../web/src/terminal/composition.js'

afterEach(() => {
  vi.useRealTimers()
})

const fireComposition = (
  el: HTMLElement,
  type: 'compositionstart' | 'compositionupdate' | 'compositionend',
  data: string
) => {
  const event = new CompositionEvent(type, { data })
  el.dispatchEvent(event)
}

const fireInput = (
  el: HTMLElement,
  input: { data: string; inputType?: string } = { data: 'hello' }
) => {
  const event = new InputEvent('input', {
    cancelable: true,
    data: input.data,
    inputType: input.inputType ?? 'insertText',
  })
  el.dispatchEvent(event)
}

describe('attachCompositionBridge', () => {
  test('commits the composed string exactly once on compositionend', () => {
    const textarea = document.createElement('textarea')
    const commit = vi.fn()
    const setComposing = vi.fn()
    attachCompositionBridge(textarea, { commit, setComposing })

    fireComposition(textarea, 'compositionstart', '')
    fireComposition(textarea, 'compositionupdate', '你')
    fireComposition(textarea, 'compositionupdate', '你好')
    expect(commit).not.toHaveBeenCalled() // never commit per-update
    fireComposition(textarea, 'compositionend', '你好')

    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit).toHaveBeenCalledWith('你好')
  })

  test('keeps the composing flag true across start+update and clears it next tick', () => {
    vi.useFakeTimers()
    const textarea = document.createElement('textarea')
    let composing = false
    attachCompositionBridge(textarea, {
      commit: () => {},
      setComposing: (v) => {
        composing = v
      },
    })

    fireComposition(textarea, 'compositionstart', '')
    expect(composing).toBe(true)
    fireComposition(textarea, 'compositionupdate', '你')
    expect(composing).toBe(true)
    fireComposition(textarea, 'compositionend', '你好')
    // still suppressing synchronously after end — xterm's deferred helper runs now
    expect(composing).toBe(true)
    vi.runAllTimers()
    expect(composing).toBe(false)
  })

  test('clears the textarea synchronously on end so xterm cannot re-commit', () => {
    const textarea = document.createElement('textarea')
    textarea.value = '你好'
    attachCompositionBridge(textarea, { commit: () => {}, setComposing: () => {} })

    fireComposition(textarea, 'compositionstart', '')
    fireComposition(textarea, 'compositionend', '你好')
    expect(textarea.value).toBe('')
  })

  test('empty-data compositionend commits textarea-delivered text once', () => {
    const textarea = document.createElement('textarea')
    textarea.value = '语音输入的一整句'
    const commit = vi.fn()
    attachCompositionBridge(textarea, { commit, setComposing: () => {} })

    fireComposition(textarea, 'compositionstart', '')
    fireComposition(textarea, 'compositionend', '')
    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit).toHaveBeenCalledWith('语音输入的一整句')
    expect(textarea.value).toBe('')
  })

  test('empty-data compositionend without textarea text does not emit a spurious commit', () => {
    const textarea = document.createElement('textarea')
    const commit = vi.fn()
    attachCompositionBridge(textarea, { commit, setComposing: () => {} })

    fireComposition(textarea, 'compositionstart', '')
    fireComposition(textarea, 'compositionend', '')
    expect(commit).not.toHaveBeenCalled()
  })

  test('final insertText during composition commits once and does not duplicate on end', () => {
    const textarea = document.createElement('textarea')
    const commit = vi.fn()
    attachCompositionBridge(textarea, { commit, setComposing: () => {} })

    fireComposition(textarea, 'compositionstart', '')
    textarea.value = '听写提交'
    fireInput(textarea, { data: '听写提交' })
    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit).toHaveBeenCalledWith('听写提交')
    expect(textarea.value).toBe('')

    fireComposition(textarea, 'compositionend', '')

    expect(commit).toHaveBeenCalledTimes(1)
  })

  test('partial composition input is not committed before compositionend', () => {
    const textarea = document.createElement('textarea')
    const commit = vi.fn()
    attachCompositionBridge(textarea, { commit, setComposing: () => {} })

    fireComposition(textarea, 'compositionstart', '')
    textarea.value = 'n'
    fireInput(textarea, { data: 'n', inputType: 'insertCompositionText' })

    expect(commit).not.toHaveBeenCalled()
  })

  test('handled non-composition input is cleared without a second commit', () => {
    const textarea = document.createElement('textarea')
    const commit = vi.fn()
    textarea.addEventListener('input', (event) => event.preventDefault(), { capture: true })
    attachCompositionBridge(textarea, { commit, setComposing: () => {} })

    textarea.value = 'voice text'
    fireInput(textarea, { data: 'voice text' })

    expect(commit).not.toHaveBeenCalled()
    expect(textarea.value).toBe('')
  })

  test('the disposer removes the listeners (no commit after dispose)', () => {
    const textarea = document.createElement('textarea')
    const commit = vi.fn()
    const dispose = attachCompositionBridge(textarea, { commit, setComposing: () => {} })

    dispose()
    fireComposition(textarea, 'compositionstart', '')
    fireComposition(textarea, 'compositionend', '你好')
    expect(commit).not.toHaveBeenCalled()
  })
})
