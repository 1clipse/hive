import { Languages } from 'lucide-react'
import { useI18n } from '../i18n.js'

export const LanguageSetting = () => {
  const { language, setLanguage, t } = useI18n()

  return (
    <div className="settings-section">
      <div className="settings-section__heading">
        <Languages size={12} aria-hidden />
        <span>{t('settings.language')}</span>
      </div>
      <div
        className="flex gap-1 p-1 rounded border"
        style={{ background: 'var(--bg-1)', borderColor: 'var(--border)' }}
      >
        <button
          type="button"
          className="flex-1 py-1 px-2 rounded text-xs font-medium transition-colors cursor-pointer"
          style={{
            background: language === 'zh' ? 'var(--bg-3)' : 'transparent',
            color: language === 'zh' ? 'var(--text-primary)' : 'var(--text-secondary)',
            border: 'none',
          }}
          onClick={() => setLanguage('zh')}
          data-testid="language-zh-btn"
        >
          中文
        </button>
        <button
          type="button"
          className="flex-1 py-1 px-2 rounded text-xs font-medium transition-colors cursor-pointer"
          style={{
            background: language === 'en' ? 'var(--bg-3)' : 'transparent',
            color: language === 'en' ? 'var(--text-primary)' : 'var(--text-secondary)',
            border: 'none',
          }}
          onClick={() => setLanguage('en')}
          data-testid="language-en-btn"
        >
          English
        </button>
      </div>
    </div>
  )
}
