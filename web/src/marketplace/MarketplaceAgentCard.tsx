import { Bookmark } from 'lucide-react'
import { memo, useCallback } from 'react'

import type { MarketplaceAgentEntry } from '../api.js'
import { useI18n } from '../i18n.js'

interface MarketplaceAgentCardProps {
  agent: MarketplaceAgentEntry
  selected: boolean
  imported: boolean
  onSelect: (path: string) => void
}

const MarketplaceAgentCardComponent = ({
  agent,
  selected,
  imported,
  onSelect,
}: MarketplaceAgentCardProps) => {
  const { t } = useI18n()
  const handleClick = useCallback(() => onSelect(agent.path), [agent.path, onSelect])
  const tagline = agent.vibe?.trim() ? agent.vibe : agent.description
  const importedLabel = t('marketplace.importedBadge')
  const displayName = agent.displayName ?? agent.name
  const nameTitle = agent.nameOverflows ? displayName : undefined

  return (
    <button
      type="button"
      onClick={handleClick}
      data-testid="marketplace-agent-card"
      data-agent-path={agent.path}
      data-imported={imported ? 'true' : undefined}
      data-selected={selected ? 'true' : undefined}
      className="marketplace-card flex w-full cursor-pointer flex-col gap-2 rounded-xl border p-3.5 text-left outline-none transition-all duration-200 ease-out focus-visible:ring-2 focus-visible:ring-offset-0 active:scale-[0.98]"
      style={{
        ['--tw-ring-color' as string]: 'color-mix(in oklab, var(--accent) 55%, transparent)',
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-bright bg-3 text-base shadow-sm">
            {agent.emoji || '🤖'}
          </div>
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-sm font-semibold text-pri" title={nameTitle}>
              {displayName}
            </span>
          </div>
        </div>
        {imported ? (
          <span
            role="status"
            aria-label={importedLabel}
            title={importedLabel}
            data-testid="marketplace-agent-imported"
            className="flex shrink-0 items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[9px] font-semibold tracking-wide uppercase transition-colors"
            style={{
              background: selected
                ? 'var(--accent)'
                : 'color-mix(in oklab, var(--accent) 15%, transparent)',
              color: selected ? '#ffffff' : 'var(--accent)',
              border: selected
                ? 'none'
                : '1px solid color-mix(in oklab, var(--accent) 25%, transparent)',
            }}
          >
            <Bookmark size={9} aria-hidden />
            <span className="max-sm:hidden">{importedLabel}</span>
          </span>
        ) : null}
      </div>
      <p className="line-clamp-2 text-xs leading-normal text-sec mt-1">{tagline}</p>
    </button>
  )
}

export const MarketplaceAgentCard = memo(MarketplaceAgentCardComponent)
