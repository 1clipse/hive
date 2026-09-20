/**
 * Outbound completion/attention webhook. The user supplies a single URL (stored
 * in app_state); the runtime POSTs a small JSON payload on server-side lifecycle
 * events so they can wire their own Slack / Discord / Feishu / ntfy / Telegram
 * without Hive taking on a relay, mobile app, or account system.
 *
 * Best-effort by design: fire-and-forget with a timeout, all errors swallowed —
 * a flaky webhook must never block or fail a report/exit. This is a personal,
 * local-trust setting: the URL is whatever the user typed, and a 127.0.0.1-bound
 * runtime can reach localhost/intranet, so we only enforce an http(s) scheme and
 * leave the rest to the operator (documented in the Settings UI).
 */
export const WEBHOOK_URL_KEY = 'notifications.webhook-url'

export type WebhookEventType = 'report_received' | 'agent_stopped' | 'workflow_finished'

export interface WebhookEvent {
  type: WebhookEventType
  workspaceId: string
  agentId?: string
  agentName?: string
  summary?: string
  at: number
}

export const readWebhookUrl = (raw: string | null | undefined): string | null => {
  const trimmed = raw?.trim()
  return trimmed ? trimmed : null
}

const isHttpUrl = (raw: string): boolean => {
  try {
    const url = new URL(raw)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

interface WebhookNotifierOptions {
  getUrl: () => string | null
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export const createWebhookNotifier = ({
  getUrl,
  fetchImpl = fetch,
  timeoutMs = 5000,
}: WebhookNotifierOptions) => {
  const notify = (event: WebhookEvent): void => {
    const url = readWebhookUrl(getUrl())
    if (!url || !isHttpUrl(url)) return

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    void fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(event),
      signal: controller.signal,
    })
      .catch(() => {
        // Personal-trust, best-effort: a dead or slow webhook must not affect
        // the report/exit path that triggered it.
      })
      .finally(() => clearTimeout(timer))
  }
  return { notify }
}

export type WebhookNotifier = ReturnType<typeof createWebhookNotifier>
