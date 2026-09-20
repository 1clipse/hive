/**
 * IME composition bridge over xterm's hidden helper textarea. Typing CJK (or any
 * composed input) fires compositionstart -> compositionupdate* -> compositionend.
 * xterm's built-in CompositionHelper re-reads the textarea on a deferred
 * setTimeout(0) and would re-commit the composed text plus a run of DEL bytes,
 * corrupting the line. We take ownership:
 *
 *   - start / update    -> hold the composing flag TRUE (callers gate onData on it)
 *   - update            -> never commit (multi-keystroke CJK isn't final yet)
 *   - end               -> commit the final string ONCE if non-empty, clear the
 *                          textarea synchronously (so xterm's deferred read finds
 *                          nothing), then release the flag in a later macrotask
 *                          so xterm's own setTimeout(0) work still fires while we
 *                          are still suppressing.
 *
 * Empty-data compositionend (some Android IMEs / iOS Safari / dictation deliver
 * the text via the textarea value and end with no data) falls back to the
 * current textarea value. If both are empty, nothing is committed.
 */

export interface CompositionSink {
  setComposing: (composing: boolean) => void
  commit: (text: string) => void
}

export const attachCompositionBridge = (
  textarea: HTMLTextAreaElement,
  sink: CompositionSink
): (() => void) => {
  let releaseTimer: ReturnType<typeof setTimeout> | undefined
  let composing = false
  let committedDuringComposition = false
  const clearTextarea = () => {
    textarea.value = ''
    textarea.scrollLeft = 0
    textarea.scrollTop = 0
  }
  const releaseComposingLater = () => {
    if (releaseTimer !== undefined) clearTimeout(releaseTimer)
    releaseTimer = setTimeout(() => {
      releaseTimer = undefined
      composing = false
      committedDuringComposition = false
      sink.setComposing(false)
    }, 0)
  }
  const textFromInput = (event: InputEvent) => event.data || textarea.value
  const isFinalTextInput = (event: InputEvent) =>
    event.inputType === 'insertText' ||
    event.inputType === 'insertFromComposition' ||
    event.inputType === 'insertReplacementText' ||
    event.inputType === 'insertDictationResult'
  const onStart = () => {
    composing = true
    committedDuringComposition = false
    sink.setComposing(true)
  }
  const onUpdate = () => {
    // Reinforce the flag across each keystroke; never commit mid-composition.
    composing = true
    sink.setComposing(true)
  }
  const onEnd = (event: Event) => {
    const data = (event as CompositionEvent).data
    const composed = data || textarea.value
    if (!committedDuringComposition && composed) sink.commit(composed)
    // Clear synchronously so xterm's built-in helper has nothing to re-commit
    // on its deferred read, and so the tracked value never accumulates.
    clearTextarea()
    // Release in a later macrotask so the built-in helper's own setTimeout(0)
    // runs while we are still gating input.
    releaseComposingLater()
  }
  const onInput = (event: Event) => {
    const input = event as InputEvent
    if (composing || input.isComposing) {
      if (isFinalTextInput(input)) {
        const text = textFromInput(input)
        if (text) {
          sink.commit(text)
          committedDuringComposition = true
        }
        clearTextarea()
      }
      return
    }

    // xterm's own capture-phase input handler runs before this bridge. If it
    // handled a dictation/text insertion, it has already sent the data event
    // and called preventDefault(); clear the helper so the browser caret can't
    // keep scrolling a hidden one-line textarea sideways.
    if (input.defaultPrevented && isFinalTextInput(input)) clearTextarea()
  }

  const options: AddEventListenerOptions = { capture: true }
  textarea.addEventListener('compositionstart', onStart, options)
  textarea.addEventListener('compositionupdate', onUpdate, options)
  textarea.addEventListener('compositionend', onEnd, options)
  textarea.addEventListener('input', onInput, options)

  return () => {
    if (releaseTimer !== undefined) clearTimeout(releaseTimer)
    textarea.removeEventListener('compositionstart', onStart, options)
    textarea.removeEventListener('compositionupdate', onUpdate, options)
    textarea.removeEventListener('compositionend', onEnd, options)
    textarea.removeEventListener('input', onInput, options)
  }
}
