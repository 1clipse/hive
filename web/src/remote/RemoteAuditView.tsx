import { Activity, ChevronDown, ChevronRight } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import { listRemoteAudit, type RemoteAuditEntry } from '../api.js'
import type { TranslationKey } from '../i18n.js'
import { useI18n } from '../i18n.js'

const resultKey: Record<RemoteAuditEntry['result'], TranslationKey> = {
  ok: 'remote.audit.result.ok',
  rejected: 'remote.audit.result.rejected',
  error: 'remote.audit.result.error',
}

/** Coarse relative time — returns a short bare unit string. */
const relativeTime = (ms: number): string => {
  const delta = Math.max(0, Date.now() - ms)
  const secs = Math.floor(delta / 1000)
  if (secs < 60) return '<1m'
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h`
  return `${Math.floor(hrs / 24)}d`
}

/** Collapsed-by-default remote activity stream. Opening it loads the newest
 *  100 audit rows; rejected/error rows are color-flagged with their reason,
 *  and ws_input rows show the bounded preview + byte count. */
export const RemoteAuditView = () => {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [entries, setEntries] = useState<RemoteAuditEntry[] | null>(null)
  const [error, setError] = useState(false)

  const load = useCallback(async () => {
    setError(false)
    try {
      setEntries(await listRemoteAudit(100))
    } catch {
      setError(true)
    }
  }, [])

  useEffect(() => {
    if (open) void load()
  }, [open, load])

  return (
    <div className="mt-2" data-testid="remote-audit-view">
      <button
        type="button"
        data-testid="remote-audit-toggle"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-xs font-medium text-sec transition-colors hover:bg-3 hover:text-pri"
        aria-expanded={open}
      >
        <Activity size={12} aria-hidden className="shrink-0" />
        <span className="flex-1 text-left">
          {open ? t('remote.audit.hide') : t('remote.audit.show')}
        </span>
        {open ? (
          <ChevronDown size={12} aria-hidden className="shrink-0 text-ter" />
        ) : (
          <ChevronRight size={12} aria-hidden className="shrink-0 text-ter" />
        )}
      </button>

      {open ? (
        <div className="mt-1.5">
          {error ? (
            <div
              className="rounded px-2 py-2 text-xs"
              style={{
                color: 'var(--text-error)',
                background: 'color-mix(in oklab, var(--status-red) 8%, transparent)',
              }}
              role="alert"
            >
              {t('remote.audit.loadFailed')}
            </div>
          ) : !entries || entries.length === 0 ? (
            <div className="px-2 py-2 text-xs text-ter">{t('remote.audit.empty')}</div>
          ) : (
            <ul
              className="scroll-y flex max-h-[160px] flex-col gap-px rounded border"
              style={{ borderColor: 'var(--border)', background: 'var(--bg-0)' }}
            >
              {entries.map((entry) => {
                const isError = entry.result !== 'ok'
                return (
                  <li
                    key={entry.id}
                    className="flex items-center gap-2 px-2.5 py-1.5 text-xs"
                    data-testid={`remote-audit-row-${entry.id}`}
                    style={
                      isError
                        ? { background: 'color-mix(in oklab, var(--status-red) 6%, transparent)' }
                        : undefined
                    }
                  >
                    {/* Result dot */}
                    <span
                      className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                      style={{
                        background: isError ? 'var(--status-red)' : 'var(--status-green)',
                      }}
                      aria-hidden
                    />
                    {/* Action + endpoint */}
                    <span className="min-w-0 flex-1 truncate">
                      <span className="font-medium text-pri">{entry.action}</span>
                      {entry.endpoint ? (
                        <span className="ml-1 text-ter">{entry.endpoint}</span>
                      ) : null}
                      {entry.preview ? (
                        <span className="ml-1 text-ter">· {entry.preview}</span>
                      ) : null}
                      {typeof entry.byteCount === 'number' ? (
                        <span className="ml-1 text-ter">
                          · {t('remote.audit.bytes', { count: entry.byteCount })}
                        </span>
                      ) : null}
                    </span>
                    {/* Result badge */}
                    {isError ? (
                      <span
                        className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium"
                        style={{
                          color: 'color-mix(in oklab, var(--status-red) 55%, white)',
                          background: 'color-mix(in oklab, var(--status-red) 14%, transparent)',
                        }}
                      >
                        {t(resultKey[entry.result])}
                        {entry.rejectReason ? ` · ${entry.rejectReason}` : ''}
                      </span>
                    ) : null}
                    {/* Timestamp */}
                    <span className="shrink-0 tabular-nums text-ter">{relativeTime(entry.ts)}</span>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  )
}
