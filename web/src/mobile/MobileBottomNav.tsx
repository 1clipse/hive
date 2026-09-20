import {
  ListChecks,
  type LucideIcon,
  Settings as SettingsIcon,
  Users,
  Workflow,
} from 'lucide-react'

import { useI18n } from '../i18n.js'

// Bottom-nav sections. The orchestrator ("chat") lives stacked above the workers
// inside the Team section, so there is no separate Chat tab — a phone keeps the
// whole team in one place. Tasks stays as the focused day-one secondary tab; the
// host may opt additional sections back in by passing them through `sections`.
export type MobileSection = 'team' | 'tasks' | 'flows' | 'settings'

export const MOBILE_SECTIONS: readonly MobileSection[] = [
  'team',
  'tasks',
  'flows',
  'settings',
] as const

const SECTION_ICON: Record<MobileSection, LucideIcon> = {
  team: Users,
  tasks: ListChecks,
  flows: Workflow,
  settings: SettingsIcon,
}

const SECTION_LABEL_KEY = {
  team: 'mobile.nav.team',
  tasks: 'mobile.nav.tasks',
  flows: 'mobile.nav.flows',
  settings: 'mobile.nav.settings',
} as const

export interface MobileBottomNavProps {
  active: MobileSection
  onSelect: (section: MobileSection) => void
  /** The visible tabs, in order. Lets the host drop Flows when it's disabled. */
  sections: readonly MobileSection[]
  /** Open root-task count, surfaced as a badge on the Tasks tab. */
  openTaskCount?: number
  /** Count of agents currently working, surfaced as a badge on the Team tab. */
  workingCount?: number
}

export const MobileBottomNav = ({
  active,
  onSelect,
  sections,
  openTaskCount = 0,
  workingCount = 0,
}: MobileBottomNavProps) => {
  const { t } = useI18n()
  return (
    <nav
      aria-label={t('mobile.nav.aria')}
      className="mobile-bottom-nav flex shrink-0 items-stretch"
      data-testid="mobile-bottom-nav"
      style={{ background: 'var(--bg-0)', borderTop: '1px solid var(--border)' }}
    >
      {sections.map((section) => {
        const Icon = SECTION_ICON[section]
        const label = t(SECTION_LABEL_KEY[section])
        const isActive = section === active
        const badge =
          section === 'tasks' && openTaskCount > 0
            ? openTaskCount
            : section === 'team' && workingCount > 0
              ? workingCount
              : 0
        return (
          <button
            type="button"
            key={section}
            aria-label={label}
            aria-current={isActive ? 'page' : undefined}
            data-testid={`mobile-nav-${section}`}
            data-active={isActive ? 'true' : undefined}
            onClick={() => onSelect(section)}
            className="mobile-bottom-nav__tab relative flex flex-1 cursor-pointer flex-col items-center justify-center gap-0.5 py-2 text-xs"
            style={{ color: isActive ? 'var(--text-primary)' : 'var(--text-tertiary)' }}
          >
            {isActive ? (
              <span
                aria-hidden
                className="absolute top-0 left-1/2 h-0.5 w-8 -translate-x-1/2 rounded-b"
                style={{ background: 'var(--accent)' }}
              />
            ) : null}
            <Icon size={20} aria-hidden />
            <span>{label}</span>
            {badge > 0 ? (
              <span
                className="absolute top-1 right-[calc(50%-18px)] inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 text-[11px] font-medium tabular-nums leading-none"
                data-testid={`mobile-nav-${section}-badge`}
                style={{ background: 'var(--accent)', color: '#ffffff' }}
              >
                {badge}
              </span>
            ) : null}
          </button>
        )
      })}
    </nav>
  )
}
