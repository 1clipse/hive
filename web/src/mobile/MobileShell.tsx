import { type ReactNode, useState } from 'react'

import { useMobileFocusMode } from './focus-mode.js'
import { MobileBottomNav, type MobileSection } from './MobileBottomNav.js'
import { MobileTopbar } from './MobileTopbar.js'
import { useVisualViewportHeight } from './use-viewport-height.js'

export interface MobileShellProps {
  /** Workspace switcher trigger for the topbar (active name + chevron). */
  workspaceSwitcher?: ReactNode
  /** Topbar chrome (open-in-editor / language / notifications). */
  topbarActions?: ReactNode
  /** Reconnect banner strip rendered under the topbar. */
  banner?: ReactNode
  /**
   * Full-bleed override (runtime offline). When present it replaces the whole
   * section area so the reconnect/offline page frames inside the shell chrome.
   */
  fullBleed?: ReactNode
  /**
   * The Team section content — hosts the SAME workspace content instances
   * (Orchestrator + Workers via WorkspaceDetail). Never re-wired here.
   */
  team: ReactNode
  /** The Tasks section content (task graph as a full-screen page). */
  tasks?: ReactNode
  /**
   * The Flows section content (Workflows page). Its presence is what adds the
   * Flows tab. Currently never passed: Workflows is desktop-only (user call
   * 2026-06 — authoring/monitoring multi-agent runs is not a phone job).
   */
  flows?: ReactNode
  /** The Settings section content (toggles / webhook / remote access + devices). */
  settings?: ReactNode
  /**
   * Terminal panels — MOUNTED ALWAYS (offscreen parking lot) so the live xterm
   * sessions survive section switches and re-park into whichever slot renders.
   */
  terminalPanels?: ReactNode
  /** Shared overlays (dialogs / add-workspace flow) — centered modals on mobile. */
  overlays?: ReactNode
  /** Badge inputs for the bottom nav. */
  openTaskCount?: number
  workingCount?: number
  /**
   * Controlled active section. When provided the shell is fully controlled
   * (the parent drives navigation, e.g. a full-screen page's close routing back
   * to Team). When omitted the shell manages its own section state internally.
   */
  activeSection?: MobileSection
  onSectionChange?: (section: MobileSection) => void
}

const SECTION_TESTID: Record<MobileSection, string> = {
  team: 'mobile-section-team',
  tasks: 'mobile-section-tasks',
  flows: 'mobile-section-flows',
  settings: 'mobile-section-settings',
}

export const MobileShell = ({
  workspaceSwitcher,
  topbarActions,
  banner,
  fullBleed,
  team,
  tasks,
  flows,
  settings,
  terminalPanels,
  overlays,
  openTaskCount = 0,
  workingCount = 0,
  activeSection: controlledSection,
  onSectionChange,
}: MobileShellProps) => {
  const [internalSection, setInternalSection] = useState<MobileSection>('team')
  const requestedSection = controlledSection ?? internalSection
  // Shell height tracks the visual viewport so the composer rises above the
  // on-screen keyboard instead of hiding behind it (iOS). h-dvh is the fallback.
  const viewportHeight = useVisualViewportHeight()
  const selectSection = (section: MobileSection) => {
    setInternalSection(section)
    onSectionChange?.(section)
  }

  const sectionContent: Record<MobileSection, ReactNode> = {
    team,
    tasks,
    flows,
    settings,
  }

  // Flows and Settings are opt-in: only surface a tab when the host wired its
  // content. (Settings is currently hidden on phones — product call; the
  // section component stays so re-adding it is just passing the prop again.)
  const sections: MobileSection[] = ['team', 'tasks']
  if (flows != null) sections.push('flows')
  if (settings != null) sections.push('settings')

  // A stale section (its tab just got hidden, e.g. demo toggled off while on
  // Settings) must not strand the user on a blank page.
  const activeSection = sections.includes(requestedSection) ? requestedSection : 'team'

  // Focus mode collapses the topbar + bottom nav so the terminal owns the
  // screen. Team-section only — other tabs always keep their chrome (and the
  // way back). The reconnect banner stays: connection state must never hide.
  const focusModeOn = useMobileFocusMode()
  const focused = focusModeOn && activeSection === 'team' && fullBleed == null

  return (
    <div
      className={`mobile-shell flex h-dvh w-full max-w-[100vw] min-w-0 flex-col overflow-hidden${focused ? ' mobile-shell--focus' : ''}`}
      data-mobile-shell="true"
      data-testid="mobile-shell"
      data-focus-mode={focused ? 'true' : undefined}
      style={{
        background: 'var(--bg-0)',
        color: 'var(--text-primary)',
        ...(viewportHeight != null ? { height: `${viewportHeight}px` } : {}),
      }}
    >
      {focused ? (
        banner
      ) : (
        <MobileTopbar
          workspaceSwitcher={workspaceSwitcher}
          actions={topbarActions}
          banner={banner}
        />
      )}
      <main className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
        {fullBleed ?? (
          <div
            className={
              activeSection === 'team'
                ? 'flex h-full min-w-0 flex-col overflow-hidden'
                : 'flex h-full min-w-0 flex-col overflow-y-auto'
            }
            data-testid={SECTION_TESTID[activeSection]}
            data-mobile-section={activeSection}
          >
            {sectionContent[activeSection]}
          </div>
        )}
      </main>
      {/* Always mounted, parked offscreen — see WorkspaceTerminalPanels §2.0. */}
      {terminalPanels}
      {/* fullBleed (runtime offline) overrides the whole section area — tabs
          would press but navigate nowhere, so hide the nav entirely. Focus
          mode hides it too; the strip toggle is the way back. */}
      {fullBleed != null || focused ? null : (
        <MobileBottomNav
          active={activeSection}
          onSelect={selectSection}
          sections={sections}
          openTaskCount={openTaskCount}
          workingCount={workingCount}
        />
      )}
      {overlays}
    </div>
  )
}
