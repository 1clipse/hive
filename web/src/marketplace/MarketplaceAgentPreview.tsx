import DOMPurify from 'isomorphic-dompurify'
import { ExternalLink } from 'lucide-react'
import { marked } from 'marked'
import { useEffect, useMemo, useState } from 'react'

import type { MarketplaceAgentDetail, MarketplaceAgentEntry } from '../api.js'
import { useI18n } from '../i18n.js'
import { localizeMarketplaceCategory } from './categoryLabels.js'

// marked@18 parse() returns string when async:false. Pass the option per-call
// so a future upgrade that flips the default doesn't silently start returning
// Promise objects that DOMPurify happily stringifies to "[object Promise]".
marked.setOptions({ breaks: false, gfm: true })

const renderMarkdownToSafeHtml = (body: string): string => {
  try {
    const rawHtml = marked.parse(body, { async: false })
    if (typeof rawHtml !== 'string') {
      // Defensive: marked v18 with async:false always returns string. If we
      // ever land here, fail loudly instead of rendering "[object Promise]".
      throw new Error('marked.parse returned a non-string with async:false')
    }
    return DOMPurify.sanitize(rawHtml, {
      USE_PROFILES: { html: true },
      ALLOWED_ATTR: ['href', 'name', 'target', 'rel', 'title', 'class', 'id'],
    })
  } catch (error) {
    console.error('Failed to parse marketplace markdown:', error)
    return '<p class="text-ter">Failed to parse agent preview document.</p>'
  }
}

interface MarketplaceAgentPreviewProps {
  agent: MarketplaceAgentEntry
  sourceRepo: string
  loadAgent: (path: string) => Promise<MarketplaceAgentDetail>
  onImport: (detail: { name: string; description: string }) => void
}

const MarketplaceAgentPreviewSkeleton = () => (
  <div className="flex flex-col gap-4 animate-pulse py-2">
    <div className="h-4 bg-3 rounded w-1/3" />
    <div className="h-3 bg-3 rounded w-3/4" />
    <div className="space-y-3 pt-4 border-t border-bright/10">
      <div className="h-3 bg-3 rounded w-full" />
      <div className="h-3 bg-3 rounded w-5/6" />
      <div className="h-3 bg-3 rounded w-4/5" />
      <div className="h-3 bg-3 rounded w-2/3" />
    </div>
  </div>
)

export const MarketplaceAgentPreview = ({
  agent,
  sourceRepo,
  loadAgent,
  onImport,
}: MarketplaceAgentPreviewProps) => {
  const { t, language } = useI18n()
  const [state, setState] = useState<{
    status: 'loading' | 'loaded' | 'error'
    detail: MarketplaceAgentDetail | null
    error: string | null
  }>({ status: 'loading', detail: null, error: null })

  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading', detail: null, error: null })
    loadAgent(agent.path)
      .then((detail) => {
        if (cancelled) return
        setState({ status: 'loaded', detail, error: null })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setState({
          status: 'error',
          detail: null,
          error: error instanceof Error ? error.message : 'unknown',
        })
      })
    return () => {
      cancelled = true
    }
  }, [agent.path, loadAgent])

  const sourceUrl = `https://github.com/${sourceRepo}/blob/HEAD/${agent.path}`

  const renderedHtml = useMemo(() => {
    if (state.status !== 'loaded' || !state.detail) return null
    return renderMarkdownToSafeHtml(state.detail.body)
  }, [state])

  return (
    <div
      key={agent.path}
      data-testid="marketplace-agent-preview"
      className="flex h-full flex-col gap-4 border-l px-5 py-4 animate-fade-in"
      style={{ borderColor: 'var(--border)' }}
    >
      <header className="flex items-start gap-4">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-accent/20 to-accent/5 border border-accent/30 shadow-inner text-2xl shadow-[inset_0_1px_1px_rgba(255,255,255,0.1)]">
          {agent.emoji || '🤖'}
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex items-center gap-2">
            <h3 className="min-w-0 break-words text-base font-bold text-pri leading-snug">
              {agent.displayName ?? agent.name}
            </h3>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center rounded bg-3 px-2 py-0.5 text-[9px] font-semibold text-sec uppercase tracking-wider border border-bright/10">
              {localizeMarketplaceCategory(agent.category, language)}
            </span>
          </div>
        </div>
      </header>

      <div
        className="scroll-y min-h-0 flex-1 rounded-xl px-4 py-3.5 text-xs leading-relaxed"
        style={{ background: 'var(--bg-2)' }}
      >
        {state.status === 'loading' ? <MarketplaceAgentPreviewSkeleton /> : null}
        {state.status === 'error' ? (
          <div className="flex flex-col items-center justify-center h-full text-center p-4">
            <p className="text-ter text-sm font-medium">{t('marketplace.loadFailed')}</p>
            <p className="text-xs text-sec mt-1 bg-3 px-2 py-1 rounded border border-bright/20 font-mono">
              {state.error}
            </p>
          </div>
        ) : null}
        {state.status === 'loaded' && renderedHtml ? (
          <div
            className="marketplace-prose"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: marked output sanitized via DOMPurify with restricted attribute allowlist
            dangerouslySetInnerHTML={{ __html: renderedHtml }}
          />
        ) : null}
      </div>

      <footer className="flex items-center justify-between gap-4 pt-2 border-t border-bright/10">
        <a
          href={sourceUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex items-center gap-1.5 text-xs text-sec transition-colors hover:text-pri"
        >
          {t('marketplace.viewSource')}
          <ExternalLink size={12} aria-hidden />
        </a>
        <button
          type="button"
          disabled={state.status !== 'loaded' || !state.detail}
          onClick={() => {
            if (!state.detail) return
            onImport({ name: agent.name, description: state.detail.body.trim() })
          }}
          data-testid="marketplace-import-button"
          className="icon-btn icon-btn--primary px-4 py-2 text-xs font-semibold rounded-lg shadow-md hover:shadow-lg transition-all"
        >
          {t('marketplace.importButton')}
        </button>
      </footer>
    </div>
  )
}
