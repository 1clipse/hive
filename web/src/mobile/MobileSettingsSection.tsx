import { FlaskConical, LogOut } from 'lucide-react'
import { useI18n } from '../i18n.js'
import { NotificationSettings } from '../settings/NotificationSettings.js'
import { SettingsContent } from '../settings/SettingsMenu.js'

export interface MobileSettingsSectionProps {
  /** Whether the app is already in demo mode (hide the Demo entry then). */
  demoMode: boolean
  /** Enter the client-only Demo mode. */
  onTryDemo: () => void
  /** Exit demo mode. Only called when demoMode is true. */
  onExitDemo?: () => void
}

/**
 * The Settings bottom-nav section. Hosts the SAME body the desktop settings
 * popover uses (experimental toggles / completion webhook / Remote access +
 * device management) plus the Demo entry that used to live in the old "More"
 * section. Renders in-flow in the section column so the bottom nav stays pinned
 * below it — the nav is the way out, no close button needed.
 */
export const MobileSettingsSection = ({
  demoMode,
  onTryDemo,
  onExitDemo,
}: MobileSettingsSectionProps) => {
  const { t } = useI18n()
  return (
    <div
      // Natural height — the MobileShell section wrapper owns scrolling here.
      // An inner overflow-y-auto would nest two scrollables that fight on touch.
      className="mobile-settings-section flex min-h-full flex-col p-4"
      data-testid="mobile-settings-section"
    >
      <h1 className="mb-4 text-base font-semibold text-pri">{t('mobile.section.settings')}</h1>
      <SettingsContent />
      <NotificationSettings />

      {/* Demo section */}
      <div className="settings-section mt-3">
        <div className="settings-section__heading">
          <FlaskConical size={12} aria-hidden />
          <span>{t('mobile.section.demo')}</span>
        </div>
        {demoMode ? (
          <button
            type="button"
            data-testid="mobile-settings-exit-demo"
            onClick={onExitDemo}
            className="flex w-full items-center gap-3 rounded p-2 text-left text-sm text-pri hover:bg-3"
          >
            <LogOut size={16} aria-hidden className="text-ter" />
            <span className="min-w-0 flex-1 truncate">{t('demo.exit')}</span>
          </button>
        ) : (
          <button
            type="button"
            data-testid="mobile-settings-demo"
            onClick={onTryDemo}
            className="flex w-full items-center gap-3 rounded p-2 text-left text-sm text-pri hover:bg-3"
          >
            <FlaskConical size={16} aria-hidden className="text-ter" />
            <span className="min-w-0 flex-1 truncate">{t('mobile.section.demo')}</span>
          </button>
        )}
      </div>
    </div>
  )
}
