export type UiLanguage = 'en' | 'zh'

export const DEFAULT_UI_LANGUAGE: UiLanguage = 'en'

export const isUiLanguage = (value: unknown): value is UiLanguage =>
  value === 'en' || value === 'zh'

export const normalizeUiLanguage = (
  value: unknown,
  fallback: UiLanguage = DEFAULT_UI_LANGUAGE
): UiLanguage => (isUiLanguage(value) ? value : fallback)
