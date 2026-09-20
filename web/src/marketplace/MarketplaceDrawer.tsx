import * as Dialog from '@radix-ui/react-dialog'
import { ChevronLeft, Search, X } from 'lucide-react'
import { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react'

import type { MarketplaceAgentEntry } from '../api.js'
import { useI18n } from '../i18n.js'
import { useIsMobile } from '../mobile/layout-mode.js'
import { localizeMarketplaceCategory, sortCategoriesForDisplay } from './categoryLabels.js'
import { MarketplaceAgentCard } from './MarketplaceAgentCard.js'
import { MarketplaceAgentPreview } from './MarketplaceAgentPreview.js'
import { MarketplaceCategoryTree } from './MarketplaceCategoryTree.js'
import { useMarketplace } from './useMarketplace.js'

// Renders the source-label template (EN: "Curated from {repo}", ZH: "由
// {repo} 提供") with the repo slug in DM Mono — a github owner/repo path
// reads as code, not prose, so the slash + descenders don't collide with
// Inter's body type.
const REPO_PLACEHOLDER = 'REPO'
const renderSourceLabel = (
  t: (key: 'marketplace.sourceLabel', values: { repo: string }) => string,
  repo: string
) => {
  const template = t('marketplace.sourceLabel', { repo: REPO_PLACEHOLDER })
  const [before, after = ''] = template.split(REPO_PLACEHOLDER)
  return (
    <>
      {before}
      <span className="mono">{repo}</span>
      {after}
    </>
  )
}

// Categories surfaced by default in the marketplace. 200+ agents include many
// off-topic roles (marketing, game-dev, academic, etc.) that a CLI-coding tool
// doesn't need front-and-center. User can click "Show all categories" to
// surface the rest.
const CORE_CATEGORIES: ReadonlySet<string> = new Set([
  'engineering',
  'design',
  'product',
  'testing',
  'project-management',
  'specialized',
  'integrations',
])

interface MarketplaceDrawerProps {
  open: boolean
  onClose: () => void
  onImport: (detail: { name: string; description: string }) => void
  importedNames?: ReadonlySet<string>
}

// Phone-only category selector: the desktop sidebar tree becomes a horizontal
// chip rail above the agent grid.
const CategoryChip = ({
  active,
  label,
  onClick,
}: {
  active: boolean
  label: string
  onClick: () => void
}) => (
  <button
    type="button"
    onClick={onClick}
    data-active={active ? 'true' : 'false'}
    className="min-h-9 shrink-0 whitespace-nowrap rounded-full border px-3 py-1.5 text-sm"
    style={{
      borderColor: active ? 'transparent' : 'var(--border)',
      background: active ? 'color-mix(in oklab, var(--accent) 16%, transparent)' : 'var(--bg-2)',
      color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
    }}
  >
    {label}
  </button>
)

interface IndexedMarketplaceAgent {
  agent: MarketplaceAgentEntry
  searchText: string
}

export const MarketplaceDrawer = ({
  open,
  onClose,
  onImport,
  importedNames,
}: MarketplaceDrawerProps) => {
  const { t, language } = useI18n()
  const isMobile = useIsMobile()
  const { manifestState, loadAgent } = useMarketplace(language, open)
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null)
  const [selectedAgent, setSelectedAgent] = useState<MarketplaceAgentEntry | null>(null)
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query)
  const [showAllCategories, setShowAllCategories] = useState(true)

  // Switching UI language repoints `useMarketplace` to the other repo's
  // manifest. Anything that referenced an entry by path/name in the old
  // language would silently mis-render (preview would 404 against the new
  // fs tree), so drop selection on language change.
  // biome-ignore lint/correctness/useExhaustiveDependencies: language is the trigger; setters are stable
  useEffect(() => {
    setSelectedAgent(null)
    setSelectedCategory(null)
    setQuery('')
  }, [language])

  const handleOpenChange = (next: boolean) => {
    if (!next) onClose()
  }

  const manifest = manifestState.data

  const indexedAgents = useMemo((): readonly IndexedMarketplaceAgent[] => {
    if (!manifest) return []
    return manifest.agents.map((agent) => ({
      agent,
      searchText: `${agent.name}\n${agent.description}`.toLowerCase(),
    }))
  }, [manifest])

  const agentsByPath = useMemo(() => {
    const agents = new Map<string, MarketplaceAgentEntry>()
    if (!manifest) return agents
    for (const agent of manifest.agents) {
      agents.set(agent.path, agent)
    }
    return agents
  }, [manifest])

  const categoryCounts = useMemo(() => {
    if (!manifest) return {}
    const counts: Record<string, number> = {}
    for (const agent of manifest.agents) {
      counts[agent.category] = (counts[agent.category] ?? 0) + 1
    }
    return counts
  }, [manifest])

  const visibleCategories = useMemo(() => {
    if (!manifest) return [] as readonly string[]
    const filtered = showAllCategories
      ? manifest.categories
      : manifest.categories.filter((category) => CORE_CATEGORIES.has(category))
    return sortCategoriesForDisplay(filtered, language)
  }, [manifest, showAllCategories, language])

  const hiddenCategoryCount = useMemo(() => {
    if (!manifest) return 0
    return manifest.categories.length - visibleCategories.length
  }, [manifest, visibleCategories])

  const filteredAgents = useMemo(() => {
    const lower = deferredQuery.trim().toLowerCase()
    const agents: MarketplaceAgentEntry[] = []
    for (const { agent, searchText } of indexedAgents) {
      if (selectedCategory) {
        if (agent.category !== selectedCategory) continue
      } else if (!showAllCategories && !CORE_CATEGORIES.has(agent.category)) {
        continue
      }
      if (!lower || searchText.includes(lower)) agents.push(agent)
    }
    return agents
  }, [indexedAgents, deferredQuery, selectedCategory, showAllCategories])

  const handleSelectAgent = useCallback(
    (path: string) => {
      const agent = agentsByPath.get(path)
      if (agent) setSelectedAgent(agent)
    },
    [agentsByPath]
  )

  const handleToggleShowAll = () => {
    setShowAllCategories((current) => {
      const next = !current
      if (!next) {
        // Collapsing back to core view: if the selected category or selected
        // agent's category is now hidden, clear them — otherwise the preview
        // pane lingers on an agent whose card is no longer in the grid.
        if (selectedCategory && !CORE_CATEGORIES.has(selectedCategory)) {
          setSelectedCategory(null)
        }
        if (selectedAgent && !CORE_CATEGORIES.has(selectedAgent.category)) {
          setSelectedAgent(null)
        }
      }
      return next
    })
  }

  const handleImport = (detail: { name: string; description: string }) => {
    onImport(detail)
    setSelectedAgent(null)
    onClose()
  }

  // Shared by the desktop grid pane and the mobile single-column list.
  const agentGridContent =
    manifestState.status === 'loading' ? (
      <div className="flex h-full items-center justify-center text-sm text-ter">
        {t('marketplace.loading')}
      </div>
    ) : manifestState.status === 'error' ? (
      <div className="flex h-full items-center justify-center text-sm text-ter">
        {t('marketplace.loadFailed')}: {manifestState.error}
      </div>
    ) : filteredAgents.length === 0 ? (
      <div className="flex h-full items-center justify-center text-sm text-ter">
        {t('marketplace.empty')}
      </div>
    ) : (
      <div
        className="grid gap-3"
        style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}
      >
        {filteredAgents.map((agent) => (
          <MarketplaceAgentCard
            key={agent.path}
            agent={agent}
            selected={selectedAgent?.path === agent.path}
            imported={importedNames?.has(agent.name) ?? false}
            onSelect={handleSelectAgent}
          />
        ))}
      </div>
    )

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay
          data-testid="marketplace-overlay"
          className="app-overlay fixed inset-0 z-40"
        />
        <div className="pointer-events-none fixed inset-0 z-50 grid place-items-center p-4 max-md:items-end max-md:p-0">
          <Dialog.Content
            data-testid="marketplace-content"
            data-mobile={isMobile || undefined}
            className={`${isMobile ? 'dialog-slide-up marketplace-sheet' : 'dialog-scale-pop'} elev-2 pointer-events-auto flex w-full flex-col rounded-lg border max-md:rounded-b-none max-md:rounded-t-xl`}
            style={{
              background: 'var(--bg-elevated)',
              borderColor: 'var(--border-bright)',
              width: isMobile ? '100vw' : 'min(1280px, calc(100vw - 32px))',
              // Fixed height — without this the drawer expands to fit content,
              // so the dialog jumps in height every time the user changes
              // category / search / language. Internal sections (sidebar,
              // grid, preview) own their own overflow.
              height: isMobile ? '92dvh' : 'min(820px, calc(100vh - 48px))',
            }}
          >
            <header
              className="flex shrink-0 items-center justify-between gap-4 border-b px-5 py-4 max-md:px-4 max-md:py-3"
              style={{ borderColor: 'var(--border)' }}
            >
              <div className="flex min-w-0 flex-col gap-0.5">
                <Dialog.Title className="text-lg font-semibold text-pri">
                  {t('marketplace.title')}
                </Dialog.Title>
                <Dialog.Description className="truncate text-xs text-ter">
                  {manifest ? renderSourceLabel(t, manifest.source.repo) : ' '}
                </Dialog.Description>
              </div>
              <div className="flex items-center gap-2">
                {/* Phones get a full-width search row below the header — a
                    fixed 288px box doesn't fit beside the title. */}
                {isMobile ? null : (
                  <div className="group relative flex w-72 items-center">
                    <Search
                      size={14}
                      aria-hidden
                      className="pointer-events-none absolute left-3 text-ter transition-colors group-focus-within:text-accent"
                    />
                    <input
                      type="search"
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      placeholder={t('marketplace.searchPlaceholder')}
                      data-testid="marketplace-search"
                      className="input"
                      // `.input` ships a `padding: 8px 12px` shorthand in
                      // unlayered CSS that out-cascades a Tailwind `pl-9`
                      // utility in v4. Inline style is the only reliable
                      // override here without restructuring globals.css.
                      style={{ paddingLeft: '36px', borderRadius: '10px' }}
                    />
                  </div>
                )}
                <Dialog.Close asChild>
                  <button
                    type="button"
                    aria-label={t('marketplace.close')}
                    data-testid="marketplace-close"
                    className="flex h-7 w-7 items-center justify-center rounded text-sec hover:bg-3 hover:text-pri max-md:h-10 max-md:w-10 max-md:rounded-md transition-all duration-200 hover:scale-105 active:scale-95"
                    style={isMobile ? { background: 'var(--bg-2)' } : undefined}
                  >
                    <X size={isMobile ? 18 : 14} aria-hidden />
                  </button>
                </Dialog.Close>
              </div>
            </header>
            {isMobile ? (
              <div className="shrink-0 border-b px-4 py-2" style={{ borderColor: 'var(--border)' }}>
                <div className="group relative flex items-center">
                  <Search
                    size={14}
                    aria-hidden
                    className="pointer-events-none absolute left-3 text-ter transition-colors group-focus-within:text-accent"
                  />
                  <input
                    type="search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={t('marketplace.searchPlaceholder')}
                    data-testid="marketplace-search"
                    className="input w-full"
                    style={{ paddingLeft: '36px', borderRadius: '10px' }}
                  />
                </div>
              </div>
            ) : null}
            {isMobile ? (
              <div className="relative flex min-h-0 flex-1 flex-col">
                {/* Category chip rail — the sidebar tree has no room on a phone. */}
                <div
                  className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-b px-4 py-2"
                  style={{ borderColor: 'var(--border)' }}
                  data-testid="marketplace-category-chips"
                >
                  <CategoryChip
                    active={selectedCategory === null}
                    label={t('marketplace.allCategories')}
                    onClick={() => {
                      setSelectedCategory(null)
                      setSelectedAgent(null)
                    }}
                  />
                  {visibleCategories.map((category) => (
                    <CategoryChip
                      key={category}
                      active={selectedCategory === category}
                      label={localizeMarketplaceCategory(category, language)}
                      onClick={() => {
                        setSelectedCategory(category)
                        setSelectedAgent(null)
                        setQuery('')
                      }}
                    />
                  ))}
                  {hiddenCategoryCount > 0 || showAllCategories ? (
                    <CategoryChip
                      active={false}
                      label={
                        showAllCategories
                          ? t('marketplace.showCoreOnly')
                          : t('marketplace.showAllCategories', { count: hiddenCategoryCount })
                      }
                      onClick={handleToggleShowAll}
                    />
                  ) : null}
                </div>
                <section
                  key={selectedCategory ?? '__all__'}
                  className="scroll-y min-h-0 flex-1 px-4 py-3"
                  data-testid="marketplace-agent-grid"
                >
                  {agentGridContent}
                </section>
                {/* Tapping a card slides the preview over the list — there is
                    no third pane to put it beside. */}
                {selectedAgent && manifest ? (
                  <div
                    className="absolute inset-0 z-10 flex flex-col animate-slide-in-right"
                    style={{ background: 'var(--bg-elevated)' }}
                    data-testid="marketplace-preview-overlay"
                  >
                    <button
                      type="button"
                      onClick={() => setSelectedAgent(null)}
                      data-testid="marketplace-preview-back"
                      className="flex min-h-11 shrink-0 items-center gap-1.5 border-b px-4 text-sm text-sec"
                      style={{ borderColor: 'var(--border)' }}
                    >
                      <ChevronLeft size={16} aria-hidden />
                      {t('marketplace.backToList')}
                    </button>
                    <div className="min-h-0 flex-1">
                      <MarketplaceAgentPreview
                        agent={selectedAgent}
                        sourceRepo={manifest.source.repo}
                        loadAgent={loadAgent}
                        onImport={handleImport}
                      />
                    </div>
                  </div>
                ) : null}
              </div>
            ) : (
              <div
                className="flex min-h-0 flex-1 transition-all duration-300 ease-out"
                style={{
                  background: 'var(--bg-elevated)',
                }}
              >
                <aside
                  className="scroll-y min-h-0 w-[200px] shrink-0 border-r px-4 py-4"
                  style={{ borderColor: 'var(--border)' }}
                >
                  {manifest ? (
                    <MarketplaceCategoryTree
                      categories={visibleCategories}
                      selected={selectedCategory}
                      onSelect={(category) => {
                        setSelectedCategory(category)
                        setSelectedAgent(null)
                        setQuery('')
                      }}
                      counts={categoryCounts}
                      showAll={showAllCategories}
                      onToggleShowAll={handleToggleShowAll}
                      hiddenCount={hiddenCategoryCount}
                    />
                  ) : null}
                </aside>
                <section
                  key={selectedCategory ?? '__all__'}
                  className="scroll-y min-h-0 flex-1 px-5 py-4"
                  data-testid="marketplace-agent-grid"
                >
                  {agentGridContent}
                </section>
                <aside
                  className="min-h-0 shrink-0 transition-all duration-300 ease-in-out border-l overflow-hidden"
                  style={{
                    borderColor: 'var(--border)',
                    width: selectedAgent ? '380px' : '0px',
                    opacity: selectedAgent ? 1 : 0,
                    pointerEvents: selectedAgent ? 'auto' : 'none',
                  }}
                >
                  {selectedAgent && manifest ? (
                    <MarketplaceAgentPreview
                      agent={selectedAgent}
                      sourceRepo={manifest.source.repo}
                      loadAgent={loadAgent}
                      onImport={handleImport}
                    />
                  ) : null}
                </aside>
              </div>
            )}
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
