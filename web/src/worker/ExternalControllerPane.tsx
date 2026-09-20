import { Check, Copy, MessageSquare, Plus, TriangleAlert } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import {
  type ExternalControllerStatus,
  getApiTransport,
  getExternalController,
  updateExternalController,
} from '../api.js'
import { useI18n } from '../i18n.js'
import { copyTextToClipboard } from '../lib/clipboard.js'

const buttonFocus =
  'min-h-11 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]'

export const ExternalControllerPane = ({
  workspaceId,
  workspaceName,
  memberCount,
  onAddMember,
}: {
  workspaceId: string
  workspaceName: string
  memberCount: number
  onAddMember: () => void
}) => {
  const { t } = useI18n()
  const [status, setStatus] = useState<ExternalControllerStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState<'install' | 'connect' | 'reports' | null>(null)
  const mutationGeneration = useRef(0)
  const heading = useRef<HTMLHeadingElement>(null)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => () => clearTimeout(copyTimer.current), [])
  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      const generation = mutationGeneration.current
      try {
        const next = await getExternalController(workspaceId)
        if (!disposed && generation === mutationGeneration.current) {
          setStatus(next)
          setError(null)
        }
      } catch (cause) {
        if (!disposed && generation === mutationGeneration.current)
          setError(cause instanceof Error ? cause.message : String(cause))
      }
      if (!disposed) timer = setTimeout(poll, 3000)
    }
    void poll()
    return () => {
      disposed = true
      clearTimeout(timer)
    }
  }, [workspaceId])

  const act = async (action: 'confirm' | 'disconnect', requestId?: string) => {
    setBusy(true)
    setActionError(null)
    try {
      const next = await updateExternalController(workspaceId, action, requestId)
      setStatus(next)
      setError(null)
      heading.current?.focus()
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      // Discard polls started before this mutation settled; they may contain the old binding.
      mutationGeneration.current += 1
      setBusy(false)
    }
  }
  const copy = async (kind: 'install' | 'connect' | 'reports') => {
    try {
      await copyTextToClipboard(
        kind === 'install'
          ? installCommand
          : t(kind === 'connect' ? 'controller.connectPrompt' : 'controller.readReportsPrompt', {
              name: workspaceName,
              id: workspaceId,
            })
      )
      clearTimeout(copyTimer.current)
      setCopied(kind)
      copyTimer.current = setTimeout(() => setCopied(null), 2500)
      setActionError(null)
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause))
    }
  }
  const remote = getApiTransport().requiresUiSession === false
  const installCommand = `codex mcp add hive-controller -- hive mcp --controller${status?.runtime_port ? ` --base-url http://127.0.0.1:${status.runtime_port}` : ''}`
  const disabled = busy || !!error || remote

  return (
    <section
      aria-label={t('controller.title')}
      className="flex min-h-0 flex-1 flex-col overflow-y-auto p-5 text-sm text-sec"
    >
      <div className="mx-auto w-full max-w-xl">
        <h2
          ref={heading}
          tabIndex={-1}
          className="flex items-center gap-2 text-base font-semibold text-pri focus:outline-none"
        >
          <MessageSquare size={19} aria-hidden />
          {t('controller.title')}
        </h2>
        {(error || actionError) && (
          <p role="alert" className="mt-4 break-words text-danger">
            {actionError || error}
          </p>
        )}
        {!status?.thread_id && status?.notification_error && !actionError && (
          <p role="alert" className="mt-4 break-words text-danger">
            {status.notification_error}
          </p>
        )}
        {!status && !error && (
          <p role="status" className="mt-4">
            {t('controller.loading')}
          </p>
        )}
        {remote && <p className="mt-3 leading-relaxed">{t('controller.localOnly')}</p>}
        {status && !remote && !status.thread_id && !status.pending_request && (
          <>
            <p className="mt-2 leading-relaxed">{t('controller.setupIntro')}</p>
            <ol className="mt-6 list-decimal space-y-6 pl-5 marker:text-sec">
              <li className="pl-1">
                <h3 className="font-medium text-pri">{t('controller.installStep')}</h3>
                <p className="mt-2 leading-relaxed">{t('controller.installHint')}</p>
                <code className="mt-3 block whitespace-pre-wrap break-all rounded bg-2 p-3 text-xs leading-relaxed text-pri">
                  {installCommand}
                </code>
                <button
                  type="button"
                  className={`icon-btn mt-2 inline-flex items-center gap-2 ${buttonFocus}`}
                  onClick={() => void copy('install')}
                >
                  {copied === 'install' ? (
                    <Check size={15} aria-hidden />
                  ) : (
                    <Copy size={15} aria-hidden />
                  )}
                  {copied === 'install' ? t('controller.copied') : t('controller.copyInstall')}
                </button>
              </li>
              <li className="pl-1">
                <h3 className="font-medium text-pri">{t('controller.connectStep')}</h3>
                <p className="mt-2 leading-relaxed">{t('controller.connectStepHint')}</p>
                <button
                  type="button"
                  className={`icon-btn icon-btn--primary mt-3 inline-flex items-center gap-2 ${buttonFocus}`}
                  onClick={() => void copy('connect')}
                >
                  {copied === 'connect' ? (
                    <Check size={15} aria-hidden />
                  ) : (
                    <Copy size={15} aria-hidden />
                  )}
                  {copied === 'connect' ? t('controller.copied') : t('controller.copy')}
                </button>
                <p className="mt-2 text-xs leading-relaxed">{t('controller.returnToConfirm')}</p>
              </li>
            </ol>
          </>
        )}
        {status?.pending_request && (
          <div className="mt-6">
            <h3 className="font-medium text-pri">{t('controller.request')}</h3>
            <p className="mt-2 leading-relaxed">{t('controller.confirmHint')}</p>
            <p className="mt-3 break-all rounded bg-2 p-3 font-mono text-xs text-pri">
              {status.pending_request.thread_id}
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                disabled={disabled}
                className={`icon-btn icon-btn--primary ${buttonFocus}`}
                onClick={() => void act('confirm', status.pending_request?.id)}
              >
                {t('controller.confirm')}
              </button>
              <button
                type="button"
                disabled={disabled || !status.can_disconnect}
                className={`icon-btn ${buttonFocus}`}
                onClick={() => void act('disconnect')}
              >
                {t('controller.cancelRequest')}
              </button>
            </div>
          </div>
        )}
        {status?.thread_id && (
          <>
            <p className="mt-3 flex items-center gap-2 text-pri">
              <Check size={16} aria-hidden />
              {t('controller.bound')}
            </p>
            <div className="mt-5">
              <h3 className="font-medium text-pri">
                {t(memberCount === 0 ? 'controller.addFirstTitle' : 'controller.teamReadyTitle')}
              </h3>
              <p className="mt-2 leading-relaxed">
                {t(memberCount === 0 ? 'controller.addFirstHint' : 'controller.teamReadyHint')}
              </p>
              {memberCount === 0 && (
                <button
                  type="button"
                  className={`icon-btn icon-btn--primary mt-4 inline-flex items-center gap-2 ${buttonFocus}`}
                  onClick={onAddMember}
                >
                  <Plus size={16} aria-hidden />
                  {t('controller.addFirstMember')}
                </button>
              )}
            </div>
          </>
        )}
        {status?.thread_id && (status.pending_reports > 0 || status.notification_error) && (
          <div className="mt-6 border-t pt-4" style={{ borderColor: 'var(--border)' }}>
            {status.pending_reports > 0 && (
              <h3 className="font-medium text-pri" role="status">
                {t('controller.pendingReports', { count: status.pending_reports })}
              </h3>
            )}
            {status.notification_error && (
              <p role="alert" className="mt-2 flex items-start gap-2 break-words text-danger">
                <TriangleAlert size={16} aria-hidden className="mt-0.5 shrink-0" />
                <span className="min-w-0">
                  {t('controller.notificationError', { message: status.notification_error })}
                </span>
              </p>
            )}
            <p className="mt-2 leading-relaxed">{t('controller.readReportsHint')}</p>
            <button
              type="button"
              className={`icon-btn mt-3 inline-flex items-center gap-2 ${buttonFocus}`}
              onClick={() => void copy('reports')}
            >
              {copied === 'reports' ? (
                <Check size={15} aria-hidden />
              ) : (
                <Copy size={15} aria-hidden />
              )}
              {copied === 'reports' ? t('controller.copied') : t('controller.copyReadReports')}
            </button>
          </div>
        )}
        {status?.thread_id && (
          <details className="mt-6 border-t pt-4" style={{ borderColor: 'var(--border)' }}>
            <summary className={`cursor-pointer py-2 font-medium text-sec ${buttonFocus}`}>
              {t('controller.connectionDetails')}
            </summary>
            <p className="mt-2 break-all font-mono text-xs">{status.thread_id}</p>
            <button
              type="button"
              className={`icon-btn mt-3 ${buttonFocus}`}
              disabled={disabled || !status.can_disconnect}
              onClick={() => void act('disconnect')}
            >
              {t('controller.disconnect')}
            </button>
            {!status.can_disconnect && (
              <p className="mt-2 text-xs leading-relaxed">{t('controller.disconnectHint')}</p>
            )}
          </details>
        )}
        <span className="sr-only" role="status">
          {copied
            ? t('controller.copied')
            : status?.thread_id
              ? t('controller.bound')
              : status?.pending_request
                ? t('controller.request')
                : ''}
        </span>
      </div>
    </section>
  )
}
