export const copyTextToClipboard = async (text: string): Promise<void> => {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return
    } catch {
      // Fall through to the selection-based path for embedded browsers and
      // stricter clipboard permission contexts.
    }
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.top = '0'
  textarea.style.left = '-9999px'
  textarea.style.opacity = '0'

  const previousActiveElement =
    document.activeElement instanceof HTMLElement ? document.activeElement : null

  let copied = false
  try {
    document.body.appendChild(textarea)
    textarea.focus()
    textarea.select()
    textarea.setSelectionRange(0, textarea.value.length)
    copied = document.execCommand('copy')
  } finally {
    textarea.remove()
    previousActiveElement?.focus()
  }

  if (!copied) {
    throw new Error('Clipboard copy failed')
  }
}

/**
 * Copy text that is still being produced (e.g. a fetch in flight) without
 * losing the user-activation window: Safari revokes clipboard access at the
 * first await, so call this synchronously inside the click gesture and hand
 * it the pending promise — the ClipboardItem is created before any await.
 * Browsers without promise-backed ClipboardItem fall back to resolving the
 * text first (which Chromium accepts even after the gesture window).
 */
export const copyPendingTextToClipboard = async (pending: Promise<string>): Promise<void> => {
  if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
    const blobPromise = pending.then((text) => new Blob([text], { type: 'text/plain' }))
    // write() can reject before blobPromise settles; keep its rejection handled.
    void blobPromise.catch(() => {})
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': blobPromise })])
      return
    } catch {
      // Either the producer failed (rethrown by the await below) or this
      // browser rejected the promise-backed write; retry with resolved text.
    }
  }
  await copyTextToClipboard(await pending)
}
