import type { ReactNode } from 'react'

export interface MobileTopbarProps {
  /**
   * The workspace switcher trigger (active-workspace name + chevron). It's the
   * topbar's primary element so switching workspaces is reachable from the Team
   * home rather than buried in the section body. Falls back to the brand
   * wordmark on first run, before any workspace exists.
   */
  workspaceSwitcher?: ReactNode
  /** Chrome actions (open-in-editor / language / notifications). */
  actions?: ReactNode
  /** Reconnect banner strip (M5a connection status) rendered under the bar. */
  banner?: ReactNode
}

export const MobileTopbar = ({ workspaceSwitcher, actions, banner }: MobileTopbarProps) => {
  return (
    <header
      className="mobile-topbar flex shrink-0 flex-col"
      data-testid="mobile-topbar"
      style={{ background: 'var(--bg-0)', borderBottom: '1px solid var(--border)' }}
    >
      <div className="flex h-12 items-center gap-2 px-3">
        {/* The workspace switcher is the topbar's identity on mobile — no brand
            logo (the bottom nav + workspace name already say where you are). */}
        <div className="min-w-0 flex-1">
          {workspaceSwitcher ?? <span className="font-semibold text-pri">Hive</span>}
        </div>
        <div className="flex shrink-0 items-center gap-1">{actions}</div>
      </div>
      {banner}
    </header>
  )
}
