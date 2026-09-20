import { useEffect, useId, useState } from 'react'
import type {
  ActionCenterMessage,
  ActionCenterResponsibility,
} from '../../../src/shared/action-center.js'
import { getDispatchMessageHistory } from '../api.js'
import { useI18n } from '../i18n.js'

export const ActionCenterMessages = ({
  messages,
  workspaceId,
  workers,
  request,
}: {
  messages: ActionCenterMessage[]
  workspaceId: string
  workers: Array<{ id: string; name: string }>
  request?: { dispatchId: string } | null
}) => {
  const { t } = useI18n()
  const messagePrefix = useId()
  const [selection, setSelection] = useState<{ dispatchId: string; after: string | null } | null>(
    null
  )
  const [history, setHistory] = useState<{
    workspaceId: string
    dispatchId: string
    messages: ActionCenterMessage[]
    next: string | null
    responsibilities: ActionCenterResponsibility[]
  } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  useEffect(() => {
    if (request) setSelection({ dispatchId: request.dispatchId, after: null })
  }, [request])
  const agentName = (id: string) =>
    id === `${workspaceId}:orchestrator`
      ? t('actionCenter.message.orchestrator')
      : (workers.find((worker) => worker.id === id)?.name ?? t('actionCenter.unknownWorker'))

  useEffect(() => {
    if (!selection) return
    const controller = new AbortController()
    setLoading(true)
    setError(false)
    void getDispatchMessageHistory(
      workspaceId,
      selection.dispatchId,
      selection.after,
      controller.signal
    )
      .then((page) => {
        if (controller.signal.aborted) return
        setHistory((previous) => ({
          workspaceId,
          dispatchId: selection.dispatchId,
          messages:
            selection.after !== null &&
            previous?.workspaceId === workspaceId &&
            previous.dispatchId === selection.dispatchId
              ? [...previous.messages, ...page.messages]
              : page.messages,
          next: page.next_after_message_id,
          responsibilities: page.related_dispatches,
        }))
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true)
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [workspaceId, selection])

  if (messages.length === 0 && !selection) return null
  const currentHistory =
    history?.workspaceId === workspaceId && history.dispatchId === selection?.dispatchId
      ? history
      : null
  const visible = selection ? (currentHistory?.messages ?? []) : messages
  const responsibility = currentHistory?.responsibilities.find(
    (item) => item.id === selection?.dispatchId
  )
  const messagesById = new Map(visible.map((message) => [message.id, message]))
  return (
    <section className="action-center-panel min-w-0">
      <div className="action-center-panel__header">
        <h3>{t('actionCenter.message.title')}</h3>
        {selection ? (
          <button type="button" className="text-xs text-accent" onClick={() => setSelection(null)}>
            {t('actionCenter.message.recent')}
          </button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-xs text-sec">
          {t('actionCenter.loadFailed')}
        </p>
      ) : null}
      {currentHistory ? (
        <div className="mb-3 space-y-2">
          <nav className="flex flex-wrap gap-2" aria-label={t('actionCenter.message.related')}>
            {currentHistory.responsibilities.map((item) => (
              <button
                key={item.id}
                type="button"
                aria-pressed={item.id === selection?.dispatchId}
                className="rounded border border-bright/40 px-2 py-1 text-xs text-sec aria-pressed:text-accent"
                onClick={() => setSelection({ dispatchId: item.id, after: null })}
              >
                {item.owner_name} · {item.id.slice(0, 8)}
              </button>
            ))}
          </nav>
          {responsibility ? (
            <details className="rounded border border-bright/40 px-2 py-1.5 text-xs text-sec">
              <summary className="cursor-pointer">
                {t('actionCenter.message.responsibility')} · {responsibility.owner_name} ·{' '}
                {t(`actionCenter.activity.${responsibility.state}`, {
                  worker: responsibility.owner_name,
                  ago: '',
                })}
              </summary>
              <p className="mt-2 whitespace-pre-wrap break-words">{responsibility.text}</p>
            </details>
          ) : null}
        </div>
      ) : null}
      <ul className="max-h-80 space-y-2 overflow-auto">
        {visible.map((message) => (
          <li key={message.id} id={`${messagePrefix}-${message.id}`}>
            <details className="rounded border border-bright/40 px-2 py-1.5">
              <summary className="cursor-pointer break-words text-xs text-sec">
                {t(`actionCenter.message.${message.kind}`)} · {message.dispatch_id.slice(0, 8)} ·{' '}
                {t(`actionCenter.message.${message.delivery_state}`)}
                <span className="mt-1 block line-clamp-2 text-ter">{message.text}</span>
              </summary>
              <p className="mt-2 whitespace-pre-wrap break-words text-xs text-pri">
                {message.text}
              </p>
              <p className="mt-2 break-all text-[11px] text-ter">
                {agentName(message.from_agent_id)} → {agentName(message.recipient_agent_id)}
              </p>
              {message.reply_to ? (
                <p className="mt-2 text-xs text-sec">
                  {messagesById.has(message.reply_to) ? (
                    <button
                      type="button"
                      className="text-accent underline"
                      onClick={() => {
                        const item = document.getElementById(`${messagePrefix}-${message.reply_to}`)
                        const details = item?.querySelector('details')
                        if (details) details.open = true
                        item?.scrollIntoView({ block: 'nearest' })
                        item?.querySelector('summary')?.focus()
                      }}
                    >
                      {t('actionCenter.message.replyTo')}
                    </button>
                  ) : (
                    t('actionCenter.message.replyTo')
                  )}
                  {messagesById.get(message.reply_to)?.text ? (
                    <span className="mt-1 block line-clamp-2">
                      {messagesById.get(message.reply_to)?.text}
                    </span>
                  ) : null}
                </p>
              ) : null}
              {message.delivery_error ? (
                <p className="mt-1 break-words text-xs text-sec">{message.delivery_error}</p>
              ) : null}
              {!selection ? (
                <button
                  type="button"
                  className="mt-2 text-xs text-accent"
                  onClick={() => setSelection({ dispatchId: message.dispatch_id, after: null })}
                >
                  {t('actionCenter.message.history')}
                </button>
              ) : null}
            </details>
          </li>
        ))}
      </ul>
      {loading ? (
        <p role="status" className="mt-2 text-xs text-ter">
          {t('actionCenter.loading')}
        </p>
      ) : null}
      {selection && currentHistory?.next !== null && currentHistory?.next !== undefined ? (
        <button
          type="button"
          disabled={loading}
          className="mt-2 text-xs text-accent disabled:opacity-50"
          onClick={() =>
            setSelection({ dispatchId: selection.dispatchId, after: currentHistory.next as string })
          }
        >
          {t('actionCenter.message.more')}
        </button>
      ) : null}
    </section>
  )
}
