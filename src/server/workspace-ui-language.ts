import { DEFAULT_UI_LANGUAGE, isUiLanguage, type UiLanguage } from '../shared/ui-language.js'
import type { SettingsStore } from './settings-store.js'

export type { UiLanguage }

export const workspaceUiLanguageKey = (workspaceId: string) =>
  `workspace.${workspaceId}.ui_language`

export const readWorkspaceUiLanguage = (value: string | null | undefined): UiLanguage | null =>
  isUiLanguage(value) ? value : null

export const resolveWorkspaceUiLanguage = (
  settings: Pick<SettingsStore, 'getAppState'>,
  workspaceId: string,
  requestedLanguage?: unknown
): UiLanguage =>
  readWorkspaceUiLanguage(typeof requestedLanguage === 'string' ? requestedLanguage : null) ??
  readWorkspaceUiLanguage(settings.getAppState(workspaceUiLanguageKey(workspaceId))?.value) ??
  DEFAULT_UI_LANGUAGE

export const writeWorkspaceUiLanguage = (
  settings: Pick<SettingsStore, 'setAppState'>,
  workspaceId: string,
  language: UiLanguage
) => {
  settings.setAppState(workspaceUiLanguageKey(workspaceId), language)
}
